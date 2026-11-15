"""Unit tests for the single-exposure photometry flag criterion (docs/03 section 4.5)."""

from __future__ import annotations

import astropy.units as u
import numpy as np
from astropy.time import Time
from astropy.wcs import WCS

from destello.pipeline.calibrate import (
    CalibratedCutout,
    Cutout,
    calibrate,
    flag_names_in,
    photometry_view,
)
from destello.pipeline.photometry import PhotResult, forced_photometry, point_reason

# Bit numbers as a FLAGS header would define them; the code reads them from this mapping only.
BITS = {
    "TRANSIENT": 0,
    "OVERFLOW": 1,
    "SUR_ERROR": 2,
    "NONLINEAR": 15,
    "PERSIST": 17,
    "SOURCE": 21,
    "FULLSAMPLE": 12,
    "BLOOM": 26,
}
N = 41
CENTER = 20
SCALE_ARCSEC = 3.1
RA0, DEC0 = 150.0, 2.0


def bit(*names: str) -> int:
    value = 0
    for name in names:
        value |= 1 << BITS[name]
    return value


def make_cal(flags: np.ndarray | None = None) -> CalibratedCutout:
    """A star at the image center on a flat background, with a simple TAN WCS."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crpix = [CENTER + 1, CENTER + 1]
    wcs.wcs.crval = [RA0, DEC0]
    wcs.wcs.cdelt = [-SCALE_ARCSEC / 3600.0, SCALE_ARCSEC / 3600.0]
    yy, xx = np.mgrid[0:N, 0:N].astype(float)
    star = 40.0 * np.exp(-0.5 * ((xx - CENTER) ** 2 + (yy - CENTER) ** 2) / 1.6**2)
    t = Time(60500.0, format="mjd", scale="utc")
    cut = Cutout(
        obs_id="synthetic",
        detector=3,
        image=(star + 5.0).astype(np.float32),
        zodi=np.full((N, N), 2.0, dtype=np.float32),
        variance=np.full((N, N), 0.01, dtype=np.float32),
        flags=np.zeros((N, N), dtype=np.int64) if flags is None else flags,
        wcs=wcs,
        wave_wcs=None,
        det_wcs=None,
        t_start=t,
        t_mid=t,
        t_end=t,
        exposure_s=112.0,
        flag_bits=dict(BITS),
        omega_median_arcsec2=SCALE_ARCSEC**2,
        psf_fwhm_arcsec=None,
    )
    return calibrate(cut)


def phot(cal: CalibratedCutout, masks: str = "photometry") -> PhotResult:
    return forced_photometry(cal, RA0 * u.deg, DEC0 * u.deg, masks=masks)  # type: ignore[arg-type]


def flags_with(value: int, *pixels: tuple[int, int]) -> np.ndarray:
    f = np.zeros((N, N), dtype=np.int64)
    for y, x in pixels:
        f[y, x] |= value
    return f


def test_flag_names_in_skips_informational_flags() -> None:
    f = flags_with(bit("SOURCE", "FULLSAMPLE", "OVERFLOW"), (CENTER, CENTER))
    region = np.zeros((N, N), dtype=bool)
    region[CENTER, CENTER] = True
    assert flag_names_in(f, BITS, region) == ["OVERFLOW"]
    assert flag_names_in(f, BITS, np.zeros((N, N), dtype=bool)) == []


def test_photometry_view_keeps_overflow_and_transient_values() -> None:
    f = np.zeros((N, N), dtype=np.int64)
    f[1, 1] = bit("OVERFLOW")
    f[1, 2] = bit("TRANSIENT")
    f[1, 3] = bit("SUR_ERROR")
    f[1, 4] = bit("BLOOM")
    cal = make_cal(f)
    view = photometry_view(cal)
    assert not view.bad[1, 1] and not view.bad[1, 2]
    assert np.isfinite(view.science[1, 1]) and np.isfinite(view.science[1, 2])
    assert view.bad[1, 3] and view.bad[1, 4]
    assert view.background_bad[1, 1] and view.background_bad[1, 2]
    assert view.saturation[1, 1] and view.saturation[1, 4]
    assert not view.saturation[1, 2] and not view.saturation[1, 3]
    # the coadd mask still excludes OVERFLOW and TRANSIENT
    assert cal.bad[1, 1] and cal.bad[1, 2]


def test_overflow_only_core_is_kept_with_unchanged_flux() -> None:
    clean = phot(make_cal())
    cal = make_cal(flags_with(bit("OVERFLOW"), (CENTER, CENTER), (CENTER, CENTER + 1)))
    res = phot(cal)
    assert point_reason(clean) is None
    assert point_reason(res) is None
    assert not res.core_saturated and not res.core_masked
    assert res.flux_jy == clean.flux_jy
    assert "OVERFLOW" in res.core_flags
    # the coadd mask drops the same pixels and reports a saturated core
    coadd = phot(cal, masks="coadd")
    assert coadd.core_masked and coadd.core_saturated
    assert coadd.flux_jy < clean.flux_jy


def test_early_overflow_in_core_is_saturated() -> None:
    cal = make_cal(flags_with(bit("OVERFLOW", "SUR_ERROR"), (CENTER, CENTER)))
    res = phot(cal)
    assert res.core_saturated
    assert point_reason(res) == "saturated_core"


def test_bloom_in_core_is_saturated() -> None:
    res = phot(make_cal(flags_with(bit("BLOOM"), (CENTER, CENTER + 1))))
    assert point_reason(res) == "saturated_core"


def test_other_flag_in_core_is_core_masked_not_saturated() -> None:
    res = phot(make_cal(flags_with(bit("PERSIST"), (CENTER, CENTER))))
    assert res.core_masked and not res.core_saturated
    assert point_reason(res) == "core_masked"
    assert res.core_flags == ("PERSIST",)


def test_outer_transient_does_not_discard_the_exposure() -> None:
    res = phot(make_cal(flags_with(bit("TRANSIENT"), (CENTER, CENTER + 3))))
    assert point_reason(res) is None
    assert "TRANSIENT" in res.aperture_flags
    assert "TRANSIENT" not in res.core_flags


def test_point_reason_codes() -> None:
    base = PhotResult(1.0, 0.1, 0.0, 49, 49, 0.0, 0.0, 0.0, True, n_background=200)
    assert point_reason(base) is None
    off = PhotResult(float("nan"), float("nan"), float("nan"), 0, 0, 1.0, 0.0, 0.0, False)
    assert point_reason(off) == "off_image"
    no_bkg = PhotResult(1.0, 0.1, 0.0, 49, 49, 0.0, 0.0, 0.0, True, n_background=2)
    assert point_reason(no_bkg) == "no_background"
    none_valid = PhotResult(
        float("nan"), float("nan"), float("nan"), 49, 0, 1.0, 0.0, 0.0, False, n_background=200
    )
    assert point_reason(none_valid) == "no_valid_pixels"
    wide = PhotResult(1.0, 0.1, 0.0, 49, 30, 0.39, 0.0, 0.0, True, n_background=200)
    assert point_reason(wide) == "aperture_masked"
