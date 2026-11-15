"""On the fly spectrum at a sky position (docs/06 section 3.5, docs/03 section 4.5)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request

from destello.api import science
from destello.api.deps import AppState, client_hash, get_state, redis_get_json, redis_set_json
from destello.api.errors import ApiError
from destello.api.routes.derived import manifest_hash
from destello.api.routes.sequences import check_seq_id
from destello.core import ratelimit

router = APIRouter(tags=["science"])
CACHE_TTL_S = 7 * 86400
# Bumped whenever the spectrum response changes for the same inputs (v2: photometry flag mask,
# core saturation test and per-point reasons).
SPECTRUM_CACHE_VERSION = "v4"
SCIENCE_LIMIT = ratelimit.Limit("science", 30, 60)


async def enforce_science_limit(state: AppState, request: Request) -> None:
    try:
        res = await ratelimit.hit(state.redis, SCIENCE_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            "Measurement rate limit exceeded (30 per minute).",
            headers=res.headers(),
        )


def as_api_error(exc: science.ScienceError) -> ApiError:
    return ApiError(exc.status, exc.code, exc.title, exc.detail)


@router.get("/sequences/{sid}/spectrum")
async def spectrum(
    sid: Annotated[str, Path(max_length=16)],
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
    ra_deg: Annotated[float, Query(ge=0.0, lt=360.0)],
    dec_deg: Annotated[float, Query(ge=-90.0, le=90.0)],
    pmra_masyr: Annotated[float | None, Query(ge=-20000.0, le=20000.0)] = None,
    pmdec_masyr: Annotated[float | None, Query(ge=-20000.0, le=20000.0)] = None,
    ref_epoch: Annotated[str | None, Query(max_length=32)] = None,
    aperture_arcsec: Annotated[float, Query(ge=4.0, le=30.0)] = science.DEFAULT_APERTURE_ARCSEC,
) -> dict[str, Any]:
    """Forced photometry on every single exposure at the position propagated to its mid time."""
    check_seq_id(sid)

    async def limit() -> None:
        await enforce_science_limit(state, request)

    return await spectrum_doc(
        state, sid, ra_deg, dec_deg, pmra_masyr, pmdec_masyr, ref_epoch, aperture_arcsec, limit
    )


async def spectrum_doc(
    state: AppState,
    sid: str,
    ra_deg: float,
    dec_deg: float,
    pmra_masyr: float | None = None,
    pmdec_masyr: float | None = None,
    ref_epoch: str | None = None,
    aperture_arcsec: float = science.DEFAULT_APERTURE_ARCSEC,
    before_compute: Callable[[], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """The spectrum document, from the cache or measured and cached. `before_compute` runs only
    on a cache miss (the route passes its rate limit; the preset prewarm passes nothing)."""
    key = (
        f"destello:spectrum:{SPECTRUM_CACHE_VERSION}:{state.settings.pipeline_version}:{sid}:"
        f"{manifest_hash(state, sid)}:{ra_deg:.5f}:{dec_deg:.5f}:"
        f"{pmra_masyr}:{pmdec_masyr}:{ref_epoch}:{aperture_arcsec:.2f}"
    )
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return cached
    if before_compute is not None:
        await before_compute()
    try:
        seq = science.load_sequence(state.settings.data_dir, sid)
        astro = science.request_astrometry(ra_deg, dec_deg, pmra_masyr, pmdec_masyr, ref_epoch)
        doc = await asyncio.to_thread(
            science.run_measurement,
            science.compute_spectrum,
            seq,
            ra_deg,
            dec_deg,
            astro,
            aperture_arcsec,
        )
    except science.ScienceError as exc:
        raise as_api_error(exc) from None
    await redis_set_json(state.redis, key, doc, CACHE_TTL_S)
    return doc
