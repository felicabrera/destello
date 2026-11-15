"""Cloudflare Turnstile token verification (F-22 report submissions, docs/10).

The verification URL is a constant on an allowlisted host; nothing user supplied becomes a URL.
The client IP is not sent: Destello never handles addresses in clear outside rate limiting.
"""

from __future__ import annotations

from destello.sources.base import SourceBase, SourceError

TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
TOKEN_MAX_LEN = 2048  # Cloudflare tokens are about 1 to 2 kB


class TurnstileClient(SourceBase):
    namespace = "turnstile"

    async def verify(self, token: str, secret: str, hostname: str | None = None) -> bool:
        """True when Cloudflare accepts the token. Network failures raise SourceError.

        With `hostname`, the token must also have been issued on that host name, so a token solved
        on another site that embeds the same site key is refused.
        """
        if not token or len(token) > TOKEN_MAX_LEN:
            return False
        response = await self.request(
            "POST",
            TURNSTILE_VERIFY_URL,
            data={"secret": secret, "response": token},
            timeout_s=10.0,
        )
        if response.status_code != 200:
            raise SourceError(f"Turnstile HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError as exc:
            raise SourceError("Turnstile answered with invalid JSON") from exc
        if not (isinstance(body, dict) and body.get("success") is True):
            return False
        return hostname is None or body.get("hostname") == hostname
