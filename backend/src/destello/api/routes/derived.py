"""Derived products of a sequence: catalog overlays, difference images and the predicted path of a
source with known motion (docs/06 section 3.5)."""

from __future__ import annotations

import asyncio
import hashlib
from typing import Annotated, Literal

import astropy.units as u
from fastapi import APIRouter, Depends, Path, Query, Request

from destello.api.candidates import build_candidates
from destello.api.deps import AppState, client_hash, get_state, redis_get_json, redis_set_json
from destello.api.derived import OVERLAY_METHOD_VERSION, build_difference, build_overlay
from destello.api.errors import ApiError
from destello.api.motion_search import build_motion_search
from destello.api.path import PATH_VERSION, build_path, parse_ref_epoch
from destello.api.routes.sequences import check_seq_id
from destello.core import ratelimit
from destello.models.schemas import (
    CandidatesOut,
    DifferenceOut,
    MotionSearchOut,
    OverlayOut,
    PathOut,
)
from destello.pipeline.candidates import CANDIDATES_METHOD_VERSION
from destello.pipeline.difference import DIFFERENCE_METHOD_VERSION
from destello.pipeline.motion_search import MOTION_SEARCH_METHOD_VERSION
from destello.pipeline.propagate import Astrometry

router = APIRouter(tags=["derived"])
CACHE_TTL_S = 7 * 86400


def manifest_hash(state: AppState, sid: str) -> str:
    """Short hash of the manifest bytes, so derived caches follow rebuilt sequences."""
    try:
        data = (state.settings.manifests_dir / f"{sid}.json").read_bytes()
    except OSError:
        return "nomanifest"
    return hashlib.sha256(data).hexdigest()[:12]


@router.get("/sequences/{sid}/overlays/{catalog}", response_model=OverlayOut)
async def overlays(
    sid: Annotated[str, Path(max_length=16)],
    catalog: Literal["gaia_dr3", "catwise2020"],
    state: Annotated[AppState, Depends(get_state)],
) -> OverlayOut:
    """Catalog sources propagated to the mid time of each epoch, in frame pixel EDGE coordinates
    (pixel center at i + 0.5, y down from the top edge of the north up image)."""
    check_seq_id(sid)
    ver = f"{state.settings.pipeline_version}:{manifest_hash(state, sid)}"
    key = f"destello:overlay:{ver}:m{OVERLAY_METHOD_VERSION}:{sid}:{catalog}"
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return OverlayOut(**cached)
    doc = await build_overlay(state, sid, catalog)
    out = OverlayOut(**doc)
    await redis_set_json(state.redis, key, out.model_dump(mode="json"), CACHE_TTL_S)
    return out


@router.get("/sequences/{sid}/difference", response_model=DifferenceOut)
async def difference_image(
    sid: Annotated[str, Path(max_length=16)],
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
    a: Annotated[int, Query(ge=0, le=64)],
    b: Annotated[int, Query(ge=0, le=64)],
    detector: Annotated[int, Query(ge=0, le=6)] = 0,
) -> DifferenceOut:
    """D = A - s B with a robust field-star scale s, as a diverging RGBA WebP (detector 0 is the
    broadband coadd). `a` and `b` are 0-based epoch indices. Computed once, then cached."""
    check_seq_id(sid)
    ver = f"{state.settings.pipeline_version}:{manifest_hash(state, sid)}"
    key = f"destello:diff:{ver}:m{DIFFERENCE_METHOD_VERSION}:{sid}:{a}:{b}:{detector}"
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        out_cached = DifferenceOut(**cached)
        name = out_cached.url.rsplit("/", 1)[-1]
        if (state.settings.frames_dir / name).is_file():
            return out_cached
    try:
        res = await ratelimit.hit(state.redis, ratelimit.COMPUTE_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            "Compute rate limit exceeded.",
            headers=res.headers(),
        )
    out = DifferenceOut(**await build_difference(state, sid, a, b, detector))
    await redis_set_json(state.redis, key, out.model_dump(mode="json"), CACHE_TTL_S)
    return out


@router.get("/sequences/{sid}/candidates", response_model=CandidatesOut)
async def candidates(
    sid: Annotated[str, Path(max_length=16)],
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
    a: Annotated[int, Query(ge=0, le=64)],
    b: Annotated[int, Query(ge=0, le=64)],
) -> CandidatesOut:
    """F-29: places where epochs `a` and `b` (0-based) differ by 5 sigma or more in the detector
    coadds: dipoles, and unpaired changes seen by two or more detectors, each compared with
    Gaia DR3 and CatWISE2020 propagated to the epoch. Positions also in frame pixel EDGE
    coordinates. A listed entry is a candidate to review, not a detection of a new object."""
    check_seq_id(sid)
    ver = f"{state.settings.pipeline_version}:{manifest_hash(state, sid)}"
    key = (
        f"destello:cand:{ver}:m{DIFFERENCE_METHOD_VERSION}.{CANDIDATES_METHOD_VERSION}:"
        f"{sid}:{a}:{b}"
    )
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return CandidatesOut(**cached)
    try:
        res = await ratelimit.hit(state.redis, ratelimit.COMPUTE_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            "Compute rate limit exceeded.",
            headers=res.headers(),
        )
    doc, complete = await build_candidates(state, sid, a, b)
    out = CandidatesOut(**doc)
    # A list made while a catalog did not answer is served but not kept.
    if complete:
        await redis_set_json(state.redis, key, out.model_dump(mode="json"), CACHE_TTL_S)
    return out


async def _compute_allowed(state: AppState, request: Request) -> None:
    try:
        res = await ratelimit.hit(state.redis, ratelimit.COMPUTE_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            "Compute rate limit exceeded.",
            headers=res.headers(),
        )


@router.get("/sequences/{sid}/motion-search", response_model=MotionSearchOut)
async def motion_search(
    sid: Annotated[str, Path(max_length=16)],
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
) -> MotionSearchOut:
    """F-32: shift-and-stack search over a grid of proper motions on the detector coadds of the
    full coverage epochs (three or more). Motions are measured from per-epoch centroids; a source
    is listed when two or more detectors agree, and is compared with Gaia DR3 and CatWISE2020
    propagated to the mean epoch. A listed source is a candidate to review, not a discovery."""
    check_seq_id(sid)
    ver = f"{state.settings.pipeline_version}:{manifest_hash(state, sid)}"
    key = f"destello:motion:{ver}:m{DIFFERENCE_METHOD_VERSION}.{MOTION_SEARCH_METHOD_VERSION}:{sid}"
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return MotionSearchOut(**cached)
    await _compute_allowed(state, request)
    doc, complete = await build_motion_search(state, sid)
    out = MotionSearchOut(**doc)
    # A result made while a catalog did not answer is served but not kept.
    if complete:
        await redis_set_json(state.redis, key, out.model_dump(mode="json"), CACHE_TTL_S)
    return out


@router.get("/sequences/{sid}/path", response_model=PathOut)
async def predicted_path(
    sid: Annotated[str, Path(max_length=16)],
    state: Annotated[AppState, Depends(get_state)],
    ra_deg: Annotated[float, Query(ge=0.0, lt=360.0)],
    dec_deg: Annotated[float, Query(ge=-90.0, le=90.0)],
    pmra_masyr: Annotated[float, Query(ge=-20000.0, le=20000.0)],
    pmdec_masyr: Annotated[float, Query(ge=-20000.0, le=20000.0)],
    ref_epoch: Annotated[str, Query(min_length=5, max_length=32)],
    parallax_mas: Annotated[float, Query(ge=0.0, le=1000.0)] = 0.0,
) -> PathOut:
    """F-27: apparent path of a source (catalog position at `ref_epoch`, proper motion with
    mu_alpha* = mu_alpha cos(dec), parallax) between the first and the last observation of the
    sequence, the position at each epoch mid time and the yearly parallax ellipse, in frame pixel
    EDGE coordinates. Geocentric observer (docs/03 section 4.4). Pure computation, no network."""
    check_seq_id(sid)
    epoch = parse_ref_epoch(ref_epoch)
    ver = f"{state.settings.pipeline_version}:{manifest_hash(state, sid)}:p{PATH_VERSION}"
    key = (
        f"destello:path:{ver}:{sid}:"
        + ":".join(f"{v:.7f}" for v in (ra_deg, dec_deg, pmra_masyr, pmdec_masyr, parallax_mas))
        + f":{ref_epoch}"
    )
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        return PathOut(**cached)
    astrometry = Astrometry(
        ra=ra_deg * u.deg,
        dec=dec_deg * u.deg,
        pmra_cosdec=pmra_masyr * u.mas / u.yr,
        pmdec=pmdec_masyr * u.mas / u.yr,
        parallax=parallax_mas * u.mas,
        ref_epoch=epoch,
    )
    out = PathOut(**await asyncio.to_thread(build_path, state, sid, astrometry, ref_epoch))
    await redis_set_json(state.redis, key, out.model_dump(mode="json"), CACHE_TTL_S)
    return out
