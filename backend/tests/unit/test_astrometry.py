from typing import Any

import astropy.units as u
import numpy as np
import pytest
from astropy.time import Time

from destello.pipeline.astrometry import agreement_sigma, fit_motion, fit_offset, measure_centroid
from destello.pipeline.propagate import parallax_factors


def synth(
    n_epochs: int, noise: float, seed: int, pm: tuple[float, float] = (-8021.0, 1036.0)
) -> tuple[Time, Any, Any, Any]:
    plx = 449.0
    rng = np.random.default_rng(seed)
    t = Time("2025-08-15", scale="utc") + np.linspace(0, 420, n_epochs) * u.day
    ra0, dec0 = 133.79, -7.24
    pa, pd = parallax_factors(ra0 * u.deg, dec0 * u.deg, t)
    dt = t.tdb.jyear - np.mean(t.tdb.jyear)
    x = pm[0] / 1000 * dt + plx / 1000 * pa + rng.normal(0, noise, n_epochs)
    y = pm[1] / 1000 * dt + plx / 1000 * pd + rng.normal(0, noise, n_epochs)
    ra = ra0 + x / 3600 / np.cos(np.radians(dec0))
    dec = dec0 + y / 3600
    err = np.full(n_epochs, max(noise, 0.01))
    return t, ra * u.deg, dec * u.deg, err


def test_noise_free_recovery_three_epochs_parallax_fixed() -> None:
    t, ra, dec, err = synth(3, 0.0, 1)
    fit = fit_motion(t, ra, dec, err, err, parallax_mas=449.0)
    assert fit.parallax_fixed
    assert fit.pmra_cosdec_masyr == pytest.approx(-8021.0, abs=0.5)
    assert fit.pmdec_masyr == pytest.approx(1036.0, abs=0.5)


def test_noisy_recovery_within_uncertainty() -> None:
    misses = 0
    for seed in range(40):
        t, ra, dec, err = synth(4, 0.5, seed)
        fit = fit_motion(t, ra, dec, err, err, parallax_mas=449.0)
        if abs(fit.pmra_cosdec_masyr + 8021.0) > 3 * fit.pmra_err_masyr:
            misses += 1
        if abs(fit.pmdec_masyr - 1036.0) > 3 * fit.pmdec_err_masyr:
            misses += 1
    assert misses <= 2  # 3 sigma: expect almost none of 80 comparisons


def test_parallax_fit_requires_four_epochs() -> None:
    t, ra, dec, err = synth(3, 0.0, 1)
    assert fit_motion(t, ra, dec, err, err, 449.0, fit_parallax=True).parallax_fixed
    t, ra, dec, err = synth(6, 0.0, 1)
    fit = fit_motion(t, ra, dec, err, err, 449.0, fit_parallax=True)
    assert not fit.parallax_fixed and fit.parallax_mas == pytest.approx(449.0, rel=0.02)


def test_agreement_sigma() -> None:
    t, ra, dec, err = synth(4, 0.5, 5)
    fit = fit_motion(t, ra, dec, err, err, 449.0)
    s = agreement_sigma(fit, -8021.0, 1036.0)
    assert 0 <= s < 4


def test_centroid_ignores_flagged_pixels() -> None:
    yy, xx = np.mgrid[0:21, 0:21]
    img = 100 * np.exp(-0.5 * ((xx - 10.3) ** 2 + (yy - 9.6) ** 2) / 1.5**2) + 1.0
    img[9, 10] = 5000.0  # saturated artifact
    bad = np.zeros_like(img, dtype=bool)
    bad[9, 10] = True
    c = measure_centroid(img, np.full(img.shape, 1.0), bad, 10, 10)
    assert c is not None
    assert c.x == pytest.approx(10.3, abs=0.1) and c.y == pytest.approx(9.6, abs=0.1)


def test_fit_offset_rejects_mismatch() -> None:
    pred = np.array([[10, 10], [30, 12], [50, 40], [70, 70], [20, 60]], float)
    meas = pred + np.array([0.4, -0.3])
    meas[2] += [9, 9]  # a bad match
    off = fit_offset(pred, meas)
    assert off.dx == pytest.approx(0.4, abs=0.05) and off.dy == pytest.approx(-0.3, abs=0.05)
    assert off.n_stars == 4
