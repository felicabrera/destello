"""Rendering: one shared asinh stretch per detector, 8-bit WebP frames and FITS coadds.

Orientation of every rendered image: north up, east left (the image is flipped vertically
relative to FITS row order, and the grid WCS has a negative RA increment). Fair comparison
(docs/00-context.md, non-negotiable 3): the stretch of a detector is computed once from all epochs
together and applied unchanged to every epoch of that detector.
"""

from __future__ import annotations

import io
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass

import numpy as np
import numpy.typing as npt
from astropy.io import fits
from astropy.visualization import ZScaleInterval
from astropy.wcs import WCS
from PIL import Image

FloatArray = npt.NDArray[np.floating]
UInt8Array = npt.NDArray[np.uint8]

ASINH_SOFTENING = 0.1
HIGH_PERCENTILE = 99.9


@dataclass(frozen=True)
class Stretch:
    """Intensity mapping shared by all epochs of one detector."""

    method: str  # always "asinh" for intensity frames
    vmin: float
    vmax: float
    softening: float
    unit: str

    def as_dict(self) -> dict[str, float | str]:
        return asdict(self)


def compute_stretch(
    frames: Sequence[FloatArray], unit: str = "MJy/sr", softening: float = ASINH_SOFTENING
) -> Stretch:
    """Compute one stretch from all epochs of a detector.

    vmin is the ZScale lower limit of the pooled finite pixels; vmax is the larger of the ZScale
    upper limit and the 99.9th percentile of the pooled pixels. NaN and masked pixels are
    ignored. Raises ValueError when no finite pixel exists.
    """
    pooled = np.concatenate([np.asarray(f, dtype=np.float64).ravel() for f in frames])
    pooled = pooled[np.isfinite(pooled)]
    if pooled.size == 0:
        raise ValueError("No finite pixels to compute a stretch")
    z1, z2 = ZScaleInterval().get_limits(pooled)
    hi = float(np.percentile(pooled, HIGH_PERCENTILE))
    vmin = float(z1)
    vmax = float(max(z2, hi))
    if not vmax > vmin:
        vmax = vmin + max(abs(vmin) * 1e-3, 1e-6)
    return Stretch("asinh", vmin, vmax, softening, unit)


def apply_stretch(
    data: FloatArray, stretch: Stretch, saturated: npt.NDArray[np.bool_] | None = None
) -> UInt8Array:
    """Map data to 8 bits with the asinh stretch. Monotonic in the input.

    Pixels without valid data map to 0, except where `saturated` is true: those are pixels that
    were masked because the detector saturated, and they are drawn at full scale (255).
    """
    x = (np.asarray(data, dtype=np.float64) - stretch.vmin) / (stretch.vmax - stretch.vmin)
    finite = np.isfinite(x)
    x = np.clip(np.where(finite, x, 0.0), 0.0, 1.0)
    a = stretch.softening
    y = np.arcsinh(x / a) / np.arcsinh(1.0 / a)
    out: UInt8Array = np.rint(y * 255.0).astype(np.uint8)
    out[~finite] = 0
    if saturated is not None:
        out[~finite & saturated] = 255
    return out


def diverging_limit(diff: FloatArray, n_sigma: float = 8.0) -> float:
    """Symmetric limit for difference images: n_sigma x robust sigma of the finite pixels."""
    finite = diff[np.isfinite(diff)]
    if finite.size == 0:
        return 1.0
    sigma = 1.4826 * float(np.median(np.abs(finite - np.median(finite))))
    peak = float(np.percentile(np.abs(finite), 99.9))
    limit = n_sigma * sigma if sigma > 0 else peak
    return float(max(min(limit, peak) if peak > 0 else limit, 1e-12))


def apply_diverging(diff: FloatArray, limit: float) -> UInt8Array:
    """Map a difference image to 8 bits, zero at 128, symmetric linear stretch of +-limit."""
    x = np.asarray(diff, dtype=np.float64) / limit
    finite = np.isfinite(x)
    x = np.clip(np.where(finite, x, 0.0), -1.0, 1.0)
    out = np.rint(128.0 + 127.0 * x).astype(np.uint8)
    return out


def to_webp(frame: UInt8Array) -> bytes:
    """Encode an 8-bit image as lossless grayscale WebP, flipped so that north is up."""
    img = Image.fromarray(np.flipud(frame), mode="L")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True, quality=100, method=6)
    return buf.getvalue()


def mask_png(mask: npt.NDArray[np.bool_]) -> bytes:
    """Encode a pixel mask as an RGBA PNG on the frame grid, flipped so that north is up.

    Pixels where `mask` is true are opaque white, all others fully transparent. Only the alpha
    channel carries information; the viewer chooses the overlay color.
    """
    m = np.flipud(np.asarray(mask, dtype=bool))
    if m.ndim != 2:
        raise ValueError("mask_png needs a 2D mask")
    rgba = np.zeros((*m.shape, 4), dtype=np.uint8)
    rgba[m] = 255
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def coadd_fits_bytes(
    data: FloatArray,
    wcs: WCS,
    headers: Mapping[str, str | float | int],
    bunit: str,
    variance: FloatArray | None = None,
) -> bytes:
    """Serialise a coadd as FITS: primary image plus an optional VARIANCE extension.

    `headers` should carry DSTLVER, DSTLSEQ, DSTLEPOC, NIMAGES, RELEASE and similar provenance.
    """
    hdr = wcs.to_header()
    for key, value in headers.items():
        hdr[key[:8]] = value
    hdr["BUNIT"] = bunit
    hdus: list[fits.PrimaryHDU | fits.ImageHDU] = [
        fits.PrimaryHDU(data=np.asarray(data, dtype=np.float32), header=hdr)
    ]
    if variance is not None:
        vh = wcs.to_header()
        vh["EXTNAME"] = "VARIANCE"
        vh["BUNIT"] = f"({bunit})**2"
        hdus.append(fits.ImageHDU(data=np.asarray(variance, dtype=np.float32), header=vh))
    buf = io.BytesIO()
    fits.HDUList(hdus).writeto(buf)
    return buf.getvalue()
