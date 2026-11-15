"""Shared application state and helpers (Redis, arq queue, source clients, client identity)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from fastapi import Request

from destello.core.config import Settings
from destello.core.limiter import irsa_limiter
from destello.sources.catwise import CatwiseClient
from destello.sources.gaia import GaiaClient
from destello.sources.irsa import IrsaClient
from destello.sources.sbident import SBIdentClient
from destello.sources.sesame import SesameClient
from destello.sources.simbad import SimbadClient
from destello.sources.turnstile import TurnstileClient

SEQ_ID_RE = re.compile(r"^[0-9a-f]{16}$")
FILE_NAME_RE = re.compile(r"^[0-9a-f]{16}(\.[a-z0-9]+)*$")


@dataclass
class AppState:
    """Everything a request handler may need. Tests replace the clients and the queue."""

    settings: Settings
    redis: Any
    queue: Any  # object with `enqueue_job(name, *args, _job_id=...)` (arq pool)
    irsa: IrsaClient | None = None
    gaia: GaiaClient | None = None
    catwise: CatwiseClient | None = None
    simbad: SimbadClient | None = None
    sesame: SesameClient | None = None
    sbident: SBIdentClient | None = None
    turnstile: TurnstileClient | None = None
    reports_engine: Any | None = None  # sqlalchemy Engine for the report database (F-22)
    memory: dict[str, tuple[float, Any]] = field(default_factory=dict)

    def get_irsa(self) -> IrsaClient:
        if self.irsa is None:
            # Shares the global IRSA limiter with the workers (core.limiter).
            self.irsa = IrsaClient(
                self.settings,
                limiter=irsa_limiter(self.redis, self.settings.irsa_concurrency),
            )
        return self.irsa

    def get_gaia(self) -> GaiaClient:
        if self.gaia is None:
            self.gaia = GaiaClient(self.settings)
        return self.gaia

    def get_catwise(self) -> CatwiseClient:
        if self.catwise is None:
            self.catwise = CatwiseClient(self.settings)
        return self.catwise

    def get_simbad(self) -> SimbadClient:
        if self.simbad is None:
            self.simbad = SimbadClient(self.settings)
        return self.simbad

    def get_sesame(self) -> SesameClient:
        if self.sesame is None:
            self.sesame = SesameClient(self.settings)
        return self.sesame

    def get_sbident(self) -> SBIdentClient:
        if self.sbident is None:
            self.sbident = SBIdentClient(self.settings, max_attempts=2)
        return self.sbident

    def get_turnstile(self) -> TurnstileClient:
        if self.turnstile is None:
            self.turnstile = TurnstileClient(self.settings, max_attempts=2)
        return self.turnstile

    def get_reports_engine(self) -> Any:
        if self.reports_engine is None:
            from destello.core.db import make_engine

            self.reports_engine = make_engine(self.settings.db_url)
        return self.reports_engine

    async def aclose(self) -> None:
        clients = (
            self.irsa, self.gaia, self.catwise, self.simbad, self.sesame, self.sbident,
            self.turnstile,
        )  # fmt: skip
        for c in clients:
            if c is not None:
                await c.aclose()
        if self.reports_engine is not None:
            self.reports_engine.dispose()


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.destello
    return state


def client_hash(request: Request) -> str:
    h: str = request.state.client_hash
    return h


async def redis_get_json(redis: Any, key: str) -> Any | None:
    """Read a JSON value; a Redis outage or a corrupt value reads as a miss."""
    try:
        raw = await redis.get(key)
    except Exception:
        return None
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return None


async def redis_set_json(redis: Any, key: str, value: Any, ttl_s: int) -> None:
    try:
        await redis.set(key, json.dumps(value), ex=ttl_s)
    except Exception:
        return
