"""PSF wing centroid, offset combination and wing ring photometry (saturated sources)."""

import numpy as np

from destello.pipeline.astrometry import combine_offsets, measure_wing_centroid
from destello.pipeline.photometry import wing_annulus_flux


def moffat_image(
    xc: float, yc: float, amp: float = 5000.0, n: int = 41, noise: float = 1.0, seed: int = 3
) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    r2 = (xx - xc) ** 2 + (yy - yc) ** 2
    img = amp * (1.0 + r2 / 2.0**2) ** -1.8 + 10.0
    rng = np.random.default_rng(seed)
    img = img + rng.normal(0.0, noise, img.shape)
    return img, np.full(img.shape, noise**2)


def core_mask(n: int, xc: float, yc: float, r: float) -> np.ndarray:
    yy, xx = np.mgrid[0:n, 0:n]
    return np.hypot(xx - xc, yy - yc) <= r


def test_wing_centroid_recovers_offset_with_masked_core() -> None:
    xc, yc = 20.7, 19.4
    img, var = moffat_image(xc, yc)
    mask = core_mask(41, xc, yc, 4.0)
    img[mask] = np.nan  # saturated core: no valid value
    c = measure_wing_centroid(img, var, mask, 20.0, 20.0, r_max_pix=14.0, max_shift_pix=3.0)
    assert c is not None
    assert abs(c.x - xc) < 0.05 and abs(c.y - yc) < 0.05
    assert c.x_err > 0 and c.y_err > 0


def test_wing_centroid_rejects_one_sided_wing() -> None:
    img, var = moffat_image(20.0, 20.0)
    mask = core_mask(41, 20.0, 20.0, 4.0)
    mask[:, :20] = True  # half the wing masked: an empty azimuthal sector
    assert measure_wing_centroid(img, var, mask, 20.0, 20.0) is None


def test_wing_centroid_rejects_center_on_shift_bound() -> None:
    img, var = moffat_image(27.0, 20.0)
    mask = core_mask(41, 27.0, 20.0, 3.0)
    assert measure_wing_centroid(img, var, mask, 20.0, 20.0, max_shift_pix=2.0) is None


def test_combine_offsets_clips_outlier_and_uses_scatter() -> None:
    dx = np.array([0.10, 0.12, 0.08, 0.11, 0.09, 3.0])
    dy = np.array([-0.2, -0.21, -0.19, -0.2, -0.22, -0.2])
    e = np.full(6, 0.001)
    c = combine_offsets(dx, dy, e, e)
    assert c is not None
    assert c.n_used == 5 and c.n_total == 6
    assert abs(c.dx - 0.10) < 1e-9
    # formal errors are tiny: the error of the mean comes from the scatter
    assert abs(c.dx_err - float(np.std(dx[:5], ddof=1)) / np.sqrt(5)) < 1e-12


def test_combine_offsets_needs_two() -> None:
    one = np.array([0.1])
    assert combine_offsets(one, one, one, one) is None


def ring_scene(scale: float, n: int = 121) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:n, 0:n].astype(np.float64)
    r = np.hypot(xx - 60.0, yy - 60.0) * 3.1
    wing = 1.0e4 * (1.0 + (r / 6.0) ** 2) ** -1.5
    return 2.0 + scale * wing, np.full((n, n), 30.0)


def test_wing_ring_flux_ratio_measures_brightness_change() -> None:
    a, omega = ring_scene(1.0)
    b, _ = ring_scene(0.5)
    bad = np.zeros(a.shape, dtype=bool)
    bad[55:66, 55:66] = True  # saturated core is outside the ring and does not matter
    fa = wing_annulus_flux(a, bad, omega, 60.0, 60.0, 3.1)
    fb = wing_annulus_flux(b, bad, omega, 60.0, 60.0, 3.1)
    assert fa.reason is None and fb.reason is None
    # the wing at the background radius biases both by the same fraction
    assert abs(fb.flux_jy / fa.flux_jy - 0.5) < 1e-6


def test_wing_ring_partial_mask_is_filled_by_bin_mean() -> None:
    a, omega = ring_scene(1.0)
    bad = np.zeros(a.shape, dtype=bool)
    full = wing_annulus_flux(a, bad, omega, 60.0, 60.0, 3.1)
    bad[60:, 80:] = True  # a corner of the ring masked, every bin keeps most pixels
    part = wing_annulus_flux(a, bad, omega, 60.0, 60.0, 3.1)
    assert part.reason is None
    # residual from the radial gradient inside each one-pixel bin and the changed background set
    assert abs(part.flux_jy / full.flux_jy - 1.0) < 5e-3


def test_wing_ring_rejects_masked_bin_and_off_image() -> None:
    a, omega = ring_scene(1.0)
    bad = np.zeros(a.shape, dtype=bool)
    bad[:, :] = True
    bad[:5, :] = False
    reason = wing_annulus_flux(a, bad, omega, 60.0, 60.0, 3.1).reason
    assert reason in ("wing_masked", "no_background")
    ok = np.zeros(a.shape, dtype=bool)
    assert wing_annulus_flux(a, ok, omega, -5.0, 60.0, 3.1).reason == "off_image"
