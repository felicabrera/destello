"""Concurrency limiters for outbound requests to one service.

IRSA fair use applies to our egress IP, not to one build: the limit of 8 concurrent IRSA requests
(docs/10, config `irsa_concurrency`) must hold across every job of every worker process and the
API processes together. `RedisLimiter` enforces that with leases in a Redis sorted set shared by
all processes; `LocalLimiter` is the in-process fallback (tests, no Redis).

Lease protocol (same pattern as the SSE slots): purge expired members, add our token with an
expiry score, keep it only if the set then holds at most `limit` members, otherwise remove it and
retry after a short jittered pause. Each holder checks after its own insert, so the limit is never
exceeded, even when two processes race. A held lease is refreshed in the background, so a crashed
process frees its slots within LEASE_S.
"""

from __future__ import annotations

import asyncio
import contextlib
import random
import time
import uuid
from collections.abc import AsyncIterator
from typing import Any, Protocol

from destello.core.logging import get_logger

LEASE_S = 60.0
REFRESH_S = 20.0
POLL_MIN_S = 0.2
POLL_MAX_S = 0.6

log = get_logger(component="limiter")


class Limiter(Protocol):
    """An async context manager factory that bounds concurrent requests."""

    limit: int

    def slot(self) -> contextlib.AbstractAsyncContextManager[None]: ...


class LocalLimiter:
    """Per process limit (asyncio semaphore)."""

    def __init__(self, limit: int, semaphore: asyncio.Semaphore | None = None) -> None:
        self.limit = limit
        self.semaphore = semaphore or asyncio.Semaphore(limit)

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self.semaphore:
            yield


class RedisLimiter:
    """Global limit shared by every process that uses the same Redis key.

    A local semaphore of the same size sits in front, so one process never polls Redis for more
    slots than the global limit. If Redis fails while acquiring, the request proceeds under the
    local semaphore only (logged): the per process bound still holds.
    """

    def __init__(self, redis: Any, key: str, limit: int) -> None:
        self.redis = redis
        self.key = key
        self.limit = limit
        self.local = asyncio.Semaphore(limit)

    async def _try_acquire(self, token: str) -> bool:
        now = time.time()
        pipe = self.redis.pipeline(transaction=True)
        pipe.zremrangebyscore(self.key, 0, now)
        pipe.zadd(self.key, {token: now + LEASE_S})
        pipe.zcard(self.key)
        pipe.expire(self.key, int(LEASE_S) * 2)
        res = await pipe.execute()
        if int(res[2]) <= self.limit:
            return True
        await self.redis.zrem(self.key, token)
        return False

    async def _refresh(self, token: str) -> None:
        while True:
            await asyncio.sleep(REFRESH_S)
            with contextlib.suppress(Exception):
                await self.redis.zadd(self.key, {token: time.time() + LEASE_S}, xx=True)
                await self.redis.expire(self.key, int(LEASE_S) * 2)

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        async with self.local:
            token = uuid.uuid4().hex
            held = False
            try:
                while True:
                    if await self._try_acquire(token):
                        held = True
                        break
                    await asyncio.sleep(random.uniform(POLL_MIN_S, POLL_MAX_S))
            except Exception as exc:  # Redis unavailable: fall back to the local bound
                log.warning("global_limiter_unavailable", key=self.key, error=str(exc)[:200])
            refresher = asyncio.create_task(self._refresh(token)) if held else None
            try:
                yield
            finally:
                if refresher is not None:
                    refresher.cancel()
                    with contextlib.suppress(BaseException):
                        await refresher
                if held:
                    with contextlib.suppress(Exception):
                        await asyncio.shield(self.redis.zrem(self.key, token))

    async def in_use(self) -> int:
        """Current number of live leases (for tests and diagnostics)."""
        await self.redis.zremrangebyscore(self.key, 0, time.time())
        return int(await self.redis.zcard(self.key))


def irsa_limiter(redis: Any | None, limit: int) -> Limiter:
    """The limiter for IRSA requests: global when Redis is available, else per process."""
    if redis is None:
        return LocalLimiter(limit)
    return RedisLimiter(redis, "destello:egress:irsa", limit)


def s3_limiter(redis: Any | None, limit: int) -> Limiter:
    """The limiter for range requests to the SPHEREx S3 bucket (separate from IRSA)."""
    if redis is None:
        return LocalLimiter(limit)
    return RedisLimiter(redis, "destello:egress:s3", limit)
