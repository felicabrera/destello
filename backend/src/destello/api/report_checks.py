"""Automated cross-checks for candidate reports (F-22, docs/02, docs/06 section 3.6).

A visitor marks one position in each of two or more epochs. For every mark, catalog positions are
propagated from their own reference epoch to the mid time of the frame that was marked (Gaia DR3
with parallax, CatWISE2020 with its apparent motion, SIMBAD from J2000.0), so known high proper
motion stars are caught at the position where SPHEREx saw them. JPL SBIdent lists known small
bodies near each mark at the frame mid time for a geocentric observer.

The checks never decide that something is new. A result without catalog match only means that
these catalogs, at these radii, list nothing there.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.time import Time

from destello.api.deps import AppState
from destello.api.derived import fetch_catalog, grid_from_manifest, propagate_to_epoch
from destello.api.derived import to_frame_pixels as _to_frame_pixels
from destello.api.errors import ApiError
from destello.models.catalog import CatalogSource
from destello.pipeline.reproject import GridSpec

FloatArray = npt.NDArray[np.float64]

CHECKS_VERSION = 1
# A mark is a click on the 3.1 arcsec display grid; the source centroid is uncertain by about half
# a native pixel (6.2 arcsec). 10 arcsec covers both with margin and stays under two native pixels.
CATALOG_MATCH_ARCSEC = 10.0
MARK_SIGMA_ARCSEC = 3.1
# SIMBAD positions come from heterogeneous sources, many without proper motion: a wider radius.
SIMBAD_MATCH_ARCSEC = 20.0
# Known small bodies: SBIdent assumes a geocentric observer; from low Earth orbit the parallax of a
# main belt asteroid is up to about 7 arcsec, and much more for near Earth objects.
SBIDENT_HALF_WIDTH_ARCSEC = 60.0
SBIDENT_VMAG_LIMIT = 23.0
SBIDENT_CONCURRENCY = 2
# Deep cone around the marks (all magnitudes) on top of the cached field cone.
NEAR_MARGIN_ARCSEC = 30.0
DEEP_CONE_LIMIT = 500
# High proper motion SIMBAD objects that may have moved onto a mark since J2000.0.
SIMBAD_WIDE_ARCMIN = 6.0
SIMBAD_WIDE_MIN_PM_MASYR = 100.0
SIMBAD_LIMIT = 200
CHECK_TIMEOUT_S = 25.0
MAX_MATCHES = 10
MIN_MARKS = 2
MAX_MARKS = 12
CACHE_TTL_S = 3600

CATALOGS = ("gaia_dr3", "catwise2020", "simbad", "sbident")


@dataclass(frozen=True)
class Mark:
    """One validated mark: a position in one epoch, with the frame it was made on."""

    index: int
    epoch: int
    ra_deg: float
    dec_deg: float
    t_mid: Time
    frame: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "epoch": self.epoch,
            "ra_deg": round(self.ra_deg, 7),
            "dec_deg": round(self.dec_deg, 7),
            "t_mid_mjd": round(float(self.t_mid.utc.mjd), 6),
            "t_mid": self.t_mid.utc.isot[:19] + "Z",
            "frame": self.frame,
        }


def _invalid(detail: str) -> ApiError:
    return ApiError(422, "INVALID_MARKS", "Invalid marks", detail)


def _frame_for(epoch: dict[str, Any], detector: int | str | None) -> dict[str, Any] | None:
    frames = [f for f in epoch.get("frames") or [] if isinstance(f, dict)]
    if not frames:
        return None
    if detector is not None:
        for f in frames:
            if str(f.get("detector")) == str(detector):
                return f
    for f in frames:
        if f.get("detector") == "all":
            return f
    return frames[0]


def frame_summary(frame: dict[str, Any] | None) -> dict[str, Any]:
    """Traceability for one marked frame (docs/00 non-negotiable 2)."""
    if not frame:
        return {}
    keys = (
        "detector", "url", "t_mid_mjd", "t_start", "t_end", "wavelength_um", "obs_ids",
        "collections", "dois", "n_images",
    )  # fmt: skip
    return {k: frame[k] for k in keys if k in frame}


def in_field(grid: GridSpec, ra: float, dec: float) -> bool:
    x, y = _to_frame_pixels(grid, np.array([ra]), np.array([dec]))
    xv, yv = float(x[0]), float(y[0])
    return bool(
        np.isfinite(xv) and np.isfinite(yv) and 0.0 <= xv <= grid.nx and 0.0 <= yv <= grid.ny
    )


def resolve_marks(
    manifest: dict[str, Any], raw: list[dict[str, Any]], detector: int | str | None = None
) -> list[Mark]:
    """Validate marks against the manifest: known, distinct epochs, positions inside the field.

    Marks are returned in time order. Raises ApiError 422 INVALID_MARKS otherwise."""
    epochs = {int(e["index"]): e for e in manifest.get("epochs") or []}
    if len(epochs) < MIN_MARKS:
        raise _invalid("The sequence needs at least two epochs to report a candidate.")
    if not MIN_MARKS <= len(raw) <= min(MAX_MARKS, len(epochs)):
        raise _invalid("Mark the candidate in at least two epochs, at most once per epoch.")
    seen: set[int] = set()
    grid = grid_from_manifest(manifest)
    out: list[Mark] = []
    for m in raw:
        ep = int(m["epoch"])
        if ep not in epochs:
            raise _invalid(f"Epoch {ep} does not exist in this sequence.")
        if ep in seen:
            raise _invalid("Each epoch can hold only one mark.")
        seen.add(ep)
        ra = float(m["ra_deg"]) % 360.0
        dec = float(m["dec_deg"])
        if not in_field(grid, ra, dec):
            raise ApiError(
                422,
                "POSITION_OUTSIDE_FIELD",
                "Position outside the field",
                f"The mark in epoch {ep} is outside the field of this sequence.",
            )
        frame = _frame_for(epochs[ep], detector)
        mjd = (frame or {}).get("t_mid_mjd") or epochs[ep].get("t_mid_mjd")
        if mjd is None:
            raise _invalid(f"Epoch {ep} has no observation time.")
        out.append(
            Mark(
                index=0,
                epoch=ep,
                ra_deg=ra,
                dec_deg=dec,
                t_mid=Time(float(mjd), format="mjd", scale="utc"),
                frame=frame_summary(frame),
            )
        )
    out.sort(key=lambda k: float(k.t_mid.mjd))
    return [Mark(i, k.epoch, k.ra_deg, k.dec_deg, k.t_mid, k.frame) for i, k in enumerate(out)]


# ------------------------------------------------------------------ geometry
def sep_arcsec(ra1: float, dec1: float, ra2: FloatArray, dec2: FloatArray) -> FloatArray:
    """Great circle separation (haversine), arcsec."""
    r1, d1 = math.radians(ra1), math.radians(dec1)
    r2, d2 = np.radians(ra2), np.radians(dec2)
    a = np.sin((d2 - d1) / 2) ** 2 + math.cos(d1) * np.cos(d2) * np.sin((r2 - r1) / 2) ** 2
    out: FloatArray = np.degrees(2 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))) * 3600.0
    return out


def centroid(marks: list[Mark]) -> tuple[float, float, float]:
    """Mean direction of the marks and the largest distance from it (arcsec)."""
    ra = np.radians([m.ra_deg for m in marks])
    dec = np.radians([m.dec_deg for m in marks])
    x = float(np.mean(np.cos(dec) * np.cos(ra)))
    y = float(np.mean(np.cos(dec) * np.sin(ra)))
    z = float(np.mean(np.sin(dec)))
    c_ra = math.degrees(math.atan2(y, x)) % 360.0
    c_dec = math.degrees(math.atan2(z, math.hypot(x, y)))
    ras = np.array([m.ra_deg for m in marks])
    decs = np.array([m.dec_deg for m in marks])
    spread = float(np.max(sep_arcsec(c_ra, c_dec, ras, decs)))
    return c_ra, c_dec, spread


def estimate_motion(marks: list[Mark], sigma_arcsec: float = MARK_SIGMA_ARCSEC) -> dict[str, Any]:
    """Straight-line motion through the marks (least squares on the tangent plane).

    Parallax is not fitted. With two marks the line passes through both; with three or more the
    RMS residual tests whether the marks follow a straight track."""
    ra0 = math.radians(marks[0].ra_deg)
    dec0 = math.radians(marks[0].dec_deg)
    xs: list[float] = []
    ys: list[float] = []
    for m in marks:
        ra = math.radians(m.ra_deg)
        dec = math.radians(m.dec_deg)
        cosc = math.sin(dec0) * math.sin(dec) + math.cos(dec0) * math.cos(dec) * math.cos(ra - ra0)
        xi = math.cos(dec) * math.sin(ra - ra0) / cosc
        eta = (
            math.cos(dec0) * math.sin(dec) - math.sin(dec0) * math.cos(dec) * math.cos(ra - ra0)
        ) / cosc
        xs.append(math.degrees(xi) * 3600.0)
        ys.append(math.degrees(eta) * 3600.0)
    t = np.array([float(m.t_mid.tdb.jyear) for m in marks])
    tc = t - float(np.mean(t))
    sxx = float(np.sum(tc**2))
    x = np.array(xs)
    y = np.array(ys)
    vx = float(np.sum(tc * (x - x.mean())) / sxx)
    vy = float(np.sum(tc * (y - y.mean())) / sxx)
    total = math.hypot(vx, vy)
    sigma_v = sigma_arcsec / math.sqrt(sxx)
    rms: float | None = None
    if len(marks) >= 3:
        rx = x - (x.mean() + vx * tc)
        ry = y - (y.mean() + vy * tc)
        rms = float(math.sqrt(float(np.mean(rx**2 + ry**2))))
    pa = (math.degrees(math.atan2(vx, vy)) + 360.0) % 360.0
    return {
        "n_marks": len(marks),
        "pmra_cosdec_arcsec_yr": round(vx, 3),
        "pmdec_arcsec_yr": round(vy, 3),
        "total_arcsec_yr": round(total, 3),
        "sigma_arcsec_yr": round(sigma_v, 3),
        "significance": round(total / sigma_v, 1) if sigma_v > 0 else None,
        "position_angle_deg": round(pa, 1),
        "baseline_days": round(float((t.max() - t.min()) * 365.25), 1),
        "rms_residual_arcsec": None if rms is None else round(rms, 2),
        "mark_sigma_arcsec": sigma_arcsec,
        "parallax_fitted": False,
    }


# ------------------------------------------------------------------ catalog matching
def _merge(*groups: list[CatalogSource]) -> list[CatalogSource]:
    seen: dict[str, CatalogSource] = {}
    for g in groups:
        for s in g:
            seen.setdefault(s.source_id, s)
    return list(seen.values())


def _num(v: float | None, nd: int) -> float | None:
    return None if v is None or not math.isfinite(v) else round(float(v), nd)


def match_sources(
    sources: list[CatalogSource],
    marks: list[Mark],
    radius_arcsec: float,
    *,
    apply_parallax: bool,
) -> dict[str, Any]:
    """Propagate every source to each mark's time and match within `radius_arcsec`.

    status: `match` when one source lies within the radius of every mark, `partial` when some
    marks have a counterpart, `no_match` otherwise. `nearest` is the closest propagated source to
    any mark, whatever its distance."""
    result: dict[str, Any] = {
        "status": "no_match",
        "radius_arcsec": radius_arcsec,
        "searched": len(sources),
        "matches": [],
        "nearest": None,
        "archive": "+".join(sorted({s.archive for s in sources if s.archive})) or None,
    }
    if not sources:
        return result
    per_source: dict[int, list[dict[str, Any]]] = {}
    nearest: tuple[float, int, int] | None = None
    for m in marks:
        ra, dec = propagate_to_epoch(sources, m.t_mid, apply_parallax=apply_parallax)
        seps = sep_arcsec(m.ra_deg, m.dec_deg, ra, dec)
        j = int(np.argmin(seps))
        if nearest is None or float(seps[j]) < nearest[0]:
            nearest = (float(seps[j]), j, m.index)
        for hit in np.flatnonzero(seps <= radius_arcsec):
            k = int(hit)
            per_source.setdefault(k, []).append(
                {"mark": m.index, "sep_arcsec": round(float(seps[k]), 2)}
            )
    matches: list[dict[str, Any]] = []
    for k, hits in per_source.items():
        s = sources[k]
        matches.append(
            {
                "source_id": s.source_id,
                "mag": _num(s.mag, 2),
                "mag_band": s.mag_band,
                "pmra_masyr": _num(s.pmra_masyr, 2),
                "pmdec_masyr": _num(s.pmdec_masyr, 2),
                "parallax_mas": _num(s.parallax_mas, 3),
                "ref_epoch_jyear": round(s.ref_epoch_jyear, 3),
                "marks": hits,
                "min_sep_arcsec": min(h["sep_arcsec"] for h in hits),
            }
        )
    matches.sort(key=lambda d: (-len(d["marks"]), d["min_sep_arcsec"]))
    marks_hit = {h["mark"] for d in matches for h in d["marks"]}
    if any(len(d["marks"]) == len(marks) for d in matches):
        result["status"] = "match"
    elif marks_hit:
        result["status"] = "partial"
    result["matches"] = matches[:MAX_MATCHES]
    result["n_matches"] = len(matches)
    if nearest is not None:
        s = sources[nearest[1]]
        result["nearest"] = {
            "source_id": s.source_id,
            "sep_arcsec": round(nearest[0], 2),
            "mark": nearest[2],
            "mag": _num(s.mag, 2),
            "mag_band": s.mag_band,
            "archive": s.archive,
        }
    return result


def unavailable(reason: str) -> dict[str, Any]:
    return {"status": "unavailable", "reason": reason[:200], "matches": [], "nearest": None}


def _shared[T](state: AppState, key: str, factory: Callable[[], Awaitable[T]]) -> Awaitable[T]:
    """Run an outbound query as a shared background task.

    The check timeout cancels only the wait, not the query: it keeps running and fills the
    source cache, so the checks repeated at submission (or a retry) get the answer. Identical
    concurrent queries share one task. The entry is dropped when the task ends.
    """
    mkey = "rc:" + key
    entry = state.memory.get(mkey)
    if entry is None:
        task: asyncio.Future[T] = asyncio.ensure_future(factory())
        state.memory[mkey] = (time.time(), task)
        task.add_done_callback(lambda _t: state.memory.pop(mkey, None))
        task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
    else:
        task = entry[1]
    return asyncio.shield(task)


async def _gather_cones(*coros: Any) -> tuple[list[list[CatalogSource]], list[str]]:
    results = await asyncio.gather(*coros, return_exceptions=True)
    ok: list[list[CatalogSource]] = []
    errors: list[str] = []
    for r in results:
        if isinstance(r, BaseException):
            errors.append(type(r).__name__ if not isinstance(r, ApiError) else r.code)
        else:
            ok.append(list(r))
    return ok, errors


async def check_gaia(state: AppState, grid: GridSpec, marks: list[Mark]) -> dict[str, Any]:
    c_ra, c_dec, spread = centroid(marks)
    near_r = (spread + CATALOG_MATCH_ARCSEC + NEAR_MARGIN_ARCSEC) * u.arcsec
    groups, errors = await _gather_cones(
        fetch_catalog(state, "gaia_dr3", grid),
        _shared(
            state,
            f"gaia:{c_ra:.6f}:{c_dec:.6f}:{near_r.value:.2f}",
            lambda: state.get_gaia().cone(c_ra, c_dec, near_r, max_g=None, limit=DEEP_CONE_LIMIT),
        ),
    )
    if not groups:
        return unavailable(", ".join(errors))
    out = match_sources(_merge(*groups), marks, CATALOG_MATCH_ARCSEC, apply_parallax=True)
    out["complete"] = not errors
    return out


async def check_catwise(state: AppState, grid: GridSpec, marks: list[Mark]) -> dict[str, Any]:
    c_ra, c_dec, spread = centroid(marks)
    near_r = (spread + CATALOG_MATCH_ARCSEC + NEAR_MARGIN_ARCSEC) * u.arcsec
    groups, errors = await _gather_cones(
        fetch_catalog(state, "catwise2020", grid),
        _shared(
            state,
            f"catwise:{c_ra:.6f}:{c_dec:.6f}:{near_r.value:.2f}",
            lambda: state.get_catwise().cone(c_ra, c_dec, near_r, limit=DEEP_CONE_LIMIT),
        ),
    )
    if not groups:
        return unavailable(", ".join(errors))
    # CatWISE motions are apparent (they include parallax); no parallax shift is added.
    out = match_sources(_merge(*groups), marks, CATALOG_MATCH_ARCSEC, apply_parallax=False)
    out["complete"] = not errors
    return out


async def check_simbad(state: AppState, marks: list[Mark]) -> dict[str, Any]:
    c_ra, c_dec, spread = centroid(marks)
    simbad = state.get_simbad()
    near_r = (spread + SIMBAD_MATCH_ARCSEC + NEAR_MARGIN_ARCSEC) * u.arcsec
    wide_r = (spread / 60.0 + SIMBAD_WIDE_ARCMIN) * u.arcmin
    groups, errors = await _gather_cones(
        _shared(
            state,
            f"simbad:{c_ra:.6f}:{c_dec:.6f}:{near_r.value:.2f}",
            lambda: simbad.cone(c_ra, c_dec, near_r, limit=SIMBAD_LIMIT),
        ),
        _shared(
            state,
            f"simbad-pm:{c_ra:.6f}:{c_dec:.6f}:{wide_r.value:.4f}",
            lambda: simbad.cone(
                c_ra, c_dec, wide_r, min_pm_masyr=SIMBAD_WIDE_MIN_PM_MASYR, limit=SIMBAD_LIMIT
            ),
        ),
    )
    if not groups:
        return unavailable(", ".join(errors))
    out = match_sources(_merge(*groups), marks, SIMBAD_MATCH_ARCSEC, apply_parallax=True)
    out["complete"] = not errors
    return out


def _span_days(frame: dict[str, Any]) -> float | None:
    try:
        a = Time(str(frame["t_start"]).rstrip("Z"), scale="utc")
        b = Time(str(frame["t_end"]).rstrip("Z"), scale="utc")
    except (KeyError, ValueError):
        return None
    return round(float(b.mjd - a.mjd), 1)


async def check_sbident(state: AppState, marks: list[Mark]) -> dict[str, Any]:
    client = state.get_sbident()
    sem = asyncio.Semaphore(SBIDENT_CONCURRENCY)

    async def one(m: Mark) -> list[dict[str, Any]]:
        async def query() -> list[Any]:
            async with sem:
                return await client.identify(
                    m.ra_deg,
                    m.dec_deg,
                    m.t_mid,
                    SBIDENT_HALF_WIDTH_ARCSEC * u.arcsec,
                    vmag_limit=SBIDENT_VMAG_LIMIT,
                )

        bodies = await _shared(
            state, f"sbident:{m.ra_deg:.6f}:{m.dec_deg:.6f}:{m.t_mid.mjd:.6f}", query
        )
        return [
            {
                "mark": m.index,
                "name": b.name,
                "sep_arcsec": _num(b.sep_arcsec, 1),
                "vmag": _num(b.vmag, 1),
                "ra_rate_arcsec_h": _num(b.ra_rate_arcsec_h, 2),
                "dec_rate_arcsec_h": _num(b.dec_rate_arcsec_h, 2),
            }
            for b in bodies
        ]

    results = await asyncio.gather(*(one(m) for m in marks), return_exceptions=True)
    bodies: list[dict[str, Any]] = []
    errors: list[str] = []
    for r in results:
        if isinstance(r, BaseException):
            errors.append(type(r).__name__)
        else:
            bodies.extend(r)
    if errors and not bodies and len(errors) == len(marks):
        return unavailable(", ".join(errors))
    bodies.sort(key=lambda b: (b["sep_arcsec"] is None, b["sep_arcsec"] or 0.0))
    spans = [s for s in (_span_days(m.frame) for m in marks) if s is not None]
    return {
        "status": "match" if bodies else "no_match",
        "half_width_arcsec": SBIDENT_HALF_WIDTH_ARCSEC,
        "vmag_limit": SBIDENT_VMAG_LIMIT,
        "observer": "geocentric",
        "approximate": True,
        "epoch_span_days_max": max(spans) if spans else None,
        "matches": bodies[:MAX_MATCHES],
        "n_matches": len(bodies),
        "nearest": bodies[0] if bodies else None,
        "complete": not errors,
    }


async def _guard(coro: Any) -> dict[str, Any]:
    try:
        out: dict[str, Any] = await asyncio.wait_for(coro, timeout=CHECK_TIMEOUT_S)
        return out
    except TimeoutError:
        return unavailable("timeout")
    except ApiError as exc:
        return unavailable(exc.code)
    except Exception as exc:  # any archive failure leaves the other checks intact
        return unavailable(type(exc).__name__)


def verdict(summary: dict[str, dict[str, Any]]) -> str:
    """`match` (a known source at every mark), `partial`, `incomplete` (a check could not run)
    or `no_match`. Never a claim that the object is new."""
    statuses = [summary[c]["status"] for c in CATALOGS if c in summary]
    if "match" in statuses:
        return "match"
    if "partial" in statuses:
        return "partial"
    if "unavailable" in statuses:
        return "incomplete"
    return "no_match"


async def run_checks(
    state: AppState, manifest: dict[str, Any], marks: list[Mark]
) -> dict[str, Any]:
    """Run every check concurrently, each bounded in time; returns the `checks` document."""
    grid = grid_from_manifest(manifest)
    gaia, catwise, simbad, sbident = await asyncio.gather(
        _guard(check_gaia(state, grid, marks)),
        _guard(check_catwise(state, grid, marks)),
        _guard(check_simbad(state, marks)),
        _guard(check_sbident(state, marks)),
    )
    summary: dict[str, dict[str, Any]] = {}
    lists: dict[str, list[dict[str, Any]]] = {}
    for name, res in zip(CATALOGS, (gaia, catwise, simbad, sbident), strict=True):
        lists[name] = res.pop("matches", [])
        summary[name] = res
    motion = estimate_motion(marks)
    return {
        "version": CHECKS_VERSION,
        **lists,
        "estimated_motion_arcsec_yr": motion["total_arcsec_yr"],
        "motion": motion,
        "summary": summary,
        "verdict": verdict(summary),
    }


def complete(checks: dict[str, Any]) -> bool:
    """True when every check ran (none `unavailable`); only complete results are cached, so a
    retry or the submit picks up answers that arrived after the time limit."""
    summary = checks.get("summary") or {}
    return all(s.get("status") != "unavailable" for s in summary.values())


def checks_cache_key(sid: str, marks: list[Mark]) -> str:
    raw = json.dumps(
        [
            sid,
            CHECKS_VERSION,
            [
                [m.epoch, round(m.ra_deg, 5), round(m.dec_deg, 5), round(float(m.t_mid.mjd), 5)]
                for m in marks
            ],
        ],
        separators=(",", ":"),
    )
    return "destello:report-checks:" + hashlib.sha256(raw.encode()).hexdigest()[:24]
