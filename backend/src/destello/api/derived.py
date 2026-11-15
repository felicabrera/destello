"""Derived products computed on demand from stored data: catalog overlays and difference images.

Thin adapters over `pipeline/` (pure functions) and `sources/` (network). Nothing here fetches a
URL supplied by a user: catalog cones are built from the manifest grid and file names are
validated against the content-addressed pattern.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.io import fits
from astropy.time import Time
from PIL import Image

from destello.api.deps import FILE_NAME_RE, AppState
from destello.api.errors import ApiError
from destello.core.cache import atomic_write_bytes
from destello.models.catalog import CatalogSource
from destello.pipeline.coadd import Coadd, broadband_coadd
from destello.pipeline.difference import DIFFERENCE_METHOD_VERSION, Registration, difference
from destello.pipeline.propagate import parallax_factors
from destello.pipeline.render import diverging_limit
from destello.pipeline.reproject import GridSpec
from destello.sources.base import SourceError

FloatArray = npt.NDArray[np.float64]

# Diverging colormap anchors: --neg, --diff-zero, --glint (design/export/handoff/tokens.css).
NEG_RGB = (0x3D, 0x7B, 0xFF)
ZERO_RGB = (0x6E, 0x72, 0x80)
POS_RGB = (0xFF, 0x8A, 0x3D)
DIVERGING_POWER = 0.8
CATALOG_MAX_SOURCES = 2000
CATALOG_WAIT_S = 20.0
CONE_MARGIN_ARCMIN = 3.0  # proper motion margin on top of the half diagonal of the field


def read_manifest(state: AppState, sid: str) -> dict[str, Any]:
    path = state.settings.manifests_dir / f"{sid}.json"
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.") from None
    if not isinstance(doc, dict):
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.")
    return doc


# ------------------------------------------------------------------ overlays
#: Part of the overlay cache key; bump whenever catalog parsing or propagation changes the positions
#: (2: CatWISE reference position is the motion-fit ra_pm, dec_pm at MJD 57170).
OVERLAY_METHOD_VERSION = "2"


def propagate_to_epoch(
    sources: list[CatalogSource], t_obs: Time, *, apply_parallax: bool
) -> tuple[FloatArray, FloatArray]:
    """Vectorised propagation of catalog positions to one observation time (ICRS degrees).

    Linear space motion from each source's own reference epoch (Gaia DR3: J2016.0; CatWISE: MJD
    57170, the epoch of the motion-fit position), using mu_alpha* / cos(dec) for RA, plus the
    geocentric parallax shift from `pipeline.propagate.parallax_factors` when `apply_parallax` is
    true. Missing motion or parallax count as zero. Agrees with `apparent_positions` to well below
    a SPHEREx grid pixel for every preset (see the API tests)."""
    ra = np.array([s.ra_deg for s in sources], dtype=np.float64)
    dec = np.array([s.dec_deg for s in sources], dtype=np.float64)
    pmra = np.array([s.pmra_masyr or 0.0 for s in sources], dtype=np.float64)
    pmde = np.array([s.pmdec_masyr or 0.0 for s in sources], dtype=np.float64)
    plx = np.array([s.parallax_mas or 0.0 for s in sources], dtype=np.float64)
    dt = float(t_obs.tdb.jyear) - np.array([s.ref_epoch_jyear for s in sources], dtype=np.float64)
    cosd = np.cos(np.radians(dec))
    new_ra = ra + (pmra * dt) / 3.6e6 / cosd
    new_dec = dec + (pmde * dt) / 3.6e6
    if apply_parallax and np.any(plx > 0):
        times = Time(np.full(len(sources), t_obs.utc.mjd), format="mjd", scale="utc")
        pa, pd = parallax_factors(new_ra * u.deg, new_dec * u.deg, times)
        plx_arcsec = np.where(plx > 0, plx, 0.0) / 1000.0
        new_ra = new_ra + (plx_arcsec * pa) / 3600.0 / np.cos(np.radians(new_dec))
        new_dec = new_dec + (plx_arcsec * pd) / 3600.0
    return new_ra % 360.0, new_dec


def grid_from_manifest(manifest: dict[str, Any]) -> GridSpec:
    g = manifest["grid"]
    nx, ny = (int(v) for v in g["naxis"])
    return GridSpec(
        ra_deg=float(g["crval_deg"][0]),
        dec_deg=float(g["crval_deg"][1]),
        pixel_scale_arcsec=float(g["pixel_scale_arcsec"]),
        ny=ny,
        nx=nx,
    )


def to_frame_pixels(
    grid: GridSpec, ra: FloatArray, dec: FloatArray
) -> tuple[FloatArray, FloatArray]:
    """Sky to frame pixel coordinates of the rendered (north up, east left) images.

    Coordinates are pixel EDGE coordinates: the center of pixel i is at i + 0.5, x to the right and
    y downward from the top edge, matching design/export/handoff/player-canvas.md."""
    wcs = grid.wcs()
    x0, y0 = wcs.all_world2pix(ra, dec, 0)  # 0 based, pixel center at integers, FITS row order
    x = np.asarray(x0, dtype=np.float64) + 0.5
    y = grid.ny - np.asarray(y0, dtype=np.float64) - 0.5  # the frame is flipped: north is up
    return x, y


async def fetch_catalog(state: AppState, catalog: str, grid: GridSpec) -> list[CatalogSource]:
    radius = (
        0.5 * float(np.hypot(grid.nx, grid.ny)) * grid.pixel_scale_arcsec / 60.0
        + CONE_MARGIN_ARCMIN
    ) * u.arcmin
    key = f"cat:{catalog}:{grid.ra_deg:.5f}:{grid.dec_deg:.5f}:{grid.nx}"
    entry = state.memory.get(key)
    if entry is None or entry[1].done():
        if catalog == "gaia_dr3":
            coro = state.get_gaia().cone(
                grid.ra_deg, grid.dec_deg, radius, max_g=20.0, limit=CATALOG_MAX_SOURCES
            )
        else:
            coro = state.get_catwise().cone(
                grid.ra_deg, grid.dec_deg, radius, limit=CATALOG_MAX_SOURCES
            )
        entry = (0.0, asyncio.ensure_future(coro))
        state.memory[key] = entry

        def _forget(task: asyncio.Future[Any], key: str = key) -> None:
            # The entry only shares a query in flight (the result lives in the source cache), so it
            # is dropped when the query ends instead of keeping every catalog in memory.
            held = state.memory.get(key)
            if held is not None and held[1] is task:
                del state.memory[key]
            if not task.cancelled():
                task.exception()

        entry[1].add_done_callback(_forget)
    task = entry[1]
    # Archives can answer slowly or with 429 (retried with backoff). Wait a bounded time; the
    # query keeps running in the background and fills the source cache for the next request.
    try:
        return list(await asyncio.wait_for(asyncio.shield(task), timeout=CATALOG_WAIT_S))
    except (SourceError, OSError, TimeoutError) as exc:
        raise ApiError(
            503,
            "CATALOG_UNAVAILABLE",
            "Catalog unavailable",
            f"The {catalog} catalog could not be queried yet ({type(exc).__name__}). Retry later.",
            headers={"Retry-After": "30"},
        ) from None


async def build_overlay(state: AppState, sid: str, catalog: str) -> dict[str, Any]:
    manifest = read_manifest(state, sid)
    grid = grid_from_manifest(manifest)
    sources = await fetch_catalog(state, catalog, grid)
    epochs_out: list[dict[str, Any]] = []
    for ep in manifest["epochs"]:
        rows: list[dict[str, Any]] = []
        if sources:
            t_obs = Time(float(ep["t_mid_mjd"]), format="mjd", scale="utc")
            ra, dec = await asyncio.to_thread(
                propagate_to_epoch, sources, t_obs, apply_parallax=(catalog == "gaia_dr3")
            )
            x, y = to_frame_pixels(grid, ra, dec)
            for s, xi, yi in zip(sources, x, y, strict=True):
                if 0.0 <= xi <= grid.nx and 0.0 <= yi <= grid.ny:
                    rows.append(
                        {
                            "id": s.source_id,
                            "x": round(float(xi), 3),
                            "y": round(float(yi), 3),
                            "mag": s.mag,
                            "pmra_masyr": s.pmra_masyr,
                            "pmdec_masyr": s.pmdec_masyr,
                        }
                    )
        epochs_out.append({"index": int(ep["index"]), "sources": rows})
    archives = sorted({s.archive for s in sources if s.archive})
    return {
        "catalog": catalog,
        "archive": "+".join(archives) if archives else None,
        "epochs": epochs_out,
    }


# ------------------------------------------------------------------ difference
def _epoch_frames(manifest: dict[str, Any], epoch: int) -> list[dict[str, Any]]:
    for ep in manifest["epochs"]:
        if int(ep["index"]) == epoch:
            return [f for f in ep["frames"] if isinstance(f, dict)]
    raise ApiError(404, "NOT_FOUND", "Not found", f"No epoch {epoch}.")


def _fits_path(state: AppState, frame: dict[str, Any]) -> Path:
    url = frame.get("fits_url")
    if not url:
        raise ApiError(422, "NO_FITS", "No FITS coadd", "This frame has no FITS coadd stored.")
    name = str(url).rsplit("/", 1)[-1]
    if not FILE_NAME_RE.match(name):
        raise ApiError(500, "INTERNAL_ERROR", "Internal error", "Invalid frame name.")
    path = state.settings.frames_dir / name
    if not path.is_file():
        raise ApiError(404, "NOT_FOUND", "Not found", "FITS coadd not available.")
    return path


def _read_fits(path: Path) -> FloatArray:
    with fits.open(path) as hdul:
        return np.asarray(hdul[0].data, dtype=np.float64)


def load_epoch_image(state: AppState, manifest: dict[str, Any], epoch: int, det: int) -> FloatArray:
    """FITS-order image of an epoch: one detector coadd, or (det 0) the broadband image rebuilt
    from the per-detector coadds with `pipeline.coadd.broadband_coadd` (the broadband frame
    itself is stored as an 8-bit WebP only)."""
    frames = _epoch_frames(manifest, epoch)
    if det > 0:
        for f in frames:
            if f.get("detector") == det:
                return _read_fits(_fits_path(state, f))
        raise ApiError(
            404, "NOT_FOUND", "Not found", f"No frame for epoch {epoch}, detector {det}."
        )
    layers: dict[int, Coadd] = {}
    for f in frames:
        d = f.get("detector")
        if isinstance(d, int) and f.get("fits_url"):
            img = _read_fits(_fits_path(state, f))
            layers[d] = Coadd(
                mean=img.astype(np.float32),
                variance=np.full(img.shape, np.nan, dtype=np.float32),
                n_used=np.zeros(img.shape, dtype=np.int32),
                n_input=int(f.get("n_images", 0)),
            )
    if not layers:
        raise ApiError(422, "NO_FITS", "No FITS coadd", "No detector coadds are stored.")
    bb, _methods = broadband_coadd(layers)
    return np.asarray(bb, dtype=np.float64)


def diverging_rgba(diff_fits_order: FloatArray, limit: float) -> bytes:
    """Render a difference image as a lossless RGBA WebP, north up.

    Symmetric stretch of +-limit, magnitude raised to the power 0.8, colors blue (negative) to
    gray (zero) to orange (positive). Pixels without data are transparent."""
    d = np.asarray(diff_fits_order, dtype=np.float64)
    finite = np.isfinite(d)
    v = np.clip(np.where(finite, d / limit, 0.0), -1.0, 1.0)
    m = (np.abs(v) ** DIVERGING_POWER)[..., None]
    zero = np.array(ZERO_RGB, dtype=np.float64)
    neg = np.array(NEG_RGB, dtype=np.float64)
    pos = np.array(POS_RGB, dtype=np.float64)
    rgb = np.where((v < 0)[..., None], zero + m * (neg - zero), zero + m * (pos - zero))
    rgba = np.zeros(d.shape + (4,), dtype=np.uint8)
    rgba[..., :3] = np.rint(rgb).astype(np.uint8)
    rgba[..., 3] = np.where(finite, 255, 0)
    img = Image.fromarray(np.flipud(rgba), mode="RGBA")
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True, quality=100, method=6)
    return buf.getvalue()


def compute_difference(a: FloatArray, b: FloatArray, frames_dir: Path) -> dict[str, Any]:
    if a.shape != b.shape:
        raise ApiError(422, "GRID_MISMATCH", "Grid mismatch", "The two frames differ in shape.")
    # The request position (grid center) is excluded from registration and scaling: it is the
    # source the user asked about and may be a fast mover or a variable.
    ny, nx = a.shape
    center = ((nx - 1) / 2.0, (ny - 1) / 2.0)
    res = difference(a, b, exclude_xy=[center])
    webp = diverging_rgba(np.asarray(res.diff, dtype=np.float64), diverging_limit(res.diff))
    name = hashlib.sha256(webp).hexdigest()[:16]
    target = frames_dir / f"{name}.webp"
    if not target.exists():
        atomic_write_bytes(target, webp)
    return {
        "url": f"/frames/{name}.webp",
        "scale": round(float(res.scale), 6),
        "n_stars_used": res.n_stars,
        "registration": registration_doc(res.registration),
        "method_version": DIFFERENCE_METHOD_VERSION,
    }


def registration_doc(reg: Registration) -> dict[str, Any]:
    def r(v: float) -> float | None:
        return round(float(v), 4) if np.isfinite(v) else None

    return {
        "dx_pix": round(float(reg.dx), 4),
        "dy_pix": round(float(reg.dy), 4),
        "dx_err_pix": r(reg.dx_err),
        "dy_err_pix": r(reg.dy_err),
        "n_stars": reg.n_stars,
        "applied": reg.applied,
    }


def _diff_job(
    state: AppState, manifest: dict[str, Any], a: int, b: int, det: int
) -> dict[str, Any]:
    ia = load_epoch_image(state, manifest, a, det)
    ib = load_epoch_image(state, manifest, b, det)
    return compute_difference(ia, ib, state.settings.frames_dir)


async def build_difference(state: AppState, sid: str, a: int, b: int, det: int) -> dict[str, Any]:
    manifest = read_manifest(state, sid)
    n_epochs = len(manifest["epochs"])
    if n_epochs < 2:
        raise ApiError(422, "TOO_FEW_EPOCHS", "Too few epochs", "At least two epochs are needed.")
    if not (0 <= a < n_epochs and 0 <= b < n_epochs) or a == b:
        raise ApiError(
            422, "INVALID_EPOCHS", "Invalid epochs", "a and b must be distinct epoch indices."
        )
    return await asyncio.to_thread(_diff_job, state, manifest, a, b, det)
