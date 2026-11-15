"""Motion search of a sequence (F-32): shift-and-stack over a grid of proper motions on the
detector coadds of the measurable epochs, motion measured from per-epoch centroids, compared with
Gaia DR3 and CatWISE2020 propagated to the same time.

Thin adapter over `pipeline/motion_search` (pure) and the catalog clients. A listed entry is a
source that moves consistently across every epoch; it is never called a discovery. Nothing here
fetches a URL supplied by a user: catalog cones come from the manifest grid.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass
from typing import Any

import astropy.units as u
import numpy as np
from astropy.time import Time

from destello.api import science
from destello.api.deps import AppState
from destello.api.derived import fetch_catalog, grid_from_manifest, propagate_to_epoch
from destello.api.errors import ApiError
from destello.models.catalog import CatalogSource
from destello.pipeline import motion_search as ms
from destello.pipeline.astrometry import MotionFit, fit_motion, well_spread_epochs
from destello.pipeline.propagate import parallax_factors

CATALOGS = ("gaia_dr3", "catwise2020")
# Fastest trial motion. Barnard's Star, the fastest known star, moves 10.4 arcsec/yr; a faster
# trial grid only adds chances for noise to line up.
MU_MAX_ARCSEC_YR = 12.0
# Floor added in quadrature to every centroid uncertainty: residual registration and PSF
# differences between epochs (a twentieth of a native pixel).
CENTROID_FLOOR_ARCSEC = 0.3
# The fitted motion must differ from zero by this many standard errors.
MIN_MOTION_SIGMA = 3.0
# A source is listed when this many detectors measure it at the same place with the same motion.
MIN_DETECTORS = 2
# Parallax is fitted with the motion when every detector has this many epochs over at least a
# year (SPHEREx revisits a field about every six months, near the extremes of the parallax
# ellipse); a distance is quoted only for a parallax this many standard errors from zero.
MIN_PARALLAX_SIGMA = 3.0
MERGE_RADIUS_ARCSEC = science.NATIVE_PIXEL_ARCSEC
MERGE_PM_FLOOR_ARCSEC_YR = 1.0
MATCH_RADIUS_ARCSEC = science.NATIVE_PIXEL_ARCSEC
TARGET_RADIUS_ARCSEC = 15.0
MAX_LISTED = 50

Status = str  # "target" | "known_source" | "unmatched" | "unchecked"


@dataclass(frozen=True)
class DetectorFit:
    detector: int
    snr: float
    epoch_snr: tuple[float, ...]
    fit: MotionFit

    def position_at(self, t_years: float) -> tuple[float, float]:
        dt = t_years - float(self.fit.ref_epoch.tdb.jyear)
        cosd = math.cos(math.radians(self.fit.dec0_deg))
        ra = self.fit.ra0_deg + self.fit.pmra_cosdec_masyr * dt / 3.6e6 / cosd
        dec = self.fit.dec0_deg + self.fit.pmdec_masyr * dt / 3.6e6
        return ra % 360.0, dec


@dataclass
class Geometry:
    wcs: Any
    ny: int
    scale: float
    epochs: list[tuple[int, Time]]  # measurable epoch index and mid time
    t_ref: float  # Julian years (TDB): mean of the measurable epochs


def _motion_sigma(fit: MotionFit) -> float:
    ea, ed = fit.pmra_err_masyr, fit.pmdec_err_masyr
    if not (ea > 0 and ed > 0):
        return 0.0
    return float(math.hypot(fit.pmra_cosdec_masyr / ea, fit.pmdec_masyr / ed))


def fits_parallax(times: Time) -> bool:
    return well_spread_epochs(times)


def _fit_peak(
    tp: ms.TrackedPeak, coadds: list[science.EpochCoadd], scale: float
) -> MotionFit | None:
    if not tp.complete:
        return None
    ras: list[float] = []
    decs: list[float] = []
    ex: list[float] = []
    ey: list[float] = []
    for c, co in zip(tp.centroids, coadds, strict=True):
        assert c is not None
        ra, dec = science._pix2world(co.wcs, c.x, c.y)
        ras.append(ra)
        decs.append(dec)
        ex.append(math.hypot(c.x_err * scale, CENTROID_FLOOR_ARCSEC))
        ey.append(math.hypot(c.y_err * scale, CENTROID_FLOOR_ARCSEC))
    times = Time([co.t_mid for co in coadds])
    return fit_motion(
        times,
        np.array(ras) * u.deg,
        np.array(decs) * u.deg,
        np.array(ex),
        np.array(ey),
        fit_parallax=fits_parallax(times),
    )


def _search(
    seq: science.SequenceFiles, astro: Any
) -> tuple[list[DetectorFit], list[dict[str, Any]], Geometry | None]:
    """Per-detector searches and the motion fits that pass the per-detector tests."""
    fits_: list[DetectorFit] = []
    evidence: list[dict[str, Any]] = []
    geom: Geometry | None = None
    epochs = [
        (int(e["index"]), Time(float(e["t_mid_mjd"]), format="mjd", scale="utc"))
        for e in seq.manifest["epochs"]
    ]
    for det in science.available_detectors(seq):
        coadds = [science.load_coadd(seq, e, f) for e, f in science.coadd_frames(seq, det)]
        shapes = {c.image.shape for c in coadds}
        if len(shapes) != 1:
            continue
        scale = abs(float(coadds[0].wcs.proj_plane_pixel_scales()[0].to_value("arcsec")))
        known: list[tuple[float, float]] = []
        if astro is not None:
            for co in coadds:
                kra, kdec = science._position_at(astro, 0.0, 0.0, co.t_mid)
                kx, ky = science._world2pix(co.wcs, kra, kdec)
                known.append((float(kx), float(ky)))
        images = [
            ms.EpochImage(co.index, float(co.t_mid.tdb.jyear), co.image, co.variance)
            for co in coadds
        ]
        result = ms.search_detector(images, MU_MAX_ARCSEC_YR / scale, exclude_xy=known)
        n_fitted = 0
        n_moving = 0
        for tp in result.peaks:
            fit = _fit_peak(tp, coadds, scale)
            if fit is None:
                continue
            n_fitted += 1
            total = math.hypot(fit.pmra_cosdec_masyr, fit.pmdec_masyr) / 1000.0
            if _motion_sigma(fit) < MIN_MOTION_SIGMA or total > 1.5 * MU_MAX_ARCSEC_YR:
                continue
            n_moving += 1
            fits_.append(DetectorFit(det, tp.peak.snr, tp.peak.epoch_snr, fit))
        rf = result.residual_fraction
        evidence.append(
            {
                "detector": det,
                "usable": result.usable,
                "n_epochs": result.n_epochs,
                "n_trials": result.n_trials,
                "step_arcsec_yr": round(result.step_pix_per_year * scale, 2)
                if math.isfinite(result.step_pix_per_year)
                else None,
                "n_peaks": len(result.peaks),
                "n_fitted": n_fitted,
                "n_moving": n_moving,
                "residual_fraction": round(rf, 4) if math.isfinite(rf) else None,
            }
        )
        if geom is None and result.usable:
            ny = coadds[0].image.shape[0]
            t_ref = float(np.mean([t.tdb.jyear for _, t in epochs]))
            geom = Geometry(coadds[0].wcs, ny, scale, epochs, t_ref)
    return fits_, evidence, geom


@dataclass
class Group:
    members: list[DetectorFit]

    @property
    def head(self) -> DetectorFit:
        return self.members[0]


def _close(a: DetectorFit, b: DetectorFit, t_ref: float) -> bool:
    ra1, de1 = a.position_at(t_ref)
    ra2, de2 = b.position_at(t_ref)
    if science._sep_arcsec(ra1, de1, ra2, de2) > MERGE_RADIUS_ARCSEC:
        return False
    for va, ea, vb, eb in (
        (
            a.fit.pmra_cosdec_masyr,
            a.fit.pmra_err_masyr,
            b.fit.pmra_cosdec_masyr,
            b.fit.pmra_err_masyr,
        ),
        (a.fit.pmdec_masyr, a.fit.pmdec_err_masyr, b.fit.pmdec_masyr, b.fit.pmdec_err_masyr),
    ):
        tol = max(3.0 * math.hypot(ea, eb), MERGE_PM_FLOOR_ARCSEC_YR * 1000.0)
        if abs(va - vb) > tol:
            return False
    return True


def merge(fits_: list[DetectorFit], t_ref: float) -> list[Group]:
    """Greedy grouping, strongest first, at most one fit per detector in a group."""
    groups: list[Group] = []
    for f in sorted(fits_, key=lambda f: (-f.snr, f.detector)):
        for g in groups:
            if all(m.detector != f.detector for m in g.members) and _close(g.head, f, t_ref):
                g.members.append(f)
                break
        else:
            groups.append(Group([f]))
    return groups


def _weighted(values: list[float], errors: list[float]) -> tuple[float, float]:
    """Inverse-variance mean and its error, scaled by sqrt(chi2_red) when the members scatter more
    than their errors."""
    w = np.array([1.0 / e**2 for e in errors])
    v = np.array(values)
    mean = float(np.sum(w * v) / np.sum(w))
    err = float(1.0 / math.sqrt(float(np.sum(w))))
    if len(v) > 1:
        chi2 = float(np.sum(w * (v - mean) ** 2)) / (len(v) - 1)
        err *= math.sqrt(max(chi2, 1.0))
    return mean, err


def combine(g: Group, t_ref: float) -> dict[str, float]:
    pa, ea = _weighted(
        [m.fit.pmra_cosdec_masyr for m in g.members], [m.fit.pmra_err_masyr for m in g.members]
    )
    pd, ed = _weighted(
        [m.fit.pmdec_masyr for m in g.members], [m.fit.pmdec_err_masyr for m in g.members]
    )
    pos = [m.position_at(t_ref) for m in g.members]
    ra = float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians([p[0] for p in pos]))))))
    dec = float(np.mean([p[1] for p in pos]))
    out = {"ra": ra % 360.0, "dec": dec, "pmra": pa, "pmdec": pd, "pmra_err": ea, "pmdec_err": ed}
    plx = [m.fit for m in g.members if not m.fit.parallax_fixed and m.fit.parallax_err_mas]
    # Detectors with fewer epochs keep the parallax fixed at zero; the parallax is the combination
    # of those that fitted it, and needs as many detectors as a listed source.
    if len(plx) >= MIN_DETECTORS:
        p, ep = _weighted(
            [f.parallax_mas for f in plx], [float(f.parallax_err_mas or 0) for f in plx]
        )
        out["plx"], out["plx_err"] = p, ep
    return out


def _frame_point(geom: Geometry, ra: float, dec: float) -> dict[str, float]:
    x, y = science._world2pix(geom.wcs, ra, dec)
    return {
        "ra_deg": round(float(ra), 6),
        "dec_deg": round(float(dec), 6),
        "x": round(float(x) + 0.5, 2),
        "y": round(geom.ny - float(y) - 0.5, 2),
    }


def _catalog_match(
    ra: float,
    dec: float,
    pm: tuple[float, float, float, float],
    t: Time,
    cats: dict[str, list[CatalogSource]],
    plx: tuple[float, float] | None = None,
) -> dict[str, Any] | None:
    """Nearest Gaia DR3 or CatWISE2020 source within the match radius, propagated (without
    parallax) to time `t`, with its catalog motion and the agreement in sigma."""
    best: tuple[float, CatalogSource] | None = None
    for sources in cats.values():
        if not sources:
            continue
        cra, cdec = propagate_to_epoch(sources, t, apply_parallax=False)
        cosd = math.cos(math.radians(dec))
        d = np.hypot((cra - ra) * cosd, cdec - dec) * 3600.0
        i = int(np.nanargmin(d)) if np.isfinite(d).any() else -1
        if i >= 0 and d[i] <= MATCH_RADIUS_ARCSEC and (best is None or d[i] < best[0]):
            best = (float(d[i]), sources[i])
    if best is None:
        return None
    sep, s = best
    out: dict[str, Any] = {
        "catalog": s.catalog,
        "source_id": s.source_id,
        "sep_arcsec": round(sep, 2),
        "mag": s.mag,
        "mag_band": s.mag_band,
        "pmra_masyr": None,
        "pmdec_masyr": None,
        "pm_total_masyr": None,
        "agreement_sigma": None,
        "parallax_mas": None,
        "parallax_err_mas": None,
        "parallax_agreement_sigma": None,
    }
    if s.parallax_mas is not None:
        out["parallax_mas"] = round(s.parallax_mas, 2)
        if s.parallax_err_mas is not None:
            out["parallax_err_mas"] = round(s.parallax_err_mas, 2)
        if plx is not None:
            sp = math.hypot(plx[1], s.parallax_err_mas or 0.0)
            if sp > 0:
                out["parallax_agreement_sigma"] = round(abs(plx[0] - s.parallax_mas) / sp, 2)
    if s.pmra_masyr is not None and s.pmdec_masyr is not None:
        out["pmra_masyr"] = round(s.pmra_masyr, 1)
        out["pmdec_masyr"] = round(s.pmdec_masyr, 1)
        out["pm_total_masyr"] = round(math.hypot(s.pmra_masyr, s.pmdec_masyr), 1)
        pa, pd, ea, ed = pm
        sa = math.hypot(ea, s.pmra_err_masyr or 0.0)
        sd = math.hypot(ed, s.pmdec_err_masyr or 0.0)
        if sa > 0 and sd > 0:
            out["agreement_sigma"] = round(
                max(abs(pa - s.pmra_masyr) / sa, abs(pd - s.pmdec_masyr) / sd), 2
            )
    return out


def classify(
    geom: Geometry,
    groups: list[Group],
    cats: dict[str, list[CatalogSource]],
    catalogs_ok: bool,
    astro: Any,
) -> tuple[list[dict[str, Any]], int]:
    """Listed sources (two or more detectors) with their status, and the single-detector count."""
    listed: list[dict[str, Any]] = []
    single = 0
    t_ref = Time(geom.t_ref, format="jyear", scale="tdb")
    target_pos = science._position_at(astro, 0.0, 0.0, t_ref) if astro is not None else None
    for g in groups:
        if len(g.members) < MIN_DETECTORS:
            single += 1
            continue
        c = combine(g, geom.t_ref)
        pm = (c["pmra"], c["pmdec"], c["pmra_err"], c["pmdec_err"])
        plx = (c["plx"], c["plx_err"]) if "plx" in c else None
        match = _catalog_match(c["ra"], c["dec"], pm, t_ref, cats, plx)
        status: Status
        if (
            target_pos is not None
            and science._sep_arcsec(c["ra"], c["dec"], *target_pos) < TARGET_RADIUS_ARCSEC
        ):
            status = "target"
        elif match is not None:
            status = "known_source"
        else:
            status = "unmatched" if catalogs_ok else "unchecked"
        cosd = math.cos(math.radians(c["dec"]))
        times = Time([t for _, t in geom.epochs])
        pfa, pfd = parallax_factors(c["ra"] * u.deg, c["dec"] * u.deg, times)
        p_mas = c.get("plx", 0.0)
        track = []
        for k, (idx, t) in enumerate(geom.epochs):
            dt = float(t.tdb.jyear) - geom.t_ref
            ra = c["ra"] + (c["pmra"] * dt + p_mas * float(pfa[k])) / 3.6e6 / cosd
            dec = c["dec"] + (c["pmdec"] * dt + p_mas * float(pfd[k])) / 3.6e6
            track.append({"epoch": idx, **_frame_point(geom, ra % 360.0, dec)})
        plx_out = parallax_fields(c.get("plx"), c.get("plx_err"))
        members = sorted(g.members, key=lambda m: m.detector)
        listed.append(
            {
                "status": status,
                "snr": round(g.head.snr, 1),
                "detectors": [m.detector for m in members],
                "snr_by_detector": [round(m.snr, 1) for m in members],
                "pmra_masyr": round(c["pmra"], 1),
                "pmdec_masyr": round(c["pmdec"], 1),
                "pmra_err_masyr": round(c["pmra_err"], 1),
                "pmdec_err_masyr": round(c["pmdec_err"], 1),
                "pm_total_masyr": round(math.hypot(c["pmra"], c["pmdec"]), 1),
                **plx_out,
                "ref_epoch_jyear": round(geom.t_ref, 4),
                **_frame_point(geom, c["ra"], c["dec"]),
                "track": track,
                "match": match,
            }
        )
    order = {"unmatched": 0, "unchecked": 1, "target": 2, "known_source": 3}
    listed.sort(key=lambda e: (order[e["status"]], -len(e["detectors"]), -e["snr"]))
    for i, e in enumerate(listed):
        e["id"] = f"m{i + 1}"
    return listed, single


def parallax_fields(plx: float | None, err: float | None) -> dict[str, float | None]:
    """Parallax, its significance and, only when it is significant, the distance with its
    first-order error. A parallax that is not significant gives no distance (1/plx is then not a
    meaningful estimate)."""
    out: dict[str, float | None] = {
        "parallax_mas": None,
        "parallax_err_mas": None,
        "parallax_sigma": None,
        "distance_pc": None,
        "distance_err_pc": None,
    }
    if plx is None or err is None or not (err > 0):
        return out
    sig = plx / err
    out.update(
        parallax_mas=round(plx, 1), parallax_err_mas=round(err, 1), parallax_sigma=round(sig, 2)
    )
    if sig >= MIN_PARALLAX_SIGMA:
        out["distance_pc"] = round(1000.0 / plx, 2)
        out["distance_err_pc"] = round(1000.0 * err / plx**2, 2)
    return out


def _run(seq: science.SequenceFiles) -> tuple[Any, ...]:
    target = science.preset_target(seq)
    astro = target.to_astrometry() if target is not None else None
    fits_, evidence, geom = _search(seq, astro)
    groups = merge(fits_, geom.t_ref) if geom is not None else []
    return evidence, geom, groups, astro


async def build_motion_search(state: AppState, sid: str) -> tuple[dict[str, Any], bool]:
    """The motion search document and whether every catalog answered (only then it is cached)."""
    try:
        seq = science.load_sequence(state.settings.data_dir, sid)
    except science.ScienceError:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.") from None
    # `seq` holds the measurable epochs only: low coverage epochs are not searched.
    if len(seq.manifest["epochs"]) < ms.MIN_EPOCHS:
        raise ApiError(
            422,
            "TOO_FEW_EPOCHS",
            "Too few epochs",
            f"The motion search needs at least {ms.MIN_EPOCHS} full coverage epochs.",
        )
    evidence, geom, groups, astro = await asyncio.to_thread(science.run_measurement, _run, seq)
    if geom is None:
        raise ApiError(
            422,
            "NO_FITS",
            "No FITS coadd",
            f"No detector has a coadd in {ms.MIN_EPOCHS} or more epochs over enough time.",
        )
    grid = grid_from_manifest(seq.manifest)
    cats: dict[str, list[CatalogSource]] = {}
    availability: dict[str, str] = {}
    for name in CATALOGS:
        try:
            cats[name] = await fetch_catalog(state, name, grid)
        except ApiError:
            availability[name] = "unavailable"
            continue
        availability[name] = "ok"
    complete = all(v == "ok" for v in availability.values())
    listed, single = classify(geom, groups, cats, complete, astro)
    steps = [e["step_arcsec_yr"] for e in evidence if e["step_arcsec_yr"] is not None]
    baseline = max(float(t.tdb.jyear) for _, t in geom.epochs) - min(
        float(t.tdb.jyear) for _, t in geom.epochs
    )
    counts = {
        k: sum(1 for e in listed if e["status"] == k)
        for k in ("unmatched", "unchecked", "target", "known_source")
    }
    doc = {
        "sequence_id": sid,
        "method_version": ms.MOTION_SEARCH_METHOD_VERSION,
        "epochs": [idx for idx, _ in geom.epochs],
        "baseline_years": round(baseline, 3),
        "ref_epoch_jyear": round(geom.t_ref, 4),
        "mu_max_arcsec_yr": MU_MAX_ARCSEC_YR,
        "step_arcsec_yr": round(float(np.median(steps)), 2) if steps else None,
        "threshold_sigma": ms.DETECTION_SIGMA,
        "epoch_min_sigma": ms.EPOCH_MIN_SIGMA,
        "min_motion_sigma": MIN_MOTION_SIGMA,
        "min_detectors": MIN_DETECTORS,
        "parallax_fitted": fits_parallax(Time([t for _, t in geom.epochs])),
        "min_parallax_sigma": MIN_PARALLAX_SIGMA,
        "match_radius_arcsec": MATCH_RADIUS_ARCSEC,
        "target_radius_arcsec": TARGET_RADIUS_ARCSEC,
        "detectors": evidence,
        "catalogs": availability,
        "counts": {"listed": len(listed), "single_detector_dropped": single, **counts},
        "truncated": len(listed) > MAX_LISTED,
        "sources": listed[:MAX_LISTED],
    }
    return doc, complete
