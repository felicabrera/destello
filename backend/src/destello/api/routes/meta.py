"""Health, releases, targets, name resolution and the published validation report."""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from pathlib import Path
from typing import Annotated, Any

import astropy.units as u
from astropy.time import Time
from fastapi import APIRouter, Depends, Query, Request

from destello.api.deps import AppState, get_state, redis_get_json, redis_set_json
from destello.api.errors import ApiError
from destello.core.config import RELEASE_DOIS, SCIENCE_COLLECTIONS
from destello.core.logging import get_logger
from destello.models.schemas import (
    DefaultViewOut,
    HealthResponse,
    PropagatedOut,
    ReleaseOut,
    ReleasesOut,
    ResolveOut,
    TargetAstrometryOut,
    TargetOut,
    TargetResultOut,
)
from destello.models.targets import Target, find_target, load_targets
from destello.pipeline.propagate import Astrometry, propagate_space_motion
from destello.sources.sesame import SESAME_HOST
from destello.sources.simbad import RESOLVER_TTL_S, sanitize_name
from destello.worker.cron import RELEASES_KEY, RELEASES_TTL_S
from destello.worker.jobs import (
    PRESET_CENTER_DATE,
    manifest_path,
    params_sequence_id,
    preset_params,
)

router = APIRouter()
log = get_logger(component="meta")

HEALTH_TTL_S = 60
RELEASE_LABELS = {
    "spherex_qr3": "Quick Release 3",
    "spherex_dr1": "Data Release 1",
    "spherex_qr2": "Quick Release 2",  # retired by IRSA; label kept for stored manifests
}
_MOTION_UNITS = ("mas/yr", "arcsec/yr", "arcsec yr", "mas yr")


# ------------------------------------------------------------------ health
async def irsa_status(state: AppState) -> str:
    """IRSA availability (ok, degraded, down), probed at most once per minute."""
    cached = await redis_get_json(state.redis, "destello:health:irsa")
    if isinstance(cached, str):
        return cached
    mem = state.memory.get("irsa_health")
    if mem is not None and time.monotonic() - mem[0] < HEALTH_TTL_S:
        return str(mem[1])
    status = await state.get_irsa().health()
    state.memory["irsa_health"] = (time.monotonic(), status)
    await redis_set_json(state.redis, "destello:health:irsa", status, HEALTH_TTL_S)
    return status


@router.get("/health", response_model=HealthResponse, tags=["meta"])
async def health(state: Annotated[AppState, Depends(get_state)]) -> dict[str, Any]:
    """Liveness plus the IRSA availability (cached for 60 seconds)."""
    return {
        "status": "ok",
        "version": state.settings.version,
        "pipeline_version": state.settings.pipeline_version,
        "irsa": await irsa_status(state),
    }


# ------------------------------------------------------------------ releases
@router.get("/releases", response_model=ReleasesOut, tags=["meta"])
async def releases(state: Annotated[AppState, Depends(get_state)]) -> ReleasesOut:
    """SPHEREx collections with DOI and the latest data date known to IRSA.

    Reads the release metadata that the check_releases cron job keeps in Redis; on a miss it asks
    IRSA (waiting at most 3 s, the query keeps filling the cache in the background).
    """
    rows: list[dict[str, Any]] | None = await redis_get_json(state.redis, RELEASES_KEY)
    if not isinstance(rows, list):
        rows = None
        try:
            task = state.memory.get("releases_task")
            if task is None or task[1].done():
                task = (0.0, asyncio.ensure_future(state.get_irsa().list_releases()))
                state.memory["releases_task"] = task
            found = await asyncio.wait_for(asyncio.shield(task[1]), timeout=3.0)
            rows = [
                {
                    "collection": r.collection,
                    "n_planes": r.n_planes,
                    "latest_pub_date": r.latest_pub_date,
                    "t_max_mjd": r.t_max_mjd,
                }
                for r in found
            ]
            await redis_set_json(state.redis, RELEASES_KEY, rows, RELEASES_TTL_S)
        except Exception as exc:  # IRSA down and nothing cached: DOIs and labels remain valid
            log.warning("releases_unavailable", error=str(exc))
    dates: dict[str, str] = {}
    for row in rows or []:
        base = str(row.get("collection", "")).replace("_deep", "")
        when = str(row.get("latest_pub_date") or "")[:10]
        if when and when > dates.get(base, ""):
            dates[base] = when
    out = [
        ReleaseOut(
            collection=c,
            label=RELEASE_LABELS.get(c, c),
            doi=RELEASE_DOIS[c],
            data_as_of=dates.get(c, ""),
        )
        for c in ("spherex_qr3", "spherex_dr1")
        if c in SCIENCE_COLLECTIONS
    ]
    default = state.settings.default_release
    return ReleasesOut(default=default, releases=out)


# ------------------------------------------------------------------ targets
def _read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def validation_doc(state: AppState) -> dict[str, Any] | None:
    doc = _read_json(state.settings.data_dir / "validation.json")
    return doc if isinstance(doc, dict) else None


def _not_measurable(target_id: str, doc: dict[str, Any] | None) -> bool:
    """True when validation.json holds tests for the target that measure a position, motion or
    brightness, and every one of them is `not_measurable`."""
    if not doc:
        return False
    physical = [
        t
        for t in doc.get("tests", [])
        if isinstance(t, dict) and t.get("target") == target_id and t.get("id") != "V-10"
    ]
    return bool(physical) and all(t.get("status") == "not_measurable" for t in physical)


def _result_for(target_id: str, doc: dict[str, Any] | None) -> TargetResultOut | None:
    """Measured result of a target taken from validation.json. Nothing is derived or invented:
    a test must carry a numeric `measured` value to produce a result."""
    if not doc:
        return None
    results = doc.get("results")
    if isinstance(results, dict) and isinstance(results.get(target_id), dict):
        r = results[target_id]
        if (
            isinstance(r.get("value"), int | float)
            and isinstance(r.get("unit"), str)
            and (r["unit"].lower() in _MOTION_UNITS or r["unit"].lower() == "mag")
        ):
            try:
                return TargetResultOut(**{k: r[k] for k in TargetResultOut.model_fields if k in r})
            except ValueError:
                pass
    for t in doc.get("tests", []):
        if not isinstance(t, dict) or t.get("target") != target_id:
            continue
        # V-11 is the blind motion search check; the result card is the targeted measurement.
        if t.get("id") == "V-11":
            continue
        measured = t.get("measured")
        unit = t.get("unit")
        if not isinstance(measured, int | float) or not isinstance(unit, str):
            continue
        # Only physical measurements: counts (V-10 dipoles) and angular offsets are not results.
        if unit.lower() not in _MOTION_UNITS and unit.lower() != "mag":
            continue
        sigma = t.get("sigma")
        kind = "motion" if unit.lower() in _MOTION_UNITS else "variability"
        return TargetResultOut(
            kind=kind,
            value=float(measured),
            err=float(t["err"]) if isinstance(t.get("err"), int | float) else None,
            unit=unit,
            reference_value=float(t["reference"])
            if isinstance(t.get("reference"), int | float)
            else None,
            reference_source=t.get("source") if isinstance(t.get("source"), str) else None,
            agreement_sigma=float(sigma)
            if kind == "motion" and isinstance(sigma, int | float)
            else None,
            significance_sigma=float(sigma)
            if kind == "variability" and isinstance(sigma, int | float)
            else None,
        )
    return None


def target_out(target: Target, state: AppState, doc: dict[str, Any] | None) -> TargetOut:
    params = preset_params(target)
    seq_id = params_sequence_id(params, state.settings)
    built = manifest_path(state.settings, seq_id).exists()
    a = target.astrometry
    c = target.copy_
    return TargetOut(
        id=target.id,
        names=target.names,
        ra_deg=params.ra_deg,
        dec_deg=params.dec_deg,
        astrometry=TargetAstrometryOut(
            source=a.source,
            ref_epoch=a.ref_epoch,
            ra_deg=a.ra_deg,
            dec_deg=a.dec_deg,
            pmra_masyr=a.pmra_masyr,
            pmdec_masyr=a.pmdec_masyr,
            parallax_mas=a.parallax_mas,
        ),
        default_view=DefaultViewOut(**target.default_view.model_dump()),
        notes=target.notes,
        sequence_id=seq_id if built else None,
        result=(result := _result_for(target.id, doc)),
        not_measurable=result is None and _not_measurable(target.id, doc),
        kind=c.get("kind"),
        headline=c.get("headline"),
        look=c.get("look"),
        caption=c.get("caption"),
        limit=c.get("limit"),
        label=c.get("label"),
    )


@router.get("/targets", response_model=list[TargetOut], tags=["meta"])
async def targets(state: Annotated[AppState, Depends(get_state)]) -> list[TargetOut]:
    """The five presets. `sequence_id` is set only when the sequence is already built, and
    `result` only when a measured value exists in validation.json."""
    doc = validation_doc(state)
    return [target_out(t, state, doc) for t in load_targets().values()]


@router.get("/validation", tags=["meta"])
async def validation(state: Annotated[AppState, Depends(get_state)]) -> dict[str, Any]:
    """The published validation report (data/validation.json); 404 until a run is published."""
    doc = validation_doc(state)
    if doc is None:
        raise ApiError(404, "NOT_FOUND", "Not found", "No validation report has been published.")
    return doc


# ------------------------------------------------------------------ resolve
def _preset_resolved(target: Target, query: str) -> ResolveOut:
    a = target.astrometry
    p = preset_params(target)
    return ResolveOut(
        query=query,
        main_id=target.names.get("en", target.id),
        ra_deg=a.ra_deg,
        dec_deg=a.dec_deg,
        ref_epoch=a.ref_epoch,
        pmra_masyr=a.pmra_masyr,
        pmdec_masyr=a.pmdec_masyr,
        parallax_mas=a.parallax_mas,
        propagated=PropagatedOut(
            epoch=PRESET_CENTER_DATE + "Z", ra_deg=p.ra_deg, dec_deg=p.dec_deg
        ),
    )


async def _propagate_to_data(state: AppState, obj: ResolveOut) -> PropagatedOut | None:
    """Propagate a SIMBAD position (J2000.0) to the mean epoch of the images covering it."""
    if obj.pmra_masyr is None or obj.pmdec_masyr is None:
        return None
    try:
        recs = await state.get_irsa().query_images(
            obj.ra_deg, obj.dec_deg, list(SCIENCE_COLLECTIONS), None
        )
    except Exception:
        return None
    if not recs:
        return None
    mean_mjd = sum(float(r.t_start.mjd + r.t_end.mjd) / 2.0 for r in recs) / len(recs)
    when = Time(mean_mjd, format="mjd", scale="utc")
    astro = Astrometry(
        ra=obj.ra_deg * u.deg,
        dec=obj.dec_deg * u.deg,
        pmra_cosdec=obj.pmra_masyr * u.mas / u.yr,
        pmdec=obj.pmdec_masyr * u.mas / u.yr,
        parallax=(obj.parallax_mas or 0.0) * u.mas,
        ref_epoch=Time(2000.0, format="jyear", scale="tdb"),
    )
    moved = propagate_space_motion(astro, when)
    return PropagatedOut(
        epoch=when.utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        ra_deg=round(float(moved.ra.deg), 6),
        dec_deg=round(float(moved.dec.deg), 6),
    )


RESOLVE_TIMEOUT_S = 10.0
SESAME_TIMEOUT_S = 7.0
FALLBACK_TIMEOUT_S = 8.0
FALLBACK_TTL_S = 3600  # short, so the SIMBAD answer (with proper motion) replaces it
UNKNOWN_TTL_S = 300  # name unknown to the fallback resolvers only (they can be incomplete)


async def _sesame_step(state: AppState, query: str) -> tuple[ResolveOut | None, bool]:
    """Second resolver (CDS Sesame mirror). Returns (answer, name_known_to_be_unknown)."""
    try:
        obj = await asyncio.wait_for(state.get_sesame().resolve(query), SESAME_TIMEOUT_S)
    except Exception as exc:
        log.warning("sesame_failed", error=type(exc).__name__)
        return None, False
    if obj is None:
        return None, True
    out = ResolveOut(
        query=query,
        main_id=obj.main_id,
        ra_deg=obj.ra_deg,
        dec_deg=obj.dec_deg,
        ref_epoch=obj.ref_epoch,
        pmra_masyr=obj.pmra_masyr,
        pmdec_masyr=obj.pmdec_masyr,
        parallax_mas=obj.parallax_mas,
        resolver=f"sesame:{SESAME_HOST}",
    )
    out.propagated = await _propagate_to_data(state, out)
    return out, False


async def _irsa_fallback(state: AppState, query: str) -> tuple[ResolveOut | None, bool]:
    """Last resolver (IRSA). Returns (answer, answered_unknown); a failure is (None, False)."""
    try:
        found = await asyncio.wait_for(state.get_irsa().resolve_name(query), FALLBACK_TIMEOUT_S)
    except Exception as exc:
        log.warning("resolver_fallback_failed", error=type(exc).__name__)
        return None, False
    if found is None:
        return None, True
    return (
        ResolveOut(
            query=query,
            main_id=found.name or query,
            ra_deg=found.ra_deg,
            dec_deg=found.dec_deg,
            ref_epoch="J2000.0",
            pmra_masyr=None,
            pmdec_masyr=None,
            parallax_mas=None,
            propagated=None,
            resolver=f"irsa:{found.resolver}",
        ),
        False,
    )


def _resolver_unavailable() -> ApiError:
    return ApiError(
        502,
        "RESOLVER_UNAVAILABLE",
        "Resolver unavailable",
        "The name resolvers (SIMBAD, the Sesame mirror and IRSA) did not answer. "
        "Enter coordinates instead.",
        headers={"Retry-After": "60"},
    )


@router.get("/resolve", response_model=ResolveOut, tags=["meta"])
async def resolve(
    state: Annotated[AppState, Depends(get_state)],
    request: Request,
    name: Annotated[str, Query(min_length=1, max_length=100)],
) -> ResolveOut:
    """Resolve an object name: preset names and aliases first, then SIMBAD (cached 7 days),
    then the Sesame mirror, then the IRSA resolver when SIMBAD fails."""
    query = name.strip()
    try:
        sanitize_name(query)
    except ValueError:
        raise ApiError(
            422, "INVALID_NAME", "Invalid name", "name: unsupported characters."
        ) from None
    target = find_target(query)
    if target is not None:
        return _preset_resolved(target, query)

    key = "destello:resolve:" + hashlib.sha256(query.lower().encode()).hexdigest()[:24]
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict):
        if cached.get("not_found"):
            raise ApiError(
                404, "RESOLVE_FAILED", "Name not found", "The name could not be resolved."
            )
        if cached.get("unavailable"):
            raise _resolver_unavailable()
        return ResolveOut(**cached)
    try:
        obj = await asyncio.wait_for(state.get_simbad().resolve(query), RESOLVE_TIMEOUT_S)
    except Exception as exc:  # primary failed: try the IRSA fallback, else RESOLVER_UNAVAILABLE
        log.warning("resolver_unavailable", error=type(exc).__name__)
        sesame, sesame_unknown = await _sesame_step(state, query)
        if sesame is not None:
            await redis_set_json(state.redis, key, sesame.model_dump(mode="json"), RESOLVER_TTL_S)
            return sesame
        fallback, irsa_unknown = await _irsa_fallback(state, query)
        if fallback is not None:
            await redis_set_json(state.redis, key, fallback.model_dump(mode="json"), FALLBACK_TTL_S)
            return fallback
        if sesame_unknown and irsa_unknown:  # a real resolver was consulted and does not know it
            await redis_set_json(state.redis, key, {"not_found": True}, UNKNOWN_TTL_S)
            raise ApiError(
                404, "RESOLVE_FAILED", "Name not found", "The name could not be resolved."
            ) from None
        await redis_set_json(state.redis, key, {"unavailable": True}, 60)
        raise _resolver_unavailable() from None
    if obj is None:
        await redis_set_json(state.redis, key, {"not_found": True}, 3600)
        raise ApiError(404, "RESOLVE_FAILED", "Name not found", "The name could not be resolved.")
    out = ResolveOut(
        query=query,
        main_id=obj.main_id,
        ra_deg=obj.ra_deg,
        dec_deg=obj.dec_deg,
        ref_epoch=obj.ref_epoch,
        pmra_masyr=obj.pmra_masyr,
        pmdec_masyr=obj.pmdec_masyr,
        parallax_mas=obj.parallax_mas,
        resolver="simbad",
    )
    out.propagated = await _propagate_to_data(state, out)
    await redis_set_json(state.redis, key, out.model_dump(mode="json"), RESOLVER_TTL_S)
    return out
