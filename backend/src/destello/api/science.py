"""Spectrum and astrometry measured on stored sequences (docs/03 sections 4.5 and 4.6).

Synchronous, CPU bound functions over the files of a built sequence (manifest, sidecar with the
cutout list, FITS coadds, cached cutouts and solid angle maps). They run in a worker thread from
the API routes and directly from `scripts/run_validation.py`. Nothing here performs network
requests: catalogs are fetched by the caller (`recalibration_catalog`) through `sources/`.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import threading
import warnings
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.io import fits
from astropy.logger import log as astropy_log
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS

from destello.core.config import uses_quick_release
from destello.models.catalog import CatalogSource
from destello.models.targets import Target, load_targets, parse_epoch
from destello.pipeline.astrometry import (
    Centroid,
    MotionFit,
    Recalibration,
    agreement_sigma,
    combine_offsets,
    fit_motion,
    fit_recalibration,
    measure_centroid,
    measure_wing_centroid,
    well_spread_epochs,
)
from destello.pipeline.calibrate import (
    SATURATION_FLAGS,
    CalibratedCutout,
    calibrate,
    flag_mask,
    load_cutout,
    parse_flag_bits,
    surface_brightness_to_jy,
    wavelength_at,
    wcs_header,
)
from destello.pipeline.photometry import (
    DEFAULT_ANNULUS_ARCSEC,
    DEFAULT_APERTURE_ARCSEC,
    WING_ANNULUS_ARCSEC,
    WING_BACKGROUND_ARCSEC,
    forced_photometry,
    point_reason,
    wing_annulus_flux,
)

__all__ = [
    "DEFAULT_APERTURE_ARCSEC",
    "WING_ANNULUS_ARCSEC",
    "WING_BACKGROUND_ARCSEC",
    "ScienceError",
    "compute_spectrum",
    "measure_astrometry",
    "require_in_field",
]
from destello.pipeline.propagate import Astrometry, apparent_positions, parallax_factors
from destello.pipeline.reproject import GridSpec
from destello.pipeline.spectral_index import methane_index

FloatArray = npt.NDArray[np.float64]

NATIVE_PIXEL_ARCSEC = 6.2  # SPHEREx native pixel (docs/03 section 1)
TARGET_MATCH_ARCSEC = 60.0  # a request within this radius of a preset uses its astrometry
RECAL_MAX_MAG = 18.5
RECAL_MAX_STARS = 250
RECAL_MIN_STARS = 3
RECAL_ISOLATION_ARCSEC = 12.0
RECAL_TARGET_EXCLUSION_ARCSEC = 20.0
RECAL_MIN_SNR = 10.0
TARGET_MIN_SNR = 5.0
DEBLEND_MIN_SNR = 3.0
CENTROID_HALF_BOX = 4  # grid pixels (3.1 arcsec): a 9 x 9 box, about 1.4 PSF FWHM each side
BLEND_RADIUS_ARCSEC = 9.0
NEIGHBOR_SELF_ARCSEC = 3.0  # a catalog entry this close to the prediction is the target
GAIA_CONE_MAX_G = 19.0
CONE_LIMIT = 3000
# PSF wing centroids of saturated targets on single exposures (docs/03 section 4.5)
WING_RADIUS_ARCSEC = 86.0  # 14 native pixels: the fit covers the bright, unflagged wings
WING_MAX_SHIFT_ARCSEC = 18.6  # 3 native pixels from the prediction
WING_MIN_EXPOSURES = 3  # accepted exposures per epoch
WING_MASK_MAX_MAG = 17.0  # catalog stars masked in the wing fit
WING_MASK_ARCSEC = 10.0
# Per-axis systematic of a wing position: rms offset of Barnard's Star wing fits from its Gaia DR3
# prediction over 3 epochs x 6 detectors (0.93 arcsec in RA, 0.27 in Dec, 0.69 per axis; the sign
# follows the season, as expected from an asymmetric PSF rotated between survey passes).
WING_SYSTEMATIC_ARCSEC = 0.7


class ScienceError(Exception):
    """A measurement request that cannot be served; carries an API error code."""

    def __init__(self, status: int, code: str, title: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail


# ------------------------------------------------------------------ sequence files
@dataclass
class SequenceFiles:
    sid: str
    data_dir: Path
    manifest: dict[str, Any]
    sidecar: dict[str, Any]

    @property
    def grid(self) -> dict[str, Any]:
        g: dict[str, Any] = self.manifest["grid"]
        return g

    def target_id(self) -> str | None:
        t = self.sidecar.get("params", {}).get("target_id")
        return str(t) if t else None


def load_sequence(data_dir: Path, sid: str) -> SequenceFiles:
    try:
        manifest = json.loads((data_dir / "manifests" / f"{sid}.json").read_text("utf-8"))
        sidecar = json.loads((data_dir / "builds" / f"{sid}.json").read_text("utf-8"))
    except (OSError, ValueError):
        raise ScienceError(404, "NOT_FOUND", "Not found", "Unknown sequence.") from None
    return measurable(SequenceFiles(sid=sid, data_dir=data_dir, manifest=manifest, sidecar=sidecar))


def low_coverage_epochs(manifest: dict[str, Any]) -> set[int]:
    """Indices of the epochs built from a short revisit (manifest `coverage` "low")."""
    return {int(e["index"]) for e in manifest.get("epochs", []) if e.get("coverage") == "low"}


def measurable(seq: SequenceFiles) -> SequenceFiles:
    """The sequence as the measurements see it: without the low coverage epochs and their
    exposures. The remaining epochs keep their manifest index, so results still refer to the
    frames on screen. A sequence without such epochs is returned as it is."""
    low = low_coverage_epochs(seq.manifest)
    if not low:
        return seq
    manifest = dict(seq.manifest)
    manifest["epochs"] = [e for e in seq.manifest["epochs"] if int(e["index"]) not in low]
    sidecar = dict(seq.sidecar)
    sidecar["exposures"] = [
        e for e in seq.sidecar.get("exposures", []) if int(e["epoch"]) not in low
    ]
    return SequenceFiles(sid=seq.sid, data_dir=seq.data_dir, manifest=manifest, sidecar=sidecar)


@lru_cache(maxsize=12)
def _load_sapm(path: str) -> npt.NDArray[np.float32] | None:
    try:
        with fits.open(path, memmap=False) as hdul:
            hdu = hdul["IMAGE"] if "IMAGE" in hdul else hdul[0]
            return np.asarray(hdu.data, dtype=np.float32)
    except (OSError, KeyError):
        return None


def sapm_for(data_dir: Path, collection: str, detector: int) -> npt.NDArray[np.float32] | None:
    release = collection.replace("_deep", "")
    path = data_dir / "calibration" / f"sapm_{release}_D{detector}.fits"
    return _load_sapm(str(path)) if path.is_file() else None


@lru_cache(maxsize=8)
def _resolved_root(data_dir: str) -> str:
    return os.path.realpath(data_dir)


def exposure_path(data_dir: Path, exp: dict[str, Any]) -> Path:
    """Absolute path of a cutout named by a build sidecar, confined to the data directory.

    The relative path is normalized lexically (a sidecar is written by the build, never by a
    request) and the data directory is resolved once: resolving every cutout walks the file
    system several times per exposure, which dominated measurements on slow volumes."""
    root = _resolved_root(str(data_dir))
    path = os.path.normpath(os.path.join(root, str(exp["path"])))
    if os.path.commonpath([root, path]) != root or path == root:
        raise ScienceError(500, "INTERNAL_ERROR", "Internal error", "Invalid cutout path.")
    return Path(path)


def open_exposure(data_dir: Path, exp: dict[str, Any]) -> CalibratedCutout:
    path = exposure_path(data_dir, exp)
    with fits.open(path) as hdul:
        cut = load_cutout(hdul, str(exp["obs_id"]))
    return calibrate(cut, sapm_for(data_dir, str(exp["collection"]), int(exp["detector"])))


# Per exposure work (FITS parsing, WCS construction, photometry) is independent between
# exposures and releases the GIL for a good part of it; a small pool cuts the wall time of the
# spectrum and astrometry endpoints. Results always come back in input order.
EXPOSURE_THREADS = 4


# At most this many measurements run at once per process (each one uses EXPOSURE_THREADS), so a
# burst of uncached requests queues instead of oversubscribing the CPU and memory of the API.
MEASUREMENT_SLOTS = 2
_measurement_slots = threading.BoundedSemaphore(MEASUREMENT_SLOTS)


def run_measurement[R](fn: Callable[..., R], *args: Any) -> R:
    """Run `fn(*args)` (a worker thread entry point) holding a measurement slot."""
    with _measurement_slots:
        return fn(*args)


def map_exposures[T, R](fn: Callable[[T], R], items: Sequence[T]) -> list[R]:
    """`[fn(x) for x in items]` on a bounded thread pool, preserving order."""
    if len(items) < 2:
        return [fn(x) for x in items]
    with ThreadPoolExecutor(max_workers=EXPOSURE_THREADS, thread_name_prefix="exposure") as pool:
        return list(pool.map(fn, items))


@dataclass(frozen=True)
class _SaturationInfo:
    t_mid: Time
    wcs: WCS
    saturated: npt.NDArray[np.bool_]
    scale_arcsec: float
    lock: threading.Lock = field(default_factory=threading.Lock, compare=False)


@lru_cache(maxsize=4096)
def _saturation_info(path: str, mtime_ns: int, size: int) -> _SaturationInfo:
    """IMAGE header WCS, mid time and SATURATION_FLAGS mask of one cutout (memoized by file
    identity; `mtime_ns` and `size` invalidate the entry when the file is replaced). Reads only
    the IMAGE header and the FLAGS extension, the inputs of `CalibratedCutout.saturated`."""
    del mtime_ns, size  # part of the cache key only
    with fits.open(path) as hdul:
        hdr = hdul["IMAGE"].header
        flags_hdu = hdul["FLAGS"]
        flags = np.asarray(flags_hdu.data, dtype=np.int64)
        bits = parse_flag_bits(flags_hdu.header)
        with warnings.catch_warnings(), astropy_log.log_to_list():
            warnings.simplefilter("ignore", AstropyWarning)
            wcs = WCS(wcs_header(hdr))
        t_mid = Time(float(hdr["MJD-AVG"]), format="mjd", scale="utc")
    saturated = flag_mask(flags, bits, SATURATION_FLAGS)
    saturated.setflags(write=False)
    return _SaturationInfo(
        t_mid=t_mid, wcs=wcs, saturated=saturated, scale_arcsec=_pixel_scale_arcsec(wcs)
    )


def preset_target(seq: SequenceFiles) -> Target | None:
    tid = seq.target_id()
    return load_targets().get(tid) if tid else None


def mean_time(seq: SequenceFiles) -> Time:
    mjd = [float(e["t_mid_mjd"]) for e in seq.manifest["epochs"]]
    return Time(float(np.mean(mjd)), format="mjd", scale="utc")


def _sep_arcsec(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    d_ra = (ra1 - ra2 + 180.0) % 360.0 - 180.0
    return float(np.hypot(d_ra * math.cos(math.radians(dec2)), dec1 - dec2) * 3600.0)


def match_target(seq: SequenceFiles, ra: float, dec: float) -> Target | None:
    """The preset whose propagated position at the sequence mean time lies near (ra, dec)."""
    t = mean_time(seq)
    candidates = [preset_target(seq)] + list(load_targets().values())
    for target in candidates:
        if target is None:
            continue
        pos = apparent_positions(target.to_astrometry(), t)
        a = target.astrometry
        near_now = _sep_arcsec(float(pos.ra.deg), float(pos.dec.deg), ra, dec)
        near_ref = _sep_arcsec(a.ra_deg, a.dec_deg, ra, dec)  # catalog position as given
        if min(near_now, near_ref) <= TARGET_MATCH_ARCSEC:
            return target
    return None


def request_astrometry(
    ra: float,
    dec: float,
    pmra_masyr: float | None,
    pmdec_masyr: float | None,
    ref_epoch: str | None,
) -> Astrometry | None:
    """Astrometry from explicit request parameters (motion given), else None."""
    if pmra_masyr is None and pmdec_masyr is None:
        return None
    try:
        epoch = parse_epoch(ref_epoch) if ref_epoch else parse_epoch("J2016.0")
    except ValueError:
        try:
            epoch = Time(str(ref_epoch), scale="utc")
        except ValueError:
            raise ScienceError(
                422, "INVALID_EPOCH", "Invalid epoch", "ref_epoch: use J2016.0, MJD57338.5 or ISO."
            ) from None
    return Astrometry(
        ra=ra * u.deg,
        dec=dec * u.deg,
        pmra_cosdec=float(pmra_masyr or 0.0) * u.mas / u.yr,
        pmdec=float(pmdec_masyr or 0.0) * u.mas / u.yr,
        parallax=0.0 * u.mas,
        ref_epoch=epoch,
    )


def _great_circle_deg(ra1: float, dec1: float, ra2: float, dec2: float) -> float:
    a1, d1, a2, d2 = (math.radians(v) for v in (ra1, dec1, ra2, dec2))
    h = (
        math.sin((d2 - d1) / 2.0) ** 2
        + math.cos(d1) * math.cos(d2) * math.sin((a2 - a1) / 2.0) ** 2
    )
    return math.degrees(2.0 * math.asin(min(1.0, math.sqrt(h))))


def check_in_field(seq: SequenceFiles, ra: float, dec: float, astro: Astrometry | None) -> None:
    """Raise a 422 `POSITION_OUTSIDE_FIELD` when the measurement point is off the sequence grid.

    The measurement point is (ra, dec) propagated with `astro` to the mean observation time of
    the sequence, or (ra, dec) itself when `astro` is None. A point on the grid that cannot be
    measured (blank sky, saturation, too few epochs) is an outcome, not an error.
    """
    pra, pdec = _position_at(astro, ra, dec, mean_time(seq))
    g = seq.grid
    nx, ny = (int(v) for v in g["naxis"])
    ra0, dec0 = (float(v) for v in g["crval_deg"])
    scale = float(g["pixel_scale_arcsec"])
    sep_deg = _great_circle_deg(pra, pdec, ra0, dec0)
    inside = False
    if math.isfinite(sep_deg) and sep_deg < 89.0:  # the gnomonic projection ends at 90 degrees
        grid = GridSpec(ra_deg=ra0, dec_deg=dec0, pixel_scale_arcsec=scale, ny=ny, nx=nx)
        px, py = _world2pix(grid.wcs(), pra, pdec)
        x, y = float(px), float(py)
        inside = (
            math.isfinite(x)
            and math.isfinite(y)
            and -0.5 <= x <= nx - 0.5
            and -0.5 <= y <= ny - 0.5
        )
    if inside:
        return
    sep = f"{sep_deg * 60.0:.1f} arcmin" if sep_deg < 2.0 else f"{sep_deg:.1f} deg"
    what = "The position" if astro is None else "The position propagated to the observation time"
    raise ScienceError(
        422,
        "POSITION_OUTSIDE_FIELD",
        "Position outside the field",
        f"{what} lies {sep} from the field center, outside the "
        f"{nx * scale / 60.0:.1f} by {ny * scale / 60.0:.1f} arcmin field of this sequence.",
    )


def require_in_field(seq: SequenceFiles, ra: float, dec: float, astro: Astrometry | None) -> None:
    """`check_in_field` with the astrometry the measurement will use: the request motion when
    given, else the astrometry of a matching preset, else the fixed position."""
    if astro is None:
        target = match_target(seq, ra, dec)
        astro = target.to_astrometry() if target is not None else None
    check_in_field(seq, ra, dec, astro)


def _quick_release(seq: SequenceFiles) -> bool:
    """True when the sequence uses Quick Release images (collections of the manifest)."""
    return uses_quick_release(seq.manifest.get("provenance", {}).get("collections", []))


def _target_warnings(target: Target | None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if target is None:
        return out
    v = target.validation
    if v.get("unresolved_pair"):
        out.append(
            {
                "code": "EPSILON_INDI_UNRESOLVED",
                "detail": "Epsilon Indi Ba and Bb are separated by less than 1 arcsec; SPHEREx "
                "pixels are about 6.2 arcsec, so the measurement refers to the unresolved pair.",
            }
        )
    if target.id == "rwaur":
        out.append(
            {
                "code": "BLENDED_SOURCE",
                "detail": "RW Aur B lies about 1.5 arcsec from RW Aur A and is blended with it.",
            }
        )
    return out


# ------------------------------------------------------------------ spectrum
def compute_spectrum(
    seq: SequenceFiles,
    ra: float,
    dec: float,
    astro: Astrometry | None,
    aperture_arcsec: float = DEFAULT_APERTURE_ARCSEC,
) -> dict[str, Any]:
    """Forced aperture photometry on every single exposure of the sequence (not the coadds).

    The position is propagated to each exposure mid time when `astro` is given (request motion
    or a matching preset); otherwise the fixed position is used. Flux density in Jy through the
    per-pixel solid angle; wavelength and bandwidth at the target pixel from the spectral WCS.
    """
    target: Target | None = None
    warn: list[dict[str, str]] = []
    if astro is None:
        target = match_target(seq, ra, dec)
        if target is not None:
            astro = target.to_astrometry()
            warn.append(
                {
                    "code": "PRESET_ASTROMETRY_USED",
                    "detail": f"Position propagated per exposure with {target.astrometry.source} "
                    f"(reference epoch {target.astrometry.ref_epoch}).",
                }
            )
    check_in_field(seq, ra, dec, astro)
    annulus = (
        max(DEFAULT_ANNULUS_ARCSEC[0], aperture_arcsec * 1.5),
        max(DEFAULT_ANNULUS_ARCSEC[1], aperture_arcsec * 3.0),
    )
    exposures = list(seq.sidecar.get("exposures", []))
    if not exposures:
        raise ScienceError(422, "NO_EXPOSURES", "No exposures", "The sequence lists no cutouts.")

    def one(exp: dict[str, Any]) -> dict[str, Any] | None:
        try:
            cal = open_exposure(seq.data_dir, exp)
        except (OSError, ValueError, KeyError):
            return None
        cut = cal.cutout
        if astro is not None:
            pos = apparent_positions(astro, cut.t_mid)
            pra, pdec = float(pos.ra.deg), float(pos.dec.deg)
        else:
            pra, pdec = ra, dec
        phot = forced_photometry(
            cal, pra * u.deg, pdec * u.deg, aperture_arcsec, annulus, masks="photometry"
        )
        reason = point_reason(phot)
        point: dict[str, Any] = {
            "epoch": int(exp["epoch"]),
            "obs_id": cut.obs_id,
            "detector": int(cut.detector),
            "t_mid_mjd": round(float(cut.t_mid.mjd), 6),
            "wavelength_um": None,
            "bandwidth_um": None,
            "flux": None,
            "flux_err": None,
            "flagged": reason is not None,
            "saturated": bool(phot.core_saturated),
            "flagged_fraction": round(float(phot.flagged_fraction), 3),
            "reason": reason,
            "aperture_flags": list(phot.aperture_flags),
            "core_flags": list(phot.core_flags),
        }
        if np.isfinite(phot.x) and np.isfinite(phot.y):
            try:
                wl, bw = wavelength_at(cut, phot.x, phot.y)
                if np.isfinite(wl.value):
                    point["wavelength_um"] = round(float(wl.to_value(u.um)), 5)
                    point["bandwidth_um"] = round(float(bw.to_value(u.um)), 5)
            except ValueError:
                pass
        # A saturated core leaves no measurement (the replaced sum is only a lower bound).
        if phot.usable and np.isfinite(phot.flux_jy) and not phot.core_saturated:
            point["flux"] = float(phot.flux_jy)
            point["flux_err"] = float(phot.flux_err_jy)
        if point["wavelength_um"] is None:
            return None  # outside the cutout or without spectral WCS: not a spectrum point
        return point

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        points = [p for p in map_exposures(one, exposures) if p is not None]
    points.sort(key=lambda p: (p["epoch"], p["wavelength_um"]))
    epoch_phot = epoch_photometry(points)
    n_sat = sum(1 for p in points if p["saturated"])
    if n_sat:
        warn.append(
            {
                "code": "SATURATION",
                "detail": f"{n_sat} of {len(points)} exposures have a saturated source core "
                "(early overflow, bloom or unreliable nonlinearity correction); those points "
                "are marked flagged and left out of the per-epoch photometry.",
            }
        )
    n_over = sum(1 for p in points if not p["flagged"] and "OVERFLOW" in p["core_flags"])
    if n_over:
        warn.append(
            {
                "code": "OVERFLOW_PIXELS_USED",
                "detail": f"{n_over} unflagged points include core pixels that reached the "
                "onboard overflow threshold (about half of full well). Their values come from "
                "the samples before the threshold and are kept, following the SPHEREx "
                "Explanatory Supplement.",
            }
        )
    warn.append(
        {
            "code": "NO_APERTURE_CORRECTION",
            "detail": f"Aperture sums within {aperture_arcsec:g} arcsec without aperture "
            "correction (PSF wings are missed).",
        }
    )
    if _quick_release(seq):
        warn.append(
            {
                "code": "QUICK_RELEASE_CALIBRATION",
                "detail": "SPHEREx Quick Release calibration is preliminary.",
            }
        )
    if astro is None:
        warn.append(
            {
                "code": "POSITION_NOT_PROPAGATED",
                "detail": "No proper motion given: the same position is used for every exposure.",
            }
        )
    warn.extend(_target_warnings(target or match_target(seq, ra, dec)))
    return {
        "unit": "Jy",
        "sequence_id": seq.sid,
        "ra_deg": ra,
        "dec_deg": dec,
        "aperture_arcsec": aperture_arcsec,
        "annulus_arcsec": list(annulus),
        "points": points,
        "epoch_photometry": epoch_phot,
        "methane_index": methane_index(points),
        "warnings": warn,
    }


def epoch_photometry(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per (epoch, detector) mean of the unflagged single-exposure fluxes.

    The mean is unweighted (each exposure samples a different wavelength inside the band) and its
    uncertainty is the larger of the propagated formal error and the standard error of the mean.
    """
    groups: dict[tuple[int, int], list[dict[str, Any]]] = {}
    for p in points:
        groups.setdefault((int(p["epoch"]), int(p["detector"])), []).append(p)
    out: list[dict[str, Any]] = []
    for (ep, det), pts in sorted(groups.items()):
        good = [p for p in pts if p["flux"] is not None and not p["flagged"]]
        wl = [p["wavelength_um"] for p in pts]
        row: dict[str, Any] = {
            "epoch": ep,
            "detector": det,
            "flux": None,
            "flux_err": None,
            "n_images": len(good),
            "n_total": len(pts),
            "saturated": any(p["saturated"] for p in pts),
            "wavelength_um": [round(min(wl), 4), round(max(wl), 4)],
        }
        if good:
            f = np.array([p["flux"] for p in good], dtype=np.float64)
            e = np.array([p["flux_err"] for p in good], dtype=np.float64)
            formal = float(np.sqrt(np.sum(e**2)) / len(f))
            sem = float(np.std(f, ddof=1) / np.sqrt(len(f))) if len(f) > 1 else formal
            row["flux"] = float(np.mean(f))
            row["flux_err"] = max(formal, sem)
        out.append(row)
    return out


# ------------------------------------------------------------------ catalogs
def cone_radius(grid: dict[str, Any]) -> u.Quantity:
    nx, ny = (int(v) for v in grid["naxis"])
    return (
        0.5 * float(np.hypot(nx, ny)) * float(grid["pixel_scale_arcsec"]) / 60.0 + 0.5
    ) * u.arcmin


async def recalibration_catalog(
    state: Any, grid: dict[str, Any], wait_s: float
) -> tuple[str, list[CatalogSource]]:
    """Reference stars for the local recalibration: Gaia DR3, or CatWISE2020 when Gaia fails.

    `state` provides `get_gaia()` and `get_catwise()` (the API AppState or an equivalent). The
    query parameters are fixed so that cached results are shared by the API and the scripts.
    """
    ra, dec = (float(v) for v in grid["crval_deg"])
    radius = cone_radius(grid)
    try:
        rows = await _shielded(
            state.get_gaia().cone(ra, dec, radius, max_g=GAIA_CONE_MAX_G, limit=CONE_LIMIT),
            wait_s,
        )
        return "gaia_dr3", list(rows)
    except Exception:  # Gaia 429, timeout or outage: fall back to CatWISE2020 at IRSA
        pass
    try:
        rows = await _shielded(state.get_catwise().cone(ra, dec, radius, limit=CONE_LIMIT), wait_s)
        return "catwise2020", list(rows)
    except Exception:
        return "none", []


# Queries that outlive the wait keep running so that their result reaches the source cache and
# serves the next request; the references keep the tasks alive until they finish.
_BACKGROUND_QUERIES: set[asyncio.Future[Any]] = set()


def _settle(task: asyncio.Future[Any]) -> None:
    _BACKGROUND_QUERIES.discard(task)
    if not task.cancelled():
        task.exception()  # retrieved: a late failure is not reported as unhandled


async def _shielded(coro: Any, wait_s: float) -> Any:
    """Await `coro` for at most `wait_s` seconds without cancelling it on timeout."""
    task = asyncio.ensure_future(coro)
    _BACKGROUND_QUERIES.add(task)
    task.add_done_callback(_settle)
    return await asyncio.wait_for(asyncio.shield(task), timeout=wait_s)


def propagate_sources(
    sources: list[CatalogSource], t_obs: Time, apply_parallax: bool
) -> tuple[FloatArray, FloatArray]:
    """Linear space motion from each source epoch plus geocentric parallax (ICRS degrees)."""
    if not sources:
        return np.zeros(0), np.zeros(0)
    ra = np.array([s.ra_deg for s in sources], dtype=np.float64)
    dec = np.array([s.dec_deg for s in sources], dtype=np.float64)
    pmra = np.array([s.pmra_masyr or 0.0 for s in sources], dtype=np.float64)
    pmde = np.array([s.pmdec_masyr or 0.0 for s in sources], dtype=np.float64)
    plx = np.array([s.parallax_mas or 0.0 for s in sources], dtype=np.float64)
    dt = float(t_obs.tdb.jyear) - np.array([s.ref_epoch_jyear for s in sources], dtype=np.float64)
    cosd = np.cos(np.radians(dec))
    new_ra = ra + pmra * dt / 3.6e6 / cosd
    new_dec = dec + pmde * dt / 3.6e6
    if apply_parallax and np.any(plx > 0):
        pa, pd = parallax_factors(
            float(np.mean(new_ra)) * u.deg, float(np.mean(new_dec)) * u.deg, t_obs
        )
        p = np.where(plx > 0, plx, 0.0) / 1000.0
        new_ra = new_ra + p * float(np.ravel(pa)[0]) / 3600.0 / np.cos(np.radians(new_dec))
        new_dec = new_dec + p * float(np.ravel(pd)[0]) / 3600.0
    return new_ra % 360.0, new_dec


# ------------------------------------------------------------------ astrometry
@dataclass
class EpochCoadd:
    index: int
    detector: int
    t_mid: Time
    image: FloatArray
    variance: FloatArray
    wcs: WCS
    n_images: int
    exposures: list[dict[str, Any]] = field(default_factory=list)


def load_coadd(seq: SequenceFiles, epoch: dict[str, Any], frame: dict[str, Any]) -> EpochCoadd:
    name = str(frame["fits_url"]).rsplit("/", 1)[-1]
    path = seq.data_dir / "frames" / name
    with fits.open(path) as hdul, warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        img = np.asarray(hdul[0].data, dtype=np.float64)
        wcs = WCS(hdul[0].header)
        var = (
            np.asarray(hdul["VARIANCE"].data, dtype=np.float64)
            if "VARIANCE" in hdul
            else np.full(img.shape, np.nan)
        )
    det = int(frame["detector"])
    exps = [
        e
        for e in seq.sidecar.get("exposures", [])
        if int(e["epoch"]) == int(epoch["index"]) and int(e["detector"]) == det
    ]
    return EpochCoadd(
        index=int(epoch["index"]),
        detector=det,
        t_mid=Time(float(frame.get("t_mid_mjd") or epoch["t_mid_mjd"]), format="mjd", scale="utc"),
        image=img,
        variance=var,
        wcs=wcs,
        n_images=int(frame.get("n_images", 0)),
        exposures=exps,
    )


def coadd_frames(seq: SequenceFiles, detector: int) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    out = []
    for ep in seq.manifest["epochs"]:
        for f in ep["frames"]:
            if f.get("detector") == detector and f.get("fits_url"):
                out.append((ep, f))
    return out


def available_detectors(seq: SequenceFiles) -> list[int]:
    dets = {
        int(f["detector"])
        for ep in seq.manifest["epochs"]
        for f in ep["frames"]
        if isinstance(f.get("detector"), int) and f.get("fits_url")
    }
    return sorted(dets)


def saturation_at(
    seq: SequenceFiles, exposures: list[dict[str, Any]], astro: Astrometry | None,
    ra: float, dec: float, radius_arcsec: float = NATIVE_PIXEL_ARCSEC,
) -> float:  # fmt: skip
    """Share of exposures with a saturation related flag within `radius_arcsec` of the source.

    Uses `CalibratedCutout.saturated` (SATURATION_FLAGS), the bright-source flags whose pixels
    are masked in the coadds the centroids are measured on; this is deliberately broader than
    the core saturation test of the spectrum, which keeps OVERFLOW and TRANSIENT pixel values.
    """
    if not exposures:
        return 0.0

    def one(exp: dict[str, Any]) -> bool | None:
        """True or False when the source falls on the cutout, None when it does not."""
        try:
            path = exposure_path(seq.data_dir, exp)
            st = path.stat()
            info = _saturation_info(str(path), st.st_mtime_ns, st.st_size)
        except (OSError, ValueError, KeyError):
            return None
        if astro is not None:
            pos = apparent_positions(astro, info.t_mid)
            pra, pdec = float(pos.ra.deg), float(pos.dec.deg)
        else:
            pra, pdec = ra, dec
        with info.lock, warnings.catch_warnings():  # a cached WCS is shared between threads
            warnings.simplefilter("ignore", AstropyWarning)
            x, y = info.wcs.all_world2pix(pra, pdec, 0, quiet=True)
        fx, fy = float(x), float(y)
        if not (math.isfinite(fx) and math.isfinite(fy)):
            return None
        # Pixels within the radius, evaluated on the bounding box only (same set as a full grid).
        ny, nx = info.saturated.shape
        r_pix = radius_arcsec / info.scale_arcsec
        x0, x1 = max(0, math.floor(fx - r_pix)), min(nx, math.ceil(fx + r_pix) + 1)
        y0, y1 = max(0, math.floor(fy - r_pix)), min(ny, math.ceil(fy + r_pix) + 1)
        if x0 >= x1 or y0 >= y1:
            return None
        yy, xx = np.mgrid[y0:y1, x0:x1]
        near = np.hypot(xx - fx, yy - fy) <= r_pix
        if not near.any():
            return None
        return bool(info.saturated[y0:y1, x0:x1][near].any())

    found = [r for r in map_exposures(one, exposures) if r is not None]
    return sum(found) / len(found) if found else 0.0


def _world2pix(wcs: WCS, ra: FloatArray | float, dec: FloatArray | float) -> tuple[Any, Any]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        x, y = wcs.all_world2pix(ra, dec, 0)
    return x, y


def _pix2world(wcs: WCS, x: float, y: float) -> tuple[float, float]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        r, d = wcs.all_pix2world(x, y, 0)
    return float(r), float(d)


def _core_finite(img: FloatArray, x: float, y: float) -> bool:
    if not (math.isfinite(x) and math.isfinite(y)):
        return False
    xi, yi = int(round(x)), int(round(y))
    ny, nx = img.shape
    if not (1 <= xi < nx - 1 and 1 <= yi < ny - 1):
        return False
    return bool(np.isfinite(img[yi - 1 : yi + 2, xi - 1 : xi + 2]).all())


def _good_centroid(c: Centroid | None, x0: float, y0: float, min_snr: float) -> bool:
    if c is None or not np.isfinite(c.amp_err) or c.amp_err <= 0:
        return False
    if c.amp / c.amp_err < min_snr:
        return False
    if abs(c.x - x0) > CENTROID_HALF_BOX - 0.5 or abs(c.y - y0) > CENTROID_HALF_BOX - 0.5:
        return False
    return 1.2 <= c.fwhm_pix <= 7.0 and max(c.x_err, c.y_err) < 1.0


def recalibrate_epoch(
    co: EpochCoadd,
    catalog: list[CatalogSource],
    catalog_name: str,
    target_ra: float,
    target_dec: float,
    exclude_ids: set[str],
) -> tuple[Recalibration, dict[str, Any]]:
    """Measure catalog stars on one coadd and fit the local offset (and rotation if enough)."""
    scale = abs(float(co.wcs.proj_plane_pixel_scales()[0].to_value(u.arcsec)))
    usable = [
        s for s in catalog
        if s.source_id not in exclude_ids
        and s.mag is not None
        and s.mag <= RECAL_MAX_MAG
        and (catalog_name != "gaia_dr3" or s.pmra_masyr is not None)
    ]  # fmt: skip
    ra, dec = propagate_sources(usable, co.t_mid, apply_parallax=(catalog_name == "gaia_dr3"))
    all_ra, all_dec = propagate_sources(catalog, co.t_mid, apply_parallax=False)
    all_mag = np.array([s.mag if s.mag is not None else 99.0 for s in catalog])
    ny, nx = co.image.shape
    x, y = _world2pix(co.wcs, ra, dec)
    order = np.argsort(np.array([s.mag if s.mag is not None else 99.0 for s in usable]))
    pred: list[tuple[float, float]] = []
    meas: list[tuple[float, float]] = []
    errs: list[tuple[float, float]] = []
    ids: list[str] = []
    margin = CENTROID_HALF_BOX + 2
    for i in order:
        if len(pred) >= RECAL_MAX_STARS:
            break
        xi, yi = float(x[i]), float(y[i])
        if not (margin <= xi <= nx - 1 - margin and margin <= yi <= ny - 1 - margin):
            continue
        if _sep_arcsec(float(ra[i]), float(dec[i]), target_ra, target_dec) < (
            RECAL_TARGET_EXCLUSION_ARCSEC
        ):
            continue
        cosd = math.cos(math.radians(float(dec[i])))
        sep = np.hypot((all_ra - ra[i]) * cosd, all_dec - dec[i]) * 3600.0
        mag_i = usable[i].mag if usable[i].mag is not None else 99.0
        crowd = (sep > 0.05) & (sep < RECAL_ISOLATION_ARCSEC) & (all_mag < mag_i + 2.5)
        if crowd.any():
            continue
        if not _core_finite(co.image, xi, yi):
            continue  # saturated or flagged core: not usable as a reference star
        c = measure_centroid(
            co.image, co.variance, ~np.isfinite(co.image), xi, yi, CENTROID_HALF_BOX
        )
        if not _good_centroid(c, xi, yi, RECAL_MIN_SNR) or c is None:
            continue
        pred.append((xi, yi))
        meas.append((c.x, c.y))
        errs.append((c.x_err, c.y_err))
        ids.append(usable[i].source_id)
    center = ((nx - 1) / 2.0, (ny - 1) / 2.0)
    rec = fit_recalibration(
        np.array(pred).reshape(-1, 2),
        np.array(meas).reshape(-1, 2),
        np.array(errs).reshape(-1, 2),
        center,
        fit_rotation=True,
        min_stars_rotation=10,
    )
    raw = np.array(meas).reshape(-1, 2) - np.array(pred).reshape(-1, 2)
    info: dict[str, Any] = {
        "catalog": catalog_name,
        "n_candidates": len(pred),
        "n_used": rec.n_stars,
        "offset_arcsec": [round(rec.dx * scale, 4), round(rec.dy * scale, 4)],
        "rotation_deg": round(math.degrees(rec.theta_rad), 5) if rec.rotation_fitted else None,
        "scatter_arcsec": round(rec.scatter_pix * scale, 4)
        if np.isfinite(rec.scatter_pix)
        else None,
        "raw_median_offset_arcsec": (
            round(float(np.median(np.hypot(raw[:, 0], raw[:, 1]))) * scale, 4) if len(raw) else None
        ),
        "residual_median_arcsec": (
            round(float(np.median(np.hypot(*rec.residuals[rec.kept].T))) * scale, 4)
            if rec.n_stars
            else None
        ),
        "star_ids": [sid for sid, k in zip(ids, rec.kept, strict=True) if k],
    }
    return rec, info


def neighbor_pixels(
    co: EpochCoadd,
    catalog: list[CatalogSource],
    catalog_name: str,
    target_ra: float,
    target_dec: float,
    exclude_ids: set[str],
    rec: Recalibration,
) -> list[tuple[float, float]]:
    """Catalog sources near the target, propagated to the epoch, in measured pixel coordinates.

    Sources within NEIGHBOR_SELF_ARCSEC of the predicted target position (the target itself) and
    excluded identifiers are skipped. Positions go through the epoch recalibration when available.
    """
    if not catalog:
        return []
    ra, dec = propagate_sources(catalog, co.t_mid, apply_parallax=(catalog_name == "gaia_dr3"))
    reach = (
        (CENTROID_HALF_BOX + 4)
        * 1.5
        * abs(float(co.wcs.proj_plane_pixel_scales()[0].to_value(u.arcsec)))
    )
    out: list[tuple[float, float]] = []
    for s, r, d in zip(catalog, ra, dec, strict=True):
        if s.source_id in exclude_ids:
            continue
        sep = _sep_arcsec(float(r), float(d), target_ra, target_dec)
        if sep < NEIGHBOR_SELF_ARCSEC or sep > reach:
            continue
        x, y = _world2pix(co.wcs, float(r), float(d))
        if rec.n_stars >= RECAL_MIN_STARS:
            x, y = rec.apply(float(x), float(y))
        out.append((float(x), float(y)))
    return out


def choose_detector(
    seq: SequenceFiles, astro: Astrometry | None, ra: float, dec: float, candidates: list[int]
) -> tuple[int, dict[int, dict[str, float | None]]]:
    """Detector with the best centroid signal-to-noise at the source among the unsaturated ones.

    Score per detector: number of epochs with an accepted centroid on the coadd (flagged pixels
    excluded), then the minimum centroid S/N over those epochs. Detectors whose exposures carry
    saturation flags within one native pixel of the source in more than 5 percent of the
    exposures are used only when no unsaturated detector yields two measured epochs.
    """
    stats = detector_stats(seq, astro, ra, dec, candidates)
    if not stats:
        raise ScienceError(422, "NO_FITS", "No FITS coadd", "No detector coadds are stored.")
    usable = [d for d, s in stats.items() if (s["n_measured"] or 0) >= 2]
    unsat = [d for d in usable if _sat(stats[d]) <= 0.05]
    pool = unsat or usable or list(stats)
    best = max(pool, key=lambda d: (stats[d]["n_measured"] or 0.0, stats[d]["min_snr"] or 0.0))
    return best, stats


def _sat(s: dict[str, float | None]) -> float:
    v = s.get("saturated_fraction")
    return 1.0 if v is None else float(v)


def suggest_detector(stats: dict[int, dict[str, float | None]], current: int) -> int | None:
    """Least saturated other detector with at least two measured epochs (ties: more epochs)."""
    ok = [
        d
        for d, s in stats.items()
        if d != current
        and (s.get("n_measured") or 0) >= 2
        and s.get("saturated_fraction") is not None
    ]
    if not ok:
        return None
    return min(ok, key=lambda d: (_sat(stats[d]), -(stats[d].get("n_measured") or 0.0)))


def detector_stats(
    seq: SequenceFiles, astro: Astrometry | None, ra: float, dec: float, candidates: list[int]
) -> dict[int, dict[str, float | None]]:
    """Per detector: epochs, epochs measured, minimum centroid S/N and saturated fraction
    (null when the detector has no coadd, hence unknown)."""
    stats: dict[int, dict[str, float | None]] = {}
    for det in candidates:
        snrs: list[float] = []
        n_ep = 0
        exposures: list[dict[str, Any]] = []
        for ep, fr in coadd_frames(seq, det):
            n_ep += 1
            co = load_coadd(seq, ep, fr)
            exposures.extend(co.exposures)
            pra, pdec = _position_at(astro, ra, dec, co.t_mid)
            x, y = _world2pix(co.wcs, pra, pdec)
            x0, y0 = float(x), float(y)
            c = measure_centroid(
                co.image, co.variance, ~np.isfinite(co.image), x0, y0, CENTROID_HALF_BOX
            )
            if _good_centroid(c, x0, y0, TARGET_MIN_SNR) and c is not None:
                snrs.append(float(c.amp / c.amp_err))
        stats[det] = {
            "n_epochs": float(n_ep),
            "n_measured": float(len(snrs)),
            "min_snr": float(min(snrs)) if snrs else 0.0,
            "saturated_fraction": (
                round(float(saturation_at(seq, exposures, astro, ra, dec)), 3) if n_ep else None
            ),
        }
    return stats


def _position_at(astro: Astrometry | None, ra: float, dec: float, t: Time) -> tuple[float, float]:
    if astro is None:
        return ra, dec
    pos = apparent_positions(astro, t)
    return float(pos.ra.deg), float(pos.dec.deg)


def _pixel_scale_arcsec(wcs: WCS) -> float:
    return float(np.abs(np.linalg.det(wcs.pixel_scale_matrix)) ** 0.5 * 3600.0)


def mask_catalog_stars(
    shape: tuple[int, int], wcs: WCS, catalog: list[CatalogSource], t_obs: Time,
    target_ra: float, target_dec: float, max_mag: float, radius_arcsec: float,
) -> npt.NDArray[np.bool_]:  # fmt: skip
    """Pixels within `radius_arcsec` of catalog sources brighter than `max_mag`, propagated to
    `t_obs`; entries within NEIGHBOR_SELF_ARCSEC of the target (the target itself) are skipped."""
    mask = np.zeros(shape, dtype=bool)
    stars = [s for s in catalog if s.mag is not None and s.mag < max_mag]
    if not stars:
        return mask
    sra, sdec = propagate_sources(stars, t_obs, apply_parallax=False)
    scale = _pixel_scale_arcsec(wcs)
    sx, sy = _world2pix(wcs, sra, sdec)
    ny, nx = shape
    yy, xx = np.mgrid[0:ny, 0:nx]
    r_pix = radius_arcsec / scale
    for r_, d_, x_, y_ in zip(sra, sdec, np.atleast_1d(sx), np.atleast_1d(sy), strict=True):
        if not (math.isfinite(float(x_)) and math.isfinite(float(y_))):
            continue
        if _sep_arcsec(float(r_), float(d_), target_ra, target_dec) < NEIGHBOR_SELF_ARCSEC:
            continue
        if not (-r_pix <= x_ <= nx - 1 + r_pix and -r_pix <= y_ <= ny - 1 + r_pix):
            continue
        mask |= np.hypot(xx - float(x_), yy - float(y_)) <= r_pix
    return mask


@dataclass
class WingEpoch:
    """Per-epoch target offset from PSF wing centroids on single exposures (arcsec)."""

    index: int
    dra_arcsec: float  # measured minus predicted, east (RA cos dec) component
    ddec_arcsec: float
    err_ra_arcsec: float
    err_dec_arcsec: float
    n_used: int
    n_total: int
    n_exposures: int
    scatter_arcsec: float
    fwhm_arcsec: float


def wing_offsets(
    seq: SequenceFiles, detector: int, astro: Astrometry | None, ra: float, dec: float,
    catalog: list[CatalogSource],
) -> dict[int, WingEpoch]:  # fmt: skip
    """PSF wing centroids of a saturated target on every single exposure of one detector.

    Each exposure keeps its own archive WCS; the target is fitted with `measure_wing_centroid`
    on the coadd pixel mask (flagged and saturated pixels excluded) after masking catalog stars
    brighter than WING_MASK_MAX_MAG within WING_MASK_ARCSEC of their propagated positions. The
    offset from the prediction at the exposure time is combined per epoch with
    `combine_offsets`; an epoch needs WING_MIN_EXPOSURES accepted exposures.
    """
    per_epoch: dict[int, list[tuple[float, float, float, float, float]]] = {}
    n_exp: dict[int, int] = {}
    mine = [e for e in seq.sidecar.get("exposures", []) if int(e["detector"]) == detector]
    for exp in mine:
        idx = int(exp["epoch"])
        n_exp[idx] = n_exp.get(idx, 0) + 1

    def one(exp: dict[str, Any]) -> tuple[float, float, float, float, float] | None:
        try:
            cal = open_exposure(seq.data_dir, exp)
        except (OSError, ValueError, KeyError):
            return None
        wcs = cal.cutout.wcs
        t_obs = cal.cutout.t_mid
        pra, pdec = _position_at(astro, ra, dec, t_obs)
        x0, y0 = _world2pix(wcs, pra, pdec)
        scale = _pixel_scale_arcsec(wcs)
        excl = cal.bad | mask_catalog_stars(
            cal.science.shape, wcs, catalog, t_obs, pra, pdec, WING_MASK_MAX_MAG, WING_MASK_ARCSEC
        )
        c = measure_wing_centroid(
            cal.science, cal.variance, excl, float(x0), float(y0),
            r_max_pix=WING_RADIUS_ARCSEC / scale,
            max_shift_pix=WING_MAX_SHIFT_ARCSEC / scale,
        )  # fmt: skip
        if c is None:
            return None
        mra, mdec = _pix2world(wcs, c.x, c.y)
        dra = ((mra - pra + 180.0) % 360.0 - 180.0) * math.cos(math.radians(pdec)) * 3600.0
        ddec = (mdec - pdec) * 3600.0
        return (dra, ddec, c.x_err * scale, c.y_err * scale, c.fwhm_pix * scale)

    for exp, row in zip(mine, map_exposures(one, mine), strict=True):
        if row is not None:
            per_epoch.setdefault(int(exp["epoch"]), []).append(row)
    out: dict[int, WingEpoch] = {}
    for idx, rows in per_epoch.items():
        a = np.array(rows, dtype=np.float64)
        if len(a) < WING_MIN_EXPOSURES:
            continue
        comb = combine_offsets(a[:, 0], a[:, 1], a[:, 2], a[:, 3])
        if comb is None or comb.n_used < WING_MIN_EXPOSURES:
            continue
        out[idx] = WingEpoch(
            index=idx,
            dra_arcsec=comb.dx,
            ddec_arcsec=comb.dy,
            err_ra_arcsec=comb.dx_err,
            err_dec_arcsec=comb.dy_err,
            n_used=comb.n_used,
            n_total=comb.n_total,
            n_exposures=n_exp.get(idx, 0),
            scatter_arcsec=float(math.hypot(comb.scatter_x, comb.scatter_y) / math.sqrt(2.0)),
            fwhm_arcsec=float(np.median(a[:, 4])),
        )
    return out


def wing_flux_points(
    seq: SequenceFiles, astro: Astrometry | None, ra: float, dec: float,
    catalog: list[CatalogSource],
) -> tuple[list[dict[str, Any]], dict[str, int]]:  # fmt: skip
    """PSF wing ring flux of the target on every single exposure (`wing_annulus_flux`).

    For sources saturated in every exposure, where the aperture photometry of `compute_spectrum`
    has no usable point. Each exposure keeps its archive WCS; the ring is centered on the
    propagated position at the exposure time, with the coadd pixel mask plus catalog stars
    brighter than WING_MASK_MAX_MAG within WING_MASK_ARCSEC masked. Returns the usable points
    (epoch, detector, wavelength_um, flux, flux_err in Jy, obs_id) and the rejection counts.
    """
    points: list[dict[str, Any]] = []
    rejected: dict[str, int] = {}

    def one(exp: dict[str, Any]) -> dict[str, Any] | str:
        """The point, or the rejection reason."""
        try:
            cal = open_exposure(seq.data_dir, exp)
        except (OSError, ValueError, KeyError):
            return "unreadable"
        cut = cal.cutout
        pra, pdec = _position_at(astro, ra, dec, cut.t_mid)
        x, y = _world2pix(cut.wcs, pra, pdec)
        bad = cal.bad | mask_catalog_stars(
            cal.science.shape, cut.wcs, catalog, cut.t_mid, pra, pdec, WING_MASK_MAX_MAG,
            WING_MASK_ARCSEC,
        )  # fmt: skip
        res = wing_annulus_flux(
            cal.science, bad, cal.omega_arcsec2, float(x), float(y), _pixel_scale_arcsec(cut.wcs)
        )
        if res.reason is not None:
            return str(res.reason)
        wl, _ = wavelength_at(cut, float(x), float(y))
        return {
            "epoch": int(exp["epoch"]),
            "detector": int(cut.detector),
            "wavelength_um": float(wl.to_value(u.um)),
            "flux": res.flux_jy,
            "flux_err": res.flux_err_jy,
            "obs_id": str(exp["obs_id"]),
        }

    for item in map_exposures(one, list(seq.sidecar.get("exposures", []))):
        if isinstance(item, str):
            rejected[item] = rejected.get(item, 0) + 1
        else:
            points.append(item)
    return points, rejected


def _wing_epochs(
    seq: SequenceFiles, detector: int, wings: dict[int, WingEpoch], astro: Astrometry | None,
    ra: float, dec: float, catalog: list[CatalogSource], catalog_name: str, excl: set[str],
) -> tuple[list[dict[str, Any]], list[float], list[float], list[float], list[float], list[float],
           float]:  # fmt: skip
    """Epoch rows from wing offsets: prediction at the coadd mid time plus the mean offset, then
    the local recalibration of that epoch coadd (the exposures share its archive WCS errors)."""
    rows: list[dict[str, Any]] = []
    times: list[float] = []
    ras: list[float] = []
    decs: list[float] = []
    era: list[float] = []
    edec: list[float] = []
    sat_any = 0.0
    for ep, fr in coadd_frames(seq, detector):
        co = load_coadd(seq, ep, fr)
        scale = abs(float(co.wcs.proj_plane_pixel_scales()[0].to_value(u.arcsec)))
        pra, pdec = _position_at(astro, ra, dec, co.t_mid)
        sat = saturation_at(seq, co.exposures, astro, ra, dec)
        sat_any = max(sat_any, sat)
        row: dict[str, Any] = {
            "index": int(ep["index"]),
            "t_mid_mjd": round(float(co.t_mid.mjd), 5),
            "n_images": co.n_images,
            "saturated_fraction": round(sat, 3),
            "measured": False,
            "method": "psf_wings",
        }
        w = wings.get(int(ep["index"]))
        if w is None:
            row["reason"] = "Too few single exposures with an accepted PSF wing centroid."
            rows.append(row)
            continue
        rec, info = recalibrate_epoch(co, catalog, catalog_name, pra, pdec, excl)
        ra0 = pra + w.dra_arcsec / 3600.0 / math.cos(math.radians(pdec))
        dec0 = pdec + w.ddec_arcsec / 3600.0
        x, y = _world2pix(co.wcs, ra0, dec0)
        if rec.n_stars >= RECAL_MIN_STARS:
            xc, yc = rec.correct(float(x), float(y))
            sys_pix = (rec.excess_pix if np.isfinite(rec.excess_pix) else 0.0) ** 2 + (
                rec.dx_err if np.isfinite(rec.dx_err) else 0.0
            ) ** 2
        else:
            xc, yc = float(x), float(y)
            sys_pix = 0.0
        ra_m, dec_m = _pix2world(co.wcs, xc, yc)
        sys_arcsec2 = sys_pix * scale**2 + WING_SYSTEMATIC_ARCSEC**2
        ex = math.sqrt(w.err_ra_arcsec**2 + sys_arcsec2)
        ey = math.sqrt(w.err_dec_arcsec**2 + sys_arcsec2)
        row.update(
            measured=True,
            ra_deg=ra_m,
            dec_deg=dec_m,
            err_arcsec=round(float(math.hypot(ex, ey) / math.sqrt(2.0)), 4),
            err_ra_arcsec=round(ex, 4),
            err_dec_arcsec=round(ey, 4),
            centroid_err_arcsec=round(
                math.hypot(w.err_ra_arcsec, w.err_dec_arcsec) / math.sqrt(2.0), 4
            ),
            snr=None,
            fwhm_arcsec=round(w.fwhm_arcsec, 3),
            exposures_used=w.n_used,
            exposures_fitted=w.n_total,
            exposures_total=w.n_exposures,
            exposure_scatter_arcsec=round(w.scatter_arcsec, 4),
            recalibration_stars=rec.n_stars,
            recalibration=info,
            neighbors_modeled=0,
        )
        if astro is not None:
            row["predicted_ra_deg"] = pra
            row["predicted_dec_deg"] = pdec
            row["predicted_sep_arcsec"] = round(_sep_arcsec(ra_m, dec_m, pra, pdec), 4)
        rows.append(row)
        times.append(float(co.t_mid.mjd))
        ras.append(ra_m)
        decs.append(dec_m)
        era.append(ex)
        edec.append(ey)
    return rows, times, ras, decs, era, edec, sat_any


def _by_exposure_count(seq: SequenceFiles, dets: list[int]) -> list[int]:
    counts = {d: 0 for d in dets}
    for e in seq.sidecar.get("exposures", []):
        if int(e["detector"]) in counts:
            counts[int(e["detector"])] += 1
    return sorted(dets, key=lambda d: (-counts[d], d))


def _wing_rank(w: dict[int, WingEpoch]) -> tuple[int, float]:
    errs = [math.hypot(e.err_ra_arcsec, e.err_dec_arcsec) for e in w.values()]
    return len(w), -(float(np.median(errs)) if errs else math.inf)


def measure_astrometry(
    seq: SequenceFiles,
    ra: float,
    dec: float,
    *,
    detector: int | None,
    fit_parallax: bool,
    reference: str,
    catalog_name: str,
    catalog: list[CatalogSource],
    astro: Astrometry | None = None,
    exclude_ids: set[str] | None = None,
    min_target_snr: float = TARGET_MIN_SNR,
) -> dict[str, Any]:
    """Centroid per epoch on per-detector coadds, local recalibration, proper motion fit."""
    warn: list[dict[str, str]] = []
    target = None
    if astro is None:
        target = match_target(seq, ra, dec)
        if target is not None:
            astro = target.to_astrometry()
    elif exclude_ids is None:
        target = None
    check_in_field(seq, ra, dec, astro)
    dets = available_detectors(seq)
    if detector is not None and detector not in dets:
        raise ScienceError(
            422, "INVALID_DETECTOR", "Invalid detector", f"Detector {detector} has no coadds."
        )
    det_stats: dict[int, dict[str, float | None]] = {}
    requested = detector
    if detector is None:
        detector, det_stats = choose_detector(seq, astro, ra, dec, dets)
    frames = coadd_frames(seq, detector)
    excl = set(exclude_ids or set())
    if target is not None:
        src = target.astrometry.source.rsplit(" ", 1)[-1]
        excl.add(src)
    epochs_out: list[dict[str, Any]] = []
    times: list[float] = []
    ras: list[float] = []
    decs: list[float] = []
    era: list[float] = []
    edec: list[float] = []
    sat_any = 0.0
    for ep, fr in frames:
        co = load_coadd(seq, ep, fr)
        scale = abs(float(co.wcs.proj_plane_pixel_scales()[0].to_value(u.arcsec)))
        pra, pdec = _position_at(astro, ra, dec, co.t_mid)
        x0, y0 = _world2pix(co.wcs, pra, pdec)
        x0, y0 = float(x0), float(y0)
        sat = saturation_at(seq, co.exposures, astro, ra, dec)
        sat_any = max(sat_any, sat)
        rec, info = recalibrate_epoch(co, catalog, catalog_name, pra, pdec, excl)
        nbs = neighbor_pixels(co, catalog, catalog_name, pra, pdec, excl, rec)
        bad = ~np.isfinite(co.image)
        # Detection on a single Gaussian; position from the fit that also models catalog
        # neighbors at fixed positions (their amplitudes free), when any lies close enough.
        plain = measure_centroid(co.image, co.variance, bad, x0, y0, CENTROID_HALF_BOX)
        c = plain
        deblended = False
        if nbs:
            joint = measure_centroid(
                co.image, co.variance, bad, x0, y0, CENTROID_HALF_BOX, neighbors=nbs
            )
            if _good_centroid(joint, x0, y0, DEBLEND_MIN_SNR):
                c, deblended = joint, True
        row: dict[str, Any] = {
            "index": int(ep["index"]),
            "t_mid_mjd": round(float(co.t_mid.mjd), 5),
            "n_images": co.n_images,
            "saturated_fraction": round(sat, 3),
            "measured": False,
        }
        if not _good_centroid(plain, x0, y0, min_target_snr) or c is None:
            row["reason"] = "No significant, well-fitted source at the predicted position."
            epochs_out.append(row)
            continue
        if plain is not None and deblended:
            row["blend_shift_arcsec"] = round(math.hypot(c.x - plain.x, c.y - plain.y) * scale, 3)
        if rec.n_stars >= RECAL_MIN_STARS:
            xc, yc = rec.correct(c.x, c.y)
            sys_pix = (rec.excess_pix if np.isfinite(rec.excess_pix) else 0.0) ** 2 + (
                rec.dx_err if np.isfinite(rec.dx_err) else 0.0
            ) ** 2
        else:
            xc, yc = c.x, c.y
            sys_pix = 0.0
        ra_m, dec_m = _pix2world(co.wcs, xc, yc)
        ex = math.sqrt(c.x_err**2 + sys_pix) * scale
        ey = math.sqrt(c.y_err**2 + sys_pix) * scale
        row.update(
            measured=True,
            ra_deg=ra_m,
            dec_deg=dec_m,
            err_arcsec=round(float(math.hypot(ex, ey) / math.sqrt(2.0)), 4),
            err_ra_arcsec=round(ex, 4),
            err_dec_arcsec=round(ey, 4),
            centroid_err_arcsec=round(math.hypot(c.x_err, c.y_err) / math.sqrt(2) * scale, 4),
            snr=round(float(c.amp / c.amp_err), 1),
            fwhm_arcsec=round(c.fwhm_pix * scale, 3),
            recalibration_stars=rec.n_stars,
            recalibration=info,
            neighbors_modeled=len(nbs) if deblended else 0,
        )
        if astro is not None:
            row["predicted_ra_deg"] = pra
            row["predicted_dec_deg"] = pdec
            row["predicted_sep_arcsec"] = round(_sep_arcsec(ra_m, dec_m, pra, pdec), 4)
        epochs_out.append(row)
        times.append(float(co.t_mid.mjd))
        ras.append(ra_m)
        decs.append(dec_m)
        era.append(ex)
        edec.append(ey)
    method = "coadd_centroid"
    if len(times) < 2 and sat_any > 0.05:
        # Saturated core in fewer than two measurable epochs: centroid the PSF wings on the
        # single exposures. With a requested detector only that one is used; otherwise the
        # detectors are tried by decreasing number of exposures and the first that measures
        # every epoch is kept (else the one with the most epochs, then the smallest error).
        wing_dets = [requested] if requested is not None else _by_exposure_count(seq, dets)
        n_epochs = len(seq.manifest["epochs"])
        wings: dict[int, dict[int, WingEpoch]] = {}
        for d in wing_dets:
            wings[d] = wing_offsets(seq, d, astro, ra, dec, catalog)
            if len(wings[d]) == n_epochs:
                break
        best = max(wings, key=lambda d: _wing_rank(wings[d]))
        if len(wings[best]) >= 2:
            detector, method = best, "psf_wings"
            epochs_out, times, ras, decs, era, edec, sat_any = _wing_epochs(
                seq, detector, wings[best], astro, ra, dec, catalog, catalog_name, excl
            )
    n_meas = len(times)
    if n_meas < 2:
        if not det_stats:
            det_stats = detector_stats(seq, astro, ra, dec, dets)
        warn.append(
            {
                "code": "TOO_FEW_EPOCHS",
                "detail": f"The source was measured in {n_meas} of {len(epochs_out)} epoch(s) "
                f"on D{detector}; at least two are needed for a motion fit.",
            }
        )
        if sat_any > 0.05:
            warn.append(
                {
                    "code": "SATURATION",
                    "detail": f"Saturation flags at the source in up to {sat_any:.0%} of the "
                    f"D{detector} exposures.",
                }
            )
        return {
            "sequence_id": seq.sid,
            "target_id": target.id if target is not None else None,
            "status": "not_measurable",
            "detector_used": detector,
            "centroid_method": method,
            "detector_stats": {str(k): v for k, v in det_stats.items()},
            "suggested_detector": suggest_detector(det_stats, detector),
            "epochs_measured": n_meas,
            "epochs_total": len(epochs_out),
            "recalibration_catalog": catalog_name,
            "epochs": epochs_out,
            "fit": None,
            "reference": None,
            "agreement_sigma": None,
            "warnings": warn,
        }
    if sat_any > 0.05:
        warn.append(
            {
                "code": "SATURATION",
                "detail": f"Saturation flags at the source in up to {sat_any:.0%} of the "
                f"D{detector} "
                "exposures; flagged pixels are excluded and the centroid relies on the PSF wings.",
            }
        )
    if method == "psf_wings":
        warn.append(
            {
                "code": "PSF_WINGS_CENTROID",
                "detail": f"The core is saturated in every D{detector} coadd: positions come from "
                "Moffat fits to the unflagged PSF wings on single exposures, combined per epoch "
                "with the exposure scatter as error, then corrected by the epoch recalibration.",
            }
        )
    if any(r.get("measured") and r["recalibration_stars"] < RECAL_MIN_STARS for r in epochs_out):
        warn.append(
            {
                "code": "RECALIBRATION_UNAVAILABLE",
                "detail": "Fewer than three reference stars in at least one epoch: the archive WCS "
                "was used there without local correction.",
            }
        )
    t = Time(np.array(times), format="mjd", scale="utc")
    plx_ref = float(astro.parallax.to_value(u.mas)) if astro is not None else 0.0
    if astro is None or plx_ref <= 0:
        warn.append(
            {
                "code": "PARALLAX_UNKNOWN",
                "detail": "No parallax is known for this position; it is fixed to zero.",
            }
        )
    do_plx = bool(fit_parallax and well_spread_epochs(t))
    if fit_parallax and not do_plx:
        warn.append(
            {
                "code": "PARALLAX_FIXED",
                "detail": "Parallax fitting needs four or more epochs over at least one year; it "
                "was fixed to the reference value.",
            }
        )
    fit = fit_motion(
        t,
        np.array(ras) * u.deg,
        np.array(decs) * u.deg,
        np.array(era),
        np.array(edec),
        parallax_mas=plx_ref,
        fit_parallax=do_plx,
    )
    if fit.dof == 0:
        warn.append(
            {
                "code": "NO_REDUNDANCY",
                "detail": "Two epochs determine the motion exactly: no chi-square is available "
                "and the uncertainty rests on the per-epoch errors alone.",
            }
        )
    ref = _reference(target, reference, catalog_name, catalog, fit)
    sigma = None
    if ref is not None:
        sigma = agreement_sigma(
            fit,
            ref["pmra_masyr"],
            ref["pmdec_masyr"],
            ref.get("pmra_err_masyr", 0.0),
            ref.get("pmdec_err_masyr", 0.0),
        )
    warn.extend(_target_warnings(target))
    warn.extend(_blend_warning(catalog, fit, target))
    if _quick_release(seq):
        warn.append(
            {
                "code": "QUICK_RELEASE_CALIBRATION",
                "detail": "SPHEREx Quick Release astrometry is preliminary; per-epoch WCS errors "
                "are reduced by the local recalibration.",
            }
        )
    residuals = [
        {
            "index": int(r["index"]),
            "t_mid_mjd": r["t_mid_mjd"],
            "dra_arcsec": round(float(res[0]), 4),
            "ddec_arcsec": round(float(res[1]), 4),
        }
        for r, res in zip(
            [r for r in epochs_out if r.get("measured")], fit.residuals_arcsec, strict=True
        )
    ]
    return {
        "sequence_id": seq.sid,
        "target_id": target.id if target is not None else None,
        "status": "ok",
        "detector_used": detector,
        "centroid_method": method,
        "detector_stats": {str(k): v for k, v in det_stats.items()},
        "suggested_detector": None,
        "epochs_measured": n_meas,
        "epochs_total": len(epochs_out),
        "recalibration_catalog": catalog_name,
        "epochs": epochs_out,
        "fit": {
            "pmra_masyr": round(fit.pmra_cosdec_masyr, 2),
            "pmdec_masyr": round(fit.pmdec_masyr, 2),
            "pmra_err_masyr": round(fit.pmra_err_masyr, 2),
            "pmdec_err_masyr": round(fit.pmdec_err_masyr, 2),
            "pm_total_masyr": round(float(np.hypot(fit.pmra_cosdec_masyr, fit.pmdec_masyr)), 2),
            "pm_total_err_masyr": round(_total_err(fit), 2),
            "parallax_mas": round(fit.parallax_mas, 3),
            "parallax_err_mas": None
            if fit.parallax_err_mas is None
            else round(fit.parallax_err_mas, 3),
            "parallax_fixed": fit.parallax_fixed,
            "chi2_red": None if fit.chi2_red is None else round(fit.chi2_red, 3),
            "dof": fit.dof,
            "n_epochs": fit.n_epochs,
            "ref_epoch_jyear": round(float(fit.ref_epoch.jyear), 4),
            "ra0_deg": fit.ra0_deg,
            "dec0_deg": fit.dec0_deg,
            "residuals": residuals,
        },
        "reference": ref,
        "agreement_sigma": None if sigma is None else round(float(sigma), 3),
        "warnings": warn,
    }


def _total_err(fit: MotionFit) -> float:
    mu = float(np.hypot(fit.pmra_cosdec_masyr, fit.pmdec_masyr))
    if mu <= 0:
        return float(np.hypot(fit.pmra_err_masyr, fit.pmdec_err_masyr))
    return float(
        np.hypot(fit.pmra_cosdec_masyr * fit.pmra_err_masyr, fit.pmdec_masyr * fit.pmdec_err_masyr)
        / mu
    )


def _reference(
    target: Target | None,
    reference: str,
    catalog_name: str,
    catalog: list[CatalogSource],
    fit: MotionFit,
) -> dict[str, Any] | None:
    if reference == "none":
        return None
    if target is not None:
        # A verified literature motion wins; otherwise the catalog astrometry the preset is built
        # on (Gaia DR3 or CatWISE2020, read from the archive), and the unverified literature value
        # is reported alongside for context only.
        rm = target.reference_motion
        a = target.astrometry
        if reference == "literature" and rm is not None and rm.verified:
            return {
                "pmra_masyr": rm.pmra_masyr,
                "pmdec_masyr": rm.pmdec_masyr,
                "pmra_err_masyr": rm.pmra_err_masyr,
                "pmdec_err_masyr": rm.pmdec_err_masyr,
                "source": rm.source,
                "verified": True,
            }
        out: dict[str, Any] = {
            "pmra_masyr": a.pmra_masyr,
            "pmdec_masyr": a.pmdec_masyr,
            "pmra_err_masyr": a.pmra_err_masyr or 0.0,
            "pmdec_err_masyr": a.pmdec_err_masyr or 0.0,
            "source": a.source,
            "ref_epoch": a.ref_epoch,
            "verified": True,
        }
        if rm is not None and not rm.verified:
            out["unverified_literature"] = {
                "pmra_masyr": rm.pmra_masyr,
                "pmdec_masyr": rm.pmdec_masyr,
                "source": rm.source,
            }
        return out
    # No preset: the nearest catalog source with a proper motion, at the fitted epoch.
    if not catalog:
        return None
    t = Time(fit.ref_epoch.jyear, format="jyear", scale="tdb")
    ra, dec = propagate_sources(catalog, t, apply_parallax=False)
    seps = np.array(
        [_sep_arcsec(r, d, fit.ra0_deg, fit.dec0_deg) for r, d in zip(ra, dec, strict=True)]
    )
    i = int(np.argmin(seps))
    s = catalog[i]
    if seps[i] > NATIVE_PIXEL_ARCSEC or s.pmra_masyr is None or s.pmdec_masyr is None:
        return None
    return {
        "pmra_masyr": s.pmra_masyr,
        "pmdec_masyr": s.pmdec_masyr,
        "pmra_err_masyr": s.pmra_err_masyr or 0.0,
        "pmdec_err_masyr": s.pmdec_err_masyr or 0.0,
        "source": f"{'Gaia DR3' if catalog_name == 'gaia_dr3' else 'CatWISE2020'} {s.source_id}",
        "archive": s.archive,
        "match_sep_arcsec": round(float(seps[i]), 3),
    }


def _blend_warning(
    catalog: list[CatalogSource], fit: MotionFit, target: Target | None
) -> list[dict[str, str]]:
    """BLENDED_SOURCE when another catalog source lies within 1.5 native pixels of the fit."""
    if not catalog:
        return []
    t = Time(fit.ref_epoch.jyear, format="jyear", scale="tdb")
    ra, dec = propagate_sources(catalog, t, apply_parallax=False)
    near = []
    own = target.astrometry.source.rsplit(" ", 1)[-1] if target is not None else None
    for s, r, d in zip(catalog, ra, dec, strict=True):
        sep = _sep_arcsec(float(r), float(d), fit.ra0_deg, fit.dec0_deg)
        if sep < BLEND_RADIUS_ARCSEC and s.source_id != own and sep > 0.5:
            near.append((sep, s))
    if not near or (target is not None and target.id == "rwaur"):
        return []
    sep, s = min(near, key=lambda p: p[0])
    return [
        {
            "code": "BLENDED_SOURCE",
            "detail": f"Catalog source {s.source_id} lies {sep:.1f} arcsec from the fitted "
            "position and may be blended with it.",
        }
    ]


def to_jy_per_pixel(value: float, omega_arcsec2: float) -> float:
    """Helper for tests: MJy/sr to Jy for one pixel."""
    return float(surface_brightness_to_jy(value, omega_arcsec2))
