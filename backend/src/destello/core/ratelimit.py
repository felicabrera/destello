"""Fixed window rate limiting on Redis counters (docs/06 section 2, docs/10 section 3.3).

Keys are `destello:rl:<scope>:<client hash>:<window index>` and expire with the window, so no
cleanup is needed. Clients are identified by a salted hash of the IP address, never the address.
"""

from __future__ import annotations

import hashlib
import ipaddress
import secrets
import time
from dataclasses import dataclass
from typing import Any

# Used when DESTELLO_IP_HASH_SALT is not configured: stable for the life of the process only.
_PROCESS_SALT = secrets.token_hex(16)


@dataclass(frozen=True)
class Limit:
    """A named limit: `limit` events per `window_s` seconds."""

    scope: str
    limit: int
    window_s: int


@dataclass(frozen=True)
class LimitResult:
    allowed: bool
    limit: int
    remaining: int
    reset_s: int  # seconds until the window ends

    def headers(self) -> dict[str, str]:
        out = {
            "RateLimit-Limit": str(self.limit),
            "RateLimit-Remaining": str(self.remaining),
            "RateLimit-Reset": str(self.reset_s),
        }
        if not self.allowed:
            out["Retry-After"] = str(max(self.reset_s, 1))
        return out


GLOBAL_LIMIT = Limit("all", 120, 60)
BUILD_LIMIT = Limit("build", 6, 600)
COMPUTE_LIMIT = Limit("compute", 30, 60)


def hash_ip(ip: str, salt: str) -> str:
    """Salted SHA-256 of an IP address, truncated to 16 hex characters."""
    return hashlib.sha256(f"{salt or _PROCESS_SALT}|{ip}".encode()).hexdigest()[:16]


def pick_client_ip(peer: str | None, forwarded_for: str | None) -> str:
    """Client address: the first X-Forwarded-For entry, but only when the direct peer is a
    private or loopback address (a trusted reverse proxy). Otherwise the peer itself."""
    peer = peer or "unknown"
    try:
        trusted = ipaddress.ip_address(peer).is_private
    except ValueError:
        trusted = False
    if trusted and forwarded_for:
        first = forwarded_for.split(",")[0].strip()
        try:
            ipaddress.ip_address(first)
        except ValueError:
            return peer
        return first
    return peer


async def hit(
    redis: Any, limit: Limit, client_hash: str, *, now: float | None = None
) -> LimitResult:
    """Count one event and report whether it is within the limit."""
    t = time.time() if now is None else now
    window = int(t // limit.window_s)
    key = f"destello:rl:{limit.scope}:{client_hash}:{window}"
    count = int(await redis.incr(key))
    if count == 1:
        await redis.expire(key, limit.window_s + 5)
    reset = max(int((window + 1) * limit.window_s - t), 0)
    return LimitResult(
        allowed=count <= limit.limit,
        limit=limit.limit,
        remaining=max(limit.limit - count, 0),
        reset_s=reset,
    )
