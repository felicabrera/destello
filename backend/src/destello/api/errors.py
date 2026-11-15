"""RFC 9457 problem+json error handlers with a stable `code` field (docs/06 section 1)."""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from destello.core.logging import get_logger

_log = get_logger(component="http")

PROBLEM_JSON = "application/problem+json"
TYPE_BASE = "https://destello.example/errors/"

_STATUS_CODES = {
    400: "BAD_REQUEST",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}


class ApiError(Exception):
    """Application error rendered as problem+json."""

    def __init__(
        self,
        status: int,
        code: str,
        title: str,
        detail: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail
        self.headers = headers or {}


def problem(
    request: Request,
    status: int,
    code: str,
    title: str,
    detail: str,
    headers: dict[str, str] | None = None,
    extra: dict[str, Any] | None = None,
) -> JSONResponse:
    body: dict[str, Any] = {
        "type": TYPE_BASE + code.lower().replace("_", "-"),
        "title": title,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
        "code": code,
    }
    if extra:
        body.update(extra)
    return JSONResponse(body, status_code=status, media_type=PROBLEM_JSON, headers=headers)


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return problem(request, exc.status, exc.code, exc.title, exc.detail, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0] if exc.errors() else {}
        loc = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
        detail = f"{loc}: {first.get('msg', 'invalid value')}" if loc else "Invalid request."
        return problem(request, 422, "VALIDATION_ERROR", "Invalid request", detail[:300])

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "HTTP_ERROR")
        title = "Not found" if exc.status_code == 404 else "Request error"
        return problem(request, exc.status_code, code, title, str(exc.detail)[:300])

    @app.exception_handler(HTTPException)
    async def _fastapi_http(request: Request, exc: HTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "HTTP_ERROR")
        return problem(request, exc.status_code, code, "Request error", str(exc.detail)[:300])

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        # No stack traces or internals in responses (docs/10 section 2); the full error goes to
        # the structured log with the request id, which the answer carries for support.
        rid = str(getattr(request.state, "request_id", "") or "")
        _log.error(
            "unhandled_error",
            path=request.url.path,
            method=request.method,
            request_id=rid,
            error_type=type(exc).__name__,
            exc_info=exc,
        )
        return problem(
            request,
            500,
            "INTERNAL_ERROR",
            "Internal error",
            "An unexpected error occurred.",
            extra={"request_id": rid} if rid else None,
        )
