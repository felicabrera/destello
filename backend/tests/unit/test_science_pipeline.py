"""Unit tests for the measurement functions: centroids, recalibration, motion fit, photometry."""

from __future__ import annotations

import astropy.units as u
import numpy as np
import pytest
from astropy.time import Time

from destello.api.science import epoch_photometry
from destello.pipeline.astrometry import (
    fit_motion,
    fit_recalibration,
    measure_centroid,
    well_spread_epochs,
)
from destello.pipeline.calibrate import surface_brightness_to_jy
from destello.pipeline.photometry import aperture_photometry


def gaussian_image(
    n: int, sources: list[tuple[float, float, float]], sigma: float = 1.5, bkg: float = 2.0
) -> np.ndarray:
    yy, xx = np.mgrid[0:n, 0:n].astype(float)
    img = np.full((n, n), bkg)
    for x, y, amp in sources:
        img += amp * np.exp(-0.5 * ((xx - x) ** 2 + (yy - y) ** 2) / sigma**2)
    return img


# ---------------------------------------------------------------- motion fit
def test_fit_motion_recovers_known_motion_with_parallax_fixed() -> None:
    t = Time("2025-04-01", scale="utc") + np.array([0.0, 180.0, 365.0, 545.0]) * u.day
    pmra, pmdec = 1200.0, -700.0  # mas/yr
    ra0, dec0 = 210.0, 35.0
    dt = t.tdb.jyear - np.mean(t.tdb.jyear)
    ra = ra0 + pmra / 3.6e6 * dt / np.cos(np.radians(dec0))
    dec = dec0 + pmdec / 3.6e6 * dt
    err = np.full(4, 0.2)
    fit = fit_motion(t, ra * u.deg, dec * u.deg, err, err, parallax_mas=0.0)
    assert fit.pmra_cosdec_masyr == pytest.approx(pmra, abs=1.0)
    assert fit.pmdec_masyr == pytest.approx(pmdec, abs=1.0)
    assert fit.parallax_fixed
    assert fit.dof == 4 * 2 - 4
    assert np.all(np.abs(fit.residuals_arcsec) < 1e-3)


def test_fit_motion_two_epochs_has_no_chi2() -> None:
    t = Time([60000.0, 60180.0], format="mjd", scale="utc")
    ra = np.array([10.0, 10.0 + 1e-4])
    dec = np.array([-5.0, -5.0])
    err = np.array([0.3, 0.3])
    fit = fit_motion(t, ra * u.deg, dec * u.deg, err, err)
    assert fit.chi2_red is None
    assert fit.pmra_err_masyr > 0


def test_well_spread_epochs() -> None:
    three = Time([60000.0, 60180.0, 60365.0], format="mjd")
    short = Time([60000.0, 60060.0, 60120.0, 60180.0], format="mjd")
    good = Time([60000.0, 60180.0, 60365.0, 60545.0], format="mjd")
    assert not well_spread_epochs(three)
    assert not well_spread_epochs(short)
    assert well_spread_epochs(good)


# ---------------------------------------------------------------- centroids
def test_centroid_with_masked_core_uses_wings() -> None:
    img = gaussian_image(25, [(12.3, 11.7, 500.0)])
    exclude = np.zeros(img.shape, dtype=bool)
    exclude[10:14, 11:14] = True  # saturated core removed
    img[exclude] = np.nan
    c = measure_centroid(img, np.full(img.shape, 1.0), exclude, 12.0, 12.0)
    assert c is not None
    assert c.x == pytest.approx(12.3, abs=0.05) and c.y == pytest.approx(11.7, abs=0.05)
    assert c.n_pix == 81 - 12


def test_centroid_returns_none_when_fully_masked() -> None:
    img = gaussian_image(25, [(12.0, 12.0, 500.0)])
    exclude = np.zeros(img.shape, dtype=bool)
    exclude[6:19, 6:19] = True
    assert measure_centroid(img, np.full(img.shape, 1.0), exclude, 12.0, 12.0) is None


def test_centroid_neighbor_model_removes_pull() -> None:
    true_x, true_y = 15.0, 15.0
    nb = (17.3, 15.4)  # about 2.3 px away: blended
    img = gaussian_image(31, [(true_x, true_y, 300.0), (nb[0], nb[1], 150.0)])
    var = np.full(img.shape, 1.0)
    plain = measure_centroid(img, var, None, 15.0, 15.0)
    modeled = measure_centroid(img, var, None, 15.0, 15.0, neighbors=[nb])
    assert plain is not None and modeled is not None
    assert abs(plain.x - true_x) > 0.3  # the blend pulls the single Gaussian
    assert modeled.x == pytest.approx(true_x, abs=0.02)
    assert modeled.y == pytest.approx(true_y, abs=0.02)


# ---------------------------------------------------------------- recalibration
def _stars(n: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.uniform(5, 95, size=(n, 2))


def test_recalibration_pure_offset() -> None:
    pred = _stars(12, 1)
    meas = pred + np.array([0.4, -0.25])
    err = np.full(pred.shape, 0.05)
    rec = fit_recalibration(pred, meas, err, (50.0, 50.0))
    assert rec.dx == pytest.approx(0.4, abs=1e-6) and rec.dy == pytest.approx(-0.25, abs=1e-6)
    assert rec.n_stars == 12 and not rec.rotation_fitted
    x, y = rec.correct(30.4, 19.75)
    assert x == pytest.approx(30.0, abs=1e-9) and y == pytest.approx(20.0, abs=1e-9)


def test_recalibration_offset_and_rotation_with_outlier() -> None:
    pred = _stars(20, 2)
    center = (50.0, 50.0)
    theta = np.radians(0.3)
    c, s = np.cos(theta), np.sin(theta)
    rel = pred - np.array(center)
    meas = np.array(center) + np.column_stack(
        [c * rel[:, 0] - s * rel[:, 1], s * rel[:, 0] + c * rel[:, 1]]
    )
    meas += np.array([-0.3, 0.2])
    rng = np.random.default_rng(3)
    meas += rng.normal(0, 0.02, meas.shape)
    meas[5] += [4.0, -3.0]  # mismatched star
    err = np.full(pred.shape, 0.02)
    rec = fit_recalibration(pred, meas, err, center, fit_rotation=True)
    assert rec.rotation_fitted
    assert rec.theta_rad == pytest.approx(theta, abs=np.radians(0.03))
    assert rec.dx == pytest.approx(-0.3, abs=0.02) and rec.dy == pytest.approx(0.2, abs=0.02)
    assert not rec.kept[5] and rec.n_stars == 19
    assert rec.scatter_pix == pytest.approx(0.02, rel=0.5)
    # forward and inverse models are consistent
    fx, fy = rec.apply(*pred[0])
    bx, by = rec.correct(fx, fy)
    assert bx == pytest.approx(pred[0][0], abs=1e-9) and by == pytest.approx(pred[0][1], abs=1e-9)


def test_recalibration_with_no_stars_is_empty() -> None:
    empty = np.zeros((0, 2))
    rec = fit_recalibration(empty, empty, empty, (10.0, 10.0))
    assert rec.n_stars == 0


# ---------------------------------------------------------------- photometry
def test_aperture_photometry_recovers_synthetic_flux() -> None:
    n, sigma, amp, bkg = 61, 1.6, 50.0, 3.0  # MJy/sr
    img = gaussian_image(n, [(30.2, 29.8, amp)], sigma=sigma, bkg=bkg)
    omega = np.full(img.shape, 9.61)  # arcsec^2 per pixel (3.1 arcsec)
    var = np.full(img.shape, 0.01)
    bad = np.zeros(img.shape, dtype=bool)
    sat = np.zeros(img.shape, dtype=bool)
    sat[30, 30] = True
    res = aperture_photometry(
        img, var, bad, omega, 30.2, 29.8, 3.1, aperture_arcsec=20.0,
        annulus_arcsec=(30.0, 60.0), saturated=sat,
    )  # fmt: skip
    expected = float(surface_brightness_to_jy(amp * 2 * np.pi * sigma**2, 9.61))
    assert res.usable
    assert res.flux_jy == pytest.approx(expected, rel=0.01)
    assert res.background_mjy_sr == pytest.approx(bkg, abs=0.01)
    assert res.flux_err_jy > 0
    assert res.saturated_fraction > 0


def test_epoch_photometry_skips_flagged_points() -> None:
    pts = [
        {"epoch": 0, "detector": 3, "wavelength_um": 1.5, "flux": 1.0, "flux_err": 0.1,
         "flagged": False, "saturated": False},
        {"epoch": 0, "detector": 3, "wavelength_um": 1.6, "flux": 3.0, "flux_err": 0.1,
         "flagged": False, "saturated": False},
        {"epoch": 0, "detector": 3, "wavelength_um": 1.7, "flux": 99.0, "flux_err": 0.1,
         "flagged": True, "saturated": True},
    ]  # fmt: skip
    rows = epoch_photometry(pts)
    assert len(rows) == 1
    r = rows[0]
    assert r["flux"] == pytest.approx(2.0)
    assert r["n_images"] == 2 and r["saturated"]
    assert r["flux_err"] == pytest.approx(1.0)  # standard error of the mean dominates


def test_suggest_detector_picks_least_saturated_measurable() -> None:
    from destello.api.science import suggest_detector

    stats: dict[int, dict[str, float | None]] = {
        1: {"n_measured": 0.0, "saturated_fraction": 1.0},
        2: {"n_measured": 3.0, "saturated_fraction": 0.4},
        3: {"n_measured": 3.0, "saturated_fraction": 0.0},
        4: {"n_measured": 1.0, "saturated_fraction": 0.0},
        5: {"n_measured": 3.0, "saturated_fraction": None},
    }
    assert suggest_detector(stats, 1) == 3
    assert suggest_detector({1: stats[1], 4: stats[4]}, 1) is None
