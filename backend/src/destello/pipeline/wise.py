"""WISE and NEOWISE single-exposure (L1b) frames: masks, calibration and per-visit coadds (F-40).

Pure functions: arrays and header values in, arrays and numbers out. No network, no files.

Sources of every constant:

- Mask bits. WISE All-Sky Explanatory Supplement section IV.4.a, table 2 "Bit definitions in frame
  mask images" (irsa.ipac.caltech.edu/data/WISE/docs/release/All-Sky/expsup/sec4_4a.html), and
  NEOWISE Explanatory Supplement section IV.2.a, table 7 "Bit definitions in frame masks from
  NEOWISE processing" (irsa.ipac.caltech.edu/data/WISE/docs/release/NEOWISE/expsup/sec4_2a.html),
  both read on 2026-11-14. The two tables differ (for example bit 19 is reserved in the All-Sky
  table and "hard-saturated" in the NEOWISE table), so the table is chosen per mission phase.
  The post-cryogenic 2-band phase (2010 to 2011) has no separate table in those pages; the
  All-Sky table is used for it (assumption, stated in the manifest of any build that uses it).
- Zero point. Each L1b frame carries MAGZP (Vega). Frames are rescaled to a common zero point of
  22.5 mag, so that one DN of the result is the same flux in every frame of a band.
- Bandpasses. Wright et al. 2010, AJ 140, 1868, relative spectral response per photon, files
  RSR-W1.txt and RSR-W2.txt of the All-Sky Explanatory Supplement (copied in destello/data/wise).
"""

from __future__ import annotations

import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt
from astropy.stats import sigma_clipped_stats

from destello.pipeline.coadd import Coadd

FloatArray = npt.NDArray[np.floating]
BoolArray = npt.NDArray[np.bool_]

# Version of the WISE calibration and coadd method; written to the FITS headers (DSTLWCOA).
WISE_COADD_METHOD_VERSION = "1"
ZP_REF_MAG = 22.5  # common zero point (Vega) of every rescaled frame
COADD_CLIP_SIGMA = 3.0  # per-pixel clip about the median of the frames of one visit
COADD_MIN_FRAMES_CLIP = 5  # the median and MAD need at least this many frames to clip
EPOCH_MIN_FRAMES = 5  # a visit with fewer usable frames is not coadded
SKY_CLIP_SIGMA = 3.0
BAND_RESPONSE_FRACTION = 0.5  # "in band": RSR per photon at or above half its peak

Phase = Literal["WISE", "NEOWISE"]
MaskTable = Literal["allsky", "neowise"]


@dataclass(frozen=True)
class FrameTable:
    """An IRSA single-exposure frame table and the facts that go with it."""

    table: str  # IRSA TAP table name
    ibe_path: str  # path below ibe/data/wise/
    phase: Phase  # mission phase label shown to users
    data_release: str  # data release name for provenance
    mask_table: MaskTable  # which documented bit table applies
    doi: str | None  # dataset DOI when pinned from a primary page, else None


# DOIs: 10.26131/IRSA147 "NEOWISE-R Single-exposure Image Sets" (AWS Open Data registry entry
# wise-neowiser, read 2026-11-14). The DOIs of the 2010 to 2011 image sets were not pinned.
FRAME_TABLES: dict[str, FrameTable] = {
    "allsky_4band_p1bm_frm": FrameTable(
        "allsky_4band_p1bm_frm", "allsky/4band_p1bm_frm", "WISE",
        "WISE All-Sky Release, 4-band cryogenic single-exposure images", "allsky", None,
    ),
    "allsky_3band_p1bm_frm": FrameTable(
        "allsky_3band_p1bm_frm", "cryo_3band/3band_p1bm_frm", "WISE",
        "WISE 3-band cryogenic single-exposure images", "allsky", None,
    ),
    "allsky_2band_p1bm_frm": FrameTable(
        "allsky_2band_p1bm_frm", "postcryo/2band_p1bm_frm", "NEOWISE",
        "NEOWISE post-cryogenic 2-band single-exposure images", "allsky", None,
    ),
    "neowiser_p1bm_frm": FrameTable(
        "neowiser_p1bm_frm", "neowiser/p1bm_frm", "NEOWISE",
        "NEOWISE-R single-exposure (L1b) images", "neowise", "10.26131/IRSA147",
    ),
}  # fmt: skip

# Bits whose pixels the archive sets to NaN in the intensity and uncertainty frames (quoted lists
# of the two supplements), re-applied here so a frame without NaNs is masked the same way.
_NAN_BITS: dict[MaskTable, tuple[int, ...]] = {
    "allsky": (0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18),
    "neowise": (1, 3, 4, 6, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19),
}
# Further bits excluded by Destello, with their documented meaning:
#   21 new or transient bad pixel from dynamic masking (both tables);
#   26 non-linearity correction unreliable (both);
#   27 cosmic ray or unclassified outlier (All-Sky table only; reserved in NEOWISE);
#   28 spike outlier (All-Sky) / spike outlier replaced with the local median (NEOWISE): the value
#      is not a measurement in the NEOWISE case;
#   30 inadvertent NaN from processing (NEOWISE table only; reserved in All-Sky).
_EXTRA_BITS: dict[MaskTable, tuple[int, ...]] = {
    "allsky": (21, 26, 27, 28),
    "neowise": (21, 26, 28, 30),
}
# Saturation: "saturated in sample read 1..9" (bits 10 to 18, both tables) and, NEOWISE only,
# "hard-saturated" (bit 19). Bit 5 of the All-Sky static mask ("saturated anywhere in ramp") is a
# static property of the pixel and only a warning in the supplement, so it is not used.
_SATURATION_BITS: dict[MaskTable, tuple[int, ...]] = {
    "allsky": tuple(range(10, 19)),
    "neowise": tuple(range(10, 20)),
}


def _bits_value(bits: Sequence[int]) -> int:
    return int(sum(1 << b for b in bits))


def exclusion_bits(table: MaskTable) -> int:
    """Bit mask (integer) of the msk-1b bits whose pixels are excluded for this mask table."""
    return _bits_value(_NAN_BITS[table] + _EXTRA_BITS[table])


def saturation_bits(table: MaskTable) -> int:
    """Bit mask (integer) of the msk-1b bits that mark saturated pixels for this mask table."""
    return _bits_value(_SATURATION_BITS[table])


@dataclass
class CalibratedFrame:
    """One L1b frame on the common zero point, sky subtracted, with its exclusion masks."""

    science: FloatArray  # DN at MAGZP 22.5, sky subtracted, NaN where excluded
    variance: FloatArray  # DN^2 at MAGZP 22.5, NaN where excluded
    bad: BoolArray  # excluded pixels (mask bits, non-finite intensity or uncertainty)
    saturated: BoolArray  # saturation bits set
    sky: float  # subtracted sky level (DN at MAGZP 22.5)
    sky_sigma: float  # clipped standard deviation of the sky pixels
    scale: float  # factor applied to DN: 10^(-0.4 (MAGZP - 22.5))


def calibrate_frame(
    intensity: FloatArray,
    uncertainty: FloatArray,
    mask: npt.NDArray[np.integer],
    magzp: float,
    mask_table: MaskTable,
) -> CalibratedFrame:
    """Rescale an L1b frame to MAGZP 22.5, apply the documented mask bits, subtract the sky.

    The uncertainty plane is the 1 sigma error of the intensity (Explanatory Supplement); its
    square is the variance. The sky is the 3 sigma clipped median of the valid pixels.
    Raises ValueError when the planes do not have the same shape or no valid pixel remains.
    """
    img = np.asarray(intensity, dtype=np.float64)
    unc = np.asarray(uncertainty, dtype=np.float64)
    msk = np.asarray(mask).astype(np.int64)
    if img.shape != unc.shape or img.shape != msk.shape:
        raise ValueError("Intensity, uncertainty and mask planes differ in shape")
    if not np.isfinite(magzp):
        raise ValueError("MAGZP is not finite")
    scale = float(10.0 ** (-0.4 * (float(magzp) - ZP_REF_MAG)))
    bad = (
        ~np.isfinite(img)
        | ~np.isfinite(unc)
        | (unc <= 0)
        | ((msk & exclusion_bits(mask_table)) != 0)
    )
    saturated = (msk & saturation_bits(mask_table)) != 0
    good = ~bad
    if int(good.sum()) < 10:
        raise ValueError("No valid pixels in the frame")
    sci = img * scale
    _, sky, sky_sigma = sigma_clipped_stats(sci[good], sigma=SKY_CLIP_SIGMA, maxiters=5)
    sci = np.where(good, sci - float(sky), np.nan)
    var = np.where(good, (unc * scale) ** 2, np.nan)
    return CalibratedFrame(
        science=sci.astype(np.float32),
        variance=var.astype(np.float32),
        bad=np.asarray(bad, dtype=bool),
        saturated=np.asarray(saturated, dtype=bool),
        sky=float(sky),
        sky_sigma=float(sky_sigma),
        scale=scale,
    )


def clipped_coadd(
    images: Sequence[FloatArray],
    variances: Sequence[FloatArray],
    clip: float = COADD_CLIP_SIGMA,
    min_frames_clip: int = COADD_MIN_FRAMES_CLIP,
) -> tuple[Coadd, int]:
    """Inverse-variance mean of the frames of one visit after a per-pixel clip.

    Where at least `min_frames_clip` frames are valid, a sample is rejected when it deviates from
    the per-pixel median by more than `clip` times the larger of the robust spread over the
    frames (1.4826 MAD) and its own pixel uncertainty. The spread over the frames carries the real
    variation of bright star pixels between frames (pointing phase), so they are not rejected the
    way a clip against the pixel noise alone would reject them; the pixel uncertainty keeps the
    threshold from collapsing where the MAD is small by chance. Unlike the SPHEREx linear variable
    filter, every WISE frame of one band has the same bandpass, so the frames of a visit sample the
    same quantity. Returns the coadd and the number of rejected samples.
    """
    if len(images) == 0:
        raise ValueError("clipped_coadd needs at least one image")
    img = np.stack([np.asarray(i, dtype=np.float64) for i in images])
    var = np.stack([np.asarray(v, dtype=np.float64) for v in variances])
    valid = np.isfinite(img) & np.isfinite(var) & (var > 0)
    n_valid = valid.sum(axis=0)
    rejected = 0
    if img.shape[0] >= min_frames_clip:
        data = np.where(valid, img, np.nan)
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN pixels
            med = np.nanmedian(data, axis=0)
            mad = 1.4826 * np.nanmedian(np.abs(data - med), axis=0)
        sigma = np.maximum(mad[None, :, :], np.sqrt(np.where(valid, var, 0.0)))
        can_clip = (n_valid >= min_frames_clip)[None, :, :]
        with np.errstate(invalid="ignore"):
            out = valid & can_clip & (np.abs(data - med[None, :, :]) > clip * sigma)
        rejected = int(out.sum())
        valid &= ~out
    w = np.where(valid, 1.0 / np.where(valid, var, 1.0), 0.0)
    wsum = w.sum(axis=0)
    n_used = valid.sum(axis=0).astype(np.int32)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = (w * np.where(valid, img, 0.0)).sum(axis=0) / wsum
        out_var = 1.0 / wsum
    empty = n_used == 0
    mean = np.where(empty, np.nan, mean).astype(np.float32)
    out_var = np.where(empty, np.nan, out_var).astype(np.float32)
    return Coadd(mean=mean, variance=out_var, n_used=n_used, n_input=len(images)), rejected


# ------------------------------------------------------------------ bandpasses
@dataclass(frozen=True)
class BandWindow:
    """Wavelength interval of a WISE band where the response is at least `fraction` of its peak."""

    band: str  # "W1" or "W2"
    lo_um: float
    hi_um: float
    fraction: float
    peak_um: float
    source: str


RSR_DIR = Path(__file__).resolve().parents[1] / "data" / "wise"
RSR_SOURCE = (
    "Wright et al. 2010, AJ 140, 1868; relative spectral response per photon, "
    "irsa.ipac.caltech.edu/data/WISE/docs/release/All-Sky/expsup/figures/RSR-W{n}.txt"
)


def band_window(
    wavelength_um: FloatArray, response: FloatArray, band: str,
    fraction: float = BAND_RESPONSE_FRACTION,
) -> BandWindow:  # fmt: skip
    """Outermost wavelengths at which the response reaches `fraction` of its peak.

    The edges are interpolated linearly between the tabulated points on each side. Dips below
    the threshold inside the interval (W1 has some) do not split it: the band is one interval.
    """
    wl = np.asarray(wavelength_um, dtype=np.float64)
    r = np.asarray(response, dtype=np.float64)
    order = np.argsort(wl)
    wl, r = wl[order], r[order]
    peak = float(np.max(r))
    if not peak > 0:
        raise ValueError("Response has no positive value")
    rn = r / peak
    above = np.nonzero(rn >= fraction)[0]
    i0, i1 = int(above[0]), int(above[-1])

    def edge(a: int, b: int) -> float:
        # a is below the threshold, b at or above it (or a == b at the table edge).
        if a == b or rn[a] == rn[b]:
            return float(wl[b])
        return float(wl[a] + (fraction - rn[a]) * (wl[b] - wl[a]) / (rn[b] - rn[a]))

    lo = edge(max(i0 - 1, 0), i0)
    hi = edge(min(i1 + 1, wl.size - 1), i1)
    n = band.lstrip("Ww")
    return BandWindow(band, lo, hi, fraction, float(wl[int(np.argmax(r))]), RSR_SOURCE.format(n=n))


def load_rsr(band: str) -> tuple[FloatArray, FloatArray]:
    """Tabulated RSR (wavelength in um, relative response per photon) shipped with the package."""
    name = f"RSR-{band.upper()}.txt"
    text = (RSR_DIR / name).read_text("utf-8")
    rows = [line.split() for line in text.splitlines() if line.strip() and not line.startswith("#")]
    arr = np.array([[float(a), float(b)] for a, b, *_ in rows], dtype=np.float64)
    return arr[:, 0], arr[:, 1]


def official_band_window(band: str) -> BandWindow:
    """Half-peak window of W1 or W2 from the official response file."""
    wl, r = load_rsr(band)
    return band_window(wl, r, band.upper())


def band_matched(wavelength_um: FloatArray, window: BandWindow) -> BoolArray:
    """True for exposures whose wavelength at the target lies inside the band window (inclusive).

    This selects the SPHEREx exposures that form the "WISE-matched" SPHEREx view of a band: each
    SPHEREx exposure samples one narrow wavelength at a given sky position (linear variable
    filter), so only those whose sample falls inside the WISE band are kept. Non-finite
    wavelengths are never matched.
    """
    wl = np.asarray(wavelength_um, dtype=np.float64)
    return np.asarray(np.isfinite(wl) & (wl >= window.lo_um) & (wl <= window.hi_um), dtype=bool)
