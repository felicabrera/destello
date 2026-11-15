"""Proper motion measurement on a sequence (docs/06 section 3.5, docs/03 section 4.6)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from functools import partial
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Request
from pydantic import BaseModel, Field

from destello.api import science
from destello.api.deps import AppState, get_state, redis_get_json, redis_set_json
from destello.api.routes.derived import manifest_hash
from destello.api.routes.sequences import check_seq_id
from destello.api.routes.spectrum import CACHE_TTL_S, as_api_error, enforce_science_limit

# Bumped when the response shape changes, so documents from older code are not served.
ASTROMETRY_CACHE_VERSION = "v4"

router = APIRouter(tags=["science"])
CATALOG_WAIT_S = 45.0


class AstrometryRequest(BaseModel):
    ra_deg: float = Field(ge=0.0, lt=360.0)
    dec_deg: float = Field(ge=-90.0, le=90.0)
    detector: int | None = Field(default=None, ge=1, le=6)
    fit_parallax: bool = False
    reference: Literal["literature", "gaia", "none"] = "literature"
    pmra_masyr: float | None = Field(default=None, ge=-20000.0, le=20000.0)
    pmdec_masyr: float | None = Field(default=None, ge=-20000.0, le=20000.0)
    ref_epoch: str | None = Field(default=None, max_length=32)


@router.post("/sequences/{sid}/astrometry")
async def astrometry(
    sid: Annotated[str, Path(max_length=16)],
    body: AstrometryRequest,
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
) -> dict[str, Any]:
    """Centroids per epoch on per-detector coadds, local Gaia recalibration, motion fit."""
    check_seq_id(sid)

    async def limit() -> None:
        await enforce_science_limit(state, request)

    return await astrometry_doc(state, sid, body, limit)


async def astrometry_doc(
    state: AppState,
    sid: str,
    body: AstrometryRequest,
    before_compute: Callable[[], Awaitable[None]] | None = None,
) -> dict[str, Any]:
    """The astrometry document, from the cache or measured and cached. `before_compute` runs
    only on a cache miss (the route passes its rate limit; the preset prewarm passes nothing)."""
    ver = f"{ASTROMETRY_CACHE_VERSION}:{state.settings.pipeline_version}"
    # The manifest hash makes a rebuilt sequence (new release) miss the cached measurement.
    key = f"destello:astrometry:{ver}:{sid}:{manifest_hash(state, sid)}:" + ":".join(
        str(v)
        for v in (
            f"{body.ra_deg:.5f}",
            f"{body.dec_deg:.5f}",
            body.detector,
            body.fit_parallax,
            body.reference,
            body.pmra_masyr,
            body.pmdec_masyr,
            body.ref_epoch,
        )
    )
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return cached
    if before_compute is not None:
        await before_compute()
    try:
        seq = science.load_sequence(state.settings.data_dir, sid)
        astro = science.request_astrometry(
            body.ra_deg, body.dec_deg, body.pmra_masyr, body.pmdec_masyr, body.ref_epoch
        )
        # rejected before any catalog request: a position off the grid is a client error
        await asyncio.to_thread(science.require_in_field, seq, body.ra_deg, body.dec_deg, astro)
        cat_name, catalog = await science.recalibration_catalog(state, seq.grid, CATALOG_WAIT_S)
        doc = await asyncio.to_thread(
            science.run_measurement,
            partial(
                science.measure_astrometry,
                seq,
                body.ra_deg,
                body.dec_deg,
                detector=body.detector,
                fit_parallax=body.fit_parallax,
                reference=body.reference,
                catalog_name=cat_name,
                catalog=catalog,
                astro=astro,
            ),
        )
    except science.ScienceError as exc:
        raise as_api_error(exc) from None
    await redis_set_json(state.redis, key, doc, CACHE_TTL_S)
    return doc
