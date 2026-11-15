"""Per-exposure calibration of SPHEREx Level 2 cutouts. Pure: takes an opened HDUList.

Extension layout verified against live IRSA cutouts (backend/data-notes.md): IMAGE (MJy/sr,
zodiacal light included), FLAGS (int32 bitmask, bit names in the header as MSKN<i>/MSKM<i>),
VARIANCE ((MJy/sr)^2), ZODI (MJy/sr) and WCS-WAVE (lookup table, WCS key "W", two output axes:
wavelength and bandwidth in micron). The WCS key "A" gives 0-based detector pixel coordinates.
"""

from __future__ import annotations

import re
import warnings
from dataclasses import dataclass, field

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.io import fits
from astropy.logger import log as astropy_log
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS

from destello.core.logging import silence_known_astropy_noise

# Flag names (FLAGS header MSKN/MSKM) whose pixels are excluded from science products. SOURCE only
# marks pixels mapped to a known source and must never be masked; FULLSAMPLE and PHANMISS are
# informational. Bit numbers are always read from the FLAGS header, never hardcoded.
DEFAULT_MASK_FLAGS: tuple[str, ...] = (
    "TRANSIENT",
    "OVERFLOW",
    "SUR_ERROR",
    "PHANTOM",
    "REFERENCE",
    "NONFUNC",
    "DICHROIC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "NONLINEAR",
    "PERSIST",
    "OUTLIER",
    "STREAK",
    "SNOWBALL",
)
# Flags set by bright sources (overflow, early overflow, bloom spillover) whose pixels are masked
# in coadds (DEFAULT_MASK_FLAGS); used to tell whether a source core is lost in the coadds
# (astrometry detector choice) and to draw masked bright pixels at full scale.
SATURATION_FLAGS: tuple[str, ...] = ("OVERFLOW", "NONLINEAR", "TRANSIENT", "SUR_ERROR")

# Forced photometry on single exposures follows the flag usage of the SPHEREx Explanatory
# Supplement (SSDC-DP-017 v2.0, section 3.3, "Flag usage"). OVERFLOW pixels keep a valid slope
# (the onboard fit uses only the samples before the overflow threshold, about half of full well,
# and the nonlinearity correction handles the interrupted ramp); TRANSIENT pixels report the
# photocurrent from the reads before the event. Neither is masked for photometry. SUR_ERROR marks
# early overflow or early transients (and onboard errors) and is masked. PHANTOM, REFERENCE,
# DICHROIC, OUTLIER and STREAK are not in the Supplement list and are masked here as a
# conservative choice (not science pixels, low throughput, outliers, satellites).
PHOTOMETRY_MASK_FLAGS: tuple[str, ...] = (
    "SUR_ERROR",
    "NONFUNC",
    "MISSING_DATA",
    "HOT",
    "COLD",
    "NONLINEAR",
    "PERSIST",
    "BLOOM",
    "SNOWBALL",
    "HALO",
    "SATELLITE_HALO",
    "PHANTOM",
    "REFERENCE",
    "DICHROIC",
    "OUTLIER",
    "STREAK",
)
# Background annulus: the photometry mask plus OVERFLOW and TRANSIENT (Supplement background
# list). SOURCE, also in that list, is not used: the source mask of a bright target can cover
# the whole annulus; the annulus median is robust to faint field sources.
BACKGROUND_MASK_FLAGS: tuple[str, ...] = (*PHOTOMETRY_MASK_FLAGS, "OVERFLOW", "TRANSIENT")
# A source core pixel carrying one of these and excluded from the sum means the source saturated
# the detector in that exposure (early overflow, unreliable nonlinearity correction, bloom).
CORE_SATURATION_FLAGS: tuple[str, ...] = ("OVERFLOW", "NONLINEAR", "BLOOM")
# Informational flags, never reported as quality problems.
INFORMATIONAL_FLAGS: tuple[str, ...] = ("SOURCE", "FULLSAMPLE", "PHANMISS")

_ARCSEC2_TO_SR = (np.pi / 180.0 / 3600.0) ** 2
_MJY = 1.0e6  # Jy per MJy

silence_known_astropy_noise()

FloatArray = npt.NDArray[np.floating]


class CutoutFormatError(ValueError):
    """Raised when a FITS cutout does not have the expected SPHEREx Level 2 structure."""


@dataclass
class Cutout:
    """A parsed single-exposure cutout (all arrays share the shape (ny, nx))."""

    obs_id: str
    detector: int
    image: FloatArray  # MJy/sr, zodiacal light still included
    zodi: FloatArray  # MJy/sr
    variance: FloatArray  # (MJy/sr)^2
    flags: npt.NDArray[np.int64]
    wcs: WCS
    wave_wcs: WCS | None
    det_wcs: WCS | None
    t_start: Time
    t_mid: Time
    t_end: Time
    exposure_s: float
    flag_bits: dict[str, int]
    omega_median_arcsec2: float | None
    psf_fwhm_arcsec: float | None
    extra: dict[str, float | str] = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        return int(self.image.shape[0]), int(self.image.shape[1])


def parse_flag_bits(header: fits.Header) -> dict[str, int]:
    """Read flag bit numbers from the FLAGS header.

    The IRSA files define bits with triplets MSKN<i> (name), MSKM<i> (mask value, a power of
    two) and MSKD<i> (description). Keywords MP_<NAME> = <bit number> are accepted as a fallback.
    """
    bits: dict[str, int] = {}
    for key in header:
        if not isinstance(key, str):
            continue
        if key.startswith("MSKN") and key[4:].isdigit():
            mask_key = "MSKM" + key[4:]
            try:
                value = int(header[mask_key])
                name = str(header[key]).strip()
            except (KeyError, TypeError, ValueError):
                continue
            if value > 0 and value & (value - 1) == 0 and name:
                bits[name] = value.bit_length() - 1
        elif key.startswith("MP_"):
            try:
                bits.setdefault(key[3:], int(header[key]))
            except (TypeError, ValueError):
                continue
    return bits


def flag_mask(
    flags: npt.NDArray[np.int64], bits: dict[str, int], names: tuple[str, ...]
) -> npt.NDArray[np.bool_]:
    """Boolean mask of pixels where any of the named flag bits is set. Unknown names are skipped."""
    mask = np.zeros(flags.shape, dtype=bool)
    for name in names:
        bit = bits.get(name)
        if bit is not None:
            mask |= (flags.astype(np.int64) >> bit) & 1 == 1
    return mask


def flag_names_in(
    flags: npt.NDArray[np.int64], bits: dict[str, int], region: npt.NDArray[np.bool_]
) -> list[str]:
    """Sorted names of the non-informational flag bits set on at least one pixel of `region`."""
    if not region.any():
        return []
    present = int(np.bitwise_or.reduce(flags[region].astype(np.int64)))
    return sorted(
        name
        for name, bit in bits.items()
        if name not in INFORMATIONAL_FLAGS and (present >> bit) & 1
    )


def masked_flag_names(
    flags: npt.NDArray[np.int64],
    bits: dict[str, int],
    region: npt.NDArray[np.bool_],
    mask_flags: tuple[str, ...] = DEFAULT_MASK_FLAGS,
) -> list[str]:
    """Sorted names of the masking flags (`mask_flags`) set on at least one pixel of `region`.

    Names and bit numbers come from the FLAGS header (`bits`); a masking flag that the header does
    not define is never reported.
    """
    return [n for n in flag_names_in(flags, bits, region) if n in mask_flags]


def _check_unit(header: fits.Header, expected: str, ext: str) -> None:
    raw = str(header.get("BUNIT", "")).strip()
    try:
        ok = u.Unit(raw) == u.Unit(expected)
    except ValueError:
        ok = False
    if not ok:
        raise CutoutFormatError(f"{ext}: unexpected BUNIT {raw!r}, expected {expected!r}")


_NON_WCS_KEYWORDS = frozenset({"COMMENT", "HISTORY", ""})


def wcs_header(hdr: fits.Header) -> fits.Header:
    """Copy of `hdr` without commentary cards and HIERARCH keywords.

    WCS keywords are standard (at most 8 characters) keywords, so the result defines the same
    celestial, spectral (key W) and detector (key A) transformations as `hdr`, SIP included.
    Building WCS objects from the shorter header avoids about a fifth of the per exposure parse
    cost, which dominates the spectrum and astrometry endpoints.
    """
    return fits.Header(
        [
            card
            for card in hdr.cards
            if card.keyword not in _NON_WCS_KEYWORDS and len(card.keyword) <= 8
        ]
    )


_SIP_KEYWORD = re.compile(r"^(A|B|AP|BP)_(ORDER|DMAX|\d+_\d+)$")


def alternate_wcs_header(whdr: fits.Header) -> fits.Header:
    """`whdr` without the SIP cards of the celestial WCS.

    The alternate WCS (keys W and A) are used without SIP (see `load_cutout`); building them
    from a header that has no SIP cards gives the same objects at about a third of the cost
    (astropy otherwise parses the polynomial again for every key).
    """
    return fits.Header([card for card in whdr.cards if not _SIP_KEYWORD.match(card.keyword)])


def load_cutout(hdul: fits.HDUList, obs_id: str) -> Cutout:
    """Parse an IRSA SPHEREx Level 2 cutout (HDUList) into a Cutout."""
    try:
        image_hdu = hdul["IMAGE"]
        flags_hdu = hdul["FLAGS"]
        var_hdu = hdul["VARIANCE"]
        zodi_hdu = hdul["ZODI"]
    except KeyError as exc:
        raise CutoutFormatError(f"Missing extension: {exc}") from exc
    hdr = image_hdu.header
    _check_unit(hdr, "MJy / sr", "IMAGE")
    _check_unit(zodi_hdu.header, "MJy / sr", "ZODI")
    _check_unit(var_hdu.header, "MJy2 / sr2", "VARIANCE")
    whdr = wcs_header(hdr)
    # astropy serializes a Header object several times per WCS; the serialized text is made once
    # per header here and gives the same WCS objects at about half the cost.
    wcs_text = whdr.tostring()
    alt_text = alternate_wcs_header(whdr).tostring()
    # The spectral WCS (key W) makes astropy log an INFO message about SIP; keep it out of logs.
    with warnings.catch_warnings(), astropy_log.log_to_list():
        warnings.simplefilter("ignore", AstropyWarning)
        wcs = WCS(wcs_text)
        wave_wcs: WCS | None = None
        if "WCS-WAVE" in hdul:
            try:
                wave_wcs = WCS(alt_text, fobj=hdul, key="W")
            except Exception:  # lookup table problems must not discard the exposure
                wave_wcs = None
        det_wcs: WCS | None
        try:
            det_wcs = WCS(alt_text, key="A")
        except Exception:
            det_wcs = None
    # astropy attaches the SIP polynomial of the celestial WCS to every alternate WCS built from
    # the same header. Wavelength per pixel is a property of the detector and filter, and the
    # detector coordinates are a plain pixel offset: neither sees the optical distortion. The
    # IRSA SPHEREx tutorial turns SIP off for key W for this reason; left on, the lookup moves by
    # up to tens of pixels (wavelength off by up to half a bandwidth near the detector corners).
    for alt in (wave_wcs, det_wcs):
        if alt is not None:
            alt.sip = None
    t_mid = Time(float(hdr["MJD-AVG"]), format="mjd", scale="utc")
    t_start = Time(float(hdr["MJD-BEG"]), format="mjd", scale="utc")
    t_end = Time(float(hdr["MJD-END"]), format="mjd", scale="utc")
    return Cutout(
        obs_id=obs_id,
        detector=int(hdr["DETECTOR"]),
        image=np.asarray(image_hdu.data, dtype=np.float32),
        zodi=np.asarray(zodi_hdu.data, dtype=np.float32),
        variance=np.asarray(var_hdu.data, dtype=np.float32),
        flags=np.asarray(flags_hdu.data, dtype=np.int64),
        wcs=wcs,
        wave_wcs=wave_wcs,
        det_wcs=det_wcs,
        t_start=t_start,
        t_mid=t_mid,
        t_end=t_end,
        exposure_s=float(hdr.get("XPOSURE", 0.0)),
        flag_bits=parse_flag_bits(flags_hdu.header),
        omega_median_arcsec2=_opt_float(hdr, "OMEGA_MEDIAN"),
        psf_fwhm_arcsec=_opt_float(hdr, "PSF_FWHM"),
    )


def _opt_float(hdr: fits.Header, key: str) -> float | None:
    try:
        return float(hdr[key])
    except (KeyError, TypeError, ValueError):
        return None


@dataclass
class CalibratedCutout:
    """Science image (zodiacal light removed) with matching variance and mask."""

    cutout: Cutout
    science: FloatArray  # MJy/sr
    variance: FloatArray  # (MJy/sr)^2
    bad: npt.NDArray[np.bool_]  # True where excluded
    saturated: npt.NDArray[np.bool_]  # True where saturation related flags are set
    omega_arcsec2: FloatArray  # pixel solid angle map, arcsec^2


def calibrate(
    cutout: Cutout,
    sapm: FloatArray | None = None,
    mask_flags: tuple[str, ...] = DEFAULT_MASK_FLAGS,
) -> CalibratedCutout:
    """science = IMAGE - ZODI; mask flagged and non-finite pixels; attach the solid angle map."""
    science = (cutout.image - cutout.zodi).astype(np.float32)
    bad = flag_mask(cutout.flags, cutout.flag_bits, mask_flags)
    bad |= ~np.isfinite(science) | ~np.isfinite(cutout.variance) | (cutout.variance <= 0)
    saturated = flag_mask(cutout.flags, cutout.flag_bits, SATURATION_FLAGS)
    omega = solid_angle_for_cutout(cutout, sapm)
    return CalibratedCutout(
        cutout=cutout,
        science=np.where(bad, np.nan, science).astype(np.float32),
        variance=np.where(bad, np.nan, cutout.variance).astype(np.float32),
        bad=bad,
        saturated=saturated,
        omega_arcsec2=omega,
    )


@dataclass
class PhotometryView:
    """Single-exposure arrays masked for forced photometry (PHOTOMETRY_MASK_FLAGS)."""

    science: FloatArray  # MJy/sr, NaN where `bad`
    variance: FloatArray  # (MJy/sr)^2, NaN where `bad`
    bad: npt.NDArray[np.bool_]  # excluded from aperture sums
    background_bad: npt.NDArray[np.bool_]  # excluded from the background annulus
    saturation: npt.NDArray[np.bool_]  # pixels with CORE_SATURATION_FLAGS


def photometry_view(
    cal: CalibratedCutout, mask_flags: tuple[str, ...] = PHOTOMETRY_MASK_FLAGS
) -> PhotometryView:
    """Re-mask a calibrated cutout with the photometry flag set instead of the coadd one.

    `mask_flags` sets the aperture exclusion only (moving targets drop OUTLIER, docs/03 section
    4.9); the background annulus always uses BACKGROUND_MASK_FLAGS.
    """
    cut = cal.cutout
    science = (cut.image - cut.zodi).astype(np.float32)
    invalid = ~np.isfinite(science) | ~np.isfinite(cut.variance) | (cut.variance <= 0)
    bad = flag_mask(cut.flags, cut.flag_bits, mask_flags) | invalid
    background_bad = flag_mask(cut.flags, cut.flag_bits, BACKGROUND_MASK_FLAGS) | invalid
    return PhotometryView(
        science=np.where(bad, np.nan, science).astype(np.float32),
        variance=np.where(bad, np.nan, cut.variance).astype(np.float32),
        bad=bad,
        background_bad=background_bad,
        saturation=flag_mask(cut.flags, cut.flag_bits, CORE_SATURATION_FLAGS),
    )


def solid_angle_for_cutout(cutout: Cutout, sapm: FloatArray | None) -> FloatArray:
    """Pixel solid angle (arcsec^2) for every cutout pixel.

    Uses the per-detector solid angle pixel map when given (indexed through the 0-based detector
    pixel coordinates of WCS key "A"); otherwise falls back to the header OMEGA_MEDIAN.
    """
    ny, nx = cutout.shape
    if sapm is not None and cutout.det_wcs is not None:
        yy, xx = np.mgrid[0:ny, 0:nx]
        dx, dy = cutout.det_wcs.all_pix2world(xx, yy, 0)
        ix = np.clip(np.rint(dx).astype(int), 0, sapm.shape[1] - 1)
        iy = np.clip(np.rint(dy).astype(int), 0, sapm.shape[0] - 1)
        return np.asarray(sapm[iy, ix], dtype=np.float32)
    if cutout.omega_median_arcsec2 is None:
        raise CutoutFormatError("No solid angle map and no OMEGA_MEDIAN header")
    return np.full((ny, nx), cutout.omega_median_arcsec2, dtype=np.float32)


def surface_brightness_to_jy(
    sb_mjy_sr: FloatArray | float, omega_arcsec2: FloatArray | float
) -> FloatArray:
    """Convert surface brightness (MJy/sr) to flux density per pixel (Jy) using the solid angle."""
    out: FloatArray = (
        np.asarray(sb_mjy_sr, dtype=np.float64) * _MJY * np.asarray(omega_arcsec2) * _ARCSEC2_TO_SR
    )
    return out


def wavelength_at(cutout: Cutout, x: float, y: float) -> tuple[u.Quantity, u.Quantity]:
    """(wavelength, bandwidth) in micron at cutout pixel (x, y), 0-based, from WCS key W."""
    if cutout.wave_wcs is None:
        raise CutoutFormatError("Cutout has no spectral WCS")
    wl, bw = cutout.wave_wcs.pixel_to_world_values(x, y)
    return float(wl) * u.um, float(bw) * u.um


def wavelength_range(cutout: Cutout) -> tuple[u.Quantity, u.Quantity]:
    """Minimum and maximum wavelength over the cutout (sampled on a 5 x 5 grid of pixels)."""
    ny, nx = cutout.shape
    xs = np.linspace(0, nx - 1, 5)
    ys = np.linspace(0, ny - 1, 5)
    xx, yy = np.meshgrid(xs, ys)
    if cutout.wave_wcs is None:
        raise CutoutFormatError("Cutout has no spectral WCS")
    wl, _ = cutout.wave_wcs.pixel_to_world_values(xx, yy)
    return float(np.nanmin(wl)) * u.um, float(np.nanmax(wl)) * u.um
