"""Candidate list of a pair of epochs (F-29): significant differences seen in the detector
coadds, compared with Gaia DR3 and CatWISE2020 at the epoch of each coadd.

Thin adapter over `pipeline/candidates` (pure) and the catalog clients. A listed entry is a
place where the two epochs differ; it is never called a discovery. Nothing here fetches a URL
supplied by a user: catalog cones come from the manifest grid.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import replace
from typing import Any

import numpy as np
from astropy.time import Time
from scipy.ndimage import maximum_filter

from destello.api import science
from destello.api.deps import AppState
from destello.api.derived import (
    fetch_catalog,
    grid_from_manifest,
    propagate_to_epoch,
    read_manifest,
)
from destello.api.errors import ApiError
from destello.models.catalog import CatalogSource
from destello.pipeline import candidates as cd
from destello.pipeline.difference import difference

CATALOGS = ("gaia_dr3", "catwise2020")
# A catalog source this close to a lobe (propagated to the epoch of that lobe) explains it: one
# SPHEREx native pixel.
MATCH_RADIUS_ARCSEC = science.NATIVE_PIXEL_ARCSEC
# Around the preset target, as in V-10 (docs/11).
TARGET_RADIUS_ARCSEC = 15.0
# An unpaired lobe this close to the target is the target's own PSF wing changing (a variable
# star, or a mover whose other lobe is inside the masked core): about five native pixels.
TARGET_WING_RADIUS_ARCSEC = 30.0
# An unpaired lobe within this many grid pixels of missing data (1.5 PSF FWHM) is not
# measurable: next to a masked saturated core the two coadds sample different exposures.
UNPAIRED_BLANK_MARGIN_PIX = 3
# An unpaired lobe is listed only when at least this many detectors show it at the same place:
# a source that does not move within an epoch is seen by every detector that covers it.
MIN_DETECTORS_UNPAIRED = 2
MAX_LISTED = 100


def _compact(f: cd.Feature) -> bool:
    """An unpaired lobe counts only when it stands 5 sigma above the difference around it: the
    halo and the spikes of a bright star that changed between the epochs are not sources."""
    return f.kind == "moved" or f.snr_local >= cd.DETECTION_SIGMA


Status = str  # "target" | "not_measurable" | "known_source" | "unmatched" | "unchecked"


def _pix(v: float) -> float:
    return round(float(v), 2)


def _detector_features(
    seq: science.SequenceFiles, a: int, b: int, astro: Any
) -> tuple[dict[int, list[cd.Feature]], list[dict[str, Any]], dict[str, Any]]:
    """Features per detector, the per-detector evidence and the geometry of the pair."""
    feats: dict[int, list[cd.Feature]] = {}
    evidence: list[dict[str, Any]] = []
    geom: dict[str, Any] = {}
    for det in science.available_detectors(seq):
        frames = {int(e["index"]): (e, f) for e, f in science.coadd_frames(seq, det)}
        if a not in frames or b not in frames:
            continue
        ca = science.load_coadd(seq, *frames[a])
        cb = science.load_coadd(seq, *frames[b])
        if ca.image.shape != cb.image.shape:
            continue
        ny, nx = ca.image.shape
        known: list[tuple[float, float]] = []
        if astro is not None:
            for e in (ca, cb):
                kra, kdec = science._position_at(astro, 0.0, 0.0, e.t_mid)
                kx, ky = science._world2pix(ca.wcs, kra, kdec)
                known.append((float(kx), float(ky)))
        exclude = known or [((nx - 1) / 2.0, (ny - 1) / 2.0)]
        res = difference(
            ca.image, cb.image, var_a=ca.variance, var_b=cb.variance, exclude_xy=exclude
        )
        sig = cd.significance_map(res, ca.image, ca.variance, cb.variance, exclude)
        detected = cd.detect_features(sig)
        # sig.blank already reaches one pixel; widen it to the margin for unpaired lobes.
        size = 2 * (UNPAIRED_BLANK_MARGIN_PIX - 1) + 1
        wide = maximum_filter(sig.blank.astype(np.uint8), size=size, mode="constant", cval=1) > 0
        found = [
            replace(f, near_blank=True)
            if f.kind != "moved" and not f.near_blank and wide[int(f.y), int(f.x)]
            else f
            for f in detected
            if _compact(f)
        ]
        feats[det] = found
        eps = sig.residual_fraction
        evidence.append(
            {
                "detector": det,
                "usable": sig.usable,
                "n_features": len(found),
                "n_extended": len(detected) - len(found),
                "residual_fraction": round(float(eps), 4) if math.isfinite(eps) else None,
                "registration_applied": bool(res.registration.applied),
                "n_stars_used": int(res.n_stars),
            }
        )
        if not geom:
            geom = {
                "wcs": ca.wcs,
                "ny": ny,
                "scale": abs(float(ca.wcs.proj_plane_pixel_scales()[0].to_value("arcsec"))),
                "known": known,
                "t_a": ca.t_mid,
                "t_b": cb.t_mid,
            }
    return feats, evidence, geom


def _catalog_pixels(
    geom: dict[str, Any], sources: list[CatalogSource], catalog: str
) -> dict[str, np.ndarray]:
    """Grid pixel positions of the catalog at the mid time of A and of B."""
    out: dict[str, np.ndarray] = {}
    for key in ("t_a", "t_b"):
        t: Time = geom[key]
        ra, dec = propagate_to_epoch(sources, t, apply_parallax=(catalog == "gaia_dr3"))
        x, y = geom["wcs"].all_world2pix(ra, dec, 0)
        out[key] = np.column_stack([np.asarray(x, float), np.asarray(y, float)])
    return out


def _nearest(
    geom: dict[str, Any],
    f: cd.Feature,
    cats: dict[str, tuple[list[CatalogSource], dict[str, np.ndarray]]],
) -> dict[str, Any] | None:
    """Closest catalog source to either lobe at the epoch of that lobe, within the radius."""
    best: tuple[float, CatalogSource] | None = None
    for sources, pix in cats.values():
        if not sources:
            continue
        for (x, y), key in (((f.x_a, f.y_a), "t_a"), ((f.x_b, f.y_b), "t_b")):
            d = np.hypot(pix[key][:, 0] - x, pix[key][:, 1] - y) * geom["scale"]
            i = int(np.nanargmin(d)) if np.isfinite(d).any() else -1
            if i >= 0 and d[i] <= MATCH_RADIUS_ARCSEC and (best is None or d[i] < best[0]):
                best = (float(d[i]), sources[i])
    if best is None:
        return None
    sep, s = best
    pm = (
        math.hypot(s.pmra_masyr, s.pmdec_masyr)
        if s.pmra_masyr is not None and s.pmdec_masyr is not None
        else None
    )
    return {
        "catalog": s.catalog,
        "source_id": s.source_id,
        "sep_arcsec": round(sep, 2),
        "mag": s.mag,
        "mag_band": s.mag_band,
        "pm_total_masyr": round(pm, 1) if pm is not None else None,
    }


def _point(geom: dict[str, Any], x: float, y: float) -> dict[str, float]:
    """Sky position and frame pixel EDGE coordinates (y down, north up) of a grid pixel."""
    ra, dec = science._pix2world(geom["wcs"], x, y)
    return {
        "ra_deg": round(float(ra), 6),
        "dec_deg": round(float(dec), 6),
        "x": _pix(x + 0.5),
        "y": _pix(geom["ny"] - y - 0.5),
    }


def classify(
    geom: dict[str, Any],
    merged: list[cd.Candidate],
    cats: dict[str, tuple[list[CatalogSource], dict[str, np.ndarray]]],
    catalogs_ok: bool,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Listed candidates with their status, and the counts by status and of dropped features."""
    listed: list[dict[str, Any]] = []
    counts: dict[str, int] = {"single_detector": 0}
    scale = geom["scale"]
    for c in merged:
        f = c.feature
        radius = TARGET_RADIUS_ARCSEC if f.kind == "moved" else TARGET_WING_RADIUS_ARCSEC
        at_target = any(
            math.hypot(x - kx, y - ky) * scale < radius
            for kx, ky in geom["known"]
            for x, y in ((f.x_a, f.y_a), (f.x_b, f.y_b))
        )
        if f.kind != "moved" and len(c.detectors) < MIN_DETECTORS_UNPAIRED and not at_target:
            counts["single_detector"] += 1
            continue
        match = _nearest(geom, f, cats)
        status: Status
        if at_target:
            status = "target"
        elif f.near_blank:
            status = "not_measurable"
        elif match is not None:
            status = "known_source"
        else:
            status = "unmatched" if catalogs_ok else "unchecked"
        counts[status] = counts.get(status, 0) + 1
        entry: dict[str, Any] = {
            "kind": f.kind,
            "status": status,
            "snr": round(f.snr, 1),
            "snr_local": round(f.snr_local, 1) if math.isfinite(f.snr_local) else None,
            "detectors": list(c.detectors),
            "snr_by_detector": list(c.snr_by_detector),
            **_point(geom, f.x, f.y),
            "a": None,
            "b": None,
            "separation_arcsec": None,
            "match": match,
        }
        if f.kind == "moved":
            entry["a"] = _point(geom, f.x_a, f.y_a)
            entry["b"] = _point(geom, f.x_b, f.y_b)
            entry["separation_arcsec"] = round(math.hypot(f.x_a - f.x_b, f.y_a - f.y_b) * scale, 1)
        listed.append(entry)
    order = {"unmatched": 0, "unchecked": 1, "target": 2, "known_source": 3, "not_measurable": 4}
    listed.sort(key=lambda e: (order[e["status"]], -len(e["detectors"]), -e["snr"]))
    for i, e in enumerate(listed):
        e["id"] = f"c{i + 1}"
    return listed, counts


def _detect(seq: science.SequenceFiles, a: int, b: int) -> tuple[Any, ...]:
    target = science.preset_target(seq)
    astro = target.to_astrometry() if target is not None else None
    feats, evidence, geom = _detector_features(seq, a, b, astro)
    return feats, evidence, geom, cd.merge_detectors(feats)


async def build_candidates(
    state: AppState, sid: str, a: int, b: int
) -> tuple[dict[str, Any], bool]:
    """The candidates document and whether every catalog answered (only then it is cached)."""
    try:
        seq = science.load_sequence(state.settings.data_dir, sid)
    except science.ScienceError:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.") from None
    # `seq` holds the measurable epochs only: a low coverage epoch is not searched.
    low = science.low_coverage_epochs(read_manifest(state, sid))
    if a in low or b in low:
        raise ApiError(
            422,
            "LOW_COVERAGE_EPOCH",
            "Low coverage epoch",
            "Candidates are not searched in a low coverage epoch.",
        )
    indices = {int(e["index"]) for e in seq.manifest["epochs"]}
    if len(indices) < 2:
        raise ApiError(422, "TOO_FEW_EPOCHS", "Too few epochs", "At least two epochs are needed.")
    if a not in indices or b not in indices or a == b:
        raise ApiError(
            422, "INVALID_EPOCHS", "Invalid epochs", "a and b must be distinct epoch indices."
        )
    feats, evidence, geom, merged = await asyncio.to_thread(
        science.run_measurement, _detect, seq, a, b
    )
    if not geom:
        raise ApiError(422, "NO_FITS", "No FITS coadd", "No detector has a coadd in both epochs.")
    grid = grid_from_manifest(seq.manifest)
    cats: dict[str, tuple[list[CatalogSource], dict[str, np.ndarray]]] = {}
    availability: dict[str, str] = {}
    for name in CATALOGS:
        try:
            sources = await fetch_catalog(state, name, grid)
        except ApiError:
            availability[name] = "unavailable"
            continue
        availability[name] = "ok"
        cats[name] = (sources, _catalog_pixels(geom, sources, name) if sources else {})
    complete = all(v == "ok" for v in availability.values())
    listed, counts = classify(geom, merged, cats, complete)
    doc = {
        "sequence_id": sid,
        "epoch_a": a,
        "epoch_b": b,
        "threshold_sigma": cd.DETECTION_SIGMA,
        "pair_max_arcsec": round(cd.PAIR_MAX_PIX * geom["scale"], 1),
        "match_radius_arcsec": MATCH_RADIUS_ARCSEC,
        "min_detectors_unpaired": MIN_DETECTORS_UNPAIRED,
        "target_radius_arcsec": TARGET_RADIUS_ARCSEC,
        "target_wing_radius_arcsec": TARGET_WING_RADIUS_ARCSEC,
        "method_version": cd.CANDIDATES_METHOD_VERSION,
        "detectors": evidence,
        "catalogs": availability,
        "counts": {
            "listed": len(listed),
            "single_detector_dropped": counts.pop("single_detector"),
            "extended_dropped": sum(int(e["n_extended"]) for e in evidence),
            **{
                k: counts.get(k, 0)
                for k in ("unmatched", "unchecked", "target", "known_source", "not_measurable")
            },
        },
        "truncated": len(listed) > MAX_LISTED,
        "candidates": listed[:MAX_LISTED],
    }
    return doc, complete
