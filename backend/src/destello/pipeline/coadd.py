"""Inverse-variance coaddition per (epoch, detector) and the broadband combination."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

FloatArray = npt.NDArray[np.floating]

# Version of the coaddition method, written to every coadd FITS header (DSTLCOAD). It changes
# frame content without changing pipeline_version, which is part of every sequence id
# (docs/14, 2026-11-11). Version 1 applied a per-pixel 5 sigma rejection with a 10 percent
# relative floor; version 2 is the plain inverse-variance mean over unmasked samples.
COADD_METHOD_VERSION = "2"


@dataclass
class Coadd:
    mean: FloatArray  # weighted mean (MJy/sr), NaN where no valid sample
    variance: FloatArray  # variance of the mean, NaN where no valid sample
    n_used: npt.NDArray[np.int32]  # number of exposures contributing per pixel
    n_input: int  # number of exposures offered

    @property
    def blank(self) -> npt.NDArray[np.bool_]:
        """Pixels with no valid exposure (flagged in every input or not covered)."""
        return np.asarray(self.n_used == 0, dtype=bool)

    @property
    def blank_fraction(self) -> float:
        """Fraction of pixels with no valid exposure."""
        return float(np.mean(self.blank))


def coadd_stack(
    images: Sequence[FloatArray],
    variances: Sequence[FloatArray],
) -> Coadd:
    """Inverse-variance weighted mean over unmasked pixels (docs/03 section 4.1 step 7).

    Every finite sample with a positive finite variance contributes; samples masked by the
    configured SPHEREx flag bits arrive as NaN and are skipped. There is no statistical outlier
    rejection (method version 2): the exposures of one epoch sample different wavelengths under
    the linear variable filter and different sub-pixel phases of an undersampled PSF, so a
    bright star pixel legitimately varies by a factor of 2 to 4 between exposures, and residual
    sky levels differ between exposures by many times the pixel noise. A per-pixel rejection
    against the pixel noise discarded these legitimate samples pixel by pixel (up to half the
    samples of a field), which distorted the coadded star profiles differently at each epoch.
    Outliers are left to the pipeline flags (TRANSIENT, OUTLIER, OVERFLOW and the others in the
    mask configuration).
    """
    if len(images) == 0:
        raise ValueError("coadd_stack needs at least one image")
    img = np.stack([np.asarray(i, dtype=np.float64) for i in images])
    var = np.stack([np.asarray(v, dtype=np.float64) for v in variances])
    valid = np.isfinite(img) & np.isfinite(var) & (var > 0)
    w = np.where(valid, 1.0 / np.where(valid, var, 1.0), 0.0)
    wsum = w.sum(axis=0)
    n_used = valid.sum(axis=0).astype(np.int32)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (w * np.where(valid, img, 0.0)).sum(axis=0) / wsum
        out_var = 1.0 / wsum
    empty = n_used == 0
    mean = np.where(empty, np.nan, mean).astype(np.float32)
    out_var = np.where(empty, np.nan, out_var).astype(np.float32)
    return Coadd(mean=mean, variance=out_var, n_used=n_used, n_input=len(images))


def field_median(image: FloatArray) -> float:
    """Median of the finite pixels of an image."""
    finite = image[np.isfinite(image)]
    return float(np.median(finite)) if finite.size else float("nan")


def robust_sigma(image: FloatArray) -> float:
    """1.4826 x MAD of the finite pixels."""
    finite = image[np.isfinite(image)]
    if finite.size == 0:
        return float("nan")
    return float(1.4826 * np.median(np.abs(finite - np.median(finite))))


def broadband_coadd(coadds: Mapping[int, Coadd]) -> tuple[FloatArray, dict[int, str]]:
    """Broadband image of one epoch from the available per-detector coadds (docs/03 step 7).

    Each detector coadd is divided by its field median so that detectors of very different
    sensitivity contribute comparably, then the normalised images are averaged. When a median is
    not positive or is not significant (below its robust sigma), the detector is instead
    normalised by its robust sigma after subtracting the median; the method used per detector is
    returned for the manifest. The result is dimensionless.
    """
    if not coadds:
        raise ValueError("broadband_coadd needs at least one detector")
    layers: list[FloatArray] = []
    methods: dict[int, str] = {}
    for det in sorted(coadds):
        img = coadds[det].mean.astype(np.float64)
        med = field_median(img)
        sig = robust_sigma(img)
        if np.isfinite(med) and med > 0 and (not np.isfinite(sig) or med > sig):
            layers.append(img / med)
            methods[det] = "median"
        elif np.isfinite(sig) and sig > 0:
            layers.append((img - med) / sig)
            methods[det] = "sigma"
    if not layers:
        raise ValueError("No detector could be normalised")
    stack = np.stack(layers)
    with np.errstate(invalid="ignore"):
        valid_n = np.isfinite(stack).sum(axis=0)
        total = np.where(np.isfinite(stack), stack, 0.0).sum(axis=0)
        out = np.where(valid_n > 0, total / np.maximum(valid_n, 1), np.nan)
    return out.astype(np.float32), methods
