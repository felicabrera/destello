"""FastAPI application: /api/v1 routers, middleware, lifecycle (docs/04 section 5, docs/06)."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from destello.api.deps import AppState
from destello.api.errors import install_error_handlers
from destello.api.middleware import RequestContextMiddleware
from destello.api.prewarm import prewarm_loop
from destello.api.routes import (
    astrometry,
    client_errors,
    derived,
    hunt,
    meta,
    movers,
    notebook,
    reports,
    sequences,
    spectrum,
    static,
    wise,
)
from destello.core.config import Settings, get_settings
from destello.core.logging import configure_logging
from destello.models.schemas import HealthResponse

PIPELINE_VERSION_TAG = "pipeline_version"
API_PREFIX = "/api/v1"

__all__ = ["HealthResponse", "create_app", "app"]


def create_app(
    settings: Settings | None = None,
    *,
    redis: Any | None = None,
    queue: Any | None = None,
    state: AppState | None = None,
) -> FastAPI:
    """Build the application. Tests inject `redis` (fakeredis), `queue` (an object with
    `enqueue_job`) or a complete `state` with fake source clients."""
    cfg = settings or get_settings()
    configure_logging("INFO")
    if state is None:
        state = AppState(
            settings=cfg,
            redis=redis if redis is not None else Redis.from_url(cfg.redis_url),
            queue=queue,
        )
    owns_queue = state.queue is None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        if owns_queue:
            try:
                state.queue = await create_pool(RedisSettings.from_dsn(cfg.redis_url))
            except Exception:  # Redis not up yet: POST /sequences answers 503 until it is
                state.queue = None
        warm: asyncio.Task[None] | None = None
        if cfg.prewarm_measurements:
            warm = asyncio.create_task(prewarm_loop(state))
        try:
            yield
        finally:
            if warm is not None:
                warm.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await warm
            await state.aclose()

    app = FastAPI(
        title="Destello API",
        version=cfg.version,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    app.state.destello = state
    install_error_handlers(app)

    api = APIRouter(prefix=API_PREFIX)
    api.include_router(meta.router)
    api.include_router(sequences.router)
    api.include_router(notebook.router)
    api.include_router(derived.router)
    api.include_router(spectrum.router)
    api.include_router(astrometry.router)
    api.include_router(reports.router)
    api.include_router(hunt.router)
    api.include_router(movers.router)
    api.include_router(wise.router)
    api.include_router(client_errors.router)
    app.include_router(api)
    if cfg.env != "production":  # Caddy serves these in production
        app.include_router(static.router)

    origins = {cfg.public_url.rstrip("/")}
    if cfg.env != "production":
        origins |= {"http://localhost:5173", "http://127.0.0.1:5173"}
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept"],
        expose_headers=["RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset", "Retry-After"],
        max_age=600,
    )
    app.add_middleware(RequestContextMiddleware, state=state)
    return app


app = create_app()
