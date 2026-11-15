"""Forced aperture photometry on single exposures and on coadds (docs/03 sections 4.2 and 4.6).

Flux density is reported in Jy using the per-pixel solid angle. No aperture correction is applied
(the PSF extension is not retained in cached cutouts), so fluxes are aperture sums that miss the
PSF wings; this is stated in the manifest warnings.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, replace
from typing import Literal

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.utils.exceptions import AstropyWarning

from destello.pipeline.calibrate import (
    CalibratedCutout,
    flag_names_in,
    photometry_view,
    surface_brightness_to_jy,
)

FloatArray = npt.NDArray[np.floating]

DEFAULT_APERTURE_ARCSEC = 12.0  # radius, about 1.8 x the SPHEREx PSF FWHM (6.6 arcsec)
DEFAULT_ANNULUS_ARCSEC = (18.0, 36.0)  # inner and outer radius of the background annulus
DEFAULT_CORE_ARCSEC = 6.2  # source core: one native SPHEREx pixel around the position
MIN_BACKGROUND_PIXELS = 5
FLAGGED_POINT_FRACTION = 0.2  # a measurement is "flagged" above this excluded aperture share

MaskSet = Literal["coadd", "photometry"]


@dataclass(frozen=True)
class PhotResult:
    """Result of one aperture measurement."""

    flux_jy: float
    flux_err_jy: float
    background_mjy_sr: float
    n_aperture: int  # pixels inside the aperture
    n_valid: int  # unflagged pixels inside the aperture
    flagged_fraction: float  # flagged share of aperture pixels
    x: float
    y: float
    usable: bool  # False when the aperture is off the image or has no valid pixel
    saturated_fraction: float = 0.0  # share of aperture pixels with saturation related flags
    n_background: int = 0  # valid annulus pixels
    core_masked: bool = False  # a core pixel is excluded from the sum (flagged or not finite)
    core_saturated: bool = False  # an excluded core pixel carries a saturation flag
    aperture_flags: tuple[str, ...] = ()  # flag names set inside the aperture
    core_flags: tuple[str, ...] = ()  # flag names set inside the core


_BAD = PhotResult(
    float("nan"), float("nan"), float("nan"), 0, 0, 1.0, float("nan"), float("nan"), False
)


def aperture_photometry(
    science: FloatArray,
    variance: FloatArray,
    bad: npt.NDArray[np.bool_],
    omega_arcsec2: FloatArray,
    x: float,
    y: float,
    pixel_scale_arcsec: float,
    aperture_arcsec: float = DEFAULT_APERTURE_ARCSEC,
    annulus_arcsec: tuple[float, float] = DEFAULT_ANNULUS_ARCSEC,
    saturated: npt.NDArray[np.bool_] | None = None,
    background_bad: npt.NDArray[np.bool_] | None = None,
    core_arcsec: float = DEFAULT_CORE_ARCSEC,
) -> PhotResult:
    """Background subtracted circular aperture photometry at pixel (x, y), 0-based.

    `saturated` (optional) marks pixels with saturation related flags; their share of the
    aperture is reported as `saturated_fraction`, and `core_saturated` is set when such a pixel
    within `core_arcsec` of the position is excluded from the sum. `background_bad` (optional,
    default `bad`) is the exclusion mask of the annulus.

    The background is the median of the unflagged annulus pixels. Flagged aperture pixels are
    replaced by the mean of the valid ones (the sum is scaled by n_aperture / n_valid) and the
    flagged fraction is reported so callers can set `flagged`; this replacement underestimates
    the flux when the excluded pixels are in the core, which `core_masked` reports. Uncertainty
    combines the larger of the formal and the annulus-scatter variance with the background
    uncertainty.
    """
    ny, nx = science.shape
    r_ap = aperture_arcsec / pixel_scale_arcsec
    r_in = annulus_arcsec[0] / pixel_scale_arcsec
    r_out = annulus_arcsec[1] / pixel_scale_arcsec
    if (
        not (np.isfinite(x) and np.isfinite(y))
        or not (-r_ap <= x <= nx - 1 + r_ap)
        or not (-r_ap <= y <= ny - 1 + r_ap)
    ):
        return _BAD
    bkg_bad = bad if background_bad is None else background_bad
    yy, xx = np.mgrid[0:ny, 0:nx]
    rr = np.hypot(xx - x, yy - y)
    ap = rr <= max(r_ap, 0.5)
    core = ap & (rr <= max(core_arcsec / pixel_scale_arcsec, 0.5))
    ann = (rr >= r_in) & (rr <= r_out) & ~bkg_bad & np.isfinite(science)
    n_ap = int(ap.sum())
    if n_ap == 0:
        return _BAD
    sat_frac = float(np.mean(saturated[ap])) if saturated is not None else 0.0
    ap_valid = ap & ~bad & np.isfinite(science)
    n_valid = int(ap_valid.sum())
    n_ann = int(ann.sum())
    core_lost = core & ~ap_valid
    core_masked = bool(core_lost.any())
    core_sat = bool((core_lost & saturated).any()) if saturated is not None else False
    if n_valid == 0 or n_ann < MIN_BACKGROUND_PIXELS:
        return PhotResult(
            float("nan"), float("nan"), float("nan"), n_ap, n_valid,
            1.0 - n_valid / n_ap, float(x), float(y), False, sat_frac,
            n_ann, core_masked, core_sat,
        )  # fmt: skip
    ann_vals = science[ann]
    bkg = float(np.median(ann_vals))
    sig_ann = float(1.4826 * np.median(np.abs(ann_vals - bkg)))
    net = science[ap_valid] - bkg
    scale = n_ap / n_valid
    flux_pix = surface_brightness_to_jy(net, omega_arcsec2[ap_valid])
    flux = float(np.sum(flux_pix) * scale)
    omega_sr_jy = surface_brightness_to_jy(1.0, omega_arcsec2[ap_valid])
    formal = float(np.sum(variance[ap_valid] * omega_sr_jy**2))
    empirical = float(np.sum((sig_ann * omega_sr_jy) ** 2))
    bkg_err = float(np.mean(omega_sr_jy)) * n_ap * sig_ann / np.sqrt(max(n_ann, 1))
    err = float(np.sqrt(max(formal, empirical) * scale**2 + bkg_err**2))
    return PhotResult(
        flux_jy=flux,
        flux_err_jy=err,
        background_mjy_sr=bkg,
        n_aperture=n_ap,
        n_valid=n_valid,
        flagged_fraction=1.0 - n_valid / n_ap,
        x=float(x),
        y=float(y),
        usable=True,
        saturated_fraction=sat_frac,
        n_background=n_ann,
        core_masked=core_masked,
        core_saturated=core_sat,
    )


def forced_photometry(
    cal: CalibratedCutout,
    ra: u.Quantity,
    dec: u.Quantity,
    aperture_arcsec: float = DEFAULT_APERTURE_ARCSEC,
    annulus_arcsec: tuple[float, float] = DEFAULT_ANNULUS_ARCSEC,
    masks: MaskSet = "coadd",
    photometry_flags: tuple[str, ...] | None = None,
) -> PhotResult:
    """Forced photometry on one calibrated single-exposure cutout at a sky position.

    `masks="coadd"` uses the coadd mask of `cal` (DEFAULT_MASK_FLAGS, saturation from
    SATURATION_FLAGS). `masks="photometry"` re-masks the exposure with the Explanatory Supplement
    photometry flags (`calibrate.photometry_view`): OVERFLOW and TRANSIENT pixels keep their
    values, and the core counts as saturated only when an excluded core pixel carries OVERFLOW,
    NONLINEAR or BLOOM. The flag names found in the aperture and in the core are reported.
    `photometry_flags` (with `masks="photometry"`) replaces the aperture flag set; the moving
    target method passes the set without OUTLIER (docs/03 section 4.9).
    """
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        x, y = cal.cutout.wcs.all_world2pix(ra.to_value(u.deg), dec.to_value(u.deg), 0, quiet=True)
    wcs = cal.cutout.wcs
    cd = float(np.abs(np.linalg.det(wcs.pixel_scale_matrix)) ** 0.5 * 3600.0)
    background_bad: npt.NDArray[np.bool_] | None = None
    if masks == "photometry":
        view = (
            photometry_view(cal)
            if photometry_flags is None
            else photometry_view(cal, photometry_flags)
        )
        science, variance, bad = view.science, view.variance, view.bad
        background_bad, saturated = view.background_bad, view.saturation
    else:
        science, variance, bad, saturated = cal.science, cal.variance, cal.bad, cal.saturated
    res = aperture_photometry(
        science,
        variance,
        bad,
        cal.omega_arcsec2,
        float(x),
        float(y),
        pixel_scale_arcsec=cd,
        aperture_arcsec=aperture_arcsec,
        annulus_arcsec=annulus_arcsec,
        saturated=saturated,
        background_bad=background_bad,
    )
    if res.n_aperture == 0:
        return res
    ny, nx = science.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    rr = np.hypot(xx - float(x), yy - float(y))
    ap = rr <= max(aperture_arcsec / cd, 0.5)
    core = ap & (rr <= max(DEFAULT_CORE_ARCSEC / cd, 0.5))
    flags, bits = cal.cutout.flags, cal.cutout.flag_bits
    return replace(
        res,
        aperture_flags=tuple(flag_names_in(flags, bits, ap)),
        core_flags=tuple(flag_names_in(flags, bits, core)),
    )


def point_reason(phot: PhotResult) -> str | None:
    """Why a measurement (single-exposure spectrum point or coadd epoch) is unusable, else None.

    Codes: `off_image` (aperture outside the cutout), `saturated_core` (an excluded core pixel
    carries OVERFLOW, NONLINEAR or BLOOM), `no_valid_pixels`, `no_background` (too few valid
    annulus pixels), `core_masked` (another flag removes a core pixel: the mean replacement
    would underestimate the flux) and `aperture_masked` (more than FLAGGED_POINT_FRACTION of the
    aperture excluded).
    """
    if phot.n_aperture == 0:
        return "off_image"
    if phot.core_saturated:
        return "saturated_core"
    if phot.n_valid == 0:
        return "no_valid_pixels"
    if phot.n_background < MIN_BACKGROUND_PIXELS:
        return "no_background"
    if phot.core_masked:
        return "core_masked"
    if phot.flagged_fraction > FLAGGED_POINT_FRACTION:
        return "aperture_masked"
    if not (phot.usable and np.isfinite(phot.flux_jy)):
        return "no_valid_pixels"
    return None


WING_ANNULUS_ARCSEC = (50.0, 80.0)  # PSF wing ring measured on saturated sources
WING_BACKGROUND_ARCSEC = (110.0, 145.0)  # local background ring, outside the measured wing
WING_MIN_COVERAGE = 0.6  # minimum valid share of every radial bin of the wing ring
WING_MIN_BACKGROUND_PIXELS = 30


@dataclass(frozen=True)
class WingFlux:
    """Flux density in a ring of the PSF wings (Jy) and why it is unusable, if it is."""

    flux_jy: float
    flux_err_jy: float
    background_mjy_sr: float
    n_bins: int
    n_background: int
    reason: str | None  # None when usable; else "off_image", "no_background", "wing_masked"


def wing_annulus_flux(
    science: FloatArray,
    bad: npt.NDArray[np.bool_],
    omega_arcsec2: FloatArray,
    x: float,
    y: float,
    pixel_scale_arcsec: float,
    annulus_arcsec: tuple[float, float] = WING_ANNULUS_ARCSEC,
    background_arcsec: tuple[float, float] = WING_BACKGROUND_ARCSEC,
    min_coverage: float = WING_MIN_COVERAGE,
) -> WingFlux:
    """Background subtracted flux density in a ring of the PSF wings around pixel (x, y).

    For a source whose core is saturated, the flux in a fixed ring of the wings is proportional
    to the total flux as long as the PSF shape is the same, so the ratio of two such fluxes
    measured on the same detector at the same wavelength measures a brightness change; it is not
    a total flux. The ring is split into radial bins one pixel wide; each bin contributes its
    azimuthal mean of the valid pixels, minus the background, times its full pixel count, so a
    masked pixel is replaced by the mean of its own radius rather than of the whole ring. Every
    bin needs `min_coverage` valid pixels, otherwise the measurement is rejected ("wing_masked").
    The background is the median of the valid pixels of `background_arcsec`. The uncertainty
    combines, per bin, the empirical scatter of its pixels and the background error.
    """
    ny, nx = science.shape
    if not (np.isfinite(x) and np.isfinite(y)) or not (0 <= x <= nx - 1 and 0 <= y <= ny - 1):
        return WingFlux(float("nan"), float("nan"), float("nan"), 0, 0, "off_image")
    yy, xx = np.mgrid[0:ny, 0:nx]
    rr = np.hypot(xx - x, yy - y) * pixel_scale_arcsec
    valid = ~bad & np.isfinite(science)
    bk = (rr >= background_arcsec[0]) & (rr <= background_arcsec[1]) & valid
    n_bk = int(bk.sum())
    if n_bk < WING_MIN_BACKGROUND_PIXELS:
        return WingFlux(float("nan"), float("nan"), float("nan"), 0, n_bk, "no_background")
    bk_vals = science[bk]
    bkg = float(np.median(bk_vals))
    sig_bk = float(1.4826 * np.median(np.abs(bk_vals - bkg)))
    edges = np.arange(annulus_arcsec[0], annulus_arcsec[1] + 1e-6, pixel_scale_arcsec)
    total = 0.0
    var = 0.0
    n_ring = 0
    n_bins = 0
    for a, b in zip(edges[:-1], edges[1:], strict=True):
        ring = (rr >= a) & (rr < b)
        n_all = int(ring.sum())
        if n_all == 0:
            continue
        ok = ring & valid
        n_ok = int(ok.sum())
        if n_ok < max(min_coverage * n_all, 2):
            return WingFlux(float("nan"), float("nan"), bkg, n_bins, n_bk, "wing_masked")
        to_jy = float(surface_brightness_to_jy(1.0, float(np.mean(omega_arcsec2[ring]))))
        total += (float(np.mean(science[ok])) - bkg) * to_jy * n_all
        var += (to_jy * n_all) ** 2 * float(np.var(science[ok], ddof=1)) / n_ok
        n_ring += n_all
        n_bins += 1
    if n_bins == 0:
        return WingFlux(float("nan"), float("nan"), bkg, 0, n_bk, "off_image")
    to_jy_mean = float(surface_brightness_to_jy(1.0, float(np.mean(omega_arcsec2[bk]))))
    var += (to_jy_mean * n_ring * sig_bk) ** 2 / n_bk
    return WingFlux(total, float(np.sqrt(var)), bkg, n_bins, n_bk, None)


@dataclass(frozen=True)
class BandFlux:
    """Flux density interpolated to one wavelength from single-exposure spectrum points (Jy)."""

    flux_jy: float
    flux_err_jy: float
    n_used: int
    n_total: int


def band_flux_at(
    wavelength_um: FloatArray, flux_jy: FloatArray, wl0_um: float, clip: float = 3.0
) -> BandFlux | None:
    """Power-law fit of spectrum points inside a band, evaluated at `wl0_um`.

    Fits log F = a + b log(lambda) by least squares to the positive points, rejects once the
    points whose residual exceeds `clip` robust standard deviations (1.4826 MAD), refits and
    evaluates at `wl0_um`. The error is the standard error of the fitted line at `wl0_um` from
    the residual scatter, so it includes the per-exposure scatter (calibration, sub-pixel phase,
    background) and not only the formal photometric error. Returns None with fewer than 3 points.
    """
    wl = np.asarray(wavelength_um, dtype=np.float64)
    f = np.asarray(flux_jy, dtype=np.float64)
    ok = np.isfinite(wl) & np.isfinite(f) & (f > 0) & (wl > 0)
    n_total = int(ok.sum())
    if n_total < 3:
        return None
    x, y = np.log(wl[ok]), np.log(f[ok])
    keep = np.ones(x.size, dtype=bool)
    b, a = np.polyfit(x, y, 1)
    res = y - (a + b * x)
    mad = 1.4826 * float(np.median(np.abs(res - np.median(res))))
    if mad > 0:
        keep = np.abs(res - np.median(res)) <= clip * mad
    if int(keep.sum()) < 3:
        return None
    x, y = x[keep], y[keep]
    b, a = np.polyfit(x, y, 1)
    n = int(x.size)
    x0 = float(np.log(wl0_um))
    y0 = float(a + b * x0)
    s2 = float(np.sum((y - (a + b * x)) ** 2)) / max(n - 2, 1)
    sxx = float(np.sum((x - np.mean(x)) ** 2))
    var = s2 * (1.0 / n + ((x0 - float(np.mean(x))) ** 2 / sxx if sxx > 0 else 0.0))
    flux = float(np.exp(y0))
    return BandFlux(flux, flux * float(np.sqrt(var)), n, n_total)
