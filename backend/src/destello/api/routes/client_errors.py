"""Browser error reports (NFR-OBS-01, docs/09 section 8).

The frontend sends uncaught errors here; they are written to the structured log as `client_error`
and never stored elsewhere or forwarded to a third party. Query strings and fragments are removed
from every URL before logging, so search terms and shared positions in the address do not reach
the log, and the client is identified only by the salted hash the middleware already computes.
"""

from __future__ import annotations

import re
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from destello.api.deps import AppState, client_hash, get_state
from destello.core import ratelimit
from destello.core.logging import get_logger

router = APIRouter(tags=["meta"])
log = get_logger(component="client")

CLIENT_ERROR_LIMIT = ratelimit.Limit("client_errors", 20, 3600)
# A query string or fragment, up to the end of the URL or a stack frame `:line:column` suffix.
_QUERY_RE = re.compile(r"[?#][^\s:)'\"]*")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


class ClientErrorIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["error", "unhandledrejection", "boundary"]
    message: str = Field(max_length=500)
    stack: str = Field(default="", max_length=4000)
    route: str = Field(default="", max_length=300)
    release: str = Field(default="", max_length=64)


def scrub(text: str) -> str:
    """Remove query strings, fragments and control characters (newlines are kept)."""
    return _CONTROL_RE.sub("", _QUERY_RE.sub("", text))


@router.post("/client-errors", status_code=204)
async def client_error(
    body: ClientErrorIn, request: Request, state: Annotated[AppState, Depends(get_state)]
) -> Response:
    """Log one browser error. Over the limit, reports are dropped silently (still 204)."""
    try:
        res = await ratelimit.hit(state.redis, CLIENT_ERROR_LIMIT, client_hash(request))
        allowed = res.allowed
    except Exception:  # Redis outage: the log line is still useful
        allowed = True
    if allowed:
        log.warning(
            "client_error",
            kind=body.kind,
            message=scrub(body.message),
            stack=scrub(body.stack),
            route=scrub(body.route),
            release=scrub(body.release),
            client=client_hash(request),
        )
    return Response(status_code=204)
