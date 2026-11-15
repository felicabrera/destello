"""Allowlisted, https-only outbound HTTP client (docs/10 section 3.2).

Every request URL is checked against the host allowlist before it is sent. Redirects are never
followed by httpx itself: they are followed here, and only to allowlisted https hosts. The
backend never fetches a URL supplied by a user; URLs are built from validated parameters.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urljoin, urlsplit

import httpx

MAX_REDIRECTS = 5
_REDIRECT_CODES = (301, 302, 303, 307, 308)


class EgressError(Exception):
    """Raised when a request is blocked by the egress policy."""


def check_url(url: str, allowed_hosts: frozenset[str]) -> None:
    """Raise EgressError unless the URL is https and its host is allowlisted."""
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise EgressError(f"Blocked non-https URL scheme: {parts.scheme!r}")
    host = (parts.hostname or "").lower()
    if not host or host not in allowed_hosts:
        raise EgressError(f"Blocked host not in allowlist: {host!r}")
    if parts.username or parts.password:
        raise EgressError("Blocked URL containing credentials")


class EgressClient:
    """Thin wrapper around httpx.AsyncClient enforcing the egress policy."""

    def __init__(
        self,
        allowed_hosts: frozenset[str],
        *,
        timeout_s: float = 30.0,
        transport: httpx.AsyncBaseTransport | None = None,
        user_agent: str = "Destello/0.3 (NASA Space Apps 2026)",
    ) -> None:
        self.allowed_hosts = frozenset(h.lower() for h in allowed_hosts)
        self._client = httpx.AsyncClient(
            timeout=timeout_s,
            follow_redirects=False,
            transport=transport,
            headers={"User-Agent": user_agent},
            # Room for the IRSA (8) and S3 (16) global limits plus catalog requests.
            limits=httpx.Limits(max_connections=40, max_keepalive_connections=24),
        )

    async def request(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        data: Mapping[str, Any] | None = None,
        timeout_s: float | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> httpx.Response:
        """Send a request, following redirects only to allowlisted https hosts."""
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            check_url(current, self.allowed_hosts)
            first = current == url
            response = await self._client.request(
                method,
                current,
                params=params if first else None,
                data=data if first else None,
                headers=headers,
                timeout=timeout_s if timeout_s is not None else httpx.USE_CLIENT_DEFAULT,
            )
            if response.status_code in _REDIRECT_CODES:
                location = response.headers.get("location")
                if not location:
                    raise EgressError("Redirect without Location header")
                current = urljoin(str(response.url), location)
                if response.status_code == 303:
                    method = "GET"  # See Other: fetch the result (UWS style synchronous TAP)
                continue
            return response
        raise EgressError("Too many redirects")

    async def get(
        self,
        url: str,
        *,
        params: Mapping[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> httpx.Response:
        return await self.request("GET", url, params=params, timeout_s=timeout_s)

    async def post(
        self,
        url: str,
        *,
        data: Mapping[str, Any] | None = None,
        timeout_s: float | None = None,
    ) -> httpx.Response:
        return await self.request("POST", url, data=data, timeout_s=timeout_s)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> EgressClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()
