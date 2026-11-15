"""Long-baseline astrometry: WISE/NEOWISE companion epochs plus SPHEREx epochs (F-40, docs/11 V-15).

Synchronous, CPU bound functions over stored files (companion manifest and sidecar, coadd FITS,
cached L1b cutouts). Every epoch of each mission is recalibrated on Gaia DR3 stars propagated to
its own mid time; the fit combines both missions without a per-mission offset term.

WISE epoch position, per docs/11 V-15:
- the coadd core at the prediction is finite: Gaussian centroid on the coadd (minimum S/N 5,
  catalog neighbours modelled as in `science.measure_astrometry`);
- the coadd core is masked (saturated): Moffat PSF wing centroid on each single L1b frame in its
  own WCS (60 arcsec radius, centre bounded to 8.25 arcsec), combined with `combine_offsets`
  (at least 3 frames), then mapped through the recalibration of the epoch coadd. No a priori
  wing systematic is added for WISE.
Error per axis: centroid error, recalibration excess scatter and recalibration offset error in
quadrature. Epochs with fewer than RECAL_MIN_STARS recalibration stars are excluded and listed.
"""

from __future__ import annotations

import json
import math
import warnings
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS

from destello.api import science
from destello.models.catalog import CatalogSource
from destello.pipeline.astrometry import (
    MotionFit,
    agreement_sigma,
    combine_offsets,
    fit_motion,
    measure_centroid,
    measure_wing_centroid,
    well_spread_for_parallax,
)
from destello.pipeline.propagate import Astrometry, propagate_space_motion
from destello.pipeline.wise import calibrate_frame

WISE_WING_RADIUS_ARCSEC = 60.0
WISE_WING_MAX_SHIFT_ARCSEC = 8.25  # three WISE native pixels (2.75 arcsec)
WISE_WING_MIN_FRAMES = 3
WISE_DETECTOR_LABEL = 0  # EpochCoadd.detector for WISE coadds (not a SPHEREx detector)


def load_companion(data_dir: Path, wise_sid: str) -> tuple[dict[str, Any], dict[str, Any]]:
    man = json.loads((data_dir / "manifests" / f"{wise_sid}.json").read_text("utf-8"))
    side = json.loads((data_dir / "builds" / f"{wise_sid}.json").read_text("utf-8"))
    return man, side


def wise_coadd(data_dir: Path, epoch: dict[str, Any]) -> science.EpochCoadd:
    fr = epoch["frames"][0]
    path = data_dir / "frames" / str(fr["fits_url"]).rsplit("/", 1)[-1]
    with fits.open(path) as hdul, warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        img = np.asarray(hdul[0].data, dtype=np.float64)
        wcs = WCS(hdul[0].header)
        var = np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
    return science.EpochCoadd(
        index=int(epoch["index"]), detector=WISE_DETECTOR_LABEL,
        t_mid=Time(float(fr["t_mid_mjd"]), format="mjd", scale="utc"), image=img, variance=var,
        wcs=wcs, n_images=int(fr["n_images"]),
    )  # fmt: skip


def _frame_wing_offset(
    data_dir: Path, item: dict[str, Any], astro: Astrometry, catalog: list[CatalogSource]
) -> tuple[float, float, float, float] | None:
    """Wing centroid offset (east, north, arcsec) and errors of the target on one L1b frame."""
    p = {k: data_dir / v for k, v in item["paths"].items()}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        with fits.open(p["int"]) as h:
            img = np.asarray(h[0].data, dtype=np.float64)
            hdr = h[0].header
            wcs = WCS(hdr)
        unc = np.asarray(fits.getdata(p["unc"]), dtype=np.float64)
        msk = np.asarray(fits.getdata(p["msk"]))
    try:
        cal = calibrate_frame(img, unc, msk, float(hdr["MAGZP"]), item["mask_table"])
    except (ValueError, KeyError):
        return None
    t_obs = Time(float(item["mjd_obs"]), format="mjd", scale="utc")
    pra, pdec = science._position_at(astro, 0.0, 0.0, t_obs)
    x0, y0 = science._world2pix(wcs, pra, pdec)
    scale = science._pixel_scale_arcsec(wcs)
    excl = cal.bad | science.mask_catalog_stars(
        cal.science.shape, wcs, catalog, t_obs, pra, pdec, science.WING_MASK_MAX_MAG,
        science.WING_MASK_ARCSEC,
    )  # fmt: skip
    c = measure_wing_centroid(
        np.asarray(cal.science, dtype=np.float64), np.asarray(cal.variance, dtype=np.float64),
        excl, float(x0), float(y0), r_max_pix=WISE_WING_RADIUS_ARCSEC / scale,
        max_shift_pix=WISE_WING_MAX_SHIFT_ARCSEC / scale,
    )  # fmt: skip
    if c is None:
        return None
    mra, mdec = science._pix2world(wcs, c.x, c.y)
    dra = ((mra - pra + 180.0) % 360.0 - 180.0) * math.cos(math.radians(pdec)) * 3600.0
    return dra, (mdec - pdec) * 3600.0, c.x_err * scale, c.y_err * scale


def measure_wise_epochs(
    data_dir: Path, man: dict[str, Any], side: dict[str, Any], astro: Astrometry,
    catalog: list[CatalogSource], catalog_name: str, exclude_ids: set[str],
) -> list[dict[str, Any]]:  # fmt: skip
    """One row per WISE epoch: measured position and error, or the reason it is not measured."""
    rows: list[dict[str, Any]] = []
    by_epoch: dict[int, list[dict[str, Any]]] = {}
    for it in side["frames"]:
        by_epoch.setdefault(int(it["epoch"]), []).append(it)
    for ep in man["epochs"]:
        co = wise_coadd(data_dir, ep)
        scale = abs(float(co.wcs.proj_plane_pixel_scales()[0].to_value(u.arcsec)))
        pra, pdec = science._position_at(astro, 0.0, 0.0, co.t_mid)
        x0, y0 = (float(v) for v in science._world2pix(co.wcs, pra, pdec))
        rec, info = science.recalibrate_epoch(co, catalog, catalog_name, pra, pdec, exclude_ids)
        row: dict[str, Any] = {
            "mission": "WISE", "phase": ep["phase"], "band": ep["frames"][0]["band"],
            "index": int(ep["index"]), "t_mid_mjd": round(float(co.t_mid.mjd), 5),
            "n_images": co.n_images, "measured": False, "recalibration_stars": rec.n_stars,
            "recalibration": info,
        }  # fmt: skip
        if rec.n_stars < science.RECAL_MIN_STARS:
            row["reason"] = "fewer_than_3_recalibration_stars"
            rows.append(row)
            continue
        if science._core_finite(co.image, x0, y0):
            method = "coadd_centroid"
            bad = ~np.isfinite(co.image)
            nbs = science.neighbor_pixels(co, catalog, catalog_name, pra, pdec, exclude_ids, rec)
            plain = measure_centroid(co.image, co.variance, bad, x0, y0, science.CENTROID_HALF_BOX)
            c = plain
            if nbs:
                joint = measure_centroid(co.image, co.variance, bad, x0, y0,
                                         science.CENTROID_HALF_BOX, neighbors=nbs)  # fmt: skip
                if science._good_centroid(joint, x0, y0, science.DEBLEND_MIN_SNR):
                    c = joint
            if not science._good_centroid(plain, x0, y0, science.TARGET_MIN_SNR) or c is None:
                row.update(method=method, reason="no_significant_source")
                rows.append(row)
                continue
            xm, ym, ex_pix, ey_pix = c.x, c.y, c.x_err, c.y_err
            row["snr"] = round(float(c.amp / c.amp_err), 1)
        else:
            method = "psf_wings"
            offs = [
                o for it in by_epoch.get(int(ep["index"]), [])
                if (o := _frame_wing_offset(data_dir, it, astro, catalog)) is not None
            ]  # fmt: skip
            comb = None
            if len(offs) >= WISE_WING_MIN_FRAMES:
                a = np.array(offs, dtype=np.float64)
                comb = combine_offsets(a[:, 0], a[:, 1], a[:, 2], a[:, 3])
            if comb is None or comb.n_used < WISE_WING_MIN_FRAMES:
                row.update(method=method, reason="too_few_wing_centroids", frames_fitted=len(offs))
                rows.append(row)
                continue
            ra0 = pra + comb.dx / 3600.0 / math.cos(math.radians(pdec))
            dec0 = pdec + comb.dy / 3600.0
            xw, yw = science._world2pix(co.wcs, ra0, dec0)
            xm, ym = float(xw), float(yw)
            ex_pix, ey_pix = comb.dx_err / scale, comb.dy_err / scale
            row.update(frames_fitted=len(offs), frames_used=comb.n_used,
                       frame_scatter_arcsec=round(math.hypot(comb.scatter_x, comb.scatter_y)
                                                  / math.sqrt(2.0), 4))  # fmt: skip
        xc, yc = rec.correct(xm, ym)
        sys_pix = (rec.excess_pix if np.isfinite(rec.excess_pix) else 0.0) ** 2 + (
            rec.dx_err if np.isfinite(rec.dx_err) else 0.0
        ) ** 2
        ra_m, dec_m = science._pix2world(co.wcs, xc, yc)
        ex = math.sqrt(ex_pix**2 + sys_pix) * scale
        ey = math.sqrt(ey_pix**2 + sys_pix) * scale
        row.update(
            measured=True, method=method, ra_deg=ra_m, dec_deg=dec_m, err_ra_arcsec=round(ex, 4),
            err_dec_arcsec=round(ey, 4),
            centroid_err_arcsec=round(math.hypot(ex_pix, ey_pix) / math.sqrt(2.0) * scale, 4),
            recalibration_err_arcsec=round(math.sqrt(sys_pix) * scale, 4),
            predicted_sep_arcsec=round(science._sep_arcsec(ra_m, dec_m, pra, pdec), 4),
        )  # fmt: skip
        rows.append(row)
    return rows


def spherex_rows(res: dict[str, Any]) -> list[dict[str, Any]]:
    """Epoch rows of a `science.measure_astrometry` result, labelled with the mission."""
    out = []
    for r in res.get("epochs", []):
        row = {"mission": "SPHEREx", "detector": res.get("detector_used"), **r}
        if r.get("measured") and int(r.get("recalibration_stars") or 0) < science.RECAL_MIN_STARS:
            row["measured"] = False
            row["reason"] = "fewer_than_3_recalibration_stars"
        out.append(row)
    return out


def reference_at(astro: Astrometry, t: Time) -> tuple[float, float]:
    """Proper motion (mu_alpha*, mu_delta, mas/yr) of the pinned astrometry at time `t`."""
    moved = propagate_space_motion(astro, t)
    return (float(moved.pm_ra_cosdec.to_value(u.mas / u.yr)),
            float(moved.pm_dec.to_value(u.mas / u.yr)))  # fmt: skip


def _fit_dict(fit: MotionFit) -> dict[str, Any]:
    return {
        "pmra_masyr": fit.pmra_cosdec_masyr, "pmdec_masyr": fit.pmdec_masyr,
        "pmra_err_masyr": fit.pmra_err_masyr, "pmdec_err_masyr": fit.pmdec_err_masyr,
        "parallax_mas": fit.parallax_mas, "parallax_err_mas": fit.parallax_err_mas,
        "parallax_fixed": fit.parallax_fixed, "chi2_red": fit.chi2_red, "dof": fit.dof,
        "n_epochs": fit.n_epochs, "ref_epoch_jyear": float(fit.ref_epoch.jyear),
    }  # fmt: skip


def long_baseline_fit(
    rows: list[dict[str, Any]], astro: Astrometry, ref_pm: tuple[float, float, float, float]
) -> dict[str, Any]:
    """Combined fit over the measured rows of both missions (docs/11 V-15).

    `ref_pm` = pinned (pmra, pmdec, pmra_err, pmdec_err) in mas/yr; the reference is evaluated at
    the fit epoch by propagating the pinned astrometry (its errors are the pinned ones).
    """
    used = [r for r in rows if r.get("measured")]
    per_mission = {m: sum(1 for r in used if r["mission"] == m) for m in ("WISE", "SPHEREx")}
    out: dict[str, Any] = {"epochs_per_mission": per_mission, "rows": rows}
    if min(per_mission.values()) < 2:
        out["status"] = "not_measurable"
        out["reason"] = "fewer_than_2_epochs_in_a_mission"
        return out
    t = Time(np.array([float(r["t_mid_mjd"]) for r in used]), format="mjd", scale="utc")
    ra = np.array([float(r["ra_deg"]) for r in used]) * u.deg
    dec = np.array([float(r["dec_deg"]) for r in used]) * u.deg
    era = np.array([float(r["err_ra_arcsec"]) for r in used])
    ede = np.array([float(r["err_dec_arcsec"]) for r in used])
    do_plx = well_spread_for_parallax(t, ra, dec)
    plx_ref = float(astro.parallax.to_value(u.mas))
    fit = fit_motion(t, ra, dec, era, ede, parallax_mas=plx_ref, fit_parallax=do_plx,
                     min_epochs_for_parallax=6)  # fmt: skip
    rpm = reference_at(astro, fit.ref_epoch)
    sigma = agreement_sigma(fit, rpm[0], rpm[1], ref_pm[2], ref_pm[3])
    s_ra = math.hypot(fit.pmra_err_masyr, ref_pm[2])
    s_de = math.hypot(fit.pmdec_err_masyr, ref_pm[3])
    resid = []
    for r, (dx, dy) in zip(used, fit.residuals_arcsec, strict=True):
        resid.append({"mission": r["mission"], "index": r["index"], "t_mid_mjd": r["t_mid_mjd"],
                      "dra_arcsec": float(dx), "ddec_arcsec": float(dy)})  # fmt: skip
    means: dict[str, Any] = {}
    for m in ("WISE", "SPHEREx"):
        rr = np.array([[x["dra_arcsec"], x["ddec_arcsec"]] for x in resid if x["mission"] == m])
        means[m] = [float(v) for v in rr.mean(axis=0)] if len(rr) else None
    # Season split: WISE observes each field near two elongations, six months apart.
    season: dict[str, Any] = {}
    for x in resid:
        doy = Time(x["t_mid_mjd"], format="mjd").datetime.timetuple().tm_yday
        key = f"{x['mission']}:{'H1' if doy <= 182 else 'H2'}"
        season.setdefault(key, []).append((x["dra_arcsec"], x["ddec_arcsec"]))
    out.update(
        status="pass" if sigma <= 3.0 else "fail",
        fit=_fit_dict(fit),
        parallax_fitted=do_plx,
        parallax_reference_mas=plx_ref,
        reference={
            "pmra_masyr": rpm[0],
            "pmdec_masyr": rpm[1],
            "pmra_err_masyr": ref_pm[2],
            "pmdec_err_masyr": ref_pm[3],
            "pinned_pmra_masyr": ref_pm[0],
            "pinned_pmdec_masyr": ref_pm[1],
        },  # fmt: skip
        agreement_sigma=sigma,
        sigma_per_axis=[
            abs(fit.pmra_cosdec_masyr - rpm[0]) / s_ra,
            abs(fit.pmdec_masyr - rpm[1]) / s_de,
        ],  # fmt: skip
        residuals=resid,
        mean_residual_per_mission_arcsec=means,
        mean_residual_per_season_arcsec={
            k: [float(np.mean([a for a, _ in v])), float(np.mean([b for _, b in v])), len(v)]
            for k, v in sorted(season.items())
        },
    )
    return out


def wise_matched_exposures(
    data_dir: Path, sidecar: dict[str, Any], astro: Astrometry, band: str
) -> dict[str, Any]:
    """The "WISE-matched" SPHEREx selection of one band for a stored SPHEREx sequence.

    Rule (fixed before any result): an exposure is kept when the SPHEREx wavelength at the
    target pixel (spectral WCS key W, target propagated to the exposure mid time) lies inside
    the half-peak window of the WISE band from the official RSR (Wright et al. 2010), inclusive.
    """
    from destello.pipeline.calibrate import load_cutout, wavelength_at
    from destello.pipeline.wise import band_matched, official_band_window

    window = official_band_window(band)
    rows: list[dict[str, Any]] = []
    for e in sidecar.get("exposures", []):
        path = data_dir / str(e["path"])
        if not path.is_file():
            continue
        with fits.open(path) as hdul, warnings.catch_warnings():
            warnings.simplefilter("ignore", AstropyWarning)
            co = load_cutout(hdul, str(e["obs_id"]))
            ra, dec = science._position_at(astro, 0.0, 0.0, co.t_mid)
            x, y = science._world2pix(co.wcs, ra, dec)
            wl = float("nan")
            ny, nx = co.image.shape
            if co.wave_wcs is not None and 0 <= float(x) < nx and 0 <= float(y) < ny:
                wl = float(wavelength_at(co, float(x), float(y))[0].to_value(u.um))
        rows.append({"obs_id": e["obs_id"], "epoch": e.get("epoch"), "detector": co.detector,
                     "wavelength_um": wl})  # fmt: skip
    wl_arr = np.array([r["wavelength_um"] for r in rows], dtype=np.float64)
    keep = band_matched(wl_arr, window) if rows else np.zeros(0, dtype=bool)
    for r, k in zip(rows, keep, strict=True):
        r["matched"] = bool(k)
    return {
        "band": band, "window_um": [window.lo_um, window.hi_um], "fraction": window.fraction,
        "source": window.source, "n_exposures": len(rows), "n_matched": int(keep.sum()),
        "exposures": rows,
    }  # fmt: skip
