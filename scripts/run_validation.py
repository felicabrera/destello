"""Run the scientific validation V-01 to V-14 (docs/11 section 2.2) on the presets and movers.

Real data only: the stored preset sequences (manifests, FITS coadds, cached cutouts) and the
Gaia DR3 / CatWISE2020 cone results (cached or fetched through the allowlisted clients).
Writes data/validation.json. Nothing is tuned to pass: every status follows from the stated
tolerance, and a measurement that cannot be made is recorded as not_measurable with a reason.

Usage (inside the backend image, DESTELLO_DATA_DIR pointing at the data directory):
    python scripts/run_validation.py [--only barnard,wise0855] [--tests V-10,V-05]
    python scripts/run_validation.py --tests V-13,V-14 [--movers <sequence_id>,...]

V-13 and V-14 read the moving-target outputs (manifests/<seq>.json with `moving_target`,
data/movers/<seq>/spectrum.json and ephemeris_check.json); without --movers every stored
moving-target sequence is used. pins.json is optional when only V-13 and V-14 are requested.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import sys
import traceback
import warnings
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning

from destello.api import longbaseline as lb
from destello.api import motion_search as msa
from destello.api import science
from destello.core.config import get_settings
from destello.models.catalog import CatalogSource
from destello.models.targets import Target, load_targets
from destello.pipeline.candidates import detect_features, significance_map
from destello.pipeline.difference import difference
from destello.pipeline.movers import BANDS as MOVER_BANDS
from destello.pipeline.movers import band_excess
from destello.pipeline.photometry import band_flux_at
from destello.pipeline.spectral_index import methane_index
from destello.sources.catwise import CatwiseClient
from destello.sources.gaia import GaiaClient
from destello.sources.twomass import TwoMassClient, TwoMassSource
from destello.worker.wise_build import wise_sequence_id

warnings.simplefilter("ignore", AstropyWarning)
warnings.simplefilter("ignore", RuntimeWarning)

MOVERS = ("barnard", "wise0855", "epsindib")
BLIND_SEARCH = ("epsindib",)
VARIABLES = {"rdra": "V-06", "rwaur": "V-07"}
DIPOLE_SIGMA = 5.0
DIPOLE_PAIR_PIX = 4.0  # grid pixels (3.1 arcsec): positive and negative lobes of one dipole
KNOWN_EXCLUSION_ARCSEC = 15.0
NULL_PM_MAX_MASYR = 5.0


class Shim:
    """Catalog provider with the AppState interface used by `science.recalibration_catalog`."""

    def __init__(self, gaia: GaiaClient, catwise: CatwiseClient) -> None:
        self.gaia, self.catwise = gaia, catwise

    def get_gaia(self) -> GaiaClient:
        return self.gaia

    def get_catwise(self) -> CatwiseClient:
        return self.catwise


class Tol:
    """One acceptance criterion: English text plus machine-readable fields for localization."""

    def __init__(
        self, text: str, code: str, value: float, unit: str, params: dict[str, Any] | None = None
    ) -> None:
        self.text, self.code, self.value, self.unit, self.params = text, code, value, unit, params


SIGMA3 = "Within 3 combined sigma per axis of the reference"
TOLERANCES: dict[str, Tol] = {
    "V-01": Tol("Median reference star offset below 1 arcsec after recalibration",
                "median_offset_below", 1.0, "arcsec"),
    "V-02": Tol(SIGMA3 + "; relative error below 20 percent", "within_sigma_and_relative_error",
                3.0, "sigma", {"relative_error_max": 0.2}),
    "V-03": Tol(SIGMA3, "within_sigma", 3.0, "sigma"),
    "V-04": Tol(SIGMA3, "within_sigma", 3.0, "sigma"),
    "V-05": Tol("Within 6.2 arcsec (one native pixel) in every epoch where detected",
                "max_separation_below", 6.2, "arcsec"),
    "V-06": Tol("Change above 3 sigma with a consistent sign across detectors, or documented as "
                "not sampled", "change_above_sigma_consistent_sign", 3.0, "sigma"),
    "V-07": Tol("Change detected above 3 sigma, or an honest statement of no change",
                "change_above_sigma_or_no_change", 3.0, "sigma"),
    "V-08": Tol("Within 10 percent per 2MASS band", "within_percent_per_band", 10.0, "percent"),
    "V-09": Tol("Within 3 sigma of the Gaia DR3 motion (near zero)", "within_sigma", 3.0, "sigma"),
    "V-10": Tol("No dipoles except at known movers or variables (5 sigma lobes within 4 grid "
                "pixels; sigma includes the measured static-source residual; a dipole with a lobe "
                "next to a pixel without valid exposures is reported as not measurable)",
                "no_unexplained_dipoles", 0.0, "count",
                {"lobe_sigma": DIPOLE_SIGMA, "lobe_separation_pix": DIPOLE_PAIR_PIX,
                 "known_exclusion_arcsec": KNOWN_EXCLUSION_ARCSEC}),
    "V-11": Tol("Recovered by the blind motion search (F-32) in two or more detectors, motion "
                "within 3 combined sigma per axis of the reference", "blind_search_within_sigma",
                3.0, "sigma", {"min_detectors": 2}),
    "V-12": Tol("Methane index of Epsilon Indi B below the field-star median by more than 3 sigma "
                "(sigma: its error and the robust star-to-star scatter in quadrature), with at "
                "least 5 field stars measured", "methane_index_below_field", 3.0, "sigma",
                {"min_stars": 5}),
    "V-13": Tol("Per campaign, CO2 band (4.23 to 4.27 um) flux above the interpolated continuum "
                "by more than 3 sigma, with at least 2 unflagged points in each window",
                "band_excess_above_sigma", 3.0, "sigma",
                {"band_um": [4.23, 4.27], "blue_um": [4.00, 4.17], "red_um": [4.33, 4.50],
                 "min_points": 2, "aperture_arcsec": 24.8, "annulus_arcsec": [240, 360]}),
    "V-14": Tol("Per campaign, at least 10 measured exposures and at least 90 percent of them "
                "within B_i = sqrt(3.1^2 + s_eph^2 + 1.0^2 + (3 sigma_c)^2) arcsec of the "
                "topocentric Horizons position", "ephemeris_within_bound_fraction", 0.9,
                "fraction", {"min_measured": 10, "pixel_term_arcsec": 3.1,
                             "wcs_term_arcsec": 1.0, "centroid_sigma_factor": 3.0}),
    "V-15": Tol("Long-baseline (WISE/NEOWISE plus SPHEREx) proper motion within 3 combined sigma "
                "per axis of the pinned reference evaluated at the fit epoch, with at least 2 "
                "measured epochs from each mission", "long_baseline_within_sigma", 3.0, "sigma",
                {"min_epochs_per_mission": 2}),
}  # fmt: skip


def test_row(
    vid: str, name: str, target: str | None, status: str, *, measured: float | None = None,
    reference: float | None = None, source: str | None = None, sigma: float | None = None,
    reason: str, reason_code: str, reason_params: dict[str, Any] | None = None,
    epochs_used: int | None = None, detector: int | None = None, unit: str | None = None,
    err: float | None = None,
) -> dict[str, Any]:  # fmt: skip
    """One test row. `tolerance` and `reason` stay English text for compatibility; the
    `*_code`, `tolerance_value`, `tolerance_unit` and `*_params` fields let the UI localize."""

    def r(v: float | None, n: int = 4) -> float | None:
        return None if v is None or not math.isfinite(v) else round(float(v), n)

    tol = TOLERANCES[vid]
    return {
        "id": vid,
        "name": name,
        "target": target,
        "status": status,
        "measured": r(measured),
        "err": r(err),
        "reference": r(reference),
        "source": source,
        "sigma": r(sigma, 3),
        "tolerance": tol.text,
        "tolerance_code": tol.code,
        "tolerance_value": tol.value,
        "tolerance_unit": tol.unit,
        "tolerance_params": tol.params,
        "reason": reason,
        "reason_code": reason_code,
        "reason_params": _clean(reason_params) if reason_params else None,
        "epochs_used": epochs_used,
        "detector": detector,
        "unit": unit,
    }


def _clean(v: Any) -> Any:
    """JSON-safe copy: non-finite floats become None, floats are rounded to 4 decimals."""
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_clean(x) for x in v]
    if isinstance(v, float | np.floating):
        return round(float(v), 4) if math.isfinite(v) else None
    if isinstance(v, np.integer):
        return int(v)
    return v


def unmeasured(res: dict[str, Any]) -> bool:
    """`measure_astrometry` returns status not_measurable (fit None) below two measured epochs."""
    return res.get("status") == "not_measurable" or res.get("fit") is None


def epochs_params(res: dict[str, Any]) -> dict[str, Any]:
    return {
        "epochs_measured": res.get("epochs_measured"),
        "epochs_total": res.get("epochs_total"),
        "detector_used": res.get("detector_used"),
        "suggested_detector": res.get("suggested_detector"),
        "saturated_fraction": [e.get("saturated_fraction") for e in res.get("epochs", [])],
        "warnings": [w["code"] for w in res.get("warnings", [])],
    }


def too_few_row(
    vid: str, name: str, tid: str, res: dict[str, Any], extra: str = ""
) -> dict[str, Any]:
    """not_measurable row for an astrometry result measured in fewer than two epochs."""
    details = " ".join(w["detail"] for w in res.get("warnings", []))
    return test_row(vid, name, tid, "not_measurable", reason=(details + extra).strip(),
                    reason_code="too_few_epochs", reason_params=epochs_params(res),
                    epochs_used=res.get("epochs_measured"),
                    detector=res.get("detector_used"))  # fmt: skip


def error_row(vid: str, name: str, tid: str, res: str, extra: str = "") -> dict[str, Any]:
    """not_measurable row for a `ScienceError` string from `run_motion` ("CODE: detail")."""
    code, _, detail = res.partition(": ")
    return test_row(vid, name, tid, "not_measurable", reason=res + extra,
                    reason_code="science_error",
                    reason_params={"error_code": code, "detail": detail})  # fmt: skip


def pm_total(pmra: float, pmdec: float, era: float, edec: float) -> tuple[float, float]:
    mu = math.hypot(pmra, pmdec)
    return mu, (math.hypot(pmra * era, pmdec * edec) / mu if mu > 0 else math.hypot(era, edec))


# ------------------------------------------------------------------ astrometry tests
def run_motion(
    tid: str, target: Target, seq: science.SequenceFiles, cat_name: str,
    catalog: list[CatalogSource], detector: int | None = None,
) -> dict[str, Any] | str:  # fmt: skip
    a = target.astrometry
    try:
        return science.measure_astrometry(
            seq, a.ra_deg, a.dec_deg, detector=detector, fit_parallax=False,
            reference="literature", catalog_name=cat_name, catalog=catalog,
        )  # fmt: skip
    except science.ScienceError as exc:
        return f"{exc.code}: {exc.detail}"


def motion_test(
    vid: str, name: str, tid: str, res: dict[str, Any] | str, extra: str = ""
) -> dict[str, Any]:
    if isinstance(res, str):
        return error_row(vid, name, tid, res, extra)
    if unmeasured(res):
        return too_few_row(vid, name, tid, res, extra)
    f, ref = res["fit"], res["reference"]
    mu, mu_err = pm_total(
        f["pmra_masyr"], f["pmdec_masyr"], f["pmra_err_masyr"], f["pmdec_err_masyr"]
    )
    ref_mu = math.hypot(ref["pmra_masyr"], ref["pmdec_masyr"]) if ref else None
    sigma = res["agreement_sigma"]
    rel = mu_err / mu if mu > 0 else math.inf
    ok = sigma is not None and sigma <= 3.0
    if vid == "V-02":
        ok = ok and rel < 0.2
    reason = (
        (
            f"pmra* {f['pmra_masyr']:.0f} +/- {f['pmra_err_masyr']:.0f}, "
            f"pmdec {f['pmdec_masyr']:.0f} +/- {f['pmdec_err_masyr']:.0f} mas/yr "
            f"on D{res['detector_used']} from {f['n_epochs']} "
            f"epochs (chi2_red {f['chi2_red']}); reference pmra* {ref['pmra_masyr']:.0f}, pmdec "
            f"{ref['pmdec_masyr']:.0f} mas/yr; relative error {rel:.1%}; parallax fixed at "
            f"{f['parallax_mas']:.1f} mas; recalibration against "
            f"{res['recalibration_catalog']} with "
            f"{[e.get('recalibration_stars') for e in res['epochs']]} stars per epoch."
        )
        if ref
        else "No reference motion available."
    )
    if ref and ref.get("unverified_literature"):
        lit = ref["unverified_literature"]
        reason += (
            f" The unverified literature value ({lit['pmra_masyr']:.0f}, {lit['pmdec_masyr']:.0f}) "
            "is not used as reference."
        )
    codes = [w["code"] for w in res["warnings"]]
    if codes:
        reason += " Warnings: " + ", ".join(codes) + "."
    params = {
        "pmra_masyr": f["pmra_masyr"], "pmra_err_masyr": f["pmra_err_masyr"],
        "pmdec_masyr": f["pmdec_masyr"], "pmdec_err_masyr": f["pmdec_err_masyr"],
        "chi2_red": f["chi2_red"], "relative_error": rel, "parallax_mas": f["parallax_mas"],
        "reference_pmra_masyr": ref["pmra_masyr"] if ref else None,
        "reference_pmdec_masyr": ref["pmdec_masyr"] if ref else None,
        "recalibration_catalog": res["recalibration_catalog"],
        "recalibration_stars": [e.get("recalibration_stars") for e in res["epochs"]],
        "warnings": codes, "cross_check": extra.strip() or None,
    }  # fmt: skip
    return test_row(
        vid, name, tid, "pass" if ok else "fail", measured=mu, err=mu_err, reference=ref_mu,
        source=ref["source"] if ref else None, sigma=sigma, reason=reason + extra,
        reason_code="motion_fit" if ref else "no_reference_motion", reason_params=params,
        epochs_used=f["n_epochs"], detector=res["detector_used"], unit="mas/yr",
    )  # fmt: skip


def v01_row(tid: str, res: dict[str, Any] | str) -> dict[str, Any]:
    name = "Astrometric recalibration residuals"
    if isinstance(res, str):
        return error_row("V-01", name, tid, res)
    recs = [e["recalibration"] for e in res["epochs"] if e.get("measured")]
    after = [
        r["residual_median_arcsec"] for r in recs if r.get("residual_median_arcsec") is not None
    ]
    before = [
        r["raw_median_offset_arcsec"] for r in recs if r.get("raw_median_offset_arcsec") is not None
    ]
    scat = [r["scatter_arcsec"] for r in recs if r.get("scatter_arcsec") is not None]
    if not after and unmeasured(res):
        return too_few_row("V-01", name, tid, res)
    if not after:
        return test_row("V-01", name, tid, "not_measurable",
                        reason="No epoch had three or more reference stars.",
                        reason_code="no_reference_stars")  # fmt: skip
    med = float(np.median(after))
    n_used = [r["n_used"] for r in recs]
    reason = (
        f"Per epoch median offset before recalibration {before} arcsec, after {after} arcsec, "
        f"robust scatter {scat} arcsec, stars used {n_used} "
        f"({res['recalibration_catalog']})."
    )
    return test_row(
        "V-01", name, tid, "pass" if med < 1.0 else "fail", measured=med,
        reference=0.0, sigma=None, reason=reason, reason_code="recalibration_residuals",
        reason_params={"before_arcsec": before, "after_arcsec": after, "scatter_arcsec": scat,
                       "stars_used": n_used, "catalog": res["recalibration_catalog"]},
        epochs_used=len(after), detector=res["detector_used"], unit="arcsec",
        source=res["recalibration_catalog"],
    )  # fmt: skip


def v05_row(tid: str, res: dict[str, Any] | str) -> dict[str, Any]:
    name = "Observed position versus propagated prediction"
    if isinstance(res, str):
        return error_row("V-05", name, tid, res)
    seps = [e["predicted_sep_arcsec"] for e in res["epochs"] if "predicted_sep_arcsec" in e]
    missing = [e["index"] for e in res["epochs"] if not e.get("measured")]
    if not seps:
        details = " ".join(w["detail"] for w in res.get("warnings", []))
        return test_row("V-05", name, tid, "not_measurable",
                        reason=f"The source was not measured in any epoch. {details}".strip(),
                        reason_code="not_detected_any_epoch", reason_params=epochs_params(res),
                        epochs_used=0, detector=res.get("detector_used"))  # fmt: skip
    worst = max(seps)
    reason = f"Per epoch separations {seps} arcsec on D{res['detector_used']}."
    if missing:
        reason += f" Not detected in epochs {missing}."
    return test_row(
        "V-05", name, tid, "pass" if worst <= science.NATIVE_PIXEL_ARCSEC else "fail",
        measured=worst, reference=0.0, reason=reason, reason_code="position_separations",
        reason_params={"separations_arcsec": seps, "missing_epochs": missing},
        epochs_used=len(seps), detector=res["detector_used"], unit="arcsec",
        source=res["reference"]["source"] if res.get("reference") else None,
    )  # fmt: skip


def null_test(
    seq: science.SequenceFiles, cat_name: str, catalog: list[CatalogSource],
    target: Target, detector: int,
) -> dict[str, Any]:  # fmt: skip
    """V-09: leave-one-out motion of slow, isolated Gaia stars (excluded from recalibration)."""
    name = "Null test on stationary field stars"
    if cat_name != "gaia_dr3":
        return test_row("V-09", name, target.id, "not_measurable",
                        reason="Gaia DR3 unavailable for this field.",
                        reason_code="gaia_unavailable")  # fmt: skip
    t_mid = science.mean_time(seq)
    pos_t = science._position_at(target.to_astrometry(), 0, 0, t_mid)
    ra_all, dec_all = science.propagate_sources(catalog, t_mid, apply_parallax=False)
    mags = np.array([s.mag if s.mag is not None else 99.0 for s in catalog])
    nx, ny = (int(v) for v in seq.grid["naxis"])
    half = 0.5 * min(nx, ny) * float(seq.grid["pixel_scale_arcsec"]) - 20.0
    cands: list[tuple[float, CatalogSource]] = []
    for i, s in enumerate(catalog):
        if s.pmra_masyr is None or s.mag is None or not (11.5 <= s.mag <= 15.5):
            continue
        if math.hypot(s.pmra_masyr, s.pmdec_masyr or 0.0) > NULL_PM_MAX_MASYR:
            continue
        d_target = science._sep_arcsec(float(ra_all[i]), float(dec_all[i]), *pos_t)
        d_center = science._sep_arcsec(float(ra_all[i]), float(dec_all[i]), *seq.grid["crval_deg"])
        if d_target < 60.0 or d_center > half:
            continue
        cosd = math.cos(math.radians(float(dec_all[i])))
        sep = np.hypot((ra_all - ra_all[i]) * cosd, dec_all - dec_all[i]) * 3600.0
        if np.any((sep > 0.05) & (sep < 20.0) & (mags < s.mag + 3.0)):
            continue
        cands.append((s.mag, s))
    cands.sort(key=lambda p: p[0])
    rows: list[str] = []
    stars: list[dict[str, Any]] = []
    sigmas: list[float] = []
    first: dict[str, Any] | None = None
    for _, s in cands[:3]:
        astro = science.request_astrometry(
            s.ra_deg, s.dec_deg, s.pmra_masyr, s.pmdec_masyr, f"J{s.ref_epoch_jyear}"
        )
        try:
            res = science.measure_astrometry(
                seq, s.ra_deg, s.dec_deg, detector=detector, fit_parallax=False,
                reference="none", catalog_name=cat_name, catalog=catalog, astro=astro,
                exclude_ids={s.source_id},
            )  # fmt: skip
        except science.ScienceError as exc:
            rows.append(f"Gaia DR3 {s.source_id}: {exc.code}")
            stars.append({"source_id": str(s.source_id), "error_code": exc.code})
            continue
        if unmeasured(res):  # this star is skipped, the test goes on with the others
            rows.append(
                f"Gaia DR3 {s.source_id}: measured in {res.get('epochs_measured')} of "
                f"{res.get('epochs_total')} epochs, not fitted"
            )
            stars.append({"source_id": str(s.source_id), "error_code": "TOO_FEW_EPOCHS",
                          **epochs_params(res)})  # fmt: skip
            continue
        f = res["fit"]
        sx = abs(f["pmra_masyr"] - (s.pmra_masyr or 0.0)) / max(f["pmra_err_masyr"], 1e-9)
        sy = abs(f["pmdec_masyr"] - (s.pmdec_masyr or 0.0)) / max(f["pmdec_err_masyr"], 1e-9)
        sig = max(sx, sy)
        sigmas.append(sig)
        rows.append(
            f"Gaia DR3 {s.source_id} (G {s.mag:.1f}): pmra* {f['pmra_masyr']:.0f} +/- "
            f"{f['pmra_err_masyr']:.0f}, pmdec {f['pmdec_masyr']:.0f} +/- "
            f"{f['pmdec_err_masyr']:.0f} "
            f"mas/yr, {sig:.2f} sigma"
        )
        stars.append({
            "source_id": str(s.source_id), "g_mag": s.mag,
            "pmra_masyr": f["pmra_masyr"], "pmra_err_masyr": f["pmra_err_masyr"],
            "pmdec_masyr": f["pmdec_masyr"], "pmdec_err_masyr": f["pmdec_err_masyr"],
            "sigma": sig,
        })  # fmt: skip
        if first is None:
            first = {"fit": f, "sigma": sig, "n": f["n_epochs"], "src": s}
    if first is None:
        return test_row("V-09", name, target.id, "not_measurable",
                        reason="No suitable star measured. " + "; ".join(rows),
                        reason_code="no_suitable_star",
                        reason_params={"stars": stars})  # fmt: skip
    f = first["fit"]
    mu, mu_err = pm_total(
        f["pmra_masyr"], f["pmdec_masyr"], f["pmra_err_masyr"], f["pmdec_err_masyr"]
    )
    ok = all(sg <= 3.0 for sg in sigmas)
    return test_row(
        "V-09", name, target.id, "pass" if ok else "fail", measured=mu, err=mu_err,
        reference=math.hypot(first["src"].pmra_masyr or 0, first["src"].pmdec_masyr or 0),
        source=f"Gaia DR3 {first['src'].source_id}"
        + (f" ({first['src'].archive} copy)" if first["src"].archive else ""), sigma=max(sigmas),
        reason=f"{len(sigmas)} stars, each left out of its own recalibration, on D{detector}: "
        + "; ".join(rows) + ". The table value is the first star; sigma is the worst of all.",
        reason_code="null_test_stars", reason_params={"n_stars": len(sigmas), "stars": stars},
        epochs_used=first["n"], detector=detector, unit="mas/yr",
    )  # fmt: skip


# ------------------------------------------------------------------ variability
def pair_changes(
    pts: list[dict[str, Any]], sys_by_det: dict[int, float] | None = None
) -> list[dict[str, Any]]:
    """Magnitude change per epoch pair and detector from per-exposure flux points.

    Per detector the band is split into 8 equal wavelength bins; in each bin shared by two epochs
    the magnitude change is -2.5 log10(F_b / F_a). The per-detector change is the weighted mean
    over bins, with its error scaled by sqrt(chi2_red) when the bins scatter more than expected,
    then combined in quadrature with `sys_by_det` (a per-detector systematic, magnitudes).
    """
    epochs = sorted({p["epoch"] for p in pts})
    pairs: list[dict[str, Any]] = []
    for i, ea in enumerate(epochs):
        for eb in epochs[i + 1 :]:
            per_det = []
            for det in range(1, 7):
                pa = [p for p in pts if p["epoch"] == ea and p["detector"] == det]
                pb = [p for p in pts if p["epoch"] == eb and p["detector"] == det]
                if len(pa) < 2 or len(pb) < 2:
                    continue
                wl = [p["wavelength_um"] for p in pa + pb]
                edges = np.linspace(min(wl), max(wl) + 1e-9, 9)
                dm, de = [], []
                for k in range(8):
                    fa = [p for p in pa if edges[k] <= p["wavelength_um"] < edges[k + 1]]
                    fb = [p for p in pb if edges[k] <= p["wavelength_um"] < edges[k + 1]]
                    if not fa or not fb:
                        continue
                    ma, sa = _bin_mean(fa)
                    mb, sb = _bin_mean(fb)
                    if ma <= 0 or mb <= 0:
                        continue
                    dm.append(-2.5 * math.log10(mb / ma))
                    de.append(1.0857 * math.hypot(sa / ma, sb / mb))
                if not dm:
                    continue
                w = 1.0 / np.square(de)
                mean = float(np.sum(w * np.array(dm)) / np.sum(w))
                stat = float(1.0 / math.sqrt(np.sum(w)))
                if len(dm) > 1:
                    chi2 = float(np.sum(w * (np.array(dm) - mean) ** 2) / (len(dm) - 1))
                    stat *= math.sqrt(max(chi2, 1.0))
                sys = (sys_by_det or {}).get(det, 0.0)
                per_det.append({"detector": det, "dmag": mean, "err": math.hypot(stat, sys),
                                "stat_err": stat, "sys_err": sys, "n_bins": len(dm)})  # fmt: skip
            if not per_det:
                continue
            w = np.array([1 / d["err"] ** 2 for d in per_det])
            dmv = np.array([d["dmag"] for d in per_det])
            mean = float(np.sum(w * dmv) / np.sum(w))
            err = float(1 / math.sqrt(np.sum(w)))
            sig_dets = [d for d in per_det if abs(d["dmag"]) > 3 * d["err"]]
            consistent = len({np.sign(d["dmag"]) for d in sig_dets}) <= 1
            pairs.append({"a": ea, "b": eb, "mean": mean, "err": err, "per_det": per_det,
                          "consistent": consistent, "n_sig": len(sig_dets)})  # fmt: skip
    return pairs


def wing_control(
    seq: science.SequenceFiles, target: Target, catalog: list[CatalogSource]
) -> dict[str, Any]:
    """Per-detector systematic of the PSF wing ring photometry, from a non-variable star.

    The same measurement on Barnard's Star (a quiet M dwarf, constant at this level) should give
    no change; per detector, the excess of the observed changes over their statistical errors,
    sqrt(max(0, mean(dmag^2 - err^2))) over all epoch pairs, is the systematic added in
    quadrature to the variable star measurement on that detector.
    """
    a = target.astrometry
    pts, rejected = science.wing_flux_points(
        seq, target.to_astrometry(), a.ra_deg, a.dec_deg, catalog
    )
    pairs = pair_changes(pts)
    sys_by_det: dict[int, float] = {}
    for det in range(1, 7):
        vals = [(d["dmag"], d["err"]) for p in pairs for d in p["per_det"] if d["detector"] == det]
        if vals:
            excess = float(np.mean([m * m - e * e for m, e in vals]))
            sys_by_det[det] = math.sqrt(max(excess, 0.0))
    return {
        "target": target.id,
        "name": target.names.get("en", target.id),
        "n_points": len(pts),
        "rejected": rejected,
        "systematic_mag": sys_by_det,
        "pairs": [{"epoch_a": p["a"], "epoch_b": p["b"],
                   "per_detector": [{k: d[k] for k in ("detector", "dmag", "err")}
                                    for d in p["per_det"]]} for p in pairs],
    }  # fmt: skip


def variability_test(
    vid: str, tid: str, target: Target, seq: science.SequenceFiles,
    catalog: list[CatalogSource], control: dict[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, Any] | None]:  # fmt: skip
    """Change between epochs from forced photometry on single exposures, per detector.

    Aperture photometry (`compute_spectrum`) is used when at least two epochs have unflagged
    points. When the target is saturated in every exposure, the change is measured on the PSF
    wing ring flux (`science.wing_flux_points`), with the per-detector systematic of the
    `control` star (`wing_control`) added in quadrature; without a control it is not measured.
    """
    name = "R Dra change between epochs" if tid == "rdra" else "RW Aur change between epochs"
    a = target.astrometry
    spec = science.compute_spectrum(seq, a.ra_deg, a.dec_deg, None)
    pts = [
        p for p in spec["points"] if p["flux"] is not None and not p["flagged"] and p["flux"] > 0
    ]
    epochs = sorted({p["epoch"] for p in pts})
    method = "aperture"
    sys_by_det: dict[int, float] | None = None
    wing_info: dict[str, Any] = {}
    if len(epochs) < 2:
        if control is None:
            return test_row(vid, name, tid, "not_measurable",
                            reason="Fewer than two epochs with unflagged photometry, and no "
                            "control star for the PSF wing photometry.",
                            reason_code="fewer_than_two_epochs",
                            reason_params={"epochs_with_photometry": epochs},
                            ), None  # fmt: skip
        method = "psf_wing_ring"
        n_aperture = len(spec["points"])
        pts, rejected = science.wing_flux_points(
            seq, target.to_astrometry(), a.ra_deg, a.dec_deg, catalog
        )
        sys_by_det = {int(k): float(v) for k, v in control["systematic_mag"].items()}
        wing_info = {"n_points": len(pts), "rejected": rejected, "n_aperture": n_aperture}
        epochs = sorted({p["epoch"] for p in pts})
        if len(epochs) < 2:
            return test_row(vid, name, tid, "not_measurable",
                            reason="Fewer than two epochs with unflagged aperture or PSF wing "
                            "photometry.", reason_code="fewer_than_two_epochs",
                            reason_params={"epochs_with_photometry": epochs},
                            ), None  # fmt: skip
    pairs = pair_changes(pts, sys_by_det)
    if not pairs:
        return test_row(vid, name, tid, "not_measurable",
                        reason="No detector sampled the same wavelengths in two epochs.",
                        reason_code="no_shared_wavelengths",
                        ), None  # fmt: skip
    best = max(pairs, key=lambda p: abs(p["mean"]) / p["err"])
    signif = abs(best["mean"]) / best["err"]
    det_txt = ", ".join(
        f"D{d['detector']} {d['dmag']:+.3f} +/- {d['err']:.3f}" for d in best["per_det"]
    )
    all_txt = "; ".join(
        f"epochs {p['a']} to {p['b']}: {p['mean']:+.3f} +/- {p['err']:.3f} mag" for p in pairs
    )
    detected = signif > 3.0 and best["consistent"]
    # V-07 accepts an honest no-change statement; V-06 requires a detected change.
    status = ("pass" if detected else "fail") if vid == "V-06" else "pass"
    reason = (
        f"Largest change between epochs {best['a']} and {best['b']}: per detector {det_txt} "
        f"(magnitudes, positive means fainter). Sign consistent across significant detectors: "
        f"{best['consistent']}. All pairs: {all_txt}. "
        + ("Saturated or flagged exposures excluded. " if method == "aperture" else "")
        + f"The largest of {len(pairs)} pairs is reported, so the significance is not corrected "
        "for the number of pairs."
    )
    if method == "psf_wing_ring":
        assert control is not None and sys_by_det is not None
        sys_txt = ", ".join(f"D{d} {v:.3f}" for d, v in sorted(sys_by_det.items()))
        ring = science.WING_ANNULUS_ARCSEC
        bkg = science.WING_BACKGROUND_ARCSEC
        reason = (
            f"The core is saturated in all {wing_info['n_aperture']} exposures, so the change is "
            f"measured on the flux of the PSF wings between {ring[0]:.0f} and {ring[1]:.0f} "
            f"arcsec (background {bkg[0]:.0f} to {bkg[1]:.0f} arcsec) on "
            f"{wing_info['n_points']} exposures (rejected: {wing_info['rejected']}), per "
            "detector and wavelength bin; errors include a per-detector systematic from the same "
            f"measurement on {control['name']} (non-variable control): {sys_txt} mag. "
        ) + reason
    if vid == "V-07" and not detected:
        reason = "No significant change detected. " + reason
    params: dict[str, Any] = {
        "epoch_a": best["a"], "epoch_b": best["b"], "consistent_sign": best["consistent"],
        "n_pairs": len(pairs), "method": method,
        "per_detector": [{k: d[k] for k in ("detector", "dmag", "err", "n_bins")}
                         for d in best["per_det"]],
        "pairs": [{"epoch_a": p["a"], "epoch_b": p["b"], "dmag": p["mean"], "err": p["err"]}
                  for p in pairs],
    }  # fmt: skip
    if method == "psf_wing_ring":
        assert control is not None
        params["wing"] = {
            "annulus_arcsec": list(science.WING_ANNULUS_ARCSEC),
            "background_arcsec": list(science.WING_BACKGROUND_ARCSEC),
            "n_points": wing_info["n_points"], "rejected": wing_info["rejected"],
            "n_aperture": wing_info["n_aperture"],
            "control_target": control["target"],
            "systematic_mag": {str(k): v for k, v in control["systematic_mag"].items()},
            "control_pairs": control["pairs"],
            "per_detector_stat_sys": [
                {k: d[k] for k in ("detector", "stat_err", "sys_err")} for d in best["per_det"]
            ],
        }  # fmt: skip
    row = test_row(
        vid, name, tid, status, measured=best["mean"], err=best["err"], reference=0.0,
        source=("SPHEREx PSF wing photometry (this work)" if method == "psf_wing_ring"
                else "SPHEREx forced photometry (this work)"),
        sigma=signif, reason=reason,
        reason_code="change_detected" if detected else "no_significant_change",
        reason_params=params, epochs_used=2, detector=None, unit="mag",
    )  # fmt: skip
    result = {
        "kind": "variability",
        "value": round(best["mean"], 4),
        "err": round(best["err"], 4),
        "unit": "mag",
        "reference_value": None,
        "reference_source": None,
        "agreement_sigma": None,
        "significance_sigma": round(signif, 2),
    }
    return row, result


def _bin_mean(points: list[dict[str, Any]]) -> tuple[float, float]:
    f = np.array([p["flux"] for p in points])
    e = np.array([p["flux_err"] for p in points])
    formal = float(np.sqrt(np.sum(e**2)) / len(f))
    sem = float(np.std(f, ddof=1) / math.sqrt(len(f))) if len(f) > 1 else formal
    return float(np.mean(f)), max(formal, sem)


# ------------------------------------------------------------------ dipoles
def dipole_test(
    tid: str, target: Target, seq: science.SequenceFiles, catalog: list[CatalogSource]
) -> dict[str, Any]:
    """V-10: positive and negative 5 sigma peaks closer than 4 grid pixels in difference images.

    The difference is the product's: B registered onto A on field stars, then D = A - s B'.
    Sigma per pixel is `difference_noise`: the coadd variances plus the measured subtraction
    residual of static sources (docs/03 section 4.3, docs/11 V-10), so that a dipole means a
    change beyond what a static star leaves on this pair of coadds.

    A dipole with a lobe whose 3x3 neighborhood touches a blank pixel (no valid exposure in A
    or in B', or outside the grid) is not measurable: next to a masked core the two coadds are
    built from small, different subsets of exposures (docs/11 V-10). Such dipoles are listed
    and counted separately, never dropped silently.
    """
    name = "Difference image dipoles"
    found: dict[str, dict[str, Any]] = {}
    blank_found: dict[str, dict[str, Any]] = {}
    n_known = 0
    n_images = 0
    shifts: list[float] = []
    n_applied = 0
    eps_all: list[float] = []
    astro = target.to_astrometry()
    for det in science.available_detectors(seq):
        frames = science.coadd_frames(seq, det)
        for (ea, fa), (eb, fb) in zip(frames, frames[1:], strict=False):
            ca, cb = science.load_coadd(seq, ea, fa), science.load_coadd(seq, eb, fb)
            if ca.image.shape != cb.image.shape:
                continue
            n_images += 1
            known = []
            for e in (ca, cb):
                kra, kdec = science._position_at(astro, 0, 0, e.t_mid)
                kx, ky = science._world2pix(ca.wcs, kra, kdec)
                known.append((float(kx), float(ky)))
            scale = abs(float(ca.wcs.proj_plane_pixel_scales()[0].to_value("arcsec")))
            res = difference(
                ca.image, cb.image, var_a=ca.variance, var_b=cb.variance, exclude_xy=known
            )
            reg = res.registration
            if math.isfinite(reg.dx_err):
                shifts.append(math.hypot(reg.dx, reg.dy) * scale)
            n_applied += int(reg.applied)
            # The significance map and the dipole pairing are the product's (F-29 candidates).
            sig = significance_map(res, ca.image, ca.variance, cb.variance, known)
            if math.isfinite(sig.residual_fraction):
                eps_all.append(sig.residual_fraction)
            for f in detect_features(sig, DIPOLE_SIGMA, DIPOLE_PAIR_PIX):
                if f.kind != "moved":
                    continue
                if any(math.hypot(f.x - kx, f.y - ky) * scale < KNOWN_EXCLUSION_ARCSEC
                       for kx, ky in known):  # fmt: skip
                    n_known += 1
                    continue
                ra, dec = science._pix2world(ca.wcs, f.x, f.y)
                txt = f"D{det} epochs {ca.index}-{cb.index} at ({ra:.4f}, {dec:.4f})" + _nearest(
                    catalog, ra, dec
                )
                entry = {"detector": det, "epoch_a": ca.index, "epoch_b": cb.index,
                         "ra_deg": round(float(ra), 5),
                         "dec_deg": round(float(dec), 5)}  # fmt: skip
                if f.near_blank:
                    blank_found[txt] = entry
                else:
                    found[txt] = entry
    if n_images == 0:
        return test_row("V-10", name, tid, "not_measurable", reason="No pair of epoch coadds.",
                        reason_code="no_coadd_pair")  # fmt: skip
    found_txt = sorted(found)
    reg_txt = (
        f"registration shift median {float(np.median(shifts)):.2f} arcsec "
        f"(max {max(shifts):.2f}), applied on {n_applied} of {n_images}"
        if shifts
        else f"registration not measurable (too few field stars), applied on 0 of {n_images}"
    )
    eps_txt = (
        f"static-source residual fraction {min(eps_all):.3f} to {max(eps_all):.3f} "
        f"({len(eps_all)} of {n_images} images)"
        if eps_all
        else "static-source residual not measurable (pixel noise only)"
    )
    reason = (
        f"{n_images} difference images (consecutive epochs, every detector), {DIPOLE_SIGMA:g} "
        f"sigma lobes within {DIPOLE_PAIR_PIX:g} grid pixels; {reg_txt}; {eps_txt}. "
        f"Dipoles at the preset target: {n_known}. Next to pixels without valid exposures (not "
        f"measurable): {len(blank_found)}"
        + (": " + "; ".join(sorted(blank_found)[:6]) + ("; ..." if len(blank_found) > 6 else ""))
        * bool(blank_found)
        + f". Unexplained: {len(found)}"
    )
    reason += (
        (": " + "; ".join(found_txt[:12]) + ("; ..." if len(found) > 12 else "") + ".")
        if found
        else "."
    )
    params = {
        "n_images": n_images, "n_at_target": n_known, "n_unexplained": len(found),
        "registration_measured": len(shifts), "registration_applied": n_applied,
        "shift_median_arcsec": float(np.median(shifts)) if shifts else None,
        "shift_max_arcsec": max(shifts) if shifts else None,
        "residual_fraction_measured": len(eps_all),
        "residual_fraction_min": min(eps_all) if eps_all else None,
        "residual_fraction_max": max(eps_all) if eps_all else None,
        "unexplained": [found[k] for k in found_txt],
        "n_not_measurable": len(blank_found),
        "not_measurable": [blank_found[k] for k in sorted(blank_found)],
    }  # fmt: skip
    return test_row(
        "V-10", name, tid, "pass" if not found else "fail", measured=float(len(found)),
        reference=0.0, reason=reason, reason_code="dipole_count", reason_params=params,
        epochs_used=len(seq.manifest["epochs"]), unit="count",
    )  # fmt: skip


# ------------------------------------------------------------------ blind motion search
def motion_search_test(tid: str, target: Target, seq: science.SequenceFiles) -> dict[str, Any]:
    """V-11: the F-32 search runs without the target position (it only keeps the target out of
    the registration stars) and must list the target, found in two or more detectors, with a
    motion that agrees with the reference. Same code as the product endpoint."""
    name = "Blind motion search recovers the target"
    try:
        evidence, geom, groups, astro = msa._run(seq)
    except Exception as exc:  # report, never hide
        traceback.print_exc()
        return test_row("V-11", name, tid, "not_measurable",
                        reason=f"Measurement error: {type(exc).__name__}",
                        reason_code="measurement_error",
                        reason_params={"exception": type(exc).__name__})  # fmt: skip
    if geom is None or astro is None:
        return test_row("V-11", name, tid, "not_measurable",
                        reason="No detector has a coadd in three or more full coverage epochs.",
                        reason_code="no_coadd_pair")  # fmt: skip
    t_ref = Time(geom.t_ref, format="jyear", scale="tdb")
    tra, tdec = science._position_at(astro, 0.0, 0.0, t_ref)
    listed = [g for g in groups if len(g.members) >= msa.MIN_DETECTORS]
    combined = [(g, msa.combine(g, geom.t_ref)) for g in listed]
    near = [
        (g, c)
        for g, c in combined
        if science._sep_arcsec(c["ra"], c["dec"], tra, tdec) < msa.TARGET_RADIUS_ARCSEC
    ]
    rm = target.reference_motion
    base_params: dict[str, Any] = {
        "n_listed": len(listed), "n_epochs": len(geom.epochs),
        "baseline_years": round(max(float(t.tdb.jyear) for _, t in geom.epochs)
                                - min(float(t.tdb.jyear) for _, t in geom.epochs), 3),
        "detectors_searched": [e["detector"] for e in evidence if e["usable"]],
        "mu_max_arcsec_yr": msa.MU_MAX_ARCSEC_YR,
    }  # fmt: skip
    if rm is None:
        return test_row("V-11", name, tid, "not_measurable",
                        reason="No reference motion available.",
                        reason_code="no_reference_motion")  # fmt: skip
    ref_mu = math.hypot(rm.pmra_masyr, rm.pmdec_masyr)
    if not near:
        return test_row(
            "V-11", name, tid, "fail", reference=ref_mu, source=rm.source,
            reason=f"Target not listed by the motion search ({len(listed)} sources listed).",
            reason_code="motion_search_not_found", reason_params=base_params,
            epochs_used=len(geom.epochs), unit="mas/yr",
        )  # fmt: skip
    g, c = max(near, key=lambda gc: gc[0].head.snr)
    sa = math.hypot(c["pmra_err"], rm.pmra_err_masyr or 0.0)
    sd = math.hypot(c["pmdec_err"], rm.pmdec_err_masyr or 0.0)
    sigma = max(abs(c["pmra"] - rm.pmra_masyr) / sa, abs(c["pmdec"] - rm.pmdec_masyr) / sd)
    mu, mu_err = pm_total(c["pmra"], c["pmdec"], c["pmra_err"], c["pmdec_err"])
    dets = sorted(m.detector for m in g.members)
    sep = science._sep_arcsec(c["ra"], c["dec"], tra, tdec)
    reason = (
        f"Listed without the target position in {len(dets)} detectors "
        f"({', '.join(f'D{d}' for d in dets)}) from {len(geom.epochs)} epochs: pmra* "
        f"{c['pmra']:.0f} +/- {c['pmra_err']:.0f}, pmdec {c['pmdec']:.0f} +/- {c['pmdec_err']:.0f} "
        f"mas/yr, {sep:.1f} arcsec from the propagated target; reference pmra* "
        f"{rm.pmra_masyr:.0f}, pmdec {rm.pmdec_masyr:.0f} mas/yr; sources listed in the field: "
        f"{len(listed)}."
    )
    plx_params: dict[str, Any] = {}
    astro_plx = float(astro.parallax.to_value(u.mas)) or None
    if "plx" in c:
        plx_params = {
            "parallax_mas": round(c["plx"], 1),
            "parallax_err_mas": round(c["plx_err"], 1),
            "reference_parallax_mas": round(astro_plx, 2) if astro_plx else None,
        }
        if astro_plx:
            reason += (
                f" Parallax fitted with the motion (not part of the criterion): "
                f"{c['plx']:.0f} +/- {c['plx_err']:.0f} mas, reference {astro_plx:.1f} mas."
            )
    params = {**plx_params,
        **base_params, "detectors": dets, "sep_arcsec": round(sep, 2),
        "pmra_masyr": c["pmra"], "pmra_err_masyr": c["pmra_err"],
        "pmdec_masyr": c["pmdec"], "pmdec_err_masyr": c["pmdec_err"],
        "reference_pmra_masyr": rm.pmra_masyr, "reference_pmdec_masyr": rm.pmdec_masyr,
    }  # fmt: skip
    return test_row(
        "V-11", name, tid, "pass" if sigma <= 3.0 else "fail", measured=mu, err=mu_err,
        reference=ref_mu, source=rm.source, sigma=sigma, reason=reason,
        reason_code="motion_search_recovery", reason_params=params,
        epochs_used=len(geom.epochs), unit="mas/yr",
    )  # fmt: skip


def _nearest(catalog: list[CatalogSource], ra: float, dec: float) -> str:
    best: tuple[float, CatalogSource] | None = None
    for s in catalog:
        d = science._sep_arcsec(s.ra_deg, s.dec_deg, ra, dec)
        if d < 10.0 and (best is None or d < best[0]):
            best = (d, s)
    if best is None:
        return ", no catalog source within 10 arcsec"
    return (
        f", near {best[1].catalog} {best[1].source_id} (mag {best[1].mag}) at {best[0]:.1f} arcsec"
    )


# ------------------------------------------------------------------ main
# V-08: flux scale of the spectrum tool against 2MASS on unsaturated field stars.
# 2MASS isophotal wavelength (um), zero-magnitude flux density (Jy, Cohen et al. 2003, AJ 126,
# 1090) and the wavelength window of the SPHEREx points fitted for the band (um).
TWOMASS_BANDS: dict[str, tuple[float, float, float, float]] = {
    "J": (1.235, 1594.0, 1.11, 1.36),
    "H": (1.662, 1024.0, 1.50, 1.80),
    "Ks": (2.159, 666.7, 2.00, 2.32),
}
FLUX_STAR_MAX_K = 12.5  # faint limit: enough signal in single exposures
FLUX_STAR_ISOLATION_ARCSEC = 45.0  # no 2MASS neighbor brighter than K + 4 inside this radius
FLUX_STAR_BRIGHT_K = 6.0  # and no star brighter than this ...
FLUX_STAR_BRIGHT_ARCSEC = 150.0  # ... inside this radius (PSF wings of bright stars)
FLUX_STAR_TARGET_ARCSEC = 30.0  # the preset target itself is excluded
FLUX_STAR_GAIA_ARCSEC = 2.0  # Gaia DR3 counterpart at the 2MASS epoch
FLUX_MIN_POINTS = 5  # unflagged single-exposure points inside a band window
FLUX_MIN_STARS = 2  # stars per band for the median


def _sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    s = math.sin(math.radians(dec1)) * math.sin(math.radians(dec2)) + math.cos(
        math.radians(dec1)
    ) * math.cos(math.radians(dec2)) * math.cos(math.radians(ra1 - ra2))
    return math.degrees(math.acos(max(-1.0, min(1.0, s)))) * 3600.0


def _at_epoch(src: CatalogSource, jyear: float) -> tuple[float, float]:
    """Linear proper motion propagation (enough for a 2 arcsec match over 16 years)."""
    dt = jyear - src.ref_epoch_jyear
    cosd = max(math.cos(math.radians(src.dec_deg)), 1e-6)
    return (
        src.ra_deg + (src.pmra_masyr or 0.0) * dt / 3.6e6 / cosd,
        src.dec_deg + (src.pmdec_masyr or 0.0) * dt / 3.6e6,
    )


def select_flux_stars(
    stars: list[TwoMassSource], gaia: list[CatalogSource], target: Target
) -> list[tuple[TwoMassSource, CatalogSource]]:
    """Isolated, unsaturated 2MASS stars with best quality and a Gaia DR3 counterpart.

    2MASS ph_qual AAA, rd_flg 222 (profile-fit photometry in all bands, no saturation), cc_flg
    000 (no artifact), gal_contam 0, mp_flg 0, Ks <= FLUX_STAR_MAX_K; no other 2MASS source
    brighter than K + 4 within FLUX_STAR_ISOLATION_ARCSEC and no star brighter than
    FLUX_STAR_BRIGHT_K within FLUX_STAR_BRIGHT_ARCSEC; not the preset target (propagated to the
    2MASS epoch); a Gaia DR3 source within FLUX_STAR_GAIA_ARCSEC at the 2MASS epoch, whose
    astrometry then places the aperture at each exposure time.
    """
    a = target.astrometry
    tgt = CatalogSource(catalog="gaia_dr3", source_id=target.id, ra_deg=a.ra_deg,
                        dec_deg=a.dec_deg, pmra_masyr=a.pmra_masyr, pmdec_masyr=a.pmdec_masyr,
                        parallax_mas=None, ref_epoch_jyear=float(target.ref_epoch().jyear),
                        mag=None)  # fmt: skip
    out: list[tuple[TwoMassSource, CatalogSource]] = []
    for s in stars:
        if s.k_m is None or s.k_m > FLUX_STAR_MAX_K:
            continue
        if (s.ph_qual, s.rd_flg, s.cc_flg, s.gal_contam, s.mp_flg) != ("AAA", "222", "000", 0, 0):
            continue
        jyear = (s.jdate - 2451545.0) / 365.25 + 2000.0
        if _sep_arcsec(*_at_epoch(tgt, jyear), s.ra_deg, s.dec_deg) < FLUX_STAR_TARGET_ARCSEC:
            continue
        crowded = False
        for o in stars:
            if o is s or o.k_m is None:
                continue
            d = _sep_arcsec(o.ra_deg, o.dec_deg, s.ra_deg, s.dec_deg)
            if (d < FLUX_STAR_ISOLATION_ARCSEC and o.k_m < s.k_m + 4.0) or (
                d < FLUX_STAR_BRIGHT_ARCSEC and o.k_m < FLUX_STAR_BRIGHT_K
            ):
                crowded = True
                break
        if crowded:
            continue
        best: tuple[float, CatalogSource] | None = None
        for g in gaia:
            d = _sep_arcsec(*_at_epoch(g, jyear), s.ra_deg, s.dec_deg)
            if d < FLUX_STAR_GAIA_ARCSEC and (best is None or d < best[0]):
                best = (d, g)
        if best is not None:
            out.append((s, best[1]))
    return out


_SPECTRA: dict[tuple[int, str], dict[str, Any] | None] = {}


def star_spectrum(seq: science.SequenceFiles, gaia: CatalogSource) -> dict[str, Any] | None:
    """Spectrum tool output for a field star (Gaia astrometry), computed once per run."""
    key = (id(seq), str(gaia.source_id))
    if key not in _SPECTRA:
        try:
            _SPECTRA[key] = science.compute_spectrum(
                seq, gaia.ra_deg, gaia.dec_deg, gaia.astrometry()
            )
        except science.ScienceError:
            _SPECTRA[key] = None
    return _SPECTRA[key]


def star_band_ratios(
    seq: science.SequenceFiles, star: TwoMassSource, gaia: CatalogSource
) -> dict[str, dict[str, Any]]:
    """Per 2MASS band: SPHEREx flux density at the isophotal wavelength over the 2MASS one.

    The SPHEREx points are the output of the spectrum tool (`compute_spectrum`, 12 arcsec
    aperture, no aperture correction, position propagated with the Gaia astrometry), unflagged
    and inside the band window, fitted with `band_flux_at`.
    """
    spec = star_spectrum(seq, gaia)
    if spec is None:
        return {}
    pts = [p for p in spec["points"] if p["flux"] is not None and not p["flagged"]]
    mags = {"J": (star.j_m, star.j_err), "H": (star.h_m, star.h_err), "Ks": (star.k_m, star.k_err)}
    out: dict[str, dict[str, Any]] = {}
    for band, (wl0, zp, lo, hi) in TWOMASS_BANDS.items():
        m, me = mags[band]
        sel = [p for p in pts if lo <= p["wavelength_um"] <= hi]
        if m is None or len(sel) < FLUX_MIN_POINTS:
            continue
        bf = band_flux_at(
            np.array([p["wavelength_um"] for p in sel]), np.array([p["flux"] for p in sel]), wl0
        )
        if bf is None:
            continue
        f2 = zp * 10.0 ** (-0.4 * m)
        e2 = f2 * 0.4 * math.log(10.0) * (me or 0.0)
        ratio = bf.flux_jy / f2
        out[band] = {
            "spherex_jy": bf.flux_jy, "spherex_err_jy": bf.flux_err_jy,
            "twomass_jy": f2, "twomass_err_jy": e2, "ratio": ratio,
            "ratio_err": ratio * math.hypot(bf.flux_err_jy / bf.flux_jy, e2 / f2),
            "n_points": bf.n_used, "detectors": sorted({int(p["detector"]) for p in sel}),
        }  # fmt: skip
    return out


METHANE_TARGETS = ("epsindib",)  # T dwarf with clean 3 um coverage; WISE 0855 lacks the blue window
METHANE_MIN_STARS = 5
INDEX_STAR_G = (9.0, 14.5)  # Gaia G range: unsaturated, and enough 3 um signal per exposure
INDEX_STAR_ISOLATION_ARCSEC = 30.0  # no Gaia neighbour brighter than G + 3 inside this radius
INDEX_STAR_BRIGHT_G = 7.0  # and no star brighter than this ...
INDEX_STAR_BRIGHT_ARCSEC = 120.0  # ... inside this radius
INDEX_STAR_MAX = 40  # brightest qualifying stars per preset field


def select_index_stars(gaia: list[CatalogSource], target: Target) -> list[CatalogSource]:
    """Isolated, unsaturated Gaia DR3 stars of a preset field for the V-12 reference sample.

    Positions compared at the Gaia epoch; the preset target (propagated) is excluded.
    """
    a = target.astrometry
    tgt = CatalogSource(catalog="gaia_dr3", source_id=target.id, ra_deg=a.ra_deg,
                        dec_deg=a.dec_deg, pmra_masyr=a.pmra_masyr, pmdec_masyr=a.pmdec_masyr,
                        parallax_mas=None, ref_epoch_jyear=float(target.ref_epoch().jyear),
                        mag=None)  # fmt: skip
    out: list[CatalogSource] = []
    for g in gaia:
        if g.mag is None or not INDEX_STAR_G[0] <= g.mag <= INDEX_STAR_G[1]:
            continue
        if _sep_arcsec(*_at_epoch(tgt, g.ref_epoch_jyear), g.ra_deg, g.dec_deg) < 30.0:
            continue
        crowded = False
        for o in gaia:
            if o is g or o.mag is None:
                continue
            d = _sep_arcsec(o.ra_deg, o.dec_deg, g.ra_deg, g.dec_deg)
            if (d < INDEX_STAR_ISOLATION_ARCSEC and o.mag < g.mag + 3.0) or (
                d < INDEX_STAR_BRIGHT_ARCSEC and o.mag < INDEX_STAR_BRIGHT_G
            ):
                crowded = True
                break
        if not crowded:
            out.append(g)
    out.sort(key=lambda g: g.mag or 99.0)
    return out[:INDEX_STAR_MAX]


def methane_test(
    tid: str, target: Target, seq: science.SequenceFiles,
    seqs: dict[str, science.SequenceFiles], catalogs: dict[str, tuple[str, list[CatalogSource]]],
    targets: dict[str, Target],
) -> dict[str, Any]:  # fmt: skip
    """V-12: methane 3.3 um index of a T dwarf against unsaturated field stars of all presets.

    Field stars (isolated, unsaturated Gaia DR3 stars, `select_index_stars`) have featureless
    3 um photospheres, so their index scatters around a common value; the spread is the
    empirical systematic of the method. The
    criterion was fixed before any result: at least METHANE_MIN_STARS stars measured and the
    target index below the field median by more than 3 sigma, sigma being the target error and
    the robust scatter (1.4826 MAD) in quadrature.
    """
    name = "Methane absorption of Epsilon Indi B (3.3 um index versus field stars)"
    tol = TOLERANCES["V-12"].value
    field: list[dict[str, Any]] = []
    for fid, fseq in seqs.items():
        if catalogs[fid][0] != "gaia_dr3":
            continue
        for g in select_index_stars(catalogs[fid][1], targets[fid]):
            spec = star_spectrum(fseq, g)
            if spec is None:
                continue
            mi = methane_index(spec["points"])
            if mi["index"] is not None:
                field.append({"preset": fid, "gaia_source_id": str(g.source_id), "g_mag": g.mag,
                              "index": mi["index"], "index_err": mi["index_err"]})  # fmt: skip
    try:
        tspec = science.compute_spectrum(seq, target.astrometry.ra_deg, target.astrometry.dec_deg,
                                         target.to_astrometry())  # fmt: skip
        tmi = methane_index(tspec["points"])
    except science.ScienceError as exc:
        return error_row("V-12", name, tid, str(exc))
    params: dict[str, Any] = {"target": tmi, "stars": field, "n_stars": len(field),
                              "min_stars": METHANE_MIN_STARS}  # fmt: skip
    if len(field) < METHANE_MIN_STARS or tmi["index"] is None:
        why = (
            f"{len(field)} field stars measured (at least {METHANE_MIN_STARS} needed)"
            if len(field) < METHANE_MIN_STARS
            else "the target has no epoch with all three windows measured"
        )
        return test_row("V-12", name, tid, "not_measurable", reason=f"Not measurable: {why}.",
                        reason_code="methane_not_measurable", reason_params=params,
                        unit="index")  # fmt: skip
    idx = np.array([f["index"] for f in field])
    med = float(np.median(idx))
    scatter = 1.4826 * float(np.median(np.abs(idx - med)))
    sig = math.hypot(float(tmi["index_err"]), scatter)
    depth = (med - float(tmi["index"])) / sig if sig > 0 else float("nan")
    params.update({"field_median": med, "field_scatter": scatter})
    status = "pass" if math.isfinite(depth) and depth > tol else "fail"
    reason = (
        f"Index = band (3.20-3.45 um) over a log-log continuum from 2.90-3.10 and 3.85-4.10 um, "
        f"single exposures, per survey pass. Epsilon Indi B {tmi['index']:.3f} +/- "
        f"{tmi['index_err']:.3f}; {len(field)} field stars: median {med:.3f}, robust scatter "
        f"{scatter:.3f}. Depth below the field: {depth:.1f} sigma. Epsilon Indi Ba and Bb are "
        "unresolved, so this is the combined T1 + T6 light."
    )
    return test_row("V-12", name, tid, status, measured=float(tmi["index"]),
                    err=float(tmi["index_err"]), reference=med, source="field_stars_gaia",
                    sigma=depth, reason=reason, reason_code="methane_index_vs_field",
                    reason_params=params, unit="index")  # fmt: skip


def flux_crosscheck(
    seqs: dict[str, science.SequenceFiles], catalogs: dict[str, tuple[str, list[CatalogSource]]],
    twomass: dict[str, list[TwoMassSource]], targets: dict[str, Target],
) -> dict[str, Any]:  # fmt: skip
    """V-08: median SPHEREx/2MASS flux ratio per band over the field stars of every preset.

    Pass when every band has at least FLUX_MIN_STARS stars and its median ratio is within the
    tolerance of 1. The error of a median is 1.2533 times the standard error of the mean.
    """
    tol = TOLERANCES["V-08"].value
    stars: list[dict[str, Any]] = []
    per_preset: dict[str, int] = {}
    for tid, seq in seqs.items():
        if catalogs[tid][0] != "gaia_dr3" or tid not in twomass:
            per_preset[tid] = 0
            continue
        n = 0
        for s, g in select_flux_stars(twomass[tid], catalogs[tid][1], targets[tid]):
            bands = star_band_ratios(seq, s, g)
            if bands:
                n += 1
                stars.append({"preset": tid, "designation": s.designation, "k_m": s.k_m,
                              "gaia_source_id": g.source_id, "bands": bands})  # fmt: skip
        per_preset[tid] = n
    bands_out: list[dict[str, Any]] = []
    for band in TWOMASS_BANDS:
        r = np.array([st["bands"][band]["ratio"] for st in stars if band in st["bands"]])
        if r.size == 0:
            bands_out.append({"band": band, "n_stars": 0, "median_ratio": None, "err": None})
            continue
        med = float(np.median(r))
        err = 1.2533 * float(np.std(r, ddof=1)) / math.sqrt(r.size) if r.size > 1 else None
        bands_out.append({"band": band, "n_stars": int(r.size), "median_ratio": med, "err": err})
    measurable = all(b["n_stars"] >= FLUX_MIN_STARS for b in bands_out)
    worst = max(
        (b for b in bands_out if b["median_ratio"] is not None),
        key=lambda b: abs(b["median_ratio"] - 1.0),
        default=None,
    )
    ok = measurable and all(abs(b["median_ratio"] - 1.0) * 100.0 <= tol for b in bands_out)
    status = "not_measurable" if not measurable else ("pass" if ok else "fail")
    band_txt = "; ".join(
        f"{b['band']} {b['median_ratio']:.3f} +/- {b['err'] or 0:.3f} ({b['n_stars']} stars)"
        if b["median_ratio"] is not None else f"{b['band']} no star"
        for b in bands_out
    )  # fmt: skip
    preset_txt = ", ".join(f"{k} {v}" for k, v in per_preset.items())
    reason = (
        "Spectrum tool output (single-exposure aperture photometry, 12 arcsec radius, no "
        "aperture correction) for isolated, unsaturated field stars of the preset fields with "
        "2MASS ph_qual AAA, rd_flg 222, cc_flg 000 and a Gaia DR3 counterpart, fitted per band "
        "with a power law and evaluated at the 2MASS isophotal wavelength. Median ratio "
        f"SPHEREx / 2MASS: {band_txt}. Stars per preset: {preset_txt}. "
    )
    if per_preset.get("rdra") == 0:
        reason += (
            "R Draconis is saturated in every exposure and its field holds no qualifying star, so "
            "the check uses the field stars of all presets. "
        )
    reason += (
        "The IRSA Spectrophotometry Tool offers no programmatic access, so 2MASS is the "
        "independent reference."
    )
    params = {
        "bands": bands_out,
        "per_preset": per_preset,
        "aperture_arcsec": science.DEFAULT_APERTURE_ARCSEC,
        "stars": [{"preset": st["preset"], "designation": st["designation"], "k_m": st["k_m"],
                   "ratios": {b: v["ratio"] for b, v in st["bands"].items()}}
                  for st in stars],
    }  # fmt: skip
    row = test_row(
        "V-08", "Spectrum flux scale versus 2MASS (field stars)", "field_stars", status,
        measured=None if worst is None else (worst["median_ratio"] - 1.0) * 100.0,
        err=None if worst is None or worst["err"] is None else worst["err"] * 100.0,
        reference=0.0, source="twomass_psc", reason=reason,
        reason_code="flux_crosscheck_2mass" if measurable else "too_few_flux_stars",
        reason_params=params, unit="percent",
    )  # fmt: skip
    return {"row": row, "stars": stars}


# ------------------------------------------------------------------ long baseline (F-40)
V15_TARGETS = ("wise0855", "barnard")
V15_BAND = "W2"


def v15_test(
    data_dir: Path, tid: str, target: Target, seq: science.SequenceFiles, cat_name: str,
    catalog: list[CatalogSource], spx: dict[str, Any] | str,
) -> tuple[dict[str, Any], dict[str, Any]]:  # fmt: skip
    """V-15 (docs/11): one fit over WISE/NEOWISE companion epochs and SPHEREx epochs."""
    label = {"wise0855": "WISE 0855-0714", "barnard": "Barnard's Star"}.get(tid, tid)
    vid, name = "V-15", f"{label} long-baseline proper motion (WISE/NEOWISE + SPHEREx)"
    settings = get_settings()
    wsid = wise_sequence_id(seq.sid, V15_BAND, settings)
    if cat_name != "gaia_dr3":
        return test_row(vid, name, tid, "not_measurable", reason=(
            f"Recalibration catalog is {cat_name}, not Gaia DR3: not measurable by rule."),
            reason_code="recalibration_catalog_not_gaia"), {"wise_sequence_id": wsid}  # fmt: skip
    try:
        man, side = lb.load_companion(data_dir, wsid)
    except FileNotFoundError:
        return test_row(vid, name, tid, "not_measurable",
                        reason=f"No WISE {V15_BAND} companion sequence {wsid} built.",
                        reason_code="no_wise_companion"), {"wise_sequence_id": wsid}  # fmt: skip
    astro = target.to_astrometry()
    a = target.astrometry
    excl = {target.astrometry.source.split()[-1]} if target.astrometry.source else set()
    wrows = lb.measure_wise_epochs(data_dir, man, side, astro, catalog, cat_name, excl)
    srows = lb.spherex_rows(spx) if isinstance(spx, dict) else []
    ref_pm = (a.pmra_masyr, a.pmdec_masyr, a.pmra_err_masyr or 0.0, a.pmdec_err_masyr or 0.0)
    out = lb.long_baseline_fit(wrows + srows, astro, ref_pm)
    out.update(wise_sequence_id=wsid, spherex_sequence_id=seq.sid, band=V15_BAND,
               reference_source=a.source, reference_epoch=a.ref_epoch,
               frame_list_source=man["provenance"]["frame_list_source"])  # fmt: skip
    if isinstance(spx, dict) and not unmeasured(spx):
        sf = spx["fit"]
        out["spherex_only"] = {
            k: sf[k]
            for k in (
                "pmra_masyr",
                "pmdec_masyr",
                "pmra_err_masyr",
                "pmdec_err_masyr",
                "n_epochs",
                "chi2_red",
            )
        }
    per = out["epochs_per_mission"]
    if out["status"] == "not_measurable":
        return test_row(vid, name, tid, "not_measurable", reason=(
            f"Measured epochs per mission {per}: at least 2 per mission are required."),
            reason_code="too_few_epochs_per_mission", reason_params=per), out  # fmt: skip
    f, ref = out["fit"], out["reference"]
    improve = ""
    if "spherex_only" in out:
        so = out["spherex_only"]
        out["error_ratio_spherex_only"] = [
            so["pmra_err_masyr"] / f["pmra_err_masyr"],
            so["pmdec_err_masyr"] / f["pmdec_err_masyr"],
        ]
        improve = (f" SPHEREx-only errors {so['pmra_err_masyr']:.1f}, {so['pmdec_err_masyr']:.1f}"
                   f" mas/yr (ratio {out['error_ratio_spherex_only'][0]:.1f}, "
                   f"{out['error_ratio_spherex_only'][1]:.1f}).")  # fmt: skip
    mu, mu_err = pm_total(f["pmra_masyr"], f["pmdec_masyr"], f["pmra_err_masyr"],
                          f["pmdec_err_masyr"])  # fmt: skip
    reason = (
        f"pmra* {f['pmra_masyr']:.1f} +/- {f['pmra_err_masyr']:.1f}, pmdec {f['pmdec_masyr']:.1f}"
        f" +/- {f['pmdec_err_masyr']:.1f} mas/yr at J{f['ref_epoch_jyear']:.2f} from "
        f"{f['n_epochs']} epochs {per} (chi2_red {f['chi2_red']}); reference {a.source} at the fit "
        f"epoch pmra* {ref['pmra_masyr']:.1f}, pmdec {ref['pmdec_masyr']:.1f} mas/yr; per axis "
        f"{out['sigma_per_axis'][0]:.2f}, {out['sigma_per_axis'][1]:.2f} sigma; parallax "
        f"{'fitted' if out['parallax_fitted'] else 'fixed'} {f['parallax_mas']:.1f} mas." + improve
    )
    if tid == "wise0855":
        reason += " The CatWISE2020 reference uses WISE/NEOWISE data: not an independent check."
    return test_row(
        vid, name, tid, out["status"], measured=mu, err=mu_err,
        reference=math.hypot(ref["pmra_masyr"], ref["pmdec_masyr"]), source=a.source,
        sigma=out["agreement_sigma"], reason=reason, reason_code="long_baseline_fit",
        reason_params={**f, "epochs_per_mission": per}, epochs_used=f["n_epochs"], unit="mas/yr",
    ), out  # fmt: skip


MOVER_TARGET = "3I/ATLAS"


def mover_sequences(data_dir: Path, wanted: set[str] | None) -> list[tuple[str, dict[str, Any]]]:
    """Stored moving-target sequences: (sequence id, manifest), oldest campaign first."""
    root = data_dir / "movers"
    out = []
    for d in sorted(root.iterdir()) if root.is_dir() else []:
        if wanted and d.name not in wanted:
            continue
        man = data_dir / "manifests" / f"{d.name}.json"
        if not (d / "spectrum.json").is_file() or not man.is_file():
            continue
        m = json.loads(man.read_text("utf-8"))
        if m.get("moving_target"):
            out.append((d.name, m))
    return out


def _campaign_label(m: dict[str, Any], idx: str) -> str:
    for c in m["moving_target"].get("campaigns") or []:
        if str(c["index"]) == idx:
            return f"{c['t_start'][:10]} to {c['t_end'][:10]}"
    return f"campaign {idx}"


def mover_rows(data_dir: Path, seq: str, m: dict[str, Any]) -> list[dict[str, Any]]:
    """V-13 and V-14 rows per campaign of one moving-target sequence (docs/11)."""
    mt = m["moving_target"]
    target = mt.get("name") or mt.get("designation") or MOVER_TARGET
    spec = json.loads((data_dir / "movers" / seq / "spectrum.json").read_text("utf-8"))
    chk = json.loads((data_dir / "movers" / seq / "ephemeris_check.json").read_text("utf-8"))
    rows: list[dict[str, Any]] = []
    # Recompute the band measurement from the stored points with the current estimator, so a
    # spectrum.json written by an older build does not carry a stale rule (docs/11, V-13).
    recomputed: dict[str, dict[str, Any]] = {}
    for idx in spec.get("bands", {}):
        pts = [p for p in spec.get("points", []) if str(p.get("campaign")) == str(idx)]
        recomputed[str(idx)] = {b: band_excess(pts, b) for b in MOVER_BANDS}
    for idx, bands in sorted(recomputed.items()):
        label = _campaign_label(m, idx)
        co2, h2o = bands.get("co2") or {}, bands.get("h2o") or {}
        info = {"sequence_id": seq, "campaign": int(idx), "label": label,
                "co2": co2, "h2o": h2o, "solution": spec.get("solution")}  # fmt: skip
        name = f"CO2 band of {target} ({label})"
        if h2o.get("excess") is not None:
            h2o_txt = (
                f" H2O band (reported, no criterion): excess {h2o['excess']:.3f} +/- "
                f"{h2o['excess_err']:.3f}, {h2o['significance']:.1f} sigma."
            )
        elif h2o.get("significance") is not None:
            h2o_txt = (
                f" H2O band (reported, no criterion): band {h2o['band_flux_jy']:.4g} Jy, "
                f"continuum not detected ({h2o['continuum_flux_jy']:.4g} +/- "
                f"{h2o['continuum_flux_err_jy']:.2g} Jy), {h2o['significance']:.1f} sigma."
            )
        else:
            h2o_txt = (f" H2O band not measurable ({h2o.get('reason')}, points "
                       f"{h2o.get('n_points')}).")  # fmt: skip
        if co2.get("significance") is None:
            reason_text = str(co2.get("reason") or "")
            below = reason_text.startswith("window_below_snr")
            wins = co2.get("windows") or {}
            per_window = ", ".join(
                f"{k} {(wins.get(k) or {}).get('n_points')} points"
                + (
                    f" at S/N {(wins.get(k) or {}).get('snr'):.1f}"
                    if (wins.get(k) or {}).get("snr") is not None else ""
                )
                for k in ("blue", "band", "red")
            )  # fmt: skip
            if below:
                sentence = (
                    "Not measurable: every window has the 2 points required, but at least one "
                    f"window mean is below 3 sigma ({per_window}). No detection is claimed."
                )
            else:
                sentence = (
                    "Not measurable: at least one window has fewer than the 2 points required "
                    f"({per_window}). No detection is claimed."
                )
            rows.append(test_row(
                "V-13", name, seq, "not_measurable",
                reason=sentence + h2o_txt,
                reason_code="window_below_snr" if below else "window_not_measurable",
                reason_params=info, unit="sigma",
            ))  # fmt: skip
            continue
        sig = float(co2["significance"])
        if co2.get("excess") is None:
            pw = co2["windows"]
            rows.append(test_row(
                "V-13", name, seq, "pass" if sig > TOLERANCES["V-13"].value else "fail",
                measured=float(co2["band_flux_jy"] - co2["continuum_flux_jy"]),
                err=math.hypot(co2["band_flux_err_jy"], co2["continuum_flux_err_jy"]), sigma=sig,
                reference=None,
                source="Lisse et al. 2025, arXiv:2512.07318 (August 2025)" if label.startswith(
                    "2025-08") else None,
                reason=f"Band {co2['band_flux_jy']:.4g} +/- {co2['band_flux_err_jy']:.2g} Jy "
                f"against continuum {co2['continuum_flux_jy']:.4g} +/- "
                f"{co2['continuum_flux_err_jy']:.2g} Jy (not detected: blue S/N "
                f"{pw['blue']['snr']:.1f}, red S/N {pw['red']['snr']:.1f}; interpolated linearly "
                f"in flux): band minus continuum {sig:.1f} sigma; "
                f"{co2['significance_vs_upper_limit']:.1f} sigma above the continuum 3 sigma "
                f"upper limit "
                f"{co2['continuum_upper_limit_jy']:.4g} Jy. No ratio is reported (undetected "
                f"continuum); points per window {co2['n_points']}." + h2o_txt,
                reason_code="band_excess_continuum_undetected", reason_params=info, unit="Jy",
            ))  # fmt: skip
            continue
        rows.append(test_row(
            "V-13", name, seq, "pass" if sig > TOLERANCES["V-13"].value else "fail",
            measured=float(co2["excess"]), err=float(co2["excess_err"]), sigma=sig,
            reference=None,
            source="Lisse et al. 2025, arXiv:2512.07318 (August 2025)" if label.startswith(
                "2025-08") else None,
            reason=f"Band {co2['band_flux_jy']:.4g} Jy against continuum "
            f"{co2['continuum_flux_jy']:.4g} Jy: excess {co2['excess']:.3f} +/- "
            f"{co2['excess_err']:.3f} (F_band / F_cont - 1), {sig:.1f} sigma; points per window "
            f"{co2['n_points']}." + h2o_txt,
            reason_code="band_excess", reason_params=info, unit="fraction",
        ))  # fmt: skip
    for idx, s in sorted(chk.get("campaigns", {}).items()):
        label = _campaign_label(m, idx)
        info = {"sequence_id": seq, "campaign": int(idx), "label": label, **s}
        frac = s.get("fraction_within")
        txt = (
            f"{s['n_within']} of {s['n_measured']} measured exposures within B_i "
            f"({s['n_exposures']} exposures); median offset {s['median_offset_arcsec']} arcsec, "
            f"max {s['max_offset_arcsec']} arcsec."
        )
        geo = [e.get("offset_from_geocentric_arcsec") for e in chk.get("exposures", [])
               if str(e.get("campaign")) == idx and e.get("measured")]  # fmt: skip
        geo = [g for g in geo if g is not None]
        if geo:
            txt += f" Median offset from the uncorrected geocentric position {np.median(geo):.2f}"
            txt += " arcsec (information)."
        rows.append(test_row(
            "V-14", f"Coma centroid follows the ephemeris ({label})", seq, s["status"],
            measured=frac, reference=TOLERANCES["V-14"].value,
            source="JPL Horizons " + str(chk.get("solution")), reason=txt,
            reason_code="ephemeris_check", reason_params=info,
            epochs_used=s.get("n_measured"), unit="fraction",
        ))  # fmt: skip
    return rows


async def main(
    only: set[str] | None, only_tests: set[str] | None = None, movers: set[str] | None = None
) -> int:
    settings = get_settings()

    def want(*vids: str) -> bool:
        return only_tests is None or any(v in only_tests for v in vids)

    data_dir = Path(settings.data_dir)
    pins_path = data_dir / "pins.json"
    preset_tests = only_tests is None or bool(only_tests - {"V-13", "V-14"})
    if preset_tests or pins_path.is_file():
        pins = json.loads(pins_path.read_text("utf-8"))
        presets: dict[str, Any] = pins["presets"] if preset_tests else {}
    else:
        presets = {}
    targets = load_targets()
    tests: list[dict[str, Any]] = []
    residuals: list[dict[str, Any]] = []
    results: dict[str, Any] = {}
    by_target: dict[str, list[str]] = {}
    dois: set[str] = set()
    motion: dict[str, dict[str, Any] | str] = {}
    twomass: dict[str, list[TwoMassSource]] = {}
    async with (
        GaiaClient(settings) as gaia,
        CatwiseClient(settings) as catwise,
        TwoMassClient(settings) as tmc,
    ):
        shim = Shim(gaia, catwise)
        catalogs: dict[str, tuple[str, list[CatalogSource]]] = {}
        seqs: dict[str, science.SequenceFiles] = {}
        for tid in presets:
            if only and tid not in only:
                continue
            seqs[tid] = science.load_sequence(data_dir, presets[tid]["sequence_id"])
            catalogs[tid] = await science.recalibration_catalog(shim, seqs[tid].grid, 120.0)
            prov = seqs[tid].manifest.get("provenance") or {}
            by_target[tid] = sorted(prov.get("collections") or [])
            dois.update(prov.get("dois") or [])
            print(tid, "catalog", catalogs[tid][0], len(catalogs[tid][1]), flush=True)
            if want("V-08"):
                ra0, dec0 = (float(v) for v in seqs[tid].grid["crval_deg"])
                twomass[tid] = await tmc.cone(
                    ra0, dec0, science.cone_radius(seqs[tid].grid), max_k=FLUX_STAR_MAX_K + 4.0
                )
    # The release actually used is the set of IRSA collections the preset manifests drew on.
    collections = sorted({c for cs in by_target.values() for c in cs})
    release = ", ".join(collections) or None
    releases = {"collections": collections, "dois": sorted(dois), "by_target": by_target}

    for tid in MOVERS:
        if tid not in seqs or not want("V-01", "V-02", "V-03", "V-04", "V-05", "V-09", "V-15"):
            continue
        cat_name, cat = catalogs[tid]
        print("astrometry", tid, flush=True)
        res = run_motion(tid, targets[tid], seqs[tid], cat_name, cat)
        motion[tid] = res
        tests.append(v01_row(tid, res))
        tests.append(v05_row(tid, res))
        if isinstance(res, dict) and not unmeasured(res):
            residuals.append({
                "target": tid,
                "epochs": [
                    {k: r[k] for k in ("index", "t_mid_mjd", "dra_arcsec", "ddec_arcsec")}
                    for r in res["fit"]["residuals"]
                ],
            })  # fmt: skip
    if "barnard" in motion:
        tests.append(
            motion_test("V-02", "Barnard's Star proper motion", "barnard", motion["barnard"])
        )
    if "wise0855" in motion:
        extra = ""
        other = {5: 6, 6: 5}
        res = motion["wise0855"]
        if isinstance(res, dict) and res["detector_used"] in other:
            alt = run_motion("wise0855", targets["wise0855"], seqs["wise0855"],
                             *catalogs["wise0855"],
                             detector=other[res["detector_used"]])  # fmt: skip
            if isinstance(alt, dict) and unmeasured(alt):
                extra = (
                    f" Cross-check on D{alt['detector_used']}: measured in "
                    f"{alt.get('epochs_measured')} of {alt.get('epochs_total')} epochs, not fitted."
                )
            elif isinstance(alt, dict):
                f = alt["fit"]
                extra = (
                    f" Cross-check on D{alt['detector_used']}: pmra* {f['pmra_masyr']:.0f} +/- "
                    f"{f['pmra_err_masyr']:.0f}, pmdec {f['pmdec_masyr']:.0f} +/- "
                    f"{f['pmdec_err_masyr']:.0f} mas/yr, {alt['agreement_sigma']} sigma."
                )
            else:
                extra = f" Cross-check on D{other[res['detector_used']]}: {alt}."
        tests.append(
            motion_test("V-03", "WISE 0855-0714 proper motion (D5/D6)", "wise0855", res, extra)
        )
    if "epsindib" in motion:
        tests.append(
            motion_test("V-04", "Epsilon Indi B proper motion", "epsindib", motion["epsindib"])
        )

    for tid in V15_TARGETS if want("V-15") else ():
        if tid not in seqs or tid not in motion:
            continue
        print("long baseline", tid, flush=True)
        row, detail = v15_test(data_dir, tid, targets[tid], seqs[tid], *catalogs[tid], motion[tid])
        tests.append(row)
        results.setdefault("long_baseline", {})[tid] = _clean(detail)

    for tid in ("rwaur", "rdra"):
        if tid not in seqs or not want("V-05"):
            continue
        print("position", tid, flush=True)
        res = run_motion(tid, targets[tid], seqs[tid], *catalogs[tid])
        tests.append(v05_row(tid, res))
    control: dict[str, Any] | None = None
    if "barnard" in seqs and any(t in seqs and want(v) for t, v in VARIABLES.items()):
        print("wing photometry control", flush=True)
        control = wing_control(seqs["barnard"], targets["barnard"], catalogs["barnard"][1])
    for tid, vid in VARIABLES.items():
        if tid not in seqs or not want(vid):
            continue
        print("variability", tid, flush=True)
        try:
            row, result = variability_test(
                vid, tid, targets[tid], seqs[tid], catalogs[tid][1], control
            )
        except Exception as exc:  # report, never hide
            traceback.print_exc()
            row, result = test_row(vid, "Variability", tid, "not_measurable",
                                   reason=f"Measurement error: {type(exc).__name__}",
                                   reason_code="measurement_error",
                                   reason_params={"exception": type(exc).__name__},
                                   ), None  # fmt: skip
        tests.append(row)
        if result:
            results[tid] = result
    if want("V-08"):
        print("flux cross-check", flush=True)
        tests.append(flux_crosscheck(seqs, catalogs, twomass, targets)["row"])
    for tid in METHANE_TARGETS if want("V-12") else ():
        if tid in seqs:
            print("methane index", tid, flush=True)
            tests.append(methane_test(tid, targets[tid], seqs[tid], seqs, catalogs, targets))
    if "barnard" in seqs and isinstance(motion.get("barnard"), dict):
        print("null test", flush=True)
        b = motion["barnard"]
        assert isinstance(b, dict)
        tests.append(null_test(seqs["barnard"], *catalogs["barnard"], targets["barnard"],
                               int(b["detector_used"])))  # fmt: skip
    for tid in seqs if want("V-10") else ():
        print("dipoles", tid, flush=True)
        tests.append(dipole_test(tid, targets[tid], seqs[tid], catalogs[tid][1]))

    # V-11 runs where the search can work: three or more full coverage epochs and a target that
    # is not saturated in every detector (Barnard's Star is masked; WISE 0855 has two epochs).
    for tid in BLIND_SEARCH if want("V-11") else ():
        if tid in seqs:
            print("motion search", tid, flush=True)
            tests.append(motion_search_test(tid, targets[tid], seqs[tid]))

    for seq, man in mover_sequences(data_dir, movers) if want("V-13", "V-14") else ():
        print("moving target", seq, flush=True)
        tests.extend(mover_rows(data_dir, seq, man))
        prov = man.get("provenance") or {}
        by_target[seq] = sorted(prov.get("collections") or [])
        dois.update(prov.get("dois") or [])
        releases = {"collections": sorted({c for cs in by_target.values() for c in cs}),
                    "dois": sorted(dois), "by_target": by_target}  # fmt: skip
        release = ", ".join(releases["collections"]) or None

    for tid in MOVERS:
        res = motion.get(tid)
        if not isinstance(res, dict) or unmeasured(res) or not res.get("reference"):
            continue
        f, ref = res["fit"], res["reference"]
        mu, mu_err = pm_total(
            f["pmra_masyr"], f["pmdec_masyr"], f["pmra_err_masyr"], f["pmdec_err_masyr"]
        )
        results[tid] = {
            "kind": "motion",
            "value": round(mu, 1),
            "err": round(mu_err, 1),
            "unit": "mas/yr",
            "reference_value": round(math.hypot(ref["pmra_masyr"], ref["pmdec_masyr"]), 1),
            "reference_source": ref["source"],
            "agreement_sigma": res["agreement_sigma"],
            "significance_sigma": None,
        }
    if only_tests is not None:
        tests = [t for t in tests if t["id"] in only_tests]
    tests.sort(key=lambda t: (t["id"], t["target"] or ""))
    doc = {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "pipeline_version": settings.pipeline_version,
        "release": release,
        "releases": releases,
        "tests": tests,
        "residuals": residuals,
        "results": results,
    }
    partial = bool(only) or only_tests is not None or bool(movers)
    out = data_dir / ("validation.partial.json" if partial else "validation.json")
    out.write_text(json.dumps(doc, indent=2), "utf-8")
    for t in tests:
        print(f"{t['id']} {t['target']}: {t['status']} measured={t['measured']} sigma={t['sigma']}")
    print("wrote", out)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", default="", help="comma separated preset ids (writes a partial file)")
    ap.add_argument(
        "--tests", default="", help="comma separated test ids, e.g. V-10 (writes a partial file)"
    )
    ap.add_argument(
        "--movers", default="", help="comma separated moving-target sequence ids (V-13, V-14)"
    )
    ns = ap.parse_args()
    presets_sel = {s for s in ns.only.split(",") if s} or None
    tests_sel = {s for s in ns.tests.split(",") if s} or None
    movers_sel = {s for s in ns.movers.split(",") if s} or None
    sys.exit(asyncio.run(main(presets_sel, tests_sel, movers_sel)))
