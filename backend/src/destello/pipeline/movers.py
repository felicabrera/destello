"""Solar System movers (F-33): spacecraft parallax, campaigns, band excess and ephemeris checks.

Pure functions (no network, no files). Definitions and tolerances are those of docs/11 (V-13 and
V-14 definitions) and docs/03 section 4.9; they were fixed before any measurement of the comet.

Positions: the ephemeris (JPL Horizons, `sources.horizons`) is geocentric and astrometric (ICRF,
light-time corrected). SPHEREx is in low Earth orbit, about 7000 km from the geocentre, which moves
a body at distance delta by up to r_sc / delta radians (3.7 arcsec for 3I/ATLAS in August 2025,
5.4 arcsec in December 2025). `topocentric` removes that shift with the spacecraft position of the
image header (X_SC, Y_SC, Z_SC, km, XYZ_SC_SYSTEM = GEOCENTER, taken as ICRF axes). Aberration is
not applied: the WCS is fitted on stars and carries the same aberration as the comet.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.time import Time

from destello.models.catalog import CatalogSource
from destello.pipeline.astrometry import measure_centroid
from destello.pipeline.calibrate import DEFAULT_MASK_FLAGS, PHOTOMETRY_MASK_FLAGS
from destello.pipeline.propagate import parallax_factors
from destello.pipeline.spectral_index import MIN_POINTS, _window, window_stats

FloatArray = npt.NDArray[np.floating]

AU_KM = 149_597_870.7  # IAU 2012 Resolution B2
RAD_TO_ARCSEC = 180.0 / math.pi * 3600.0
NATIVE_PIXEL_ARCSEC = 6.2  # SPHEREx native pixel, about 6.15 to 6.2 arcsec (docs/03 section 1)

# Version 2 (2026-11-14): OUTLIER is no longer an exclusion flag for moving targets (below).
# Version 3 (2026-11-15): the V-14 centroid models Gaia DR3 stars in the fit box (docs/11).
MOVER_METHOD_VERSION = "3"

# OUTLIER (SPHEREx Explanatory Supplement v2.0, section 3.2.10) is set in each exposure on pixels
# above a variance threshold in the median-filtered image after the SOURCE mask of catalogued
# sources is applied. A body that is not in the source reference catalog, such as a comet, is
# flagged by construction: in the December 2025 build 78 of 104 exposures had OUTLIER in the comet
# core, against 0 of 1759 Gaia star positions in the same exposures. The Supplement photometry list
# (section 3.3, "Flag usage") does not include OUTLIER. For moving targets it is therefore kept in
# the aperture sum, the centroid and the frames; hardware and artifact flags still exclude, and
# the background annulus keeps the Supplement background list (which has OUTLIER).
MOVER_MASK_FLAGS: tuple[str, ...] = tuple(f for f in DEFAULT_MASK_FLAGS if f != "OUTLIER")
MOVER_PHOTOMETRY_MASK_FLAGS: tuple[str, ...] = tuple(
    f for f in PHOTOMETRY_MASK_FLAGS if f != "OUTLIER"
)

# Forced photometry of a coma (docs/11, V-13 definitions): fixed before measuring.
COMA_APERTURE_ARCSEC = 24.8  # 4 native pixels
COMA_ANNULUS_ARCSEC = (240.0, 360.0)
# Display grid of a moving-target sequence and the cutout side that holds the annulus.
MOVER_FOV_ARCMIN = 12.0
MOVER_CUTOUT_ARCMIN = 14.0

# Band windows (um). CO2 nu3 band and the water band with their continuum windows (docs/11).
BANDS: dict[str, dict[str, tuple[float, float]]] = {
    "co2": {"band": (4.23, 4.27), "blue": (4.00, 4.17), "red": (4.33, 4.50)},
    "h2o": {"band": (2.70, 2.80), "blue": (2.50, 2.65), "red": (2.85, 3.00)},
}
BAND_EXCESS_SIGMA = 3.0  # V-13 pass threshold

# V-14 (docs/11): per exposure bound B_i = sqrt(3.1^2 + s_eph^2 + 1.0^2 + (3 sigma_c)^2) arcsec.
V14_PIXEL_PHASE_ARCSEC = 3.1  # half a native pixel: pixel phase bias and coma photocentre
V14_WCS_ARCSEC = 1.0  # WCS accuracy (V-01 tolerance) plus the parallax residual (< 0.1 arcsec)
V14_MAX_CENTROID_ERR_ARCSEC = 3.1  # a centroid less precise than this is "not measured"
V14_MIN_PEAK_SNR = 5.0
V14_MIN_MEASURED = 10
V14_MIN_FRACTION = 0.9
# V-14 neighbour model (method version 3, docs/11): Gaia DR3 stars of G <= 19.0 (the cone limit of
# the static deblend) inside the 9 x 9 box enlarged by one native pixel, fitted jointly with the
# comet at fixed positions with free amplitudes.
V14_HALF_BOX = 4
V14_NEIGHBOUR_MAX_G = 19.0
V14_NEIGHBOUR_MARGIN_PIX = 1.0


def topocentric(
    ra_deg: float, dec_deg: float, delta_au: float, sc_km: tuple[float, float, float]
) -> tuple[float, float, float]:
    """Direction of a body seen from the spacecraft: (ra, dec, shift in arcsec).

    The geocentric vector of the body (its astrometric unit vector times delta) minus the
    geocentric spacecraft position, renormalized. `shift` is the angle between the geocentric and
    the topocentric directions.
    """
    ra, dec = math.radians(ra_deg), math.radians(dec_deg)
    d_km = float(delta_au) * AU_KM
    g = np.array([math.cos(dec) * math.cos(ra), math.cos(dec) * math.sin(ra), math.sin(dec)])
    v = g * d_km - np.asarray(sc_km, dtype=np.float64)
    v /= np.linalg.norm(v)
    ra_t = math.degrees(math.atan2(v[1], v[0])) % 360.0
    dec_t = math.degrees(math.asin(max(-1.0, min(1.0, float(v[2])))))
    shift = math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(g, v)))))) * 3600.0
    return ra_t, dec_t, shift


def parallax_bound_arcsec(r_sc_km: float, delta_au: float) -> float:
    """Largest spacecraft parallax shift, r_sc / delta (small angle), in arcsec."""
    return float(r_sc_km) / (float(delta_au) * AU_KM) * RAD_TO_ARCSEC


def angular_sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    """Great circle separation (Vincenty form) in arcsec."""
    a1, d1, a2, d2 = map(math.radians, (ra1, dec1, ra2, dec2))
    da = a2 - a1
    num = math.hypot(
        math.cos(d2) * math.sin(da),
        math.cos(d1) * math.sin(d2) - math.sin(d1) * math.cos(d2) * math.cos(da),
    )
    den = math.sin(d1) * math.sin(d2) + math.cos(d1) * math.cos(d2) * math.cos(da)
    return math.degrees(math.atan2(num, den)) * 3600.0


def interpolate_track(
    t_mjd: float, track_mjd: FloatArray, ra_deg: FloatArray, dec_deg: FloatArray
) -> tuple[float, float]:
    """Linear interpolation of a sampled track (unit vectors, so RA wrap is handled)."""
    ra = np.radians(np.asarray(ra_deg, dtype=np.float64))
    dec = np.radians(np.asarray(dec_deg, dtype=np.float64))
    xyz = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])
    v = np.array([np.interp(t_mjd, track_mjd, c) for c in xyz])
    v /= np.linalg.norm(v)
    return math.degrees(math.atan2(v[1], v[0])) % 360.0, math.degrees(math.asin(float(v[2])))


def moving_discovery_adql(
    ra_deg: float, dec_deg: float, t_lo_mjd: float, t_hi_mjd: float, collections: list[str]
) -> str:
    """ADQL for the detector images that contain one ephemeris sample and start in a time window.

    One CONTAINS(POINT) per query: IRSA rejects several CONTAINS joined with OR (F-33-0 spike).
    """
    from destello.pipeline.query import discovery_adql

    base = discovery_adql(ra_deg, dec_deg, collections)
    clause = (
        f" AND p.time_bounds_lower >= {float(t_lo_mjd):.6f}"
        f" AND p.time_bounds_lower <= {float(t_hi_mjd):.6f}"
    )
    head, order = base.rsplit(" ORDER BY ", 1)
    return head + clause + " ORDER BY " + order


# ---------------------------------------------------------------------------------- V-13
BAND_EXCESS_VERSION = "2"  # 2026-11-15: no window S/N gate on the difference test (docs/11)


def band_excess(points: list[dict[str, Any]], band: str) -> dict[str, Any]:
    """Band flux against the continuum interpolated from two windows (docs/11, V-13).

    `points` are spectrum points (wavelength_um, flux, flux_err in Jy, flagged). Window value: the
    window estimator of docs/03 section 4.8 (unweighted mean, error the larger of the formal error
    and the standard error, at least 2 points). The test statistic is a difference,
    significance = (F_band - F_cont) / sqrt(err_band^2 + err_cont^2), which is defined whatever
    the sign or S/N of the windows, so a window mean below 3 sigma does not make the band not
    measurable (version 2); only fewer than 2 points does. Continuum: when both continuum window
    means are at 3 sigma or more, linear in log flux against log wavelength (version 1, unchanged);
    otherwise linear in flux against log wavelength, with linear error propagation, because a log
    of an undetected mean is not defined. The excess E = F_band / F_cont - 1 is a ratio and is
    reported only with a detected continuum; otherwise E is None and the continuum 3 sigma upper
    limit and the significance against it are reported.
    """
    w = BANDS[band]
    counts = {
        k: sum(
            1
            for p in points
            if p.get("flux") is not None
            and not p.get("flagged")
            and p.get("wavelength_um") is not None
            and w[k][0] <= float(p["wavelength_um"]) <= w[k][1]
        )
        for k in ("blue", "band", "red")
    }
    out: dict[str, Any] = {
        "band": band,
        "method_version": BAND_EXCESS_VERSION,
        "windows_um": {k: list(v) for k, v in w.items()},
        "n_points": counts,
        "excess": None,
        "excess_err": None,
        "significance": None,
        "band_flux_jy": None,
        "continuum_flux_jy": None,
        "continuum_detected": None,
        "reason": None,
    }
    stats = {k: window_stats(points, *w[k]) for k in ("blue", "band", "red")}
    out["windows"] = {
        k: {
            "n_points": v["n_points"],
            "mean_jy": v["mean_jy"],
            "err_jy": v["err_jy"],
            "snr": v["snr"],
        }
        for k, v in stats.items()
    }
    few = [k for k in ("blue", "band", "red") if stats[k]["n_points"] < MIN_POINTS]
    if few:
        out["reason"] = "window_not_measurable:" + ",".join(few)
        return out
    lb, fb, eb = (float(stats["blue"][k]) for k in ("wavelength_um", "mean_jy", "err_jy"))
    lc, fc, ec = (float(stats["band"][k]) for k in ("wavelength_um", "mean_jy", "err_jy"))
    lr, fr, er = (float(stats["red"][k]) for k in ("wavelength_um", "mean_jy", "err_jy"))
    x = math.log(lc / lb) / math.log(lr / lb)
    detected = _window(points, *w["blue"]) is not None and _window(points, *w["red"]) is not None
    if detected:
        cont = math.exp((1.0 - x) * math.log(fb) + x * math.log(fr))
        cont_err = cont * math.sqrt(((1.0 - x) * eb / fb) ** 2 + (x * er / fr) ** 2)
    else:
        cont = (1.0 - x) * fb + x * fr
        cont_err = math.hypot((1.0 - x) * eb, x * er)
    err = math.hypot(ec, cont_err)
    out.update(
        significance=(fc - cont) / err if err > 0 else None,
        band_flux_jy=fc,
        band_flux_err_jy=ec,
        continuum_flux_jy=cont,
        continuum_flux_err_jy=cont_err,
        continuum_detected=detected,
        continuum_interpolation="log" if detected else "linear",
        wavelength_um={"blue": lb, "band": lc, "red": lr},
    )
    if detected and cont > 0 and fc > 0:
        out["excess"] = fc / cont - 1.0
        out["excess_err"] = (fc / cont) * math.sqrt((ec / fc) ** 2 + (cont_err / cont) ** 2)
    else:
        upper = cont + 3.0 * cont_err
        out["continuum_upper_limit_jy"] = upper
        out["significance_vs_upper_limit"] = (fc - upper) / ec if ec > 0 else None
    return out


# ---------------------------------------------------------------------------------- V-14
@dataclass(frozen=True)
class EphemerisCheck:
    """Coma centroid of one exposure against the predicted (topocentric) position."""

    measured: bool
    reason: str | None  # why not measured: no_fit, imprecise, faint
    offset_arcsec: float | None  # centroid minus prediction, great circle
    dra_arcsec: float | None  # offset east (RA * cos Dec)
    ddec_arcsec: float | None
    centroid_err_arcsec: float | None  # larger axis
    bound_arcsec: float | None
    within: bool | None
    peak_snr: float | None
    n_neighbours: int = 0  # catalogue stars fitted jointly with the comet (method version 3)


def catalog_positions_at(stars: list[CatalogSource], t_obs: Time) -> tuple[FloatArray, FloatArray]:
    """ICRS positions (deg) of catalogue stars at `t_obs`: linear proper motion from each star's
    reference epoch plus the geocentric parallax shift (docs/03 section 4.4, the formula of the
    static deblend). Proper motion and parallax that are missing count as zero."""
    if not stars:
        return np.zeros(0), np.zeros(0)
    ra = np.array([s.ra_deg for s in stars], dtype=np.float64)
    dec = np.array([s.dec_deg for s in stars], dtype=np.float64)
    pmra = np.array([s.pmra_masyr or 0.0 for s in stars], dtype=np.float64)
    pmde = np.array([s.pmdec_masyr or 0.0 for s in stars], dtype=np.float64)
    plx = np.array([max(s.parallax_mas or 0.0, 0.0) for s in stars], dtype=np.float64)
    dt = float(t_obs.tdb.jyear) - np.array([s.ref_epoch_jyear for s in stars], dtype=np.float64)
    new_ra = ra + pmra * dt / 3.6e6 / np.cos(np.radians(dec))
    new_dec = dec + pmde * dt / 3.6e6
    if np.any(plx > 0):
        pa, pd = parallax_factors(
            float(np.mean(new_ra)) * u.deg, float(np.mean(new_dec)) * u.deg, t_obs
        )
        new_ra = new_ra + plx / 1000.0 * float(np.ravel(pa)[0]) / 3600.0 / np.cos(
            np.radians(new_dec)
        )
        new_dec = new_dec + plx / 1000.0 * float(np.ravel(pd)[0]) / 3600.0
    return new_ra % 360.0, new_dec


def box_neighbours(
    xy: list[tuple[float, float]],
    x_pred: float,
    y_pred: float,
    half_box: int = V14_HALF_BOX,
    margin_pix: float = V14_NEIGHBOUR_MARGIN_PIX,
) -> list[tuple[float, float]]:
    """Pixel positions within the fit box enlarged by `margin_pix` on each side (docs/11 V-14
    method version 3). The box is centred on the rounded predicted pixel, as in the fit."""
    xi, yi = int(round(x_pred)), int(round(y_pred))
    lim = half_box + margin_pix
    return [
        (float(x), float(y))
        for x, y in xy
        if math.isfinite(x) and math.isfinite(y) and abs(x - xi) <= lim and abs(y - yi) <= lim
    ]


def v14_bound(centroid_err_arcsec: float, eph_3sigma_arcsec: float) -> float:
    """B_i of docs/11 (V-14 definitions)."""
    return math.sqrt(
        V14_PIXEL_PHASE_ARCSEC**2
        + eph_3sigma_arcsec**2
        + V14_WCS_ARCSEC**2
        + (3.0 * centroid_err_arcsec) ** 2
    )


def ephemeris_check(
    science: FloatArray,
    variance: FloatArray,
    bad: npt.NDArray[np.bool_],
    x_pred: float,
    y_pred: float,
    pixel_scale_arcsec: float,
    pix2world: Any,
    ra_pred: float,
    dec_pred: float,
    eph_3sigma_arcsec: float,
    neighbours: list[tuple[float, float]] | None = None,
) -> EphemerisCheck:
    """V-14 for one exposure: Gaussian centroid (docs/03 section 4.5) started at the prediction.

    `pix2world(x, y) -> (ra, dec)` converts 0-based pixels to degrees with the full image WCS.
    `neighbours` are catalogue stars (0-based pixels, from `box_neighbours`) fitted jointly with
    the comet at fixed positions with free amplitudes (method version 3); None or an empty list
    gives the single Gaussian of method version 2.
    """
    nbs = list(neighbours or [])
    none = EphemerisCheck(False, "no_fit", None, None, None, None, None, None, None, len(nbs))
    c = measure_centroid(
        science, variance, bad, x_pred, y_pred, half_box=V14_HALF_BOX, neighbors=nbs or None
    )
    if c is None or not all(map(math.isfinite, (c.x, c.y, c.x_err, c.y_err))):
        return none
    if max(abs(c.x - x_pred), abs(c.y - y_pred)) >= 4.0 - 1e-3:
        return none  # the center reached the bound of the fit box: no constrained centroid
    err = max(c.x_err, c.y_err) * pixel_scale_arcsec
    snr = c.amp / c.amp_err if c.amp_err and c.amp_err > 0 else float("nan")
    ra_c, dec_c = pix2world(c.x, c.y)
    dra = (ra_c - ra_pred + 540.0) % 360.0 - 180.0
    dra_as = dra * math.cos(math.radians(dec_pred)) * 3600.0
    ddec_as = (dec_c - dec_pred) * 3600.0
    off = angular_sep_arcsec(ra_pred, dec_pred, ra_c, dec_c)
    reason: str | None = None
    if err > V14_MAX_CENTROID_ERR_ARCSEC:
        reason = "imprecise"
    elif not (math.isfinite(snr) and snr >= V14_MIN_PEAK_SNR):
        reason = "faint"
    bound = v14_bound(err, eph_3sigma_arcsec)
    measured = reason is None
    return EphemerisCheck(
        measured=measured,
        reason=reason,
        offset_arcsec=off,
        dra_arcsec=dra_as,
        ddec_arcsec=ddec_as,
        centroid_err_arcsec=err,
        bound_arcsec=bound,
        within=(off <= bound) if measured else None,
        peak_snr=snr if math.isfinite(snr) else None,
        n_neighbours=len(nbs),
    )


def v14_summary(checks: list[dict[str, Any]]) -> dict[str, Any]:
    """Status of V-14 for one campaign from the per exposure checks (docs/11)."""
    measured = [c for c in checks if c.get("measured")]
    within = [c for c in measured if c.get("within")]
    n = len(measured)
    frac = len(within) / n if n else None
    if n < V14_MIN_MEASURED:
        status = "not_measurable"
    else:
        status = "pass" if frac is not None and frac >= V14_MIN_FRACTION else "fail"
    offs = [float(c["offset_arcsec"]) for c in measured]
    return {
        "status": status,
        "n_exposures": len(checks),
        "n_measured": n,
        "n_within": len(within),
        "fraction_within": frac,
        "median_offset_arcsec": float(np.median(offs)) if offs else None,
        "max_offset_arcsec": float(np.max(offs)) if offs else None,
    }
