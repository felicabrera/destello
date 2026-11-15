"""Pure ASGI middleware: request id, hashed client identity, global rate limit, security headers,
structured access log. Pure ASGI (not BaseHTTPMiddleware) so that SSE streams are not buffered."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any

from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from destello.api.deps import AppState
from destello.api.errors import problem
from destello.core import ratelimit
from destello.core.logging import get_logger

_REQ_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": "frame-ancestors 'self'",
}

log = get_logger(component="http")

# Browser and CDN cache policy for API answers that do not set their own Cache-Control. Only
# successful GETs of deterministic reads are cacheable; everything else (errors, health, builds,
# POSTs) is no-store. Lifetimes stay short: a sequence can be rebuilt under the same id and presets
# gain results.
_CACHEABLE: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"^/api/v1/(targets|validation|releases)$"), "public, max-age=300"),
    (re.compile(r"^/api/v1/resolve$"), "public, max-age=3600"),
    (
        re.compile(
            r"^/api/v1/sequences/[0-9a-f]{16}/(overlays/[a-z0-9_]+|difference|spectrum|path)$"
        ),
        "public, max-age=3600",
    ),
)


def cache_policy(method: str, path: str, status: int) -> str:
    """Cache-Control value for an API answer that did not choose one."""
    if method in ("GET", "HEAD") and status == 200:
        for pattern, value in _CACHEABLE:
            if pattern.match(path):
                return value
    return "no-store"


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp, state: AppState) -> None:
        self.app = app
        self.state = state

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        rid = headers.get("x-request-id", "")
        if not _REQ_ID_RE.match(rid):
            rid = uuid.uuid4().hex
        peer = scope["client"][0] if scope.get("client") else None
        ip = ratelimit.pick_client_ip(peer, headers.get("x-forwarded-for"))
        chash = ratelimit.hash_ip(ip, self.state.settings.ip_hash_salt)
        scope.setdefault("state", {})
        scope["state"]["request_id"] = rid
        scope["state"]["client_hash"] = chash
        started = time.monotonic()
        status_holder = {"status": 0}
        path: str = scope["path"]

        extra: list[tuple[bytes, bytes]] = []
        limited_headers: dict[str, str] = {}
        if path.startswith("/api/") and path not in ("/api/docs",):
            try:
                res = await ratelimit.hit(self.state.redis, ratelimit.GLOBAL_LIMIT, chash)
            except Exception:  # Redis outage: fail open, the API stays available
                res = None
            if res is not None:
                limited_headers = res.headers()
                if not res.allowed:
                    resp = problem(
                        Request(scope),
                        429,
                        "RATE_LIMITED",
                        "Too many requests",
                        "Request rate limit exceeded. Retry later.",
                        headers={**limited_headers, "X-Request-ID": rid, **SECURITY_HEADERS},
                    )
                    status_holder["status"] = 429
                    await resp(scope, receive, send)
                    self._log(scope, rid, chash, 429, started)
                    return

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = message["status"]
                hdrs: list[tuple[bytes, bytes]] = list(message.get("headers", []))
                present = {k.lower() for k, _ in hdrs}
                override: dict[str, Any] | None = scope.get("state", {}).get("ratelimit")
                rl = override if override is not None else limited_headers
                for k, v in rl.items():
                    if k.lower().encode() not in present:
                        hdrs.append((k.lower().encode(), str(v).encode()))
                for k, v in SECURITY_HEADERS.items():
                    if k.encode() not in present:
                        hdrs.append((k.encode(), v.encode()))
                if path.startswith("/api/") and b"cache-control" not in present:
                    policy = cache_policy(scope["method"], path, message["status"])
                    hdrs.append((b"cache-control", policy.encode()))
                hdrs.append((b"x-request-id", rid.encode()))
                hdrs.extend(extra)
                message["headers"] = hdrs
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            self._log(scope, rid, chash, status_holder["status"], started)

    @staticmethod
    def _log(scope: Scope, rid: str, chash: str, status: int, started: float) -> None:
        log.info(
            "request",
            request_id=rid,
            client=chash,
            method=scope["method"],
            path=scope["path"],
            status=status,
            ms=round((time.monotonic() - started) * 1000, 1),
        )
