from typing import Any

import numpy as np
import pytest

from destello.pipeline.difference import difference, difference_scale


def star_field(n: int = 140, n_stars: int = 25, seed: int = 3) -> tuple[Any, Any, Any]:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n]
    img = np.zeros((n, n))
    pos: list[tuple[float, float]] = []
    while len(pos) < n_stars:
        x, y = rng.uniform(15, n - 15, 2)
        if all(np.hypot(x - a, y - b) > 14 for a, b in pos):
            pos.append((x, y))
            flux = rng.uniform(20, 120)
            img += flux * np.exp(-0.5 * ((xx - x) ** 2 + (yy - y) ** 2) / 1.6**2)
    return img, xx, yy


def blob(xx: Any, yy: Any, x: float, y: float, flux: float) -> Any:
    return flux * np.exp(-0.5 * ((xx - x) ** 2 + (yy - y) ** 2) / 1.6**2)


def test_scale_recovered_within_1_percent_with_a_mover() -> None:
    stars, xx, yy = star_field()
    rng = np.random.default_rng(9)
    true_s = 1.07
    b = stars + blob(xx, yy, 30.3, 70.2, 90) + rng.normal(0, 0.3, stars.shape)
    a = true_s * stars + blob(xx, yy, 36.8, 70.4, 90) + rng.normal(0, 0.3, stars.shape)
    res = difference(a, b)
    assert res.n_stars >= 3
    assert res.scale == pytest.approx(true_s, rel=0.01)


def test_mover_appears_as_dipole() -> None:
    stars, xx, yy = star_field()
    b = stars + blob(xx, yy, 30, 70, 100)
    a = stars + blob(xx, yy, 38, 70, 100)
    res = difference(a, b)
    assert res.diff[70, 38] > 50 and res.diff[70, 30] < -50


def test_nan_pixels_propagate_and_do_not_break() -> None:
    stars, _, _ = star_field()
    a = stars.copy()
    b = stars.copy()
    a[5:9, 5:9] = np.nan
    res = difference(a, b)
    assert np.isnan(res.diff[6, 6]) and res.scale == pytest.approx(1.0, rel=0.01)


def test_few_stars_returns_unity() -> None:
    flat = np.random.default_rng(1).normal(0, 1, (60, 60))
    s, n = difference_scale(flat, flat)
    assert s == 1.0 and n < 3


def test_aperture_flux_near_border_does_not_raise() -> None:
    from destello.pipeline.difference import aperture_flux

    img = np.zeros((40, 40), dtype=np.float32)
    img[38, 20] = 5.0
    for y in (8.0, 31.0, 31.9, 32.0):
        aperture_flux(img, 20.0, y)  # must return a float or NaN, never raise


def test_aperture_flux_edge_regression_every_position() -> None:
    """Regression: no position inside or near the array may raise (edge slicing bug)."""
    from destello.pipeline.difference import aperture_flux

    rng = np.random.default_rng(0)
    img = rng.normal(0, 1, (37, 41))
    for y in np.linspace(-3, 40, 87):
        for x in np.linspace(-3, 44, 95):
            v = aperture_flux(img, float(x), float(y))
            assert isinstance(v, float)
    assert np.isnan(aperture_flux(img, float("nan"), 10.0))
    assert np.isfinite(aperture_flux(img, 20.0, 18.0))


def test_difference_with_star_at_border() -> None:
    stars, xx, yy = star_field()
    a = stars + blob(xx, yy, 1.5, 70.0, 300.0) + blob(xx, yy, 138.6, 2.0, 300.0)
    res = difference(a, a)
    assert res.diff.shape == a.shape


# ------------------------------------------------------------------ registration (wave 6)
def shifted_field(dx: float, dy: float, n: int = 140, n_stars: int = 30, seed: int = 5) -> Any:
    """Gaussian stars rendered analytically at positions offset by (dx, dy)."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n]
    img = np.zeros((n, n))
    pos: list[tuple[float, float]] = []
    while len(pos) < n_stars:
        x, y = rng.uniform(15, n - 15, 2)
        if all(np.hypot(x - a, y - b) > 12 for a, b in pos):
            pos.append((x, y))
            img += rng.uniform(40, 150) * np.exp(
                -0.5 * ((xx - x - dx) ** 2 + (yy - y - dy) ** 2) / 1.4**2
            )
    return img


def test_registration_recovers_subpixel_shift() -> None:
    from destello.pipeline.difference import measure_registration

    rng = np.random.default_rng(2)
    a = shifted_field(0.0, 0.0) + rng.normal(0, 0.2, (140, 140))
    b = shifted_field(-0.3, 0.2) + rng.normal(0, 0.2, (140, 140))
    reg = measure_registration(a, b)
    assert reg.n_stars >= 10 and reg.applied
    assert reg.dx == pytest.approx(0.3, abs=0.02) and reg.dy == pytest.approx(-0.2, abs=0.02)
    assert 0 < reg.dx_err < 0.02 and 0 < reg.dy_err < 0.02


def test_registration_not_applied_when_aligned_or_too_few_stars() -> None:
    from destello.pipeline.difference import measure_registration

    rng = np.random.default_rng(4)
    a = shifted_field(0.0, 0.0) + rng.normal(0, 0.2, (140, 140))
    b = shifted_field(0.0, 0.0) + rng.normal(0, 0.2, (140, 140))
    assert not measure_registration(a, b).applied
    flat = rng.normal(0, 1, (80, 80))
    few = measure_registration(flat, flat)
    assert not few.applied and few.n_stars < 5 and np.isnan(few.dx_err)


def test_registered_difference_removes_shift_residual() -> None:
    rng = np.random.default_rng(6)
    a = shifted_field(0.0, 0.0) + rng.normal(0, 0.2, (140, 140))
    b = shifted_field(-0.35, 0.25) + rng.normal(0, 0.2, (140, 140))
    raw = difference(a, b, register=False)
    reg = difference(a, b)
    assert reg.registration.applied
    inner = (slice(10, 130), slice(10, 130))
    rms_raw = float(np.sqrt(np.nanmean(raw.diff[inner] ** 2)))
    rms_reg = float(np.sqrt(np.nanmean(reg.diff[inner] ** 2)))
    assert rms_reg < 0.3 * rms_raw


def test_registration_ignores_excluded_mover() -> None:
    from destello.pipeline.difference import field_stars

    a = shifted_field(0.0, 0.0)
    stars = field_stars(a, a)
    x0, y0 = stars[0]
    kept = field_stars(a, a, exclude_xy=[(x0, y0)], exclude_radius=5.0)
    assert (x0, y0) not in kept and len(kept) == len(stars) - 1


def test_mover_dipole_survives_registration() -> None:
    stars, xx, yy = star_field()
    b = stars + blob(xx, yy, 30, 70, 100)
    a = stars + blob(xx, yy, 38, 70, 100)
    res = difference(a, b, exclude_xy=[(34.0, 70.0)])
    assert res.diff[70, 38] > 50 and res.diff[70, 30] < -50


def test_shift_image_moves_content_and_keeps_nan() -> None:
    from destello.pipeline.difference import shift_image

    _, xx, yy = star_field(n=60, n_stars=0)
    img = blob(xx, yy, 30.0, 30.0, 10.0)
    img[5, 5] = np.nan
    out = shift_image(img, 0.5, -1.0)
    iy, ix = np.unravel_index(np.nanargmax(out), out.shape)
    assert (iy, ix) in {(29, 30), (29, 31)}
    # the bad pixel moved with the content and spoiled its neighbourhood, never filled in
    assert np.isnan(out[4, 5]) or np.isnan(out[4, 6])
    # content shifted in from outside the array has no data
    assert np.isnan(out[-1, :]).all()
    assert np.isfinite(out[30, 30])


def test_static_residual_fraction_and_noise_model() -> None:
    from destello.pipeline.difference import (
        difference_noise,
        field_stars,
        static_residual_fraction,
    )

    rng = np.random.default_rng(8)
    n = 140
    yy, xx = np.mgrid[0:n, 0:n]
    a = np.zeros((n, n))
    b = np.zeros((n, n))
    pos: list[tuple[float, float]] = []
    while len(pos) < 20:
        x, y = rng.uniform(15, n - 15, 2)
        if all(np.hypot(x - p, y - q) > 14 for p, q in pos):
            pos.append((x, y))
            f = rng.uniform(80, 200)
            r2 = (xx - x) ** 2 + (yy - y) ** 2
            a += f * np.exp(-0.5 * r2 / 1.40**2) / 1.40**2
            b += f * np.exp(-0.5 * r2 / 1.47**2) / 1.47**2  # 5 percent wider PSF in B
    var = np.full((n, n), 0.01)
    a += rng.normal(0, 0.1, (n, n))
    b += rng.normal(0, 0.1, (n, n))
    d = a - b
    noise = np.sqrt(2 * var)
    stars = field_stars(a, b)
    eps = static_residual_fraction(d, a, b, noise, stars)
    assert 0.02 < eps < 0.3
    model = difference_noise(var, var, 1.0, a, b, eps)
    # at a static star the residual term dominates; on empty sky only the pixel noise remains
    x0, y0 = stars[0]
    assert model[int(y0), int(x0)] > 5 * noise[int(y0), int(x0)]
    assert model[2, 2] == pytest.approx(noise[2, 2], rel=0.05)
    # a source present in only one epoch has no shared flux: judged on pixel noise alone
    a2 = a + blob(xx, yy, 8.0, 8.0, 50.0)
    m2 = difference_noise(var, var, 1.0, a2, b, eps)
    assert m2[8, 8] == pytest.approx(noise[8, 8], rel=0.05)
    assert np.isnan(static_residual_fraction(d, a, b, noise, []))
