"""Shared machinery for source clients: retries, bounded concurrency, data modes, TAP parsing.

All outbound traffic goes through core.egress.EgressClient. DESTELLO_DATA_MODE controls cache use:
offline (cache only), online (always fetch, still write the cache), hybrid (cache first).
"""

from __future__ import annotations

import asyncio
import csv
import io
import time
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, TypeVar

import httpx
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

from destello.core.cache import JsonCache
from destello.core.config import DataMode, Settings, get_settings
from destello.core.egress import EgressClient
from destello.core.limiter import Limiter, LocalLimiter
from destello.core.logging import get_logger

T = TypeVar("T")

RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


class SourceError(Exception):
    """A source returned an error or unusable data."""

    code = "SOURCE_ERROR"


class SourceUnavailable(SourceError):
    code = "SOURCE_UNAVAILABLE"


CIRCUIT_OPEN_S = 60.0  # how long a host that refused connections is left alone


class OfflineMiss(SourceError):
    """Data mode is offline and the requested item is not in the cache."""

    code = "OFFLINE_CACHE_MISS"


class RetryableStatus(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")
        self.status = status


class SourceBase:
    """Base class: owns the egress client, a concurrency semaphore and the JSON cache."""

    namespace = "source"

    def __init__(
        self,
        settings: Settings | None = None,
        client: EgressClient | None = None,
        cache: JsonCache | None = None,
        *,
        semaphore: asyncio.Semaphore | None = None,
        limiter: Limiter | None = None,
        max_attempts: int = 5,
        wait_initial_s: float = 2.0,
        wait_max_s: float = 60.0,
    ) -> None:
        self.settings = settings or get_settings()
        self._owns_client = client is None
        self.client = client or EgressClient(
            self.settings.egress_hosts, timeout_s=self.settings.http_timeout_s
        )
        self.cache = cache or JsonCache(self.settings.cache_dir)
        self.semaphore = semaphore or asyncio.Semaphore(self.settings.irsa_concurrency)
        # Concurrency bound for every request of this client. Pass a shared (Redis backed)
        # limiter so the bound holds across jobs and processes (core.limiter).
        self.limiter: Limiter = limiter or LocalLimiter(
            self.settings.irsa_concurrency, self.semaphore
        )
        self.max_attempts = max_attempts
        # Wire bytes received and responses seen (all builds sharing this client; for logs).
        self.bytes_downloaded = 0
        self.responses = 0
        self.wait_initial_s = wait_initial_s
        self.wait_max_s = wait_max_s
        self.log = get_logger(source=self.namespace)
        # Circuit breaker: hosts that refused every attempt of a request are not contacted again
        # for a short while, so callers fail fast (and fall back to stale cache) during an outage.
        self._down_until: dict[str, float] = {}
        # Requests in flight by cache key (see _fetch_once).
        self._inflight: dict[str, asyncio.Future[Any]] = {}

    @property
    def mode(self) -> DataMode:
        return self.settings.data_mode

    async def aclose(self) -> None:
        if self._owns_client:
            await self.client.aclose()

    async def __aenter__(self) -> SourceBase:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        timeout_s: float | None = None,
        headers: Mapping[str, str] | None = None,
        attempts: int | None = None,
    ) -> httpx.Response:
        """Bounded, retried request. Retries transport errors and 429/5xx with jittered backoff.

        `attempts` lowers the retry budget for one call (used when a fallback service exists).
        """
        if self.mode == DataMode.OFFLINE:
            raise OfflineMiss(f"Offline mode: network request to {url} refused")
        host = httpx.URL(url).host
        if time.monotonic() < self._down_until.get(host, 0.0):
            raise SourceUnavailable(f"{url}: {host} did not answer recently; not retried yet")
        last: BaseException | None = None
        try:
            async for attempt in AsyncRetrying(
                retry=retry_if_exception_type((httpx.TransportError, RetryableStatus)),
                wait=wait_exponential_jitter(
                    multiplier=self.wait_initial_s, max=self.wait_max_s, jitter=self.wait_initial_s
                ),
                stop=stop_after_attempt(min(attempts or self.max_attempts, self.max_attempts)),
                reraise=True,
            ):
                with attempt:
                    async with self.limiter.slot():
                        response = await self.client.request(
                            method,
                            url,
                            params=params,
                            data=data,
                            timeout_s=timeout_s,
                            headers=headers,
                        )
                    self.bytes_downloaded += response.num_bytes_downloaded
                    self.responses += 1
                    if response.status_code in RETRYABLE_STATUS:
                        self.log.warning("retryable_status", url=url, status=response.status_code)
                        raise RetryableStatus(response.status_code)
                    return response
        except (httpx.TransportError, RetryableStatus) as exc:
            last = exc
            if isinstance(exc, httpx.ConnectError | httpx.ConnectTimeout):
                self._down_until[host] = time.monotonic() + CIRCUIT_OPEN_S
                self.log.warning("circuit_open", host=host, seconds=CIRCUIT_OPEN_S)
        raise SourceUnavailable(f"{url}: {last}")

    async def cached(
        self,
        key: str,
        fetch: Callable[[], Awaitable[T]],
        *,
        ttl_s: float | None = None,
    ) -> T:
        """Return the cached JSON value for `key`, fetching according to the data mode.

        offline: cache only (OfflineMiss on a miss). online: always fetch. hybrid: use the cache
        unless missing or older than `ttl_s`; on a fetch failure, a stale entry is still used.
        """
        entry = self.cache.get(self.namespace, key)
        if self.mode == DataMode.OFFLINE:
            if entry is None:
                raise OfflineMiss(f"{self.namespace}: {key[:80]!r} not in cache")
            value: T = entry["data"]
            return value
        fresh = (
            entry is not None
            and self.mode == DataMode.HYBRID
            and (ttl_s is None or time.time() - float(entry["fetched_at"]) < ttl_s)
        )
        if fresh and entry is not None:
            value = entry["data"]
            return value
        try:
            value = await self._fetch_once(key, fetch)
        except SourceError:
            if entry is not None:
                self.log.warning("using_stale_cache", key=key[:80])
                stale: T = entry["data"]
                return stale
            raise
        self.cache.put(self.namespace, key, {"fetched_at": time.time(), "data": value})
        return value

    async def _fetch_once(self, key: str, fetch: Callable[[], Awaitable[T]]) -> T:
        """Run `fetch`, sharing one request between concurrent callers of the same key.

        Several requests for the same catalog cone or metadata (two visitors opening the same
        field, an overlay and a measurement) would otherwise each query the archive. The shared
        task is shielded: a caller that goes away does not cancel it for the others.
        """
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(fetch())
            self._inflight[key] = task

            def _done(t: asyncio.Future[Any], key: str = key) -> None:
                if self._inflight.get(key) is t:
                    del self._inflight[key]
                if not t.cancelled():
                    t.exception()  # retrieved here so an abandoned failure is not reported late

            task.add_done_callback(_done)
        value: T = await asyncio.shield(task)
        return value

    async def tap_rows(
        self, url: str, adql: str, *, maxrec: int | None = None, attempts: int | None = None
    ) -> list[dict[str, str]]:
        """Run a synchronous TAP query returning CSV and parse it into a list of dict rows."""
        form: dict[str, Any] = {
            "REQUEST": "doQuery",
            "LANG": "ADQL",
            "FORMAT": "csv",
            "QUERY": adql,
        }
        if maxrec is not None:
            form["MAXREC"] = maxrec
        response = await self.request(
            "POST",
            url,
            data=form,
            timeout_s=max(self.settings.http_timeout_s, 120.0),
            attempts=attempts,
        )
        if response.status_code != 200:
            raise SourceError(f"TAP {url} returned HTTP {response.status_code}")
        text = response.text
        head = text.lstrip()[:200].lower()
        if head.startswith("<?xml") or head.startswith("<votable"):
            raise SourceError("TAP query failed: " + _votable_error(text))
        return list(csv.DictReader(io.StringIO(text)))


def _votable_error(text: str) -> str:
    marker = 'name="QUERY_STATUS"'
    i = text.find(marker)
    if i < 0:
        return "unknown error"
    j = text.find(">", i)
    k = text.find("</INFO>", j)
    return text[j + 1 : k].strip()[:300]


def opt_float(value: str | None) -> float | None:
    """Parse an optional float from a CSV cell."""
    if value is None or value == "" or value.lower() == "null":
        return None
    try:
        out = float(value)
    except ValueError:
        return None
    return None if out != out else out
