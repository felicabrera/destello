"""Candidate detection in difference images (F-29): significant residuals between two epochs.

Pure functions: arrays in, pixel positions and numbers out. No network, no files. The
significance map is the one validated by V-10 (docs/11): D = A - s B' divided by a per-pixel
noise that adds the measured subtraction residual of static sources to the coadd variances.

A detection is only a place where two coadds differ beyond that noise. It is never a discovery:
image artifacts, variable stars and subtraction residuals produce the same signature.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy.ndimage import maximum_filter

from destello.pipeline.difference import (
    DifferenceResult,
    difference_noise,
    field_stars,
    shift_variance,
    static_residual_fraction,
)

FloatArray = npt.NDArray[np.floating]
BoolArray = npt.NDArray[np.bool_]

# Bumped whenever detection, pairing or merging change; part of the API cache key.
CANDIDATES_METHOD_VERSION = "3"

DETECTION_SIGMA = 5.0  # peak significance of a lobe
PAIR_MAX_PIX = 4.0  # positive and negative lobes of one displaced source (grid pixels)
MERGE_MAX_PIX = 2.0  # the same feature seen in several detectors
MIN_FINITE_PIXELS = 100  # below this the significance map is not usable
# Compactness of a lobe: its difference minus the median difference in this annulus (grid
# pixels) around it. The halo and the diffraction spikes of a bright star that changed are
# smooth on this scale; a point source (PSF FWHM about two grid pixels) is not.
LOCAL_INNER_PIX = 3.0
LOCAL_OUTER_PIX = 6.0
LOCAL_MIN_FRACTION = 0.5  # of the annulus with data

Kind = str  # "moved" | "brighter_in_a" | "brighter_in_b"


@dataclass(frozen=True)
class Significance:
    """z = D / sigma, rescaled so that its robust width is never below one."""

    z: FloatArray
    diff: FloatArray  # D = A - s B'
    sigma: FloatArray  # per-pixel noise of D after the rescaling, so that z = diff / sigma
    blank: BoolArray  # True where the 3x3 neighborhood has no data in A or in B'
    residual_fraction: float  # measured static-source residual (NaN when not measurable)
    usable: bool


@dataclass(frozen=True)
class Feature:
    """One detection on one detector, in 0-based grid pixels (FITS row order).

    `moved` is a dipole: (x_a, y_a) is the positive lobe (flux present in A) and (x_b, y_b) the
    negative lobe (flux present in B); (x, y) is their midpoint. For the other kinds both lobes
    equal (x, y).
    """

    kind: Kind
    x: float
    y: float
    x_a: float
    y_a: float
    x_b: float
    y_b: float
    snr: float  # the weaker lobe of a dipole, the peak otherwise
    snr_local: float  # the same after subtracting the local median difference (NaN: no data)
    near_blank: bool


@dataclass(frozen=True)
class Candidate:
    """A feature merged across detectors (positions from the most significant detection)."""

    feature: Feature
    detectors: tuple[int, ...]
    snr_by_detector: tuple[float, ...]


def blank_neighbors(blank: BoolArray) -> BoolArray:
    """True where the 3x3 neighborhood holds a blank pixel or reaches outside the grid."""
    return np.asarray(
        maximum_filter(blank.astype(np.uint8), size=3, mode="constant", cval=1) > 0, dtype=bool
    )


def local_peaks(z: FloatArray, threshold: float) -> list[tuple[float, float]]:
    """Local maxima of `z` (3x3) above `threshold`, as (x, y) pixel positions."""
    zz = np.where(np.isfinite(z), z, -np.inf)
    m = (zz == maximum_filter(zz, size=3)) & (zz > threshold)
    ys, xs = np.nonzero(m)
    return [(float(x), float(y)) for x, y in zip(xs, ys, strict=True)]


def significance_map(
    res: DifferenceResult,
    a: FloatArray,
    var_a: FloatArray,
    var_b: FloatArray,
    exclude_xy: Sequence[tuple[float, float]] = (),
) -> Significance:
    """Significance of the difference `res` of coadds A and B (variances `var_a`, `var_b`).

    Sigma per pixel is `difference_noise` with the residual fraction measured on the field stars
    of this pair (away from `exclude_xy`). The map is divided by its robust width when that
    exceeds one (correlated noise after reprojection), never multiplied.
    """
    b_reg = res.b_registered if res.b_registered is not None else np.full(a.shape, np.nan)
    b_scaled = res.scale * b_reg
    var_b_reg = shift_variance(var_b, res.registration)
    pix_noise = np.sqrt(np.asarray(var_a, dtype=np.float64) + res.scale**2 * var_b_reg)
    stars = field_stars(a, b_reg, exclude_xy)
    eps = static_residual_fraction(res.diff, a, b_scaled, pix_noise, stars)
    noise = difference_noise(var_a, var_b_reg, res.scale, a, b_scaled, eps)
    diff = np.asarray(res.diff, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = diff / noise
    finite = np.isfinite(z)
    blank = blank_neighbors(~np.isfinite(a) | ~np.isfinite(b_reg))
    if int(finite.sum()) < MIN_FINITE_PIXELS:
        return Significance(
            z=z, diff=diff, sigma=noise, blank=blank, residual_fraction=eps, usable=False
        )
    mad = float(np.median(np.abs(z[finite] - np.median(z[finite])))) * 1.4826
    width = max(mad, 1.0)
    return Significance(
        z=z / width, diff=diff, sigma=noise * width, blank=blank, residual_fraction=eps, usable=True
    )


def _peak_value(z: FloatArray, x: float, y: float) -> float:
    return float(abs(z[int(y), int(x)]))


def local_snr(sig: Significance, x: float, y: float) -> float:
    """|D - median of D in the annulus| / sigma at pixel (x, y), signed like the lobe.

    NaN when less than `LOCAL_MIN_FRACTION` of the annulus has data.
    """
    ix, iy = int(x), int(y)
    r = int(math.ceil(LOCAL_OUTER_PIX))
    ny, nx = sig.diff.shape
    y0, y1, x0, x1 = max(iy - r, 0), min(iy + r + 1, ny), max(ix - r, 0), min(ix + r + 1, nx)
    yy, xx = np.mgrid[y0:y1, x0:x1]
    rr = np.hypot(xx - ix, yy - iy)
    ring = (rr >= LOCAL_INNER_PIX) & (rr <= LOCAL_OUTER_PIX)
    full = np.hypot(*np.mgrid[-r : r + 1, -r : r + 1])
    n_full = int(((full >= LOCAL_INNER_PIX) & (full <= LOCAL_OUTER_PIX)).sum())
    values = sig.diff[y0:y1, x0:x1][ring]
    values = values[np.isfinite(values)]
    d, s = float(sig.diff[iy, ix]), float(sig.sigma[iy, ix])
    if len(values) < LOCAL_MIN_FRACTION * n_full or not (math.isfinite(d) and s > 0):
        return math.nan
    return float((d - float(np.median(values))) / s * (1.0 if d >= 0 else -1.0))


def detect_features(
    sig: Significance, threshold: float = DETECTION_SIGMA, pair_max_pix: float = PAIR_MAX_PIX
) -> list[Feature]:
    """Dipoles (a positive and a negative lobe closer than `pair_max_pix`) and unpaired lobes.

    Every positive-negative pair inside the distance is a dipole, as in V-10; a lobe that
    belongs to a dipole is not listed again on its own.
    """
    if not sig.usable:
        return []
    z = sig.z
    pos = local_peaks(z, threshold)
    neg = local_peaks(-z, threshold)
    out: list[Feature] = []
    paired_pos: set[int] = set()
    paired_neg: set[int] = set()
    for i, (px, py) in enumerate(pos):
        for j, (nx, ny) in enumerate(neg):
            if math.hypot(px - nx, py - ny) > pair_max_pix:
                continue
            paired_pos.add(i)
            paired_neg.add(j)
            out.append(
                Feature(
                    kind="moved",
                    x=(px + nx) / 2,
                    y=(py + ny) / 2,
                    x_a=px,
                    y_a=py,
                    x_b=nx,
                    y_b=ny,
                    snr=min(_peak_value(z, px, py), _peak_value(z, nx, ny)),
                    snr_local=min(local_snr(sig, px, py), local_snr(sig, nx, ny)),
                    near_blank=bool(sig.blank[int(py), int(px)] or sig.blank[int(ny), int(nx)]),
                )
            )
    for kind, peaks, paired in (
        ("brighter_in_a", pos, paired_pos),
        ("brighter_in_b", neg, paired_neg),
    ):
        for i, (x, y) in enumerate(peaks):
            if i in paired:
                continue
            out.append(
                Feature(
                    kind=kind,
                    x=x,
                    y=y,
                    x_a=x,
                    y_a=y,
                    x_b=x,
                    y_b=y,
                    snr=_peak_value(z, x, y),
                    snr_local=local_snr(sig, x, y),
                    near_blank=bool(sig.blank[int(y), int(x)]),
                )
            )
    return out


def merge_detectors(
    by_detector: Mapping[int, Sequence[Feature]], merge_max_pix: float = MERGE_MAX_PIX
) -> list[Candidate]:
    """Group features of the same kind closer than `merge_max_pix` across detectors.

    Greedy, most significant first, at most one feature per detector in a group. The group
    keeps the positions of its most significant member; it is near a blank region only when
    every member is. Sorted by number of detectors, then significance.
    """
    items = sorted(
        ((f, d) for d, feats in by_detector.items() for f in feats),
        key=lambda fd: (-fd[0].snr, fd[1], fd[0].x, fd[0].y),
    )
    groups: list[list[tuple[Feature, int]]] = []
    for f, d in items:
        for g in groups:
            head = g[0][0]
            if (
                head.kind == f.kind
                and all(gd != d for _, gd in g)
                and math.hypot(head.x - f.x, head.y - f.y) <= merge_max_pix
            ):
                g.append((f, d))
                break
        else:
            groups.append([(f, d)])
    out: list[Candidate] = []
    for g in groups:
        members = sorted(g, key=lambda fd: fd[1])
        head = g[0][0]
        if head.near_blank and not all(f.near_blank for f, _ in g):
            head = Feature(**{**head.__dict__, "near_blank": False})
        out.append(
            Candidate(
                feature=head,
                detectors=tuple(d for _, d in members),
                snr_by_detector=tuple(round(f.snr, 2) for f, _ in members),
            )
        )
    out.sort(key=lambda c: (-len(c.detectors), -c.feature.snr, c.feature.x, c.feature.y))
    return out
