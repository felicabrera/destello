"""Moving-target science helpers (F-33): parallax, discovery ADQL, band excess, V-14 bound."""

from __future__ import annotations

import math

import numpy as np
import pytest

from destello.pipeline.movers import (
    AU_KM,
    angular_sep_arcsec,
    band_excess,
    ephemeris_check,
    interpolate_track,
    moving_discovery_adql,
    parallax_bound_arcsec,
    topocentric,
    v14_bound,
    v14_summary,
)
from destello.sources.movers import iso_weeks, record_from_key
from destello.sources.s3 import S3Unavailable


def test_topocentric_shift_matches_small_angle_bound() -> None:
    # Spacecraft 7000 km away perpendicular to the line of sight: shift = r / delta.
    ra, dec, shift = topocentric(0.0, 0.0, 1.8, (0.0, 7000.0, 0.0))
    assert shift == pytest.approx(parallax_bound_arcsec(7000.0, 1.8), rel=1e-6)
    assert shift == pytest.approx(7000.0 / (1.8 * AU_KM) * 206264.806, rel=1e-6)
    # Observer moved towards +y: the body appears displaced towards -y (RA decreases).
    assert ra > 359.0 and dec == pytest.approx(0.0, abs=1e-12)
    # Along the line of sight: no shift.
    _, _, s0 = topocentric(10.0, 20.0, 1.8, tuple(7000.0 * np.array([
        math.cos(math.radians(20)) * math.cos(math.radians(10)),
        math.cos(math.radians(20)) * math.sin(math.radians(10)),
        math.sin(math.radians(20)),
    ])))  # fmt: skip
    assert s0 == pytest.approx(0.0, abs=1e-6)


def test_header_bounds_of_the_spike() -> None:
    # 3I/ATLAS: r_sc up to 7041 km; delta about 2.6 au in August and 1.8 au in December 2025.
    assert parallax_bound_arcsec(7041.0, 2.62) == pytest.approx(3.7, abs=0.05)
    assert parallax_bound_arcsec(7041.0, 1.80) == pytest.approx(5.4, abs=0.05)


def test_interpolate_track_wraps_ra() -> None:
    ra, dec = interpolate_track(1.5, np.array([1.0, 2.0]), np.array([359.9, 0.1]), np.array([0, 0]))
    assert ra == pytest.approx(0.0, abs=1e-6) or ra == pytest.approx(360.0, abs=1e-6)
    assert dec == pytest.approx(0.0, abs=1e-9)


def test_moving_discovery_adql_has_one_contains_and_time_window() -> None:
    q = moving_discovery_adql(173.8, 2.8, 61017.0, 61017.05, ["spherex_dr1"])
    assert q.count("CONTAINS") == 1
    assert "p.time_bounds_lower >= 61017.000000" in q
    assert q.endswith("ORDER BY p.time_bounds_lower")
    with pytest.raises(ValueError):
        moving_discovery_adql(1, 2, 3, 4, ["x'; drop"])


def _pts(wl: list[float], f: list[float], err: float = 0.01) -> list[dict[str, object]]:
    return [
        {"wavelength_um": w, "flux": v, "flux_err": err, "flagged": False}
        for w, v in zip(wl, f, strict=True)
    ]


def test_band_excess_flat_continuum_and_emission() -> None:
    blue = _pts([4.05, 4.10, 4.15], [1.0, 1.01, 0.99])
    red = _pts([4.35, 4.40, 4.45], [1.0, 0.99, 1.01])
    flat = band_excess(blue + red + _pts([4.24, 4.26], [1.0, 1.0]), "co2")
    assert flat["excess"] == pytest.approx(0.0, abs=0.02)
    assert abs(flat["significance"]) < 3
    em = band_excess(blue + red + _pts([4.24, 4.26], [1.5, 1.52]), "co2")
    assert em["excess"] == pytest.approx(0.51, abs=0.03)
    assert em["significance"] > 3
    # A flagged band point does not count; with one point left the band is not measurable.
    flagged = (
        blue
        + red
        + _pts([4.24], [1.5])
        + [{"wavelength_um": 4.25, "flux": 9.0, "flux_err": 0.01, "flagged": True}]
    )
    nm = band_excess(flagged, "co2")
    assert nm["excess"] is None and nm["reason"] == "window_not_measurable:band"
    assert nm["n_points"]["band"] == 1


def test_band_excess_only_point_count_makes_it_not_measurable() -> None:
    blue = _pts([4.05, 4.10, 4.15], [1.0, 1.01, 0.99])
    red = _pts([4.35, 4.40, 4.45], [1.0, 0.99, 1.01])
    # Two band points with a mean below 3 sigma: measured (version 2), not significant.
    noisy = band_excess(blue + red + _pts([4.24, 4.26], [0.4, -0.3], err=0.5), "co2")
    assert noisy["reason"] is None and noisy["method_version"] == "2"
    assert noisy["windows"]["band"]["n_points"] == 2
    assert noisy["windows"]["band"]["snr"] < 3
    assert noisy["significance"] is not None and noisy["significance"] < 3
    # Too few points: not measurable, with the points reason.
    few = band_excess(blue + red + _pts([4.24], [1.5]), "co2")
    assert few["excess"] is None and few["significance"] is None
    assert few["reason"] == "window_not_measurable:band"
    assert few["windows"]["band"]["n_points"] == 1
    assert few["windows"]["band"]["snr"] is None


def test_band_excess_detected_continuum_keeps_log_interpolation() -> None:
    blue = _pts([4.05, 4.10, 4.15], [1.0, 1.01, 0.99])
    red = _pts([4.35, 4.40, 4.45], [2.0, 1.99, 2.01])
    r = band_excess(blue + red + _pts([4.24, 4.26], [3.0, 3.02]), "co2")
    lb, lc, lr = 4.10, 4.25, 4.40
    x = math.log(lc / lb) / math.log(lr / lb)
    assert r["continuum_detected"] is True and r["continuum_interpolation"] == "log"
    assert r["continuum_flux_jy"] == pytest.approx(2.0**x, rel=1e-9)
    assert r["excess"] == pytest.approx(3.01 / 2.0**x - 1.0, rel=1e-9)


def test_band_excess_undetected_continuum_is_a_difference_with_upper_limit() -> None:
    # Emission band over a continuum that is not detected in either window.
    blue = _pts([4.05, 4.10, 4.15], [0.02, -0.01, 0.02], err=0.05)
    red = _pts([4.35, 4.40, 4.45], [0.03, 0.0, 0.0], err=0.05)
    r = band_excess(blue + red + _pts([4.24, 4.26], [1.0, 1.1], err=0.05), "co2")
    assert r["reason"] is None and r["continuum_detected"] is False
    assert r["continuum_interpolation"] == "linear"
    assert r["excess"] is None and r["excess_err"] is None  # a ratio is not defined here
    x = math.log(4.25 / 4.10) / math.log(4.40 / 4.10)
    fb, fr = 0.01, 0.01
    assert r["continuum_flux_jy"] == pytest.approx((1 - x) * fb + x * fr, rel=1e-9)
    eb = max(0.05 * math.sqrt(3) / 3, float(np.std([0.02, -0.01, 0.02], ddof=1)) / math.sqrt(3))
    er = max(0.05 * math.sqrt(3) / 3, float(np.std([0.03, 0.0, 0.0], ddof=1)) / math.sqrt(3))
    ce = math.hypot((1 - x) * eb, x * er)
    assert r["continuum_flux_err_jy"] == pytest.approx(ce, rel=1e-9)
    ec = max(0.05 * math.sqrt(2) / 2, float(np.std([1.0, 1.1], ddof=1)) / math.sqrt(2))
    assert r["significance"] == pytest.approx((1.05 - r["continuum_flux_jy"]) / math.hypot(ec, ce))
    up = r["continuum_flux_jy"] + 3 * ce
    assert r["continuum_upper_limit_jy"] == pytest.approx(up)
    assert r["significance_vs_upper_limit"] == pytest.approx((1.05 - up) / ec)
    # No emission over the same undetected continuum: measured, not significant.
    flat = band_excess(blue + red + _pts([4.24, 4.26], [0.0, 0.02], err=0.05), "co2")
    assert flat["reason"] is None and abs(flat["significance"]) < 3


def test_band_excess_power_law_continuum_is_one() -> None:
    def pl(w: float) -> float:
        return 2.0 * (w / 4.0) ** 3

    wl = [4.02, 4.10, 4.16, 4.24, 4.26, 4.35, 4.42, 4.49]
    r = band_excess(_pts(wl, [pl(w) for w in wl], err=1e-4), "co2")
    assert r["excess"] == pytest.approx(0.0, abs=2e-3)


def test_v14_bound_terms() -> None:
    assert v14_bound(0.0, 0.0) == pytest.approx(math.hypot(3.1, 1.0))
    assert v14_bound(1.0, 1.9) == pytest.approx(math.sqrt(3.1**2 + 1.9**2 + 1.0 + 9.0))


def test_ephemeris_check_recovers_synthetic_offset() -> None:
    # Synthetic Gaussian 1.2 px east of the prediction on a 6.2 arcsec grid (x grows to the east
    # here: pix2world maps x to RA directly).
    ny = nx = 41
    yy, xx = np.mgrid[0:ny, 0:nx]
    img = 100.0 * np.exp(-0.5 * (((xx - 21.2) / 1.2) ** 2 + ((yy - 20.0) / 1.2) ** 2)) + 1.0
    rng = np.random.default_rng(1)
    img = img + rng.normal(0, 0.5, img.shape)
    var = np.full(img.shape, 0.25)
    bad = np.zeros(img.shape, dtype=bool)
    scale = 6.2

    def p2w(x: float, y: float) -> tuple[float, float]:
        return 10.0 + (x - 20.0) * scale / 3600.0, (y - 20.0) * scale / 3600.0

    c = ephemeris_check(img, var, bad, 20.0, 20.0, scale, p2w, 10.0, 0.0, 0.1)
    assert c.measured
    assert c.dra_arcsec == pytest.approx(1.2 * 6.2, abs=0.3)
    expected = angular_sep_arcsec(10.0, 0.0, 10.0 + 7.44 / 3600, 0.0)
    assert c.offset_arcsec == pytest.approx(expected, abs=0.3)
    assert c.within is False  # 7.4 arcsec is outside sqrt(3.1^2 + 1 + small)


def test_v14_summary_rules() -> None:
    rows = [{"measured": True, "within": True, "offset_arcsec": 1.0}] * 9
    assert v14_summary(rows)["status"] == "not_measurable"
    rows = rows + [{"measured": True, "within": False, "offset_arcsec": 9.0}]
    s = v14_summary(rows)
    assert s["status"] == "pass" and s["fraction_within"] == pytest.approx(0.9)
    s = v14_summary(rows + [{"measured": True, "within": False, "offset_arcsec": 9.0}])
    assert s["status"] == "fail"


def test_iso_weeks_and_record_from_key() -> None:
    from astropy.time import Time

    w = iso_weeks(Time("2025-12-01"), Time("2026-01-01"), margin_days=0)
    assert (2025, 49) in w and (2026, 1) in w and (2025, 48) not in w
    key = (
        "dr1/level2/2025W50_1A/l2b-v27-2026-209/1/"
        "level2_2025W50_1A_0002_1D1_spx_l2b-v27-2026-209.fits"
    )
    rec = record_from_key(
        key,
        {"DETECTOR": 1, "MJD-BEG": 61017.0045, "MJD-END": 61017.0058, "OBSID": "2025W50_1A_0002_1",
         "XPOSURE": 113.58},
    )  # fmt: skip
    assert rec.collection == "spherex_dr1" and rec.detector == 1
    assert rec.uri == "ibe/data/spherex/" + key
    assert rec.observation_id == "2025W50_1A_0002_1"
    with pytest.raises(S3Unavailable):
        record_from_key("../x.fits", {"DETECTOR": 1, "MJD-BEG": 1, "MJD-END": 2})


def test_mover_masks_keep_outlier_pixels_and_hardware_flags() -> None:
    from destello.pipeline.calibrate import BACKGROUND_MASK_FLAGS
    from destello.pipeline.movers import MOVER_MASK_FLAGS, MOVER_PHOTOMETRY_MASK_FLAGS

    assert "OUTLIER" not in MOVER_MASK_FLAGS and "OUTLIER" not in MOVER_PHOTOMETRY_MASK_FLAGS
    for f in ("SUR_ERROR", "NONFUNC", "HOT", "PERSIST", "MISSING_DATA"):
        assert f in MOVER_MASK_FLAGS and f in MOVER_PHOTOMETRY_MASK_FLAGS
    for f in ("BLOOM", "HALO", "SNOWBALL"):
        assert f in MOVER_PHOTOMETRY_MASK_FLAGS
    assert "OVERFLOW" in MOVER_MASK_FLAGS
    assert "OUTLIER" in BACKGROUND_MASK_FLAGS  # the annulus keeps the Supplement background list
