"""arq WorkerSettings. Run with: arq destello.worker.main.WorkerSettings"""

from __future__ import annotations

from typing import Any

from arq import cron
from arq.connections import RedisSettings

from destello.core.config import get_settings
from destello.core.limiter import irsa_limiter, s3_limiter
from destello.core.logging import configure_logging
from destello.sources.irsa import IrsaClient
from destello.sources.s3 import S3CutoutSource
from destello.worker.cron import backup_reports, check_releases, cleanup, warm_presets
from destello.worker.jobs import build_sequence

_settings = get_settings()


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging("INFO")
    ctx["settings"] = _settings
    # One client per process, and a Redis backed limiter shared with every other worker and API
    # process: the IRSA concurrency bound (8) applies to our egress IP, not to one job.
    ctx["irsa"] = IrsaClient(
        _settings, limiter=irsa_limiter(ctx.get("redis"), _settings.irsa_concurrency)
    )
    # Primary cutout source (AWS open data copy, range reads); IRSA stays the per image fallback.
    # Its own global limiter (DESTELLO_S3_CONCURRENCY) is independent of the IRSA bound.
    if _settings.cutout_source == "s3":
        ctx["s3"] = S3CutoutSource(
            _settings,
            irsa=ctx["irsa"],
            limiter=s3_limiter(ctx.get("redis"), _settings.s3_concurrency),
        )


async def shutdown(ctx: dict[str, Any]) -> None:
    for name in ("s3", "irsa"):
        client = ctx.get(name)
        if client is not None:
            await client.aclose()


class WorkerSettings:
    functions = [build_sequence, warm_presets, check_releases, cleanup, backup_reports]
    cron_jobs = [
        cron(check_releases, hour={0, 6, 12, 18}, minute=5),
        cron(warm_presets, hour={6}, minute=0),  # 06:00 UTC, and on a release change
        # Hourly (docs/09 section 6): a busy day must not overshoot the disk quota between runs.
        cron(cleanup, minute=15),
        cron(backup_reports, hour={3}, minute=40),  # daily, local copy (docs/09 section 9)
    ]
    redis_settings = RedisSettings.from_dsn(_settings.redis_url)
    on_startup = startup
    on_shutdown = shutdown
    max_jobs = 2
    job_timeout = 3600
    keep_result = 3600
