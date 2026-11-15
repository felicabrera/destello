"""Coaddition per (epoch, detector): plain inverse-variance mean over unmasked samples."""

from __future__ import annotations

import numpy as np

from destello.pipeline.coadd import coadd_stack


def test_bright_pixel_scatter_is_kept() -> None:
    """A star pixel whose value changes by a factor of 4 between exposures (PSF phase and
    wavelength under the linear variable filter) keeps every sample: the coadd is the
    inverse-variance mean of all of them, never a subset chosen per pixel."""
    values = [0.57, 0.9, 1.2, 1.6, 2.18, 0.8, 1.1]
    images = [np.full((3, 3), v) for v in values]
    variances = [np.full((3, 3), 0.01) for _ in values]
    c = coadd_stack(images, variances)
    assert np.all(c.n_used == len(values))
    np.testing.assert_allclose(c.mean, np.mean(values), rtol=1e-6)
    np.testing.assert_allclose(c.variance, 0.01 / len(values), rtol=1e-6)


def test_inverse_variance_weights() -> None:
    images = [np.full((2, 2), 1.0), np.full((2, 2), 4.0)]
    variances = [np.full((2, 2), 1.0), np.full((2, 2), 4.0)]
    c = coadd_stack(images, variances)
    # weights 1 and 1/4: (1 + 1) / 1.25
    np.testing.assert_allclose(c.mean, 1.6, rtol=1e-6)
    np.testing.assert_allclose(c.variance, 0.8, rtol=1e-6)


def test_masked_samples_are_skipped_and_blank_pixels_stay_nan() -> None:
    a = np.array([[1.0, np.nan], [2.0, np.nan]])
    b = np.array([[3.0, 5.0], [np.nan, np.nan]])
    va = np.ones((2, 2))
    vb = np.array([[1.0, 1.0], [1.0, 0.0]])  # a zero variance is not a valid sample
    c = coadd_stack([a, b], [va, vb])
    assert c.n_used.tolist() == [[2, 1], [1, 0]]
    assert c.mean[0, 0] == 2.0 and c.mean[0, 1] == 5.0 and c.mean[1, 0] == 2.0
    assert np.isnan(c.mean[1, 1]) and np.isnan(c.variance[1, 1])
    assert c.blank.tolist() == [[False, False], [False, True]]
    assert c.n_input == 2
