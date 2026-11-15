"""Difference imaging: inter-epoch registration, robust field-star flux scale and a noise model
for the difference (docs/03 section 4.3).

Pure functions: arrays and pixel positions in, arrays and numbers out. No network, no files.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from photutils.detection import find_peaks
from scipy.ndimage import binary_dilation
from scipy.ndimage import shift as ndi_shift
from scipy.spatial import cKDTree

from destello.pipeline.astrometry import measure_centroid

FloatArray = npt.NDArray[np.floating]

# Bumped whenever the difference algorithm changes; part of the API difference cache key.
DIFFERENCE_METHOD_VERSION = "2"

REG_MIN_STARS = 5  # isolated field stars needed to estimate the inter-epoch shift
REG_MAX_CENTROID_ERR_PIX = 0.2  # per-star centroid error accepted for registration
REG_SIGNIFICANCE = 3.0  # apply the shift only when |shift| exceeds this many standard errors
REG_MAX_SHIFT_PIX = 2.0  # larger measured shifts are not trusted (recorded, not applied)
REG_MIN_SHIFT_PIX = 0.02  # smaller shifts are not worth a resampling (0.06 arcsec)
EXCLUDE_RADIUS_PIX = 10.0  # default exclusion radius around `exclude_xy` positions
RESID_MIN_SNR = 10.0  # core pixels used for the static residual fraction: shared flux S/N
RESID_CORE_PIX = 2.0  # core radius (pixels) for the static residual fraction


@dataclass(frozen=True)
class Registration:
    """Residual shift of epoch B relative to epoch A measured on field stars, in grid pixels.

    `dx`, `dy` are the median of (centroid in A - centroid in B): B is resampled by (+dx, +dy)
    so that its stars land on the A positions. `applied` is False when too few stars were
    usable, the shift is not significant, too small to matter, or implausibly large.
    """

    dx: float
    dy: float
    dx_err: float
    dy_err: float
    n_stars: int
    applied: bool


NO_REGISTRATION = Registration(0.0, 0.0, float("nan"), float("nan"), 0, False)


@dataclass(frozen=True)
class DifferenceResult:
    """D = A - scale * B' (B' is B after registration) and the evidence for each step."""

    diff: FloatArray
    scale: float
    n_stars: int
    registration: Registration = NO_REGISTRATION
    b_registered: FloatArray | None = None


def _robust_sigma(img: FloatArray) -> float:
    f = img[np.isfinite(img)]
    if f.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(f - np.median(f))))


def aperture_flux(
    image: FloatArray,
    x: float,
    y: float,
    r_ap: float = 2.5,
    r_in: float = 5.0,
    r_out: float = 8.0,
) -> float:
    """Background subtracted aperture sum (image units x pixels) around (x, y) in pixels.

    Returns NaN when the aperture or annulus touches the edge or contains no finite data.
    """
    ny, nx = image.shape
    if not (np.isfinite(x) and np.isfinite(y)):
        return float("nan")
    if x - r_out < 0 or y - r_out < 0 or x + r_out > nx - 1 or y + r_out > ny - 1:
        return float("nan")
    # Clip the window to the array on both sides so a slice can never run past the edge.
    y0, y1 = max(int(np.floor(y - r_out)), 0), min(int(np.ceil(y + r_out)) + 1, ny)
    x0, x1 = max(int(np.floor(x - r_out)), 0), min(int(np.ceil(x + r_out)) + 1, nx)
    sub = image[y0:y1, x0:x1]
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.hypot(xx - x, yy - y)
    ap = rr <= r_ap
    ann = (rr >= r_in) & (rr <= r_out) & np.isfinite(sub)
    if ann.sum() < 8 or not np.isfinite(sub[ap]).all():
        return float("nan")
    bkg = float(np.median(sub[ann]))
    return float(np.sum(sub[ap] - bkg))


def find_isolated_stars(
    image: FloatArray, n_sigma: float = 8.0, min_separation: float = 8.0, max_stars: int = 60
) -> list[tuple[float, float]]:
    """Bright, isolated local maxima of `image` (x, y in pixels), brightest first."""
    finite = np.isfinite(image)
    if not finite.any():
        return []
    med = float(np.median(image[finite]))
    sig = _robust_sigma(image)
    if not np.isfinite(sig) or sig <= 0:
        return []
    filled = np.where(finite, image, med)
    peaks = find_peaks(filled, threshold=med + n_sigma * sig, box_size=5, border_width=6)
    if peaks is None or len(peaks) == 0:
        return []
    peaks.sort("peak_value", reverse=True)
    pts = np.column_stack([np.asarray(peaks["x_peak"], float), np.asarray(peaks["y_peak"], float)])
    tree = cKDTree(pts)
    keep: list[tuple[float, float]] = []
    for p in pts:
        neighbours = tree.query_ball_point(p, r=min_separation)
        if len(neighbours) == 1:
            keep.append((float(p[0]), float(p[1])))
        if len(keep) >= max_stars:
            break
    return keep


def _excluded(x: float, y: float, exclude_xy: Sequence[tuple[float, float]], radius: float) -> bool:
    return any(math.hypot(x - ex, y - ey) < radius for ex, ey in exclude_xy)


def _core_finite(img: FloatArray, x: float, y: float) -> bool:
    """3x3 core around (x, y) fully finite (flagged and saturated pixels are NaN in coadds)."""
    xi, yi = int(round(x)), int(round(y))
    ny, nx = img.shape
    if not (1 <= xi < nx - 1 and 1 <= yi < ny - 1):
        return False
    return bool(np.isfinite(img[yi - 1 : yi + 2, xi - 1 : xi + 2]).all())


def field_stars(
    a: FloatArray,
    b: FloatArray,
    exclude_xy: Sequence[tuple[float, float]] = (),
    exclude_radius: float = EXCLUDE_RADIUS_PIX,
    max_stars: int = 60,
) -> list[tuple[float, float]]:
    """Bright isolated stars detected on A + B with an unflagged core in both epochs, away from
    the `exclude_xy` positions (the target and other known movers)."""
    both = np.where(np.isfinite(a) & np.isfinite(b), a + b, np.nan)
    out: list[tuple[float, float]] = []
    for x, y in find_isolated_stars(both, max_stars=max_stars):
        if _excluded(x, y, exclude_xy, exclude_radius):
            continue
        if _core_finite(a, x, y) and _core_finite(b, x, y):
            out.append((x, y))
    return out


def measure_registration(
    a: FloatArray,
    b: FloatArray,
    var_a: FloatArray | None = None,
    var_b: FloatArray | None = None,
    exclude_xy: Sequence[tuple[float, float]] = (),
    exclude_radius: float = EXCLUDE_RADIUS_PIX,
    min_stars: int = REG_MIN_STARS,
) -> Registration:
    """Median centroid offset (A - B) of isolated field stars, with its standard error.

    Each star is centroided with a 2D Gaussian on both coadds (non-finite pixels left out);
    stars with a centroid error above `REG_MAX_CENTROID_ERR_PIX` are dropped. The standard error
    of the median is 1.2533 x 1.4826 MAD / sqrt(n).
    """
    d: list[tuple[float, float]] = []
    for x, y in field_stars(a, b, exclude_xy, exclude_radius):
        ca = measure_centroid(a, var_a, None, x, y, 4)
        cb = measure_centroid(b, var_b, None, x, y, 4)
        if ca is None or cb is None:
            continue
        errs = (ca.x_err, ca.y_err, cb.x_err, cb.y_err)
        if not all(np.isfinite(e) and e < REG_MAX_CENTROID_ERR_PIX for e in errs):
            continue
        d.append((ca.x - cb.x, ca.y - cb.y))
    n = len(d)
    if n < min_stars:
        return Registration(0.0, 0.0, float("nan"), float("nan"), n, False)
    arr = np.asarray(d, dtype=np.float64)
    med = np.median(arr, axis=0)
    mad = 1.4826 * np.median(np.abs(arr - med), axis=0)
    err = 1.2533 * np.maximum(mad, 1e-3) / math.sqrt(n)
    dx, dy = float(med[0]), float(med[1])
    size = math.hypot(dx, dy)
    significant = size > REG_SIGNIFICANCE * float(math.hypot(err[0], err[1]))
    applied = significant and REG_MIN_SHIFT_PIX <= size <= REG_MAX_SHIFT_PIX
    return Registration(dx, dy, float(err[0]), float(err[1]), n, bool(applied))


def shift_image(img: FloatArray, dx: float, dy: float, order: int = 3) -> FloatArray:
    """Resample `img` so that its content moves by (+dx, +dy) pixels (cubic spline by default).

    Non-finite pixels are filled with the image median for the interpolation only; every output
    pixel whose interpolation stencil touched a non-finite input pixel, or that falls outside
    the input, is NaN again, so no data are invented where none existed.
    """
    arr = np.asarray(img, dtype=np.float64)
    finite = np.isfinite(arr)
    if not finite.any():
        return arr.copy()
    if dx == 0.0 and dy == 0.0:
        return arr.copy()
    fill = float(np.median(arr[finite]))
    out = np.asarray(
        ndi_shift(np.where(finite, arr, fill), (dy, dx), order=order, mode="nearest"),
        dtype=np.float64,
    )
    # Validity: a bad input pixel spoils the output pixels within the stencil (order + 1 wide),
    # and anything shifted in from outside the array has no data.
    bad = (~finite).astype(np.float64)
    reach = ndi_shift(bad, (dy, dx), order=1, mode="constant", cval=1.0)
    spoiled = reach > 1e-6
    if order > 1:
        spoiled = binary_dilation(spoiled, iterations=(order + 1) // 2)
    out[spoiled] = np.nan
    return out


def difference_scale(
    a: FloatArray,
    b: FloatArray,
    min_stars: int = 3,
    exclude_xy: Sequence[tuple[float, float]] = (),
    exclude_radius: float = EXCLUDE_RADIUS_PIX,
) -> tuple[float, int]:
    """Robust flux ratio s = median(F_A / F_B) over bright, isolated field stars.

    Stars are detected on A + B (positive peaks) so that a source present in only one epoch is
    not required to match; the median makes the estimate insensitive to the few movers and
    variables. Returns (1.0, 0) when fewer than `min_stars` usable stars exist.
    """
    both = np.where(np.isfinite(a) & np.isfinite(b), a + b, np.nan)
    stars = find_isolated_stars(both)
    ratios: list[float] = []
    for x, y in stars:
        if _excluded(x, y, exclude_xy, exclude_radius):
            continue
        fa = aperture_flux(a, x, y)
        fb = aperture_flux(b, x, y)
        if np.isfinite(fa) and np.isfinite(fb) and fa > 0 and fb > 0:
            ratios.append(fa / fb)
    if len(ratios) < min_stars:
        return 1.0, len(ratios)
    return float(np.median(ratios)), len(ratios)


def difference(
    a: FloatArray,
    b: FloatArray,
    *,
    var_a: FloatArray | None = None,
    var_b: FloatArray | None = None,
    exclude_xy: Sequence[tuple[float, float]] = (),
    register: bool = True,
) -> DifferenceResult:
    """Return D = A - s B' with B' = B registered onto A (when a significant shift is measured)
    and s from `difference_scale` on (A, B'). NaN where either input is NaN."""
    reg = NO_REGISTRATION
    b_reg: FloatArray = np.asarray(b, dtype=np.float64)
    if register:
        reg = measure_registration(a, b, var_a, var_b, exclude_xy)
        if reg.applied:
            b_reg = shift_image(b_reg, reg.dx, reg.dy)
    s, n = difference_scale(a, b_reg, exclude_xy=exclude_xy)
    d = (np.asarray(a, dtype=np.float64) - s * b_reg).astype(np.float32)
    return DifferenceResult(diff=d, scale=s, n_stars=n, registration=reg, b_registered=b_reg)


def shift_variance(var: FloatArray, reg: Registration) -> FloatArray:
    """Variance map following the same registration (bilinear, so it stays non-negative)."""
    arr = np.asarray(var, dtype=np.float64)
    if not reg.applied:
        return arr
    return shift_image(arr, reg.dx, reg.dy, order=1)


def static_residual_fraction(
    diff: FloatArray,
    a: FloatArray,
    b_scaled: FloatArray,
    noise: FloatArray,
    stars: Sequence[tuple[float, float]],
    min_stars: int = 3,
) -> float:
    """Empirical fractional subtraction residual of static sources, per pixel.

    For each isolated field star, take the core pixels (within `RESID_CORE_PIX`) where the flux
    shared by both epochs, M = min(A - bkg_A, s B' - bkg_B), exceeds `RESID_MIN_SNR` times the
    pixel noise, and pool the ratios D / M. Returns the robust standard deviation
    (1.4826 x median |D / M|) of the pooled ratios, or NaN with fewer than `min_stars` stars.

    This measures how well a static source subtracts on this pair of coadds (PSF and wavelength
    mixture differences between epochs, residual registration). Movers among the stars only
    add outliers, which the median ignores.
    """
    bkg_a = float(np.nanmedian(a))
    bkg_b = float(np.nanmedian(b_scaled))
    shared = np.minimum(a - bkg_a, b_scaled - bkg_b)
    ny, nx = diff.shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    ratios: list[npt.NDArray[np.float64]] = []
    n_used = 0
    for x, y in stars:
        xi, yi = int(round(x)), int(round(y))
        r = int(math.ceil(RESID_CORE_PIX))
        sl = (slice(max(yi - r, 0), yi + r + 1), slice(max(xi - r, 0), xi + r + 1))
        core = np.hypot(xx[sl] - x, yy[sl] - y) <= RESID_CORE_PIX
        m = shared[sl]
        d = diff[sl]
        nz = noise[sl]
        ok = core & np.isfinite(m) & np.isfinite(d) & np.isfinite(nz) & (m > RESID_MIN_SNR * nz)
        if not ok.any():
            continue
        ratios.append(np.asarray(d[ok] / m[ok], dtype=np.float64))
        n_used += 1
    if n_used < min_stars:
        return float("nan")
    pooled = np.concatenate(ratios)
    return float(1.4826 * np.median(np.abs(pooled)))


def difference_noise(
    var_a: FloatArray,
    var_b: FloatArray,
    scale: float,
    a: FloatArray,
    b_scaled: FloatArray,
    residual_fraction: float,
) -> FloatArray:
    """Per-pixel 1-sigma noise of D = A - s B'.

    sigma^2 = var_A + s^2 var_B' + (eps M)^2, with M = max(min(A - bkg, s B' - bkg), 0) the flux
    present in both epochs and eps the measured `static_residual_fraction`. The last term is the
    subtraction residual of static sources; flux that appears, disappears or moves between the
    epochs is not shared and is judged against the pixel noise alone. A NaN eps drops the term.
    """
    var = np.asarray(var_a, dtype=np.float64) + scale**2 * np.asarray(var_b, dtype=np.float64)
    if np.isfinite(residual_fraction) and residual_fraction > 0:
        bkg_a = float(np.nanmedian(a))
        bkg_b = float(np.nanmedian(b_scaled))
        shared = np.clip(np.minimum(a - bkg_a, b_scaled - bkg_b), 0.0, None)
        var = var + (residual_fraction * shared) ** 2
    return np.asarray(np.sqrt(var), dtype=np.float64)
