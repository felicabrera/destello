"""Moving-target sequence build (F-33): Solar System bodies followed with a JPL Horizons ephemeris.

Flow (docs/03 section 4.9):

1. Resolve the designation with JPL Horizons (`sources.horizons`), sample its geocentric
   ephemeris over each requested time window.
2. Discover the SPHEREx images that contain the track: IRSA TAP with one CONTAINS(POINT) per
   ephemeris sample, or, when IRSA does not answer, the header scan of the AWS open data copy
   (`sources.movers`). The path used is recorded in the manifest.
3. Ask Horizons for the position at the mid time of every image and move it from the geocentre to
   the spacecraft (header X_SC, Y_SC, Z_SC; `pipeline.movers.topocentric`).
4. Per image: cutout centered on that position, zodiacal model subtracted, flags from the FLAGS
   header, reprojection onto a grid centered on the target (co-moving, north up), forced
   photometry with the coma aperture (V-13) and the coma centroid against the prediction (V-14).
5. One stretch per detector over all its exposures (fair comparison); one object-aligned stack per
   detector and campaign (the target is sharp, stars trail), with one stretch per detector over
   its stacks.
6. Manifest (docs/06 section 3.4 plus the `moving_target` block): one epoch per exposure
   (observation id), with a frame per detector that saw the target in it.

Real data only: every frame is a real exposure or an inverse-variance mean of real exposures; a
detector or exposure without data has no frame, nothing is interpolated in its place.
"""

from __future__ import annotations

import asyncio
import json
import math
import time
import warnings as pywarnings
from collections import defaultdict
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning

from destello.core.cache import atomic_write_bytes
from destello.core.config import EPOCH_GAP_DAYS, Settings, get_settings
from destello.core.ids import frame_key, sequence_id
from destello.core.logging import get_logger
from destello.models.catalog import CatalogSource
from destello.models.manifest import (
    ManifestCampaign,
    ManifestEphemerisPoint,
    ManifestFrame,
    ManifestMovingTarget,
    ManifestRequest,
    ManifestWarning,
)
from destello.pipeline import manifest as mf
from destello.pipeline.calibrate import (
    calibrate,
    load_cutout,
    masked_flag_names,
    wavelength_at,
    wavelength_range,
)
from destello.pipeline.coadd import COADD_METHOD_VERSION, coadd_stack
from destello.pipeline.epochs import group_epochs
from destello.pipeline.movers import (
    BANDS,
    COMA_ANNULUS_ARCSEC,
    COMA_APERTURE_ARCSEC,
    MOVER_CUTOUT_ARCMIN,
    MOVER_FOV_ARCMIN,
    MOVER_MASK_FLAGS,
    MOVER_METHOD_VERSION,
    MOVER_PHOTOMETRY_MASK_FLAGS,
    V14_NEIGHBOUR_MAX_G,
    EphemerisCheck,
    band_excess,
    box_neighbours,
    catalog_positions_at,
    ephemeris_check,
    interpolate_track,
    parallax_bound_arcsec,
    topocentric,
    v14_summary,
)
from destello.pipeline.photometry import forced_photometry, point_reason
from destello.pipeline.render import (
    Stretch,
    apply_stretch,
    coadd_fits_bytes,
    compute_stretch,
    mask_png,
    to_webp,
)
from destello.pipeline.reproject import GridSpec, make_grid, reproject_cutout
from destello.sources.base import SourceError
from destello.sources.cutouts import CutoutRouter, CutoutSource
from destello.sources.gaia import GaiaClient
from destello.sources.horizons import Ephemeris, EphemerisRow, HorizonsClient
from destello.sources.irsa import IrsaClient
from destello.sources.movers import (
    DISCOVERY_PATH_S3,
    DISCOVERY_PATH_TAP,
    ListedKeyS3Source,
    MoverImage,
    MoverS3Scan,
    discover_tap,
)
from destello.sources.s3 import S3CutoutSource, cutout_source_of

Publish = Callable[[str, dict[str, Any]], Awaitable[None]]

SERVICE_HORIZONS = "JPL Horizons (ssd.jpl.nasa.gov/api/horizons.api)"
# Cone around each prediction for the V-14 neighbour model: it holds the 11 x 11 native pixel
# selection square (half diagonal 5 * sqrt(2) * 6.2 = 44 arcsec) with a margin for the WCS.
V14_NEIGHBOUR_CONE_ARCSEC = 60.0
SERVICE_TAP = "IRSA TAP"
SERVICE_S3 = "AWS Open Data SPHEREx copy (s3://nasa-irsa-spherex)"
SERVICE_S3_SCAN = "AWS Open Data SPHEREx copy, bucket listing and header scan"
SERVICE_IBE = "IRSA cutouts"
SERVICE_SAPM = "SPHEREx solid angle pixel maps"
MAX_MOVER_IMAGES = 600  # same total bound as a sequence build (docs/10 section 3.3)
CPU_WORKERS = 4


async def _no_publish(event: str, data: dict[str, Any]) -> None:
    return None


@dataclass(frozen=True)
class MoverParams:
    """A moving-target request: designation and time windows (ISO 8601 UTC)."""

    designation: str
    windows: tuple[tuple[str, str], ...]
    detectors: tuple[int, ...] = (1, 2, 3, 4, 5, 6)
    fov_arcmin: float = MOVER_FOV_ARCMIN
    step_hours: float = 1.0  # ephemeris sampling for discovery
    releases: tuple[str, ...] = ("dr1", "qr3")

    def windows_time(self) -> list[tuple[Time, Time]]:
        out = [(Time(a, scale="utc"), Time(b, scale="utc")) for a, b in self.windows]
        for a, b in out:
            if not b > a or (b - a).to_value(u.day) > 62:
                raise ValueError("Each window must be 0 to 62 days long")
        return out


def mover_sequence_id(params: MoverParams, record_id: int, settings: Settings) -> str:
    """Sequence id: the generic hash with the Horizons record and windows as mode parameters."""
    return sequence_id(
        0.0,
        0.0,
        params.fov_arcmin,
        params.detectors,
        ",".join(params.releases),
        settings.pipeline_version,
        {
            "mover": int(record_id),
            "windows": [list(w) for w in params.windows],
            "method": MOVER_METHOD_VERSION,
        },
    )


def movers_dir(settings: Settings, seq_id: str) -> Path:
    return settings.data_dir / "movers" / seq_id


@dataclass
class _Exposure:
    """Everything measured on one image (filled in a worker thread)."""

    image: MoverImage
    eph: EphemerisRow
    path: Path
    ra: float = math.nan  # topocentric prediction
    dec: float = math.nan
    shift_arcsec: float | None = None
    sc_km: tuple[float, float, float] | None = None
    grid: GridSpec | None = None
    science: np.ndarray[Any, Any] | None = None
    variance: np.ndarray[Any, Any] | None = None
    wl_range: tuple[float, float] | None = None
    wl_target: float | None = None
    point: dict[str, Any] = field(default_factory=dict)
    check: dict[str, Any] = field(default_factory=dict)
    mask_flags: list[str] = field(default_factory=list)
    stars: list[CatalogSource] | None = None  # Gaia DR3 near the prediction (None: not answered)
    error: str | None = None


def _process(
    x: _Exposure, sapm: np.ndarray[Any, Any] | None, fov: u.Quantity, solution: str
) -> _Exposure:
    """CPU bound work for one image (pure apart from reading its cached cutout)."""
    rec = x.image.record
    with fits.open(x.path) as hdul:
        cut = load_cutout(hdul, rec.obs_id)
        h = hdul["IMAGE"].header
        sc = None
        if all(k in h for k in ("X_SC", "Y_SC", "Z_SC")):
            sc = (float(h["X_SC"]), float(h["Y_SC"]), float(h["Z_SC"]))
    sc = sc or x.image.sc_km
    if sc is not None:
        ra, dec, shift = topocentric(x.eph.ra_deg, x.eph.dec_deg, x.eph.delta_au, sc)
    else:
        ra, dec, shift = x.eph.ra_deg, x.eph.dec_deg, None
    x.ra, x.dec, x.shift_arcsec, x.sc_km = ra, dec, shift, sc
    # Moving targets: OUTLIER is not an exclusion flag (pipeline.movers, docs/03 section 4.9).
    cal = calibrate(cut, sapm, mask_flags=MOVER_MASK_FLAGS)
    with pywarnings.catch_warnings():
        pywarnings.simplefilter("ignore", AstropyWarning)
        xp, yp = (float(v) for v in cut.wcs.all_world2pix(ra, dec, 0, quiet=True))
    scale = float(np.abs(np.linalg.det(cut.wcs.pixel_scale_matrix)) ** 0.5 * 3600.0)
    # V-13 point: coma aperture, single-exposure flag usage (docs/03 section 4.6).
    phot = forced_photometry(
        cal,
        ra * u.deg,
        dec * u.deg,
        aperture_arcsec=COMA_APERTURE_ARCSEC,
        annulus_arcsec=COMA_ANNULUS_ARCSEC,
        masks="photometry",
        photometry_flags=MOVER_PHOTOMETRY_MASK_FLAGS,
    )
    reason = point_reason(phot)
    wl = bw = None
    try:
        wlq, bwq = wavelength_at(cut, xp, yp)
        wl, bw = float(wlq.value), float(bwq.value)
    except Exception:
        wl = bw = None
    x.wl_target = wl
    x.point = {
        "obs_id": rec.obs_id,
        "observation_id": rec.observation_id,
        "detector": rec.detector,
        "collection": rec.collection,
        "t_mid_mjd": round(float(cut.t_mid.mjd), 7),
        "ra_deg": ra,
        "dec_deg": dec,
        "wavelength_um": wl,
        "bandwidth_um": bw,
        "flux": phot.flux_jy
        if reason != "saturated_core" and math.isfinite(phot.flux_jy)
        else None,
        "flux_err": phot.flux_err_jy if math.isfinite(phot.flux_err_jy) else None,
        "background_mjy_sr": phot.background_mjy_sr
        if math.isfinite(phot.background_mjy_sr)
        else None,
        "flagged": reason is not None,
        "reason": reason,
        "flagged_fraction": round(phot.flagged_fraction, 3),
        "aperture_flags": list(phot.aperture_flags),
        "core_flags": list(phot.core_flags),
    }
    # V-14 check on the calibrated exposure (coadd mask without OUTLIER).
    s_eph = max(x.eph.ra_3sigma_arcsec or 0.0, x.eph.dec_3sigma_arcsec or 0.0)

    def pix2world(px: float, py: float) -> tuple[float, float]:
        a, d = cut.wcs.all_pix2world(px, py, 0)
        return float(a), float(d)

    # Method version 2 (single Gaussian), kept for the record next to version 3 (docs/11).
    plain = ephemeris_check(
        cal.science, cal.variance, cal.bad, xp, yp, scale, pix2world, ra, dec, s_eph
    )
    # Method version 3: Gaia DR3 stars in the box fitted jointly with the comet (docs/11 V-14).
    if x.stars is None:
        chk = EphemerisCheck(False, "catalog_unavailable", None, None, None, None, None, None,
                             None)  # fmt: skip
    else:
        sra, sdec = catalog_positions_at(x.stars, cut.t_mid)
        with pywarnings.catch_warnings():
            pywarnings.simplefilter("ignore", AstropyWarning)
            sx, sy = cut.wcs.all_world2pix(sra, sdec, 0, quiet=True) if len(sra) else ([], [])
        nbs = box_neighbours([(float(a), float(b)) for a, b in zip(sx, sy, strict=True)], xp, yp)
        chk = ephemeris_check(
            cal.science, cal.variance, cal.bad, xp, yp, scale, pix2world, ra, dec, s_eph, nbs
        )
    from destello.pipeline.movers import angular_sep_arcsec

    geo_off = None
    if chk.offset_arcsec is not None and chk.dra_arcsec is not None and chk.ddec_arcsec is not None:
        ra_c = ra + chk.dra_arcsec / 3600.0 / math.cos(math.radians(dec))
        dec_c = dec + chk.ddec_arcsec / 3600.0
        geo_off = angular_sep_arcsec(x.eph.ra_deg, x.eph.dec_deg, ra_c, dec_c)
    x.check = {
        "obs_id": rec.obs_id,
        "detector": rec.detector,
        "t_mid_mjd": round(float(cut.t_mid.mjd), 7),
        "eph_3sigma_arcsec": s_eph,
        "parallax_shift_arcsec": shift,
        "offset_from_geocentric_arcsec": geo_off,
        "solution": solution,
        **asdict(chk),
        "method_version_2": asdict(plain),
    }
    # Co-moving frame.
    grid = make_grid(ra * u.deg, dec * u.deg, fov)
    rp = reproject_cutout(cal, grid)
    x.grid, x.science, x.variance = grid, rp.science, rp.variance
    lo, hi = wavelength_range(cut)
    x.wl_range = (float(lo.value), float(hi.value))
    from destello.pipeline.reproject import grid_footprint

    x.mask_flags = masked_flag_names(
        cut.flags, cut.flag_bits, grid_footprint(cut.wcs, cut.shape, grid), MOVER_MASK_FLAGS
    )
    return x


async def _discover(
    params: MoverParams,
    horizons: HorizonsClient,
    irsa: IrsaClient,
    scan: MoverS3Scan,
    record_id: int,
    log: Any,
) -> tuple[list[MoverImage], str, str, list[Ephemeris]]:
    """Images along the track of every window, TAP first, S3 header scan as the fallback."""
    tracks: list[Ephemeris] = []
    images: list[MoverImage] = []
    path = DISCOVERY_PATH_TAP
    details: list[str] = []
    collections = [f"spherex_{r}" for r in params.releases]
    for start, stop in params.windows_time():
        eph = await horizons.ephemeris_range(record_id, start, stop, params.step_hours)
        tracks.append(eph)
        mjd = np.array([r.jd_utc - 2400000.5 for r in eph.rows])
        ras = np.array([r.ra_deg for r in eph.rows])
        decs = np.array([r.dec_deg for r in eph.rows])

        def track(
            t: float, mjd: Any = mjd, ras: Any = ras, decs: Any = decs
        ) -> tuple[float, float]:
            return interpolate_track(t, mjd, ras, decs)

        found: list[MoverImage] | None = None
        if path == DISCOVERY_PATH_TAP:
            samples = [
                (float(m), float(a), float(d)) for m, a, d in zip(mjd, ras, decs, strict=True)
            ]
            try:
                found = await discover_tap(
                    irsa, samples, params.step_hours / 48.0, collections, track
                )
                details.append(f"TAP: {len(samples)} CONTAINS queries, {len(found)} images")
            except SourceError as exc:
                log.warning("tap_discovery_failed", error=str(exc)[:200])
                path = DISCOVERY_PATH_S3
                details.append(
                    f"IRSA TAP did not answer ({type(exc).__name__}); S3 header scan used"
                )
        if found is None:
            found = await scan.discover(track, start, stop, params.releases)
            details.append(
                f"S3 header scan {start.isot[:10]} to {stop.isot[:10]}: {len(found)} images"
            )
        images += found
    if path == DISCOVERY_PATH_S3 and any(m.key is None for m in images):
        # A mixed result (TAP answered for an early window, then failed): rescan the early
        # windows on S3 so every image has a listed key and one discovery path.
        images = []
        for (start, stop), eph in zip(params.windows_time(), tracks, strict=True):
            mjd = np.array([r.jd_utc - 2400000.5 for r in eph.rows])
            ras = np.array([r.ra_deg for r in eph.rows])
            decs = np.array([r.dec_deg for r in eph.rows])

            def track2(t: float, m: Any = mjd, a: Any = ras, d: Any = decs) -> tuple[float, float]:
                return interpolate_track(t, m, a, d)

            images += await scan.discover(track2, start, stop, params.releases)
    images = [m for m in images if m.record.detector in params.detectors]
    images.sort(key=lambda m: (m.record.t_mid.mjd, m.record.detector, m.record.obs_id))
    return images, path, "; ".join(details), tracks


async def run_mover_build(
    params: MoverParams,
    settings: Settings | None = None,
    publish: Publish = _no_publish,
    *,
    force: bool = False,
) -> str:
    """Build a moving-target sequence and return its id (manifest at manifests/<id>.json)."""
    settings = settings or get_settings()
    t0 = time.perf_counter()
    horizons = HorizonsClient(settings)
    try:
        target = await horizons.lookup(params.designation)
        seq_id = mover_sequence_id(params, target.record_id, settings)
        log = get_logger(sequence_id=seq_id, mover=target.record_id)
        mpath = settings.manifests_dir / f"{seq_id}.json"
        if mpath.exists() and not force:
            await publish("completed", {"manifest_url": f"/manifests/{seq_id}.json"})
            return seq_id
        irsa = IrsaClient(settings)
        scan = MoverS3Scan(settings)
        try:
            await publish("progress", {"stage": "query", "done": 0, "total": 1})
            images, path, detail, _ = await _discover(
                params, horizons, irsa, scan, target.record_id, log
            )
            if not images:
                raise SourceError("No SPHEREx image contains the ephemeris in these windows")
            if len(images) > MAX_MOVER_IMAGES:
                raise SourceError(f"{len(images)} images exceed the bound of {MAX_MOVER_IMAGES}")
            await publish("progress", {"stage": "query", "done": 1, "total": 1})
            log.info(
                "mover_discovery",
                images=len(images),
                path=path,
                seconds=round(time.perf_counter() - t0, 1),
            )
            eph = await horizons.ephemeris(target.record_id, [m.record.t_mid for m in images])
            await _build(
                params, settings, publish, seq_id, target.name, target.record_id, eph, images,
                path, detail, irsa, log,
            )  # fmt: skip
        finally:
            await scan.aclose()
            await irsa.aclose()
    finally:
        await horizons.aclose()
    log.info("mover_build_done", seconds=round(time.perf_counter() - t0, 1))
    await publish("completed", {"manifest_url": f"/manifests/{seq_id}.json"})
    return seq_id


async def _build(
    params: MoverParams,
    settings: Settings,
    publish: Publish,
    seq_id: str,
    name: str,
    record_id: int,
    eph: Ephemeris,
    images: list[MoverImage],
    path: str,
    detail: str,
    irsa: IrsaClient,
    log: Any,
) -> None:
    fov = params.fov_arcmin * u.arcmin
    csize = MOVER_CUTOUT_ARCMIN * u.arcmin
    s3_listed: ListedKeyS3Source | None = None
    owned_s3: S3CutoutSource | None = None
    if path == DISCOVERY_PATH_S3:
        s3_listed = ListedKeyS3Source(settings, irsa=irsa, keys=[m.key for m in images if m.key])
        cutouts: CutoutSource = CutoutRouter(irsa, s3_listed)
    else:
        owned_s3 = S3CutoutSource(settings, irsa=irsa)
        cutouts = CutoutRouter(irsa, owned_s3)
    exposures: list[_Exposure] = []
    try:
        # Cutout centers: topocentric when the header scan gave the spacecraft position.
        sem = asyncio.Semaphore(settings.s3_concurrency)
        done = 0

        async def fetch(m: MoverImage, row: EphemerisRow) -> None:
            nonlocal done
            if m.sc_km is not None:
                ra, dec, _ = topocentric(row.ra_deg, row.dec_deg, row.delta_au, m.sc_km)
            else:
                ra, dec = row.ra_deg, row.dec_deg
            async with sem:
                try:
                    p = await cutouts.download_cutout(m.record, ra, dec, csize)
                except SourceError as exc:
                    log.warning("cutout_failed", obs_id=m.record.obs_id, error=str(exc)[:200])
                    return
            exposures.append(_Exposure(image=m, eph=row, path=p))
            done += 1
            if done % 20 == 0:
                await publish("progress", {"stage": "cutouts", "done": done, "total": len(images)})

        await asyncio.gather(*(fetch(m, r) for m, r in zip(images, eph.rows, strict=True)))
        log.info("mover_cutouts", ok=len(exposures), total=len(images))
        # Solid angle maps per (release, detector).
        sapms: dict[tuple[str, int], np.ndarray[Any, Any]] = {}
        sapm_names: set[str] = set()
        for key in sorted(
            {
                (x.image.record.collection.replace("_deep", ""), x.image.record.detector)
                for x in exposures
            }
        ):
            try:
                if s3_listed is not None:
                    sapms[key] = await s3_listed.solid_angle_map(*key)
                else:
                    try:
                        sapms[key] = await irsa.solid_angle_map(*key)
                    except SourceError:
                        probe = ListedKeyS3Source(settings, irsa=irsa, keys=[])
                        try:
                            sapms[key] = await probe.solid_angle_map(*key)
                        finally:
                            await probe.aclose()
                sapm_names.add(irsa.sapm_path(*key).name)
            except SourceError as exc:
                log.warning("sapm_missing", key=key, error=str(exc)[:200])
    finally:
        if s3_listed is not None:
            await s3_listed.aclose()
        if owned_s3 is not None:
            await owned_s3.aclose()

    # Gaia DR3 stars near each prediction for the V-14 neighbour model (method version 3). A cone
    # that does not answer leaves that exposure without a version 3 check (`catalog_unavailable`).
    gaia = GaiaClient(settings)
    try:

        async def stars_for(x: _Exposure) -> None:
            sc = x.image.sc_km
            if sc is not None:
                ra, dec, _ = topocentric(x.eph.ra_deg, x.eph.dec_deg, x.eph.delta_au, sc)
            else:
                ra, dec = x.eph.ra_deg, x.eph.dec_deg
            try:
                x.stars = await gaia.cone(
                    ra, dec, V14_NEIGHBOUR_CONE_ARCSEC * u.arcsec, max_g=V14_NEIGHBOUR_MAX_G
                )
            except SourceError as exc:
                log.warning("mover_gaia_failed", obs_id=x.image.record.obs_id, error=str(exc)[:200])

        await asyncio.gather(*(stars_for(x) for x in exposures))
    finally:
        await gaia.aclose()

    # Per-image processing in worker threads.
    cpu = asyncio.Semaphore(CPU_WORKERS)

    async def work(x: _Exposure) -> None:
        rec = x.image.record
        async with cpu:
            try:
                await asyncio.to_thread(
                    _process, x, sapms.get((rec.collection.replace("_deep", ""), rec.detector)),
                    fov, eph.solution,
                )  # fmt: skip
            except Exception as exc:  # one bad file costs that image only
                x.error = f"{type(exc).__name__}: {exc}"[:200]
                log.warning("mover_image_failed", obs_id=rec.obs_id, error=x.error)

    await asyncio.gather(*(work(x) for x in exposures))
    good = [x for x in exposures if x.error is None and x.science is not None]
    good.sort(key=lambda x: (x.image.record.t_mid.mjd, x.image.record.detector))
    if not good:
        raise SourceError("No image could be processed")
    await publish("progress", {"stage": "render", "done": 0, "total": len(good)})
    _write_outputs(params, settings, seq_id, name, record_id, eph.solution, good, path, detail,
                   sorted(sapm_names), exposures)  # fmt: skip


def _write_outputs(
    params: MoverParams,
    settings: Settings,
    seq_id: str,
    name: str,
    record_id: int,
    solution: str,
    good: list[_Exposure],
    path: str,
    detail: str,
    sapm_names: list[str],
    all_exposures: list[_Exposure],
) -> None:
    times = Time([x.image.record.t_mid.mjd for x in good], format="mjd", scale="utc")
    campaigns = group_epochs(times, EPOCH_GAP_DAYS)
    camp_of = {i: c.index for c in campaigns for i in c.members}
    for i, x in enumerate(good):
        x.point["campaign"] = camp_of[i]
        x.point["epoch"] = camp_of[i]
        x.check["campaign"] = camp_of[i]
    proto = good[0].grid
    assert proto is not None
    detectors = sorted({x.image.record.detector for x in good})
    stretches: dict[str, Stretch] = {}
    for d in detectors:
        stretches[str(d)] = compute_stretch(
            [x.science for x in good if x.image.record.detector == d and x.science is not None]
        )
    frames_dir = settings.frames_dir
    # Epochs: one per exposure (observation id), in time order.
    by_obs: dict[str, list[int]] = defaultdict(list)
    for i, x in enumerate(good):
        by_obs[x.image.record.observation_id].append(i)
    order = sorted(by_obs, key=lambda o: min(good[i].image.record.t_mid.mjd for i in by_obs[o]))
    epochs = []
    for ei, obs in enumerate(order):
        frames: list[ManifestFrame] = []
        for i in sorted(by_obs[obs], key=lambda i: good[i].image.record.detector):
            frames.append(_render_exposure(settings, seq_id, ei, good[i], stretches, solution))
        recs = [good[i].image.record for i in by_obs[obs]]
        epochs.append(
            mf.make_epoch(
                ei,
                min(r.t_start for r in recs),
                max(r.t_end for r in recs),
                Time(float(np.mean([r.t_mid.mjd for r in recs])), format="mjd"),
                len(recs),
                frames,
            )
        )
    # Object-aligned stacks per (campaign, detector).
    stacks: list[ManifestFrame] = []
    stack_data: dict[tuple[int, int], Any] = {}
    for c in campaigns:
        for d in detectors:
            members = [good[i] for i in c.members if good[i].image.record.detector == d]
            if not members:
                continue
            stack_data[(c.index, d)] = (coadd_stack(
                [m.science for m in members if m.science is not None],
                [m.variance for m in members if m.variance is not None],
            ), members)  # fmt: skip
    for d in detectors:
        means = [v[0].mean for (ci, dd), v in stack_data.items() if dd == d]
        if means:
            stretches[f"stack{d}"] = compute_stretch(means)
    for (ci, d), (co, members) in sorted(stack_data.items()):
        st = stretches[f"stack{d}"]
        stem = frame_key(seq_id, ci, str(d), "stack", {"vmin": st.vmin, "vmax": st.vmax})
        mstem = frame_key(seq_id, ci, str(d), "stackmask")
        recs = [m.image.record for m in members]
        g = members[0].grid
        assert g is not None
        atomic_write_bytes(frames_dir / f"{stem}.webp", to_webp(apply_stretch(co.mean, st)))
        atomic_write_bytes(frames_dir / f"{mstem}.png", mask_png(co.blank))
        atomic_write_bytes(
            frames_dir / f"{stem}.fits",
            coadd_fits_bytes(co.mean, g.wcs(), {
                "DSTLVER": settings.pipeline_version, "DSTLCOAD": COADD_METHOD_VERSION,
                "DSTLSEQ": seq_id, "DSTLCAMP": ci + 1, "DSTLDET": d, "NIMAGES": len(recs),
                "DSTLMOVR": "object-aligned stack; WCS of the first exposure grid",
                "EPHSOLN": solution,
            }, "MJy/sr", co.variance),
        )  # fmt: skip
        f = mf.make_frame(
            detector=d, kind="stack", url=f"/frames/{stem}.webp", fits_url=f"/frames/{stem}.fits",
            wavelength_um=(min(m.wl_range[0] for m in members if m.wl_range),
                           max(m.wl_range[1] for m in members if m.wl_range)),
            n_images=len(recs), flagged_fraction=co.blank_fraction,
            obs_ids=[r.obs_id for r in recs], collections=[r.collection for r in recs],
            t_start=min(r.t_start for r in recs), t_end=max(r.t_end for r in recs),
            t_mid=Time(float(np.mean([r.t_mid.mjd for r in recs])), format="mjd"),
            cutout_sources={m.image.record.obs_id: cutout_source_of(m.path) for m in members},
            flags_url=f"/frames/{mstem}.png",
            mask_flags=sorted({n for m in members for n in m.mask_flags}),
        )  # fmt: skip
        stacks.append(f.model_copy(update={"campaign": ci}))
    # Campaign summaries, spectrum and ephemeris check.
    mcamps = []
    for c in campaigns:
        mem = [good[i] for i in c.members]
        bounds = [
            parallax_bound_arcsec(float(np.linalg.norm(m.sc_km)), m.eph.delta_au)
            for m in mem
            if m.sc_km is not None
        ]
        mcamps.append(
            ManifestCampaign(
                index=c.index,
                t_start=mf.iso_utc(min(m.image.record.t_start for m in mem)),
                t_end=mf.iso_utc(max(m.image.record.t_end for m in mem)),
                t_mid_mjd=round(float(c.t_mid.mjd), 5),
                n_images=len(mem),
                parallax_bound_arcsec=round(max(bounds), 3) if bounds else None,
            )
        )
    points = [x.point for x in good]
    spectrum = {
        "sequence_id": seq_id,
        "designation": params.designation,
        "horizons_record": record_id,
        "solution": solution,
        "aperture_arcsec": COMA_APERTURE_ARCSEC,
        "annulus_arcsec": list(COMA_ANNULUS_ARCSEC),
        "aperture_correction": None,
        "unit": "Jy",
        "points": points,
        "bands": {
            str(c.index): {
                b: band_excess([p for p in points if p["campaign"] == c.index], b) for b in BANDS
            }
            for c in campaigns
        },
    }
    checks = [x.check for x in good]
    check_doc = {
        "sequence_id": seq_id,
        "solution": solution,
        "exposures": checks,
        "method_version": MOVER_METHOD_VERSION,
        "campaigns": {
            str(c.index): v14_summary([k for k in checks if k["campaign"] == c.index])
            for c in campaigns
        },
        # The single-Gaussian result of method version 2, kept next to it (docs/11 V-14).
        "campaigns_method_version_2": {
            str(c.index): v14_summary(
                [k["method_version_2"] for k in checks if k["campaign"] == c.index]
            )
            for c in campaigns
        },
        "failed_images": [
            {"obs_id": x.image.record.obs_id, "error": x.error} for x in all_exposures if x.error
        ],
    }
    out_dir = movers_dir(settings, seq_id)
    for fname, doc in (("spectrum.json", spectrum), ("ephemeris_check.json", check_doc)):
        atomic_write_bytes(out_dir / fname, json.dumps(doc, indent=1, default=_json).encode())
    collections = sorted({x.image.record.collection for x in good})
    services = [SERVICE_HORIZONS]
    services += [SERVICE_S3_SCAN] if path == DISCOVERY_PATH_S3 else [SERVICE_TAP]
    kinds = {cutout_source_of(x.path) for x in good}
    if "s3" in kinds:
        services.append(SERVICE_S3)
    if "irsa" in kinds:
        services.append(SERVICE_IBE)
    services.append(SERVICE_SAPM)
    warns = [
        ManifestWarning(
            code="MOVING_TARGET",
            detail=(
                "Frames follow the target: each exposure is centered on the JPL Horizons position "
                "at its mid time, corrected to the spacecraft position. Stars move between frames "
                "and trail in the stacks."
            ),
        ),
        ManifestWarning(
            code="NO_APERTURE_CORRECTION",
            detail="Coma photometry is an aperture sum without aperture correction.",
        ),
    ]
    if any(x.sc_km is None for x in good):
        warns.append(
            ManifestWarning(
                code="NO_SPACECRAFT_POSITION",
                detail="Some images carry no spacecraft position; their prediction is geocentric.",
            )
        )
    n_failed = len(all_exposures) - len(good)
    if n_failed:
        detail_failed = f"{n_failed} images could not be processed."
        warns.append(ManifestWarning(code="IMAGES_FAILED", detail=detail_failed))
    g0 = good[0]
    request = ManifestRequest(
        ra_deg=round(g0.ra, 6), dec_deg=round(g0.dec, 6), fov_arcmin=params.fov_arcmin,
        detectors=list(params.detectors), release=",".join(params.releases), target_id=None,
    )  # fmt: skip
    moving = ManifestMovingTarget(
        designation=params.designation, name=name, horizons_record=record_id, solution=solution,
        ephemeris_service=SERVICE_HORIZONS, discovery_path=path,
        discovery_detail=detail, method_version=MOVER_METHOD_VERSION,
        aperture_arcsec=COMA_APERTURE_ARCSEC, annulus_arcsec=COMA_ANNULUS_ARCSEC,
        campaigns=mcamps, stacks=stacks,
        spectrum_url=f"/api/v1/movers/{seq_id}/spectrum",
        ephemeris_check_url=f"/api/v1/movers/{seq_id}/ephemeris-check",
    )  # fmt: skip
    manifest = mf.build_manifest(
        sequence_id=seq_id, pipeline_version=settings.pipeline_version, request=request,
        grid=proto, epochs=epochs, stretches=stretches, photometry_url=None,
        collections=collections, services=services, warnings=warns,
        solid_angle_maps=sapm_names,
    ).model_copy(update={"moving_target": moving})  # fmt: skip
    atomic_write_bytes(
        settings.manifests_dir / f"{seq_id}.json",
        manifest.model_dump_json(indent=1).encode("utf-8"),
    )


def _render_exposure(
    settings: Settings,
    seq_id: str,
    ei: int,
    x: _Exposure,
    stretches: dict[str, Stretch],
    solution: str,
) -> ManifestFrame:
    rec = x.image.record
    d = rec.detector
    st = stretches[str(d)]
    assert x.science is not None and x.grid is not None
    stem = frame_key(seq_id, ei, str(d), "exposure", {"vmin": st.vmin, "vmax": st.vmax})
    mstem = frame_key(seq_id, ei, str(d), "exposuremask")
    blank = ~np.isfinite(x.science)
    atomic_write_bytes(settings.frames_dir / f"{stem}.webp", to_webp(apply_stretch(x.science, st)))
    atomic_write_bytes(settings.frames_dir / f"{mstem}.png", mask_png(blank))
    atomic_write_bytes(
        settings.frames_dir / f"{stem}.fits",
        coadd_fits_bytes(x.science, x.grid.wcs(), {
            "DSTLVER": settings.pipeline_version, "DSTLSEQ": seq_id, "DSTLEPOC": ei + 1,
            "DSTLDET": d, "NIMAGES": 1, "RELEASE": rec.collection, "OBS_ID": rec.obs_id[:68],
            "DATE-OBS": mf.iso_utc(rec.t_start), "DATE-END": mf.iso_utc(rec.t_end),
            "EPHSOLN": solution,
        }, "MJy/sr", x.variance),
    )  # fmt: skip
    f = mf.make_frame(
        detector=d, kind="exposure", url=f"/frames/{stem}.webp", fits_url=f"/frames/{stem}.fits",
        wavelength_um=x.wl_range, n_images=1, flagged_fraction=float(blank.mean()),
        obs_ids=[rec.obs_id], collections=[rec.collection], t_start=rec.t_start, t_end=rec.t_end,
        t_mid=rec.t_mid, cutout_sources={rec.obs_id: cutout_source_of(x.path)},
        flags_url=f"/frames/{mstem}.png", mask_flags=x.mask_flags,
    )  # fmt: skip
    return f.model_copy(
        update={
            "center_deg": (round(x.grid.ra_deg, 7), round(x.grid.dec_deg, 7)),
            "target_wavelength_um": x.wl_target,
            "ephemeris": ManifestEphemerisPoint(
                ra_deg=round(x.ra, 7),
                dec_deg=round(x.dec, 7),
                geocentric_ra_deg=x.eph.ra_deg,
                geocentric_dec_deg=x.eph.dec_deg,
                parallax_shift_arcsec=(
                    round(x.shift_arcsec, 3) if x.shift_arcsec is not None else None
                ),
                delta_au=x.eph.delta_au,
                ra_3sigma_arcsec=x.eph.ra_3sigma_arcsec,
                dec_3sigma_arcsec=x.eph.dec_3sigma_arcsec,
                solution=solution,
            ),
        }
    )


def _json(o: Any) -> Any:
    if isinstance(o, np.floating | np.integer):
        return o.item()
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(type(o).__name__)


def _main(argv: Sequence[str] | None = None) -> int:
    """CLI: python -m destello.worker.movers "3I/ATLAS" 2025-12-01T00:00:00 2026-01-01T00:00:00"""
    import argparse

    ap = argparse.ArgumentParser(description=_main.__doc__)
    ap.add_argument("designation")
    ap.add_argument("windows", nargs="+", help="start stop [start stop ...] (ISO UTC)")
    ap.add_argument("--force", action="store_true")
    ns = ap.parse_args(argv)
    if len(ns.windows) % 2:
        ap.error("windows come in start stop pairs")
    w = tuple((ns.windows[i], ns.windows[i + 1]) for i in range(0, len(ns.windows), 2))
    seq = asyncio.run(run_mover_build(MoverParams(ns.designation, w), force=ns.force))
    print(seq)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
