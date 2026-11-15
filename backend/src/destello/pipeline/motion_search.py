"""Shift-and-stack search over a grid of proper motions (F-32), per detector.

Pure functions: arrays in, pixel positions and numbers out. No network, no files.

Method (docs/03 section 4.7):
1. Every epoch coadd of one detector is registered and flux scaled onto a reference epoch with the
   same field-star method as the difference images (`pipeline.difference.difference`).
2. A static template is the inverse-variance mean of the epochs. Subtracting it from every epoch
   removes everything that does not move or change; a mover leaves a positive residual at its
   position in each epoch.
3. For each trial motion of the grid, the residual of every epoch is shifted back by the motion
   times its time from the mean epoch (whole grid pixels: nothing is interpolated) and the shifted
   residuals are stacked with inverse-variance weights. A mover adds up only at its own motion.
4. A peak is kept only when the stack reaches `DETECTION_SIGMA` and every single epoch contributes
   at least `EPOCH_MIN_SIGMA` at its shifted position: one bright residual (a variable star, an
   artifact in one epoch) cannot pass on its own.
5. The motion of a kept peak is then measured, not taken from the grid: a Gaussian centroid on
   each registered epoch coadd (template not subtracted) near the position predicted by the
   trial. Template subtraction biases the trial motion high for sources that move less than a
   few PSF widths (part of the source is removed with the template), the centroids do not.

A listed source is a place where something moves consistently across all epochs. It is never a
discovery: blends, residuals of bright stars and artifacts can produce the same signature, and the
API compares every entry with catalogs propagated to the same epoch.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy.ndimage import maximum_filter

from destello.pipeline.astrometry import Centroid, measure_centroid
from destello.pipeline.difference import (
    difference,
    field_stars,
    shift_variance,
    static_residual_fraction,
)

FloatArray = npt.NDArray[np.floating]

# Bumped whenever the search, the refinement or the merging change; part of the API cache key.
MOTION_SEARCH_METHOD_VERSION = "2"

MIN_EPOCHS = 3  # with two epochs any pair of residuals lines up at some motion
MIN_BASELINE_YEARS = 0.4
DETECTION_SIGMA = 5.0  # stacked residual significance of a peak
EPOCH_MIN_SIGMA = 2.0  # every epoch must contribute at least this at the shifted position
# Peaks of other trials this close (grid pixels, at the mean epoch) are the same source.
SUPPRESS_PIX = 3.0
MAX_PEAKS = 40  # strongest peaks refined per detector
CENTROID_HALF_BOX = 3
CENTROID_MIN_PIXELS = 12
CENTROID_MAX_ERR_PIX = 1.0  # a centroid less precise than this is not used
# A centroid farther than this from the trial prediction (peak pixel, residual self-subtraction,
# grid step and shift rounding stay inside it) has locked onto a neighbour, usually a static star.
TRACK_MAX_OFFSET_PIX = 3.0


@dataclass(frozen=True)
class EpochImage:
    """One epoch coadd of one detector on the common grid."""

    index: int
    t_years: float  # mid time (Julian years, TDB)
    image: FloatArray
    variance: FloatArray


@dataclass(frozen=True)
class Peak:
    """A stacked residual peak: position at the mean epoch and the trial motion (grid pixels and
    grid pixels per year, in array axes: +x along columns, +y along rows)."""

    x: float
    y: float
    vx: float
    vy: float
    snr: float
    epoch_snr: tuple[float, ...]


@dataclass(frozen=True)
class TrackedPeak:
    """A peak with a centroid on every epoch coadd (None where the fit failed)."""

    peak: Peak
    centroids: tuple[Centroid | None, ...]

    @property
    def complete(self) -> bool:
        return all(c is not None for c in self.centroids)


@dataclass(frozen=True)
class DetectorSearch:
    usable: bool
    n_epochs: int
    baseline_years: float
    step_pix_per_year: float
    n_trials: int
    residual_fraction: float  # median over epochs of the measured static residual (NaN: none)
    peaks: tuple[TrackedPeak, ...]


def trial_motions(
    dt_years: Sequence[float], v_max_pix: float, step_pix: float
) -> list[tuple[float, float, tuple[tuple[int, int], ...]]]:
    """Trial motions (vx, vy) on a square grid of step `step_pix` within `v_max_pix`, with the
    whole-pixel shift of each epoch. Trials with the same shifts are the same trial; the trial
    without any shift is the static sky and is skipped."""
    n = int(math.floor(v_max_pix / step_pix + 1e-9))
    seen: set[tuple[tuple[int, int], ...]] = set()
    out: list[tuple[float, float, tuple[tuple[int, int], ...]]] = []
    # Smallest motions first, so a duplicate shift set keeps its slowest trial.
    grid = sorted(
        ((i * step_pix, j * step_pix) for i in range(-n, n + 1) for j in range(-n, n + 1)),
        key=lambda v: (math.hypot(*v), v),
    )
    for vx, vy in grid:
        if math.hypot(vx, vy) > v_max_pix + 1e-9:
            continue
        shifts = tuple((int(round(vx * d)), int(round(vy * d))) for d in dt_years)
        if shifts in seen or all(s == (0, 0) for s in shifts):
            continue
        seen.add(shifts)
        out.append((vx, vy, shifts))
    return out


def normalize(
    epochs: Sequence[EpochImage], ref: int, exclude_xy: Sequence[tuple[float, float]] = ()
) -> tuple[FloatArray, FloatArray]:
    """Epoch images registered and flux scaled onto epoch `ref`, and their variances
    (shape (n, ny, nx))."""
    r = epochs[ref]
    imgs: list[FloatArray] = []
    vars_: list[FloatArray] = []
    for i, e in enumerate(epochs):
        if i == ref:
            imgs.append(np.asarray(r.image, dtype=np.float64))
            vars_.append(np.asarray(r.variance, dtype=np.float64))
            continue
        res = difference(
            r.image, e.image, var_a=r.variance, var_b=e.variance, exclude_xy=exclude_xy
        )
        b = res.b_registered if res.b_registered is not None else np.asarray(e.image, np.float64)
        imgs.append(res.scale * np.asarray(b, dtype=np.float64))
        vars_.append(res.scale**2 * shift_variance(e.variance, res.registration))
    return np.asarray(imgs, dtype=np.float64), np.asarray(vars_, dtype=np.float64)


def residuals(
    norm: FloatArray, var: FloatArray
) -> tuple[FloatArray, FloatArray, FloatArray, list[float]]:
    """Static template T, residuals R_i = N_i - T, their 1-sigma noise and the measured static
    residual fraction of each epoch.

    T is the inverse-variance mean over the pixels covered by every epoch. The noise of R_i is the
    propagated pixel noise (T shares N_i) plus the subtraction residual of static sources, eps T,
    with eps measured on the isolated field stars of T (as for the difference images)."""
    n = norm.shape[0]
    w = 1.0 / var
    ok = np.all(np.isfinite(norm) & np.isfinite(w) & (var > 0), axis=0)
    wz = np.where(ok, w, 0.0)
    nz = np.where(ok, norm, 0.0)
    wsum = wz.sum(axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        template = (wz * nz).sum(axis=0) / wsum
        template[~ok] = np.nan
        frac = wz / np.where(wsum > 0, wsum, np.nan)
        total = (frac**2 * np.where(ok, var, 0.0)).sum(axis=0)
    stars = field_stars(template, template)
    bkg = float(np.nanmedian(template)) if np.isfinite(template).any() else 0.0
    shared = np.clip(template - bkg, 0.0, None)
    res = np.empty_like(norm)
    noise = np.empty_like(norm)
    eps_all: list[float] = []
    for i in range(n):
        r = norm[i] - template
        # Var(N_i - sum_j f_j N_j) = (1 - f_i)^2 V_i + sum_{j != i} f_j^2 V_j
        v = (1.0 - frac[i]) ** 2 * var[i] + total - frac[i] ** 2 * var[i]
        pix = np.sqrt(v)
        eps = static_residual_fraction(r, norm[i], template, pix, stars)
        eps_all.append(eps)
        if math.isfinite(eps) and eps > 0:
            v = v + (eps * shared) ** 2
        r[~ok] = np.nan
        res[i] = r
        noise[i] = np.where(ok, np.sqrt(v), np.nan)
    return template, res, noise, eps_all


def _shifted(img: FloatArray, sx: int, sy: int) -> FloatArray:
    """out[y, x] = img[y + sy, x + sx], NaN outside."""
    ny, nx = img.shape
    out = np.full(img.shape, np.nan)
    ys, ye = max(0, -sy), min(ny, ny - sy)
    xs, xe = max(0, -sx), min(nx, nx - sx)
    if ys < ye and xs < xe:
        out[ys:ye, xs:xe] = img[ys + sy : ye + sy, xs + sx : xe + sx]
    return out


def stack_trial(
    res: FloatArray, noise: FloatArray, shifts: Sequence[tuple[int, int]]
) -> tuple[FloatArray, FloatArray]:
    """Significance of the inverse-variance stack of the shifted residuals, rescaled by its robust
    width when that exceeds one (never multiplied), and the smallest per-epoch significance.
    NaN where an epoch has no data after the shift."""
    n, ny, nx = res.shape
    num = np.zeros((ny, nx))
    den = np.zeros((ny, nx))
    per = np.empty((n, ny, nx))
    for i, (sx, sy) in enumerate(shifts):
        r = _shifted(res[i], sx, sy)
        s = _shifted(noise[i], sx, sy)
        with np.errstate(invalid="ignore", divide="ignore"):
            per[i] = r / s
            w = 1.0 / s**2
        good = np.isfinite(r) & np.isfinite(w)
        num += np.where(good, w * r, 0.0)
        den += np.where(good, w, 0.0)
    full = np.all(np.isfinite(per), axis=0)
    with np.errstate(invalid="ignore", divide="ignore"):
        z = num / np.sqrt(den)
    z[~full] = np.nan
    fin = np.isfinite(z)
    if int(fin.sum()) >= 100:
        mad = 1.4826 * float(np.median(np.abs(z[fin] - np.median(z[fin]))))
        if mad > 1.0:
            z = z / mad
            per = per / mad
    zmin = np.where(full, np.min(np.where(np.isfinite(per), per, np.inf), axis=0), np.nan)
    return z, zmin


def find_peaks(
    res: FloatArray,
    noise: FloatArray,
    trials: Sequence[tuple[float, float, tuple[tuple[int, int], ...]]],
    threshold: float = DETECTION_SIGMA,
    epoch_min: float = EPOCH_MIN_SIGMA,
) -> list[Peak]:
    """Local maxima of every trial stack above `threshold` where every epoch contributes at least
    `epoch_min`, strongest first, one per source (`SUPPRESS_PIX` at the mean epoch)."""
    found: list[Peak] = []
    for vx, vy, shifts in trials:
        z, zmin = stack_trial(res, noise, shifts)
        zz = np.where(np.isfinite(z), z, -np.inf)
        mask = (zz == maximum_filter(zz, size=3)) & (zz > threshold)
        mask &= np.nan_to_num(zmin, nan=-np.inf) >= epoch_min
        for y, x in zip(*np.nonzero(mask), strict=True):
            per = tuple(
                float(res[i][y + sy, x + sx] / noise[i][y + sy, x + sx])
                for i, (sx, sy) in enumerate(shifts)
            )
            found.append(Peak(float(x), float(y), vx, vy, float(z[y, x]), per))
    found.sort(key=lambda p: (-p.snr, p.x, p.y, p.vx, p.vy))
    kept: list[Peak] = []
    for p in found:
        if all(math.hypot(p.x - k.x, p.y - k.y) > SUPPRESS_PIX for k in kept):
            kept.append(p)
    return kept


def track(norm: FloatArray, var: FloatArray, peak: Peak, dt_years: Sequence[float]) -> TrackedPeak:
    """Gaussian centroid of the peak on every registered epoch coadd, starting at the position
    predicted by its trial motion. A centroid pulled away from that position (a neighbouring
    source dominates the box) is dropped, so the peak is not fitted rather than fitted wrong."""
    cents: list[Centroid | None] = []
    for i, d in enumerate(dt_years):
        px, py = peak.x + peak.vx * d, peak.y + peak.vy * d
        c = measure_centroid(
            norm[i],
            var[i],
            None,
            px,
            py,
            half_box=CENTROID_HALF_BOX,
            min_pixels=CENTROID_MIN_PIXELS,
        )
        good = (
            c is not None
            and math.isfinite(c.x_err)
            and math.isfinite(c.y_err)
            and max(c.x_err, c.y_err) <= CENTROID_MAX_ERR_PIX
            and math.hypot(c.x - px, c.y - py) <= TRACK_MAX_OFFSET_PIX
        )
        cents.append(c if good else None)
    return TrackedPeak(peak, tuple(cents))


def search_detector(
    epochs: Sequence[EpochImage],
    v_max_pix_per_year: float,
    exclude_xy: Sequence[tuple[float, float]] = (),
) -> DetectorSearch:
    """Run the search on the epoch coadds of one detector (all on the same grid).

    `v_max_pix_per_year` bounds the trial grid; its step moves the last epoch one grid pixel
    relative to the first. `exclude_xy` only keeps those positions out of the registration and
    flux scale stars (it does not hide them from the search)."""
    n = len(epochs)
    times = np.array([e.t_years for e in epochs], dtype=np.float64)
    baseline = float(times.max() - times.min()) if n else 0.0
    if n < MIN_EPOCHS or baseline < MIN_BASELINE_YEARS:
        return DetectorSearch(False, n, baseline, math.nan, 0, math.nan, ())
    dt = times - float(times.mean())
    step = 1.0 / baseline
    ref = int(np.argmin(np.abs(dt)))
    norm, var = normalize(epochs, ref, exclude_xy)
    _, res, noise, eps = residuals(norm, var)
    if int(np.isfinite(res[0]).sum()) < 100:
        return DetectorSearch(False, n, baseline, step, 0, math.nan, ())
    trials = trial_motions(dt.tolist(), v_max_pix_per_year, step)
    peaks = find_peaks(res, noise, trials)[:MAX_PEAKS]
    tracked = tuple(track(norm, var, p, dt.tolist()) for p in peaks)
    finite = [e for e in eps if math.isfinite(e)]
    return DetectorSearch(
        usable=True,
        n_epochs=n,
        baseline_years=baseline,
        step_pix_per_year=step,
        n_trials=len(trials),
        residual_fraction=float(np.median(finite)) if finite else math.nan,
        peaks=tracked,
    )
