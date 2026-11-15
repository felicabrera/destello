"""The build_sequence job: discovery, cutouts, calibration, coadds, rendering, photometry, manifest.

Idempotent by sequence_id: if the manifest already exists the job only republishes `completed`.
Events are published on the Redis pub/sub channel `destello:seq:<id>` as JSON documents
{"event": ..., "data": ...} with events status, progress, detector_ready, epoch_ready, completed
and failed (docs/06 section 3.3).

Progressive build: detectors are downloaded in priority order (detector_priority). When every
cutout of a detector is in, all of its epochs are coadded, its intensity stretch is computed over
all of them together (fair comparison, docs/00 non-negotiable 3; the stretch is final, so the
frames are immutable and keep their final names), a partial manifest is written to
data/builds/<id>.partial.json and `detector_ready` is published. `epoch_ready` is emitted in
chronological order once every detector and the broadband frames are done; the final manifest is
written last.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

from destello.core.cache import atomic_write_bytes
from destello.core.config import (
    CUTOUT_MARGIN_ARCMIN,
    EPOCH_GAP_DAYS,
    SCIENCE_COLLECTIONS,
    Settings,
    get_settings,
    uses_quick_release,
)
from destello.core.ids import cutout_key, frame_key, sequence_id
from destello.core.logging import get_logger
from destello.models.manifest import Manifest, ManifestFrame, ManifestRequest, ManifestWarning
from destello.models.targets import Target, load_targets
from destello.pipeline import manifest as mf
from destello.pipeline.calibrate import (
    CalibratedCutout,
    calibrate,
    load_cutout,
    masked_flag_names,
    wavelength_at,
    wavelength_range,
)
from destello.pipeline.coadd import COADD_METHOD_VERSION, Coadd, broadband_coadd, coadd_stack
from destello.pipeline.epochs import Epoch, group_epochs
from destello.pipeline.photometry import (
    DEFAULT_APERTURE_ARCSEC,
    aperture_photometry,
    forced_photometry,
    point_reason,
)
from destello.pipeline.propagate import Astrometry, apparent_positions, propagate_space_motion
from destello.pipeline.query import ImageRecord, cutout_size
from destello.pipeline.render import (
    Stretch,
    apply_stretch,
    coadd_fits_bytes,
    compute_stretch,
    mask_png,
    to_webp,
)
from destello.pipeline.reproject import (
    GridSpec,
    grid_footprint,
    make_grid,
    reproject_cutout,
    reproject_mask,
)
from destello.sources.base import SourceError
from destello.sources.cutouts import CutoutRouter, CutoutSource
from destello.sources.irsa import IrsaClient
from destello.sources.s3 import S3CutoutSource, cutout_source_of

Publish = Callable[[str, dict[str, Any]], Awaitable[None]]

# Epochs with fewer images than this (over all detectors) are dropped with a warning: a full pass
# gives about 18 exposures per detector, while the short revisits seen in the survey (for
# example 8 to 10 images on two detectors) cannot form a comparable per-detector coadd.
MIN_EPOCH_IMAGES = 20
# With `include_partial` a shorter revisit is kept as a low coverage epoch, on the detectors
# that have at least this many images (a coadd needs a few exposures to reject outliers).
MIN_PARTIAL_DETECTOR_IMAGES = 3
# Deterministic cap per (epoch, detector); docs/10 section 3.3 allows up to 600 images in total.
MAX_IMAGES_PER_EPOCH_DETECTOR = 40
MAX_IMAGES_TOTAL = 600
# Date used to center preset requests so that their sequence identifiers are deterministic.
PRESET_CENTER_DATE = "2026-02-01T00:00:00"
SERVICE_TAP = "IRSA TAP"
SERVICE_IBE = "IRSA cutouts"
SERVICE_SIA = "IRSA SIA (cloud_access)"
SERVICE_S3 = "AWS Open Data SPHEREx copy (s3://nasa-irsa-spherex)"
SERVICE_SAPM = "IRSA solid angle pixel maps"
SERVICES = [SERVICE_TAP, SERVICE_IBE, SERVICE_SAPM]  # an IRSA only build


@dataclass(frozen=True)
class SequenceParams:
    """Normalized, validated request for a sequence."""

    ra_deg: float
    dec_deg: float
    fov_arcmin: float
    detectors: tuple[int, ...] = (1, 2, 3, 4, 5, 6)
    release: str = "all"
    target_id: str | None = None
    track: dict[str, Any] | None = None  # pmra_masyr, pmdec_masyr, parallax_mas, ref_epoch
    # Detector downloaded and published first (the one on screen). It only changes the build
    # order, never the result, so it is not part of the sequence identifier.
    priority_detector: int | None = None
    # Keep the short revisits between survey passes as low coverage epochs. It changes the
    # result, so it is part of the sequence identifier (only when set: identifiers of
    # sequences without it are unchanged).
    include_partial: bool = False

    def mode_params(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.include_partial:
            out["partial"] = True
        if self.target_id:
            out["target"] = self.target_id
        if self.track:
            out["track"] = {k: self.track[k] for k in sorted(self.track)}
        return out

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> SequenceParams:
        return cls(
            ra_deg=float(d["ra_deg"]),
            dec_deg=float(d["dec_deg"]),
            fov_arcmin=float(d["fov_arcmin"]),
            detectors=tuple(sorted({int(x) for x in d.get("detectors", (1, 2, 3, 4, 5, 6))})),
            release=str(d.get("release", "all")),
            target_id=d.get("target_id"),
            track=d.get("track"),
            priority_detector=(
                int(d["priority_detector"]) if d.get("priority_detector") is not None else None
            ),
            include_partial=bool(d.get("include_partial", False)),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "ra_deg": self.ra_deg,
            "dec_deg": self.dec_deg,
            "fov_arcmin": self.fov_arcmin,
            "detectors": list(self.detectors),
            "release": self.release,
            "target_id": self.target_id,
            "track": self.track,
            "priority_detector": self.priority_detector,
            "include_partial": self.include_partial,
        }


def collections_for_release(release: str) -> list[str]:
    """ "all" means every science collection; otherwise the named collection and its deep field."""
    if release == "all":
        return list(SCIENCE_COLLECTIONS)
    if release not in SCIENCE_COLLECTIONS:
        raise ValueError(f"Unknown release {release!r}")
    base = release.replace("_deep", "")
    return [base, base + "_deep"]


def preset_params(target: Target) -> SequenceParams:
    """Deterministic request for a preset: centered on the target position at PRESET_CENTER_DATE."""
    pos = apparent_positions(target.to_astrometry(), Time(PRESET_CENTER_DATE, scale="utc"))
    view = target.default_view
    return SequenceParams(
        ra_deg=round(float(pos.ra.deg), 5),
        dec_deg=round(float(pos.dec.deg), 5),
        fov_arcmin=float(view.fov_arcmin),
        detectors=tuple(view.detectors),
        release="all",
        target_id=target.id,
    )


def params_sequence_id(params: SequenceParams, settings: Settings) -> str:
    return sequence_id(
        params.ra_deg,
        params.dec_deg,
        params.fov_arcmin,
        params.detectors,
        params.release,
        settings.pipeline_version,
        params.mode_params(),
    )


def manifest_path(settings: Settings, seq_id: str) -> Path:
    return settings.manifests_dir / f"{seq_id}.json"


def plan_epochs(
    epochs: list[Epoch], detectors: list[int], *, include_partial: bool
) -> tuple[list[Epoch], dict[int, dict[int, set[int]]]]:
    """Epochs to build, in time order, and the low coverage ones among them.

    An epoch with at least MIN_EPOCH_IMAGES images is a survey pass and is always kept. With
    `include_partial` a shorter revisit is kept too, restricted to the detectors that have at
    least MIN_PARTIAL_DETECTOR_IMAGES images; it is dropped when no detector does. The second
    value maps the index of a low coverage epoch in the returned list to the record indices
    it uses, by detector. `detectors[i]` is the detector of record `i`."""
    kept: list[Epoch] = []
    low: dict[int, dict[int, set[int]]] = {}
    for e in epochs:
        if len(e.members) >= MIN_EPOCH_IMAGES:
            kept.append(e)
            continue
        if not include_partial:
            continue
        by_det: dict[int, set[int]] = defaultdict(set)
        for i in e.members:
            by_det[detectors[i]].add(i)
        usable = {d: m for d, m in by_det.items() if len(m) >= MIN_PARTIAL_DETECTOR_IMAGES}
        if usable:
            low[len(kept)] = usable
            kept.append(e)
    return kept, low


def select_images(records: list[ImageRecord], cap: int) -> list[ImageRecord]:
    """Deterministic thinning to at most `cap` records (evenly spaced in time order)."""
    if len(records) <= cap:
        return records
    idx = np.unique(np.linspace(0, len(records) - 1, cap).round().astype(int))
    return [records[i] for i in idx]


@dataclass
class _Group:
    """All exposures of one detector within one epoch."""

    epoch: int
    detector: int
    records: list[ImageRecord] = field(default_factory=list)


def _target_astrometry(params: SequenceParams) -> tuple[Astrometry | None, Target | None]:
    """Astrometry used to place the target in each exposure (preset or user supplied track)."""
    if params.target_id:
        t = load_targets().get(params.target_id)
        if t is not None:
            return t.to_astrometry(), t
    if params.track:
        from destello.models.targets import parse_epoch

        tr = params.track
        return (
            Astrometry(
                ra=params.ra_deg * u.deg,
                dec=params.dec_deg * u.deg,
                pmra_cosdec=float(tr.get("pmra_masyr", 0.0)) * u.mas / u.yr,
                pmdec=float(tr.get("pmdec_masyr", 0.0)) * u.mas / u.yr,
                parallax=float(tr.get("parallax_mas", 0.0)) * u.mas,
                ref_epoch=parse_epoch(str(tr.get("ref_epoch", "J2016.0"))),
            ),
            None,
        )
    return None, None


def _process_group(
    group: _Group,
    paths: dict[str, Path],
    sapms: dict[tuple[str, int], np.ndarray[Any, Any]],
    grid: GridSpec,
    target_astro: Astrometry | None,
    fallback_pos: tuple[float, float],
) -> dict[str, Any]:
    """CPU bound work for one (epoch, detector): calibrate, photometry, reproject, coadd."""
    images: list[np.ndarray[Any, Any]] = []
    variances: list[np.ndarray[Any, Any]] = []
    sat_sum = np.zeros(grid.shape, dtype=np.float32)
    used: list[ImageRecord] = []
    points: list[dict[str, Any]] = []
    wmin: list[float] = []
    wmax: list[float] = []
    mask_names: set[str] = set()
    for rec in group.records:
        path = paths.get(rec.obs_id)
        if path is None:
            continue
        with fits.open(path) as hdul:
            cut = load_cutout(hdul, rec.obs_id)
        sapm = sapms.get((rec.collection.replace("_deep", ""), rec.detector))
        cal: CalibratedCutout = calibrate(cut, sapm)
        # Target position at this exposure: propagated from the reference epoch.
        if target_astro is not None:
            pos = apparent_positions(target_astro, cut.t_mid)
            ra, dec = float(pos.ra.deg), float(pos.dec.deg)
        else:
            ra, dec = fallback_pos
        phot = forced_photometry(cal, ra * u.deg, dec * u.deg)
        entry: dict[str, Any] = {
            "epoch": group.epoch,
            "obs_id": rec.obs_id,
            "detector": rec.detector,
            "collection": rec.collection,
            "t_mid_mjd": round(float(cut.t_mid.mjd), 6),
            "ra_deg": ra,
            "dec_deg": dec,
            "usable": phot.usable,
        }
        if phot.usable:
            xw, yw = cut.wcs.all_world2pix(ra, dec, 0, quiet=True)
            try:
                wl, bw = wavelength_at(cut, float(xw), float(yw))
                entry["wavelength_um"] = float(wl.value)
                entry["bandwidth_um"] = float(bw.value)
            except Exception:
                entry["wavelength_um"] = None
                entry["bandwidth_um"] = None
            entry.update(
                flux=phot.flux_jy,
                flux_err=phot.flux_err_jy,
                flagged=bool(phot.flagged_fraction > 0.2),
                flagged_fraction=round(phot.flagged_fraction, 3),
            )
        points.append(entry)
        rp = reproject_cutout(cal, grid)
        if rp.coverage <= 0.0:
            continue
        images.append(rp.science)
        variances.append(rp.variance)
        sat_sum += reproject_mask(cal.saturated, cut.wcs, grid)
        mask_names.update(
            masked_flag_names(cut.flags, cut.flag_bits, grid_footprint(cut.wcs, cut.shape, grid))
        )
        used.append(rec)
        lo, hi = wavelength_range(cut)
        wmin.append(float(lo.value))
        wmax.append(float(hi.value))
    result: dict[str, Any] = {"group": group, "points": points, "used": used}
    if images:
        result["coadd"] = coadd_stack(images, variances)
        result["saturated_fraction_map"] = sat_sum / len(images)
        result["wavelength_um"] = (min(wmin), max(wmax))
        result["mask_flags"] = sorted(mask_names)
    return result


def partial_manifest_path(settings: Settings, seq_id: str) -> Path:
    """Manifest of the detectors finished so far (served by the API, never by the static
    /manifests route); removed when the final manifest is written or the build fails."""
    return settings.data_dir / "builds" / f"{seq_id}.partial.json"


def manifest_api_url(seq_id: str) -> str:
    return f"/api/v1/sequences/{seq_id}/manifest"


def services_for(sources: Iterable[str]) -> list[str]:
    """Provenance services for the cutout sources that produced the used images."""
    kinds = set(sources)
    out = [SERVICE_TAP]
    if "irsa" in kinds or not kinds:
        out.append(SERVICE_IBE)
    if "s3" in kinds:
        out.extend([SERVICE_SIA, SERVICE_S3])
    out.append(SERVICE_SAPM)
    return out


def detector_priority(groups: Sequence[_Group], requested: int | None = None) -> list[int]:
    """Order in which detectors are downloaded, coadded and published.

    The requested detector (the one on screen) comes first when it has images. The others follow,
    ranked by most epochs (a usable blink first), then fewest images (fastest to fetch), then the
    higher detector number (longer wavelengths, where cool moving objects are brightest).
    """
    epochs: dict[int, set[int]] = defaultdict(set)
    images: dict[int, int] = defaultdict(int)
    for g in groups:
        if g.records:
            epochs[g.detector].add(g.epoch)
            images[g.detector] += len(g.records)
    ranked = sorted(epochs, key=lambda d: (-len(epochs[d]), images[d], -d))
    if requested is not None and requested in epochs:
        ranked.remove(requested)
        ranked.insert(0, requested)
    return ranked


def _requested_detector(params: SequenceParams, target: Target | None) -> int | None:
    if params.priority_detector is not None:
        return params.priority_detector
    if target is not None and isinstance(target.default_view.det, int):
        return target.default_view.det
    return None


def _first_error(group: BaseExceptionGroup[BaseException]) -> BaseException:
    """The first leaf exception of a task group failure (keeps error codes for the event)."""
    first = group.exceptions[0]
    while isinstance(first, BaseExceptionGroup):
        first = first.exceptions[0]
    return first


def _bytes(client: object) -> int:
    return int(getattr(client, "bytes_downloaded", 0) or 0)


def _render_coadd(
    settings: Settings,
    seq_id: str,
    ei: int,
    d: int,
    c: Coadd,
    used: list[ImageRecord],
    st: Stretch,
    sat_map: np.ndarray[Any, Any],
    wl_range: tuple[float, float],
    grid: GridSpec,
    wcs: WCS,
    target_pos: tuple[float, float],
    sources: dict[str, str],
    mask_flags: list[str],
) -> tuple[ManifestFrame, dict[str, Any]]:
    """Write the WebP, mask PNG and FITS files of one (epoch, detector) coadd; return its manifest
    frame and its epoch photometry entry."""
    stem = frame_key(seq_id, ei, str(d), "coadd", {"vmin": st.vmin, "vmax": st.vmax})
    mask_stem = frame_key(seq_id, ei, str(d), "mask")
    webp = to_webp(apply_stretch(c.mean, st, sat_map))
    fits_bytes = coadd_fits_bytes(
        c.mean,
        wcs,
        {
            "DSTLVER": settings.pipeline_version,
            "DSTLCOAD": COADD_METHOD_VERSION,
            "DSTLSEQ": seq_id,
            "DSTLEPOC": ei + 1,
            "DSTLDET": d,
            "NIMAGES": len(used),
            "RELEASE": ",".join(sorted({r.collection for r in used})),
            "DATE-OBS": mf.iso_utc(min(r.t_start for r in used)),
            "DATE-END": mf.iso_utc(max(r.t_end for r in used)),
        },
        "MJy/sr",
        c.variance,
    )
    atomic_write_bytes(settings.frames_dir / f"{stem}.webp", webp)
    atomic_write_bytes(settings.frames_dir / f"{stem}.fits", fits_bytes)
    atomic_write_bytes(settings.frames_dir / f"{mask_stem}.png", mask_png(c.blank))
    frame = mf.make_frame(
        detector=d,
        kind="coadd",
        url=f"/frames/{stem}.webp",
        fits_url=f"/frames/{stem}.fits",
        wavelength_um=wl_range,
        n_images=len(used),
        flagged_fraction=c.blank_fraction,
        obs_ids=[r.obs_id for r in used],
        collections=[r.collection for r in used],
        t_start=min(r.t_start for r in used),
        t_end=max(r.t_end for r in used),
        t_mid=Time(float(np.mean([r.t_mid.mjd for r in used])), format="mjd"),
        cutout_sources={r.obs_id: sources.get(r.obs_id, "irsa") for r in used},
        flags_url=f"/frames/{mask_stem}.png",
        mask_flags=mask_flags,
    )
    ra_t, dec_t = target_pos
    xg, yg = wcs.all_world2pix(ra_t, dec_t, 0)
    scale = grid.pixel_scale_arcsec
    ph = aperture_photometry(
        c.mean,
        c.variance,
        c.n_used == 0,
        np.full(c.mean.shape, scale * scale, dtype=np.float32),
        float(xg),
        float(yg),
        pixel_scale_arcsec=scale,
        saturated=sat_map,
    )
    # Same rejection rule as the single-exposure spectrum points (docs/03 section 4.6): a coadd
    # whose core is saturated or masked carries no flux, because the sum would be a lower bound.
    reason = point_reason(ph)
    phot = {
        "epoch": ei,
        "detector": d,
        "flux": ph.flux_jy if reason is None else None,
        "flux_err": ph.flux_err_jy if reason is None else None,
        "reason": reason,
        "n_images": len(used),
        "wavelength_um": list(wl_range),
        "ra_deg": ra_t,
        "dec_deg": dec_t,
    }
    return frame, phot


async def run_build(
    params: SequenceParams,
    settings: Settings,
    publish: Publish,
    irsa: IrsaClient | None = None,
    *,
    force: bool = False,
    s3: CutoutSource | None = None,
) -> str:
    """Build (or reuse) a sequence and return its sequence_id. Raises on failure after publishing
    a `failed` event.

    `s3` is the primary cutout source (IRSA is the per image fallback). When no IRSA client is
    passed, the function owns its clients and creates the S3 source itself if
    DESTELLO_CUTOUT_SOURCE is "s3"; an injected IRSA client is used alone unless `s3` is given.
    """
    seq_id = params_sequence_id(params, settings)
    log = get_logger(sequence_id=seq_id)
    mpath = manifest_path(settings, seq_id)
    if mpath.exists() and not force:
        await publish("completed", {"manifest_url": f"/manifests/{seq_id}.json"})
        return seq_id
    owns = irsa is None
    client = irsa or IrsaClient(settings)
    owned_s3: S3CutoutSource | None = None
    if s3 is None and owns and settings.cutout_source == "s3":
        owned_s3 = S3CutoutSource(settings, irsa=client)
        s3 = owned_s3
    try:
        await publish("status", {"status": "running", "position": 0})
        await _build(params, settings, publish, client, s3, seq_id, log)
    except Exception as exc:
        partial_manifest_path(settings, seq_id).unlink(missing_ok=True)
        code = getattr(exc, "code", "BUILD_FAILED")
        log.error("build_failed", error=str(exc), code=code)
        await publish("failed", {"code": code, "retry_after_s": 300})
        raise
    finally:
        if owned_s3 is not None:
            await owned_s3.aclose()
        if owns:
            await client.aclose()
    await publish("completed", {"manifest_url": f"/manifests/{seq_id}.json"})
    return seq_id


async def _build(
    params: SequenceParams,
    settings: Settings,
    publish: Publish,
    irsa: IrsaClient,
    s3: CutoutSource | None,
    seq_id: str,
    log: Any,
) -> None:
    started = time.perf_counter()
    collections = collections_for_release(params.release)
    warnings: list[ManifestWarning] = []

    # 1. Discovery ------------------------------------------------------------------------
    await publish("progress", {"stage": "query", "done": 0, "total": 1})
    records = await irsa.query_images(params.ra_deg, params.dec_deg, collections, params.detectors)
    await publish("progress", {"stage": "query", "done": 1, "total": 1})
    if not records:
        raise SourceError("No SPHEREx images cover this position")
    epochs = group_epochs(
        Time([r.t_mid.mjd for r in records], format="mjd", scale="utc"), EPOCH_GAP_DAYS
    )
    kept, low = plan_epochs(
        epochs, [r.detector for r in records], include_partial=params.include_partial
    )
    kept_ids = {id(e) for e in kept}
    for i, e in enumerate(kept):
        if i in low:
            n_low = sum(len(v) for v in low[i].values())
            warnings.append(
                ManifestWarning(
                    code="EPOCH_LOW_COVERAGE",
                    detail=(
                        f"A partial revisit of {n_low} images around MJD {e.t_mid.mjd:.1f} is "
                        "shown as a low coverage epoch: it is not used in measurements."
                    ),
                )
            )
    for e in epochs:
        if id(e) not in kept_ids:
            warnings.append(
                ManifestWarning(
                    code="EPOCH_PARTIAL_SKIPPED",
                    detail=(
                        f"A partial revisit of {len(e.members)} images around MJD "
                        f"{e.t_mid.mjd:.1f} was not used: it is too small to coadd and compare."
                    ),
                )
            )
    if not kept:
        raise SourceError("No epoch with enough images")
    # Deterministic thinning per (epoch, detector), then globally.
    groups: list[_Group] = []
    for new_index, e in enumerate(kept):
        by_det: dict[int, list[ImageRecord]] = defaultdict(list)
        for i in e.members:
            if new_index not in low or i in low[new_index].get(records[i].detector, ()):
                by_det[records[i].detector].append(records[i])
        for det in sorted(by_det):
            recs = select_images(
                sorted(by_det[det], key=lambda r: (r.t_mid.mjd, r.obs_id)),
                MAX_IMAGES_PER_EPOCH_DETECTOR,
            )
            groups.append(_Group(epoch=new_index, detector=det, records=recs))
    total_images = sum(len(g.records) for g in groups)
    if total_images > MAX_IMAGES_TOTAL:
        per = max(MAX_IMAGES_TOTAL // len(groups), 1)
        for g in groups:
            g.records = select_images(g.records, per)
        warnings.append(
            ManifestWarning(
                code="IMAGE_CAP_APPLIED",
                detail=f"{total_images} images were available; thinned to {MAX_IMAGES_TOTAL}.",
            )
        )
        total_images = sum(len(g.records) for g in groups)

    # 2. Geometry -------------------------------------------------------------------------
    target_astro, target = _target_astrometry(params)
    center = SkyCenter(params.ra_deg, params.dec_deg)
    epoch_mid = [Time(e.t_mid.mjd, format="mjd", scale="utc") for e in kept]
    max_off = 0.0 * u.arcmin
    if target_astro is not None:
        from astropy.coordinates import SkyCoord

        pos = apparent_positions(target_astro, Time([t.mjd for t in epoch_mid], format="mjd"))
        ctr = SkyCoord(center.ra * u.deg, center.dec * u.deg)
        max_off = float(pos.separation(ctr).max().to_value(u.arcmin)) * u.arcmin
    fov = params.fov_arcmin * u.arcmin
    csize = cutout_size(fov, max_off, CUTOUT_MARGIN_ARCMIN * u.arcmin)
    grid = make_grid(center.ra * u.deg, center.dec * u.deg, fov)
    wcs = grid.wcs()
    # Target position at each epoch's mean time (field center without a target).
    target_at: list[tuple[float, float]] = []
    for t in epoch_mid:
        if target_astro is None:
            target_at.append((center.ra, center.dec))
        else:
            tpos = apparent_positions(target_astro, t)
            target_at.append((float(tpos.ra.deg), float(tpos.dec.deg)))
    request = ManifestRequest(
        ra_deg=params.ra_deg,
        dec_deg=params.dec_deg,
        fov_arcmin=params.fov_arcmin,
        detectors=list(params.detectors),
        release=params.release,
        target_id=params.target_id,
    )
    order = detector_priority(groups, _requested_detector(params, target))
    log.info(
        "plan",
        epochs=len(kept),
        images=total_images,
        cutout_arcmin=float(csize.value),
        detector_order=order,
        cutout_source="s3" if s3 is not None else "irsa",
    )

    # 3. Cutouts and coadds, detector by detector ------------------------------------------------
    # A bounded pool of workers fetches the cutouts in detector priority order. As soon as every
    # cutout of a detector is in, its epochs are coadded and its stretch is computed over all of
    # its epochs (final, so its frames are immutable and keep their names), a partial manifest is
    # written and `detector_ready` is published, while the next detectors are still downloading.
    cutouts: CutoutSource = CutoutRouter(irsa, s3) if s3 is not None else irsa
    by_group_det = {d: [g for g in groups if g.detector == d] for d in order}
    queue = [r for d in order for g in by_group_det[d] for r in g.records]
    all_records = [r for g in groups for r in g.records]
    remaining = {d: sum(len(g.records) for g in by_group_det[d]) for d in order}
    det_done = {d: asyncio.Event() for d in order}
    pool = settings.s3_concurrency if s3 is not None else settings.irsa_concurrency
    bytes_before = {"irsa": _bytes(irsa), "s3": _bytes(s3)}
    paths: dict[str, Path] = {}
    sources: dict[str, str] = {}
    failed: list[str] = []
    done = 0

    async def fetch(rec: ImageRecord) -> None:
        nonlocal done
        try:
            path = await cutouts.download_cutout(rec, center.ra, center.dec, csize)
            paths[rec.obs_id] = path
            sources[rec.obs_id] = cutout_source_of(path)
        except SourceError as exc:
            failed.append(rec.obs_id)
            log.warning("cutout_failed", obs_id=rec.obs_id, error=str(exc))
        except Exception as exc:
            # An unexpected error (disk, a malformed response) costs this cutout only: the detector
            # bookkeeping below must still run, or the build would wait for it forever.
            failed.append(rec.obs_id)
            log.error("cutout_failed_unexpected", obs_id=rec.obs_id, error=repr(exc))
        done += 1
        remaining[rec.detector] -= 1
        if remaining[rec.detector] == 0:
            det_done[rec.detector].set()
        if done % 5 == 0 or done == len(queue):
            await publish("progress", {"stage": "cutouts", "done": done, "total": len(queue)})

    pending_records = iter(queue)

    async def worker() -> None:
        for rec in pending_records:  # shared iterator: each record is taken by one worker
            await fetch(rec)

    sapms: dict[tuple[str, int], np.ndarray[Any, Any]] = {}
    sapm_names: list[str] = []

    async def load_sapm(rel: str, det: int) -> None:
        try:
            sapms[(rel, det)] = await irsa.solid_angle_map(rel, det)
            sapm_names.append(irsa.sapm_path(rel, det).name)
        except SourceError as exc:
            warnings.append(
                ManifestWarning(
                    code="SOLID_ANGLE_FALLBACK",
                    detail=f"No solid angle map for {rel} D{det} ({exc}); OMEGA_MEDIAN used.",
                )
            )

    results: dict[tuple[int, int], dict[str, Any]] = {}
    coadds: dict[tuple[int, int], Coadd] = {}
    sat_maps: dict[tuple[int, int], np.ndarray[Any, Any]] = {}
    wl_ranges: dict[tuple[int, int], tuple[float, float]] = {}
    mask_names: dict[tuple[int, int], list[str]] = {}
    group_used: dict[tuple[int, int], list[ImageRecord]] = {}
    stretches: dict[str, Stretch] = {}
    det_frames: dict[int, dict[int, ManifestFrame]] = {}
    epoch_phot: list[dict[str, Any]] = []
    finished: list[int] = []
    ready: list[int] = []
    settings.frames_dir.mkdir(parents=True, exist_ok=True)

    def coverage_of(ei: int) -> Literal["full", "low"]:
        return "low" if ei in low else "full"

    def write_partial() -> Manifest:
        part_epochs = []
        for ei, e in enumerate(kept):
            frames = [det_frames[dd][ei] for dd in sorted(ready) if ei in det_frames[dd]]
            n_img = sum(len(group_used.get((ei, dd), [])) for dd in ready)
            part_epochs.append(
                mf.make_epoch(ei, e.t_start, e.t_end, e.t_mid, n_img, frames, coverage_of(ei))
            )
        used_ready = [r for (_, dd), recs in group_used.items() if dd in ready for r in recs]
        ready_coadds = {k: v for k, v in coadds.items() if k[1] in ready}
        manifest = mf.build_manifest(
            sequence_id=seq_id,
            pipeline_version=settings.pipeline_version,
            request=request,
            grid=grid,
            epochs=part_epochs,
            stretches={str(dd): stretches[str(dd)] for dd in sorted(ready)},
            photometry_url=None,
            collections=sorted({r.collection for r in used_ready}),
            services=services_for(sources.get(r.obs_id, "irsa") for r in used_ready),
            warnings=[
                *warnings,
                *_science_warnings(
                    params,
                    target,
                    ready_coadds,
                    [e.t_mid for e in kept],
                    collections={r.collection for r in used_ready},
                ),
            ],
            solid_angle_maps=sapm_names,
            created_at=datetime.now(UTC),
        )
        doc = manifest.model_dump(mode="json")
        doc["build"] = {
            "status": "partial",
            "priority_detector": order[0],
            "detectors_ready": list(ready),
            "detectors_pending": [x for x in order if x not in finished],
        }
        atomic_write_bytes(partial_manifest_path(settings, seq_id), json.dumps(doc).encode())
        return manifest

    def render_detector(d: int, keys: list[tuple[int, int]]) -> Manifest:
        # One stretch over every epoch of this detector (fair comparison): it is final here.
        st = compute_stretch([coadds[k].mean for k in keys])
        stretches[str(d)] = st
        det_frames[d] = {}
        for k in keys:
            ei = k[0]
            frame, phot = _render_coadd(
                settings,
                seq_id,
                ei,
                d,
                coadds[k],
                group_used[k],
                st,
                sat_maps[k],
                wl_ranges[k],
                grid,
                wcs,
                target_at[ei],
                sources,
                mask_names[k],
            )
            det_frames[d][ei] = frame
            epoch_phot.append(phot)
        ready.append(d)
        return write_partial()

    async def finish_detector(d: int) -> None:
        need = sorted(
            {(r.collection.replace("_deep", ""), d) for g in by_group_det[d] for r in g.records}
        )
        await asyncio.gather(*(load_sapm(rel, det) for rel, det in need))
        for g in by_group_det[d]:
            res = await asyncio.to_thread(
                _process_group, g, paths, sapms, grid, target_astro, (center.ra, center.dec)
            )
            key = (g.epoch, g.detector)
            results[key] = res
            if "coadd" in res:
                coadds[key] = res["coadd"]
                sat_maps[key] = res["saturated_fraction_map"] >= 0.5
                wl_ranges[key] = res["wavelength_um"]
                mask_names[key] = res["mask_flags"]
                group_used[key] = res["used"]
            if done == len(queue):  # coadd progress only once every download is finished
                await publish(
                    "progress", {"stage": "coadd", "done": len(results), "total": len(groups)}
                )
        finished.append(d)
        keys = sorted(k for k in coadds if k[1] == d)
        if not keys:
            log.warning("detector_empty", detector=d)
            return
        # Stretch, WebP/PNG/FITS encoding and file writes are CPU and disk bound: they run in a
        # worker thread so that the event loop keeps serving downloads and progress events.
        manifest = await asyncio.to_thread(render_detector, d, keys)
        await publish(
            "detector_ready",
            {
                "detector": d,
                "stretch": manifest.stretch[str(d)].model_dump(mode="json"),
                "frames": [
                    {"epoch": ei, **det_frames[d][ei].model_dump(mode="json")}
                    for ei in sorted(det_frames[d])
                ],
                "manifest_url": manifest_api_url(seq_id),
                "detectors_ready": list(ready),
                "detectors_pending": [x for x in order if x not in finished],
            },
        )
        log.info(
            "detector_ready",
            detector=d,
            elapsed_s=round(time.perf_counter() - started, 1),
            cutouts_done=done,
            cutouts_total=len(queue),
        )

    try:
        async with asyncio.TaskGroup() as tg:
            for _ in range(max(1, min(pool, len(queue)))):
                tg.create_task(worker())
            for d in order:
                await det_done[d].wait()
                await finish_detector(d)
    except ExceptionGroup as group:
        raise _first_error(group) from None
    log.info(
        "cutouts_done",
        images=len(queue),
        failed=len(failed),
        sources=getattr(cutouts, "counts", None),
        irsa_bytes=_bytes(irsa) - bytes_before["irsa"],
        s3_bytes=_bytes(s3) - bytes_before["s3"],
        elapsed_s=round(time.perf_counter() - started, 1),
    )
    if len(failed) > 0.5 * len(queue):
        err = SourceError("More than half of the cutouts could not be retrieved")
        err.code = "IRSA_UNAVAILABLE"
        raise err
    if failed:
        warnings.append(
            ManifestWarning(
                code="CUTOUTS_MISSING",
                detail=f"{len(failed)} of {len(queue)} cutouts could not be retrieved.",
            )
        )
    if not coadds:
        raise SourceError("No usable exposures after calibration")
    # Low coverage epochs are shown, never measured: no photometry of them is published.
    points: list[dict[str, Any]] = []
    for g in groups:
        if g.epoch not in low:
            points.extend(results[(g.epoch, g.detector)]["points"])
    epoch_phot = [p for p in epoch_phot if int(p["epoch"]) not in low]
    epoch_phot.sort(key=lambda p: (p["epoch"], p["detector"]))

    # 4. Broadband frames and the final manifest -------------------------------------------------
    await publish("progress", {"stage": "render", "done": 0, "total": 1})
    detectors = sorted({d for (_, d) in coadds})
    stretches = {str(d): stretches[str(d)] for d in detectors}
    broadband: dict[int, np.ndarray[Any, Any]] = {}
    bb_methods: dict[int, dict[int, str]] = {}
    for ei in range(len(kept)):
        per_det = {d: coadds[(ei, d)] for d in detectors if (ei, d) in coadds}
        if per_det:
            broadband[ei], bb_methods[ei] = broadband_coadd(per_det)
    if broadband:
        stretches["all"] = compute_stretch(list(broadband.values()), unit="normalized")

    manifest_epochs: list[Any] = []
    release_dates: list[str] = []
    epoch_frames: dict[int, list[Any]] = {}
    for ei, e in enumerate(kept):
        frames: list[Any] = [det_frames[d][ei] for d in detectors if ei in det_frames.get(d, {})]
        if ei in broadband:
            st = stretches["all"]
            stem = frame_key(seq_id, ei, "all", "broadband", {"vmin": st.vmin, "vmax": st.vmax})
            sat_any = np.zeros(grid.shape, dtype=bool)
            for d in detectors:
                if (ei, d) in sat_maps:
                    sat_any |= sat_maps[(ei, d)]
            atomic_write_bytes(
                settings.frames_dir / f"{stem}.webp",
                to_webp(apply_stretch(broadband[ei], st, sat_any)),
            )
            bb_blank = ~np.isfinite(broadband[ei])
            bb_mask_stem = frame_key(seq_id, ei, "all", "mask")
            atomic_write_bytes(settings.frames_dir / f"{bb_mask_stem}.png", mask_png(bb_blank))
            bb_flags = sorted({n for d in detectors for n in mask_names.get((ei, d), [])})
            all_used = [r for d in detectors for r in group_used.get((ei, d), [])]
            frames.append(
                mf.make_frame(
                    detector="all",
                    kind="broadband",
                    url=f"/frames/{stem}.webp",
                    fits_url=None,
                    wavelength_um=None,
                    n_images=len(all_used),
                    flagged_fraction=float(np.mean(bb_blank)),
                    obs_ids=[r.obs_id for r in all_used],
                    collections=[r.collection for r in all_used],
                    t_start=min(r.t_start for r in all_used),
                    t_end=max(r.t_end for r in all_used),
                    t_mid=Time(float(np.mean([r.t_mid.mjd for r in all_used])), format="mjd"),
                    normalization=",".join(f"D{d}:{m}" for d, m in sorted(bb_methods[ei].items())),
                    cutout_sources={r.obs_id: sources.get(r.obs_id, "irsa") for r in all_used},
                    flags_url=f"/frames/{bb_mask_stem}.png",
                    mask_flags=bb_flags,
                )
            )
        epoch_frames[ei] = frames
        n_img = sum(len(group_used.get((ei, d), [])) for d in detectors)
        manifest_epochs.append(
            mf.make_epoch(ei, e.t_start, e.t_end, e.t_mid, n_img, frames, coverage_of(ei))
        )
    await publish("progress", {"stage": "render", "done": 1, "total": 1})

    # 5. Photometry file, manifest ---------------------------------------------------------------
    await publish("progress", {"stage": "photometry", "done": 0, "total": 1})
    phot_name = f"{seq_id}.photometry.json"
    phot_doc = {
        "unit": "Jy",
        "sequence_id": seq_id,
        "aperture_radius_arcsec": DEFAULT_APERTURE_ARCSEC,
        "note": "Aperture sums without aperture correction; solid angle from the pixel map.",
        "points": points,
        "epoch_photometry": epoch_phot,
    }
    settings.manifests_dir.mkdir(parents=True, exist_ok=True)
    atomic_write_bytes(
        settings.manifests_dir / phot_name, json.dumps(phot_doc, sort_keys=True).encode()
    )
    used_collections = sorted({r.collection for r in all_records})
    warnings.extend(
        _science_warnings(
            params,
            target,
            coadds,
            [e.t_mid for e in kept],
            epoch_phot=epoch_phot,
            collections=used_collections,
        )
    )
    used_sources = [sources.get(r.obs_id, "irsa") for recs in group_used.values() for r in recs]
    manifest = mf.build_manifest(
        sequence_id=seq_id,
        pipeline_version=settings.pipeline_version,
        request=request,
        grid=grid,
        epochs=manifest_epochs,
        stretches=stretches,
        photometry_url=f"/manifests/{phot_name}",
        collections=used_collections,
        services=services_for(used_sources),
        warnings=warnings,
        data_release_dates=release_dates,
        solid_angle_maps=sapm_names,
        created_at=datetime.now(UTC),
    )
    # Sidecar for the API (spectrum endpoint, cleanup): where cutouts live and their geometry.
    builds_dir = settings.data_dir / "builds"
    sidecar = {
        "sequence_id": seq_id,
        "params": params.to_dict(),
        "cutout_center_deg": [center.ra, center.dec],
        "cutout_size_arcmin": float(csize.value),
        "exposures": [
            {
                "obs_id": r.obs_id,
                "collection": r.collection,
                "detector": r.detector,
                "epoch": ei,
                "cutout_key": cutout_key(r.obs_id, center.ra, center.dec, float(csize.value)),
                "path": str(paths[r.obs_id].relative_to(settings.data_dir)),
                "source": sources.get(r.obs_id, "irsa"),
            }
            for (ei, _), recs in sorted(group_used.items())
            for r in recs
        ],
        "frames": [f.url for ep in manifest_epochs for f in ep.frames]
        + [f.fits_url for ep in manifest_epochs for f in ep.frames if f.fits_url]
        + [f.flags_url for ep in manifest_epochs for f in ep.frames if f.flags_url],
    }
    atomic_write_bytes(builds_dir / f"{seq_id}.json", json.dumps(sidecar).encode())
    for ei, frames in epoch_frames.items():
        await publish(
            "epoch_ready", {"epoch": ei, "frames": [f.model_dump(mode="json") for f in frames]}
        )
    # The manifest is written last: its presence marks the sequence as complete.
    atomic_write_bytes(manifest_path(settings, seq_id), manifest.model_dump_json(indent=1).encode())
    partial_manifest_path(settings, seq_id).unlink(missing_ok=True)
    log.info("build_done", elapsed_s=round(time.perf_counter() - started, 1))
    await publish("progress", {"stage": "photometry", "done": 1, "total": 1})


@dataclass(frozen=True)
class SkyCenter:
    ra: float
    dec: float


# A moving target farther than this fraction of the half field from the center in any epoch is
# reported as near the edge (docs/06 section 3.4): its ring and photometry lose context there.
FAST_MOVER_EDGE_FRACTION = 0.8


def fast_mover_offset(params: SequenceParams, times: list[Time]) -> float | None:
    """Largest offset of the moving target from the grid center over the epochs, as a fraction
    of the half field of view, or None when the target has no known motion."""
    astro, _ = _target_astrometry(params)
    if astro is None or not times:
        return None
    if astro.pmra_cosdec.to_value(u.mas / u.yr) == 0 and astro.pmdec.to_value(u.mas / u.yr) == 0:
        return None
    center = SkyCoord(params.ra_deg * u.deg, params.dec_deg * u.deg, frame="icrs")
    moved = propagate_space_motion(astro, Time(times))
    pos = SkyCoord(moved.ra, moved.dec, frame="icrs")
    dra, ddec = center.spherical_offsets_to(pos)
    worst = np.maximum(np.abs(dra.to_value(u.arcmin)), np.abs(ddec.to_value(u.arcmin)))
    return float(np.max(worst)) / (params.fov_arcmin / 2)


def _science_warnings(
    params: SequenceParams,
    target: Target | None,
    coadds: dict[tuple[int, int], Coadd],
    epoch_times: list[Time] | None = None,
    *,
    epoch_phot: list[dict[str, Any]] | None = None,
    collections: Iterable[str] = (),
) -> list[ManifestWarning]:
    """Warnings of a manifest. `collections` are the collections of the images used: the Quick
    Release notice is given only when one of them is a Quick Release.

    `epoch_phot` (the build photometry at the target position, one
    entry per epoch and detector) is given for the final manifest: saturation is then stated as
    measured. A partial manifest, written before the photometry exists, can only state the risk
    recorded in the target registry."""
    out: list[ManifestWarning] = []
    if uses_quick_release(collections):
        out.append(
            ManifestWarning(
                code="QUICK_RELEASE_CALIBRATION",
                detail="SPHEREx Quick Release calibration is preliminary; absolute fluxes can "
                "carry systematic errors.",
            )
        )
    out.append(
        ManifestWarning(
            code="WAVELENGTH_MIXTURE",
            detail="Each coadd mixes exposures at different wavelengths; epochs of one detector "
            "can differ in wavelength sampling.",
        )
    )
    n_epochs = len({e for (e, _) in coadds})
    if n_epochs < 2:
        out.append(
            ManifestWarning(
                code="SINGLE_EPOCH", detail="Only one epoch is available; no time-lapse possible."
            )
        )
    if target is not None and target.validation.get("unresolved_pair"):
        out.append(
            ManifestWarning(
                code="UNRESOLVED_PAIR",
                detail="The target is an unresolved pair (separation below 1 arcsec; SPHEREx "
                "pixels are about 6.2 arcsec).",
            )
        )
    offset = fast_mover_offset(params, epoch_times or [])
    if offset is not None and offset > FAST_MOVER_EDGE_FRACTION:
        out.append(
            ManifestWarning(
                code="FAST_MOVER_NEAR_EDGE",
                detail="The moving target comes near or past the field edge in at least one "
                "epoch; a larger field of view keeps it inside.",
            )
        )
    if epoch_phot is not None:
        saturated = saturated_core_warning(epoch_phot)
        if saturated is not None:
            out.append(saturated)
    elif target is not None and target.validation.get("saturation_risk"):
        out.append(
            ManifestWarning(
                code="SATURATION_RISK",
                detail="The target is bright and may saturate in some detectors; flagged pixels "
                "are excluded from centroids and photometry.",
            )
        )
    return out


def saturated_core_warning(epoch_phot: list[dict[str, Any]]) -> ManifestWarning | None:
    """SATURATED_CORE when the build photometry found the target core saturated in at least one
    coadd; None otherwise. Counts and detectors are read from the measurements, not assumed."""
    hit = [e for e in epoch_phot if e.get("reason") == "saturated_core"]
    if not hit:
        return None
    dets = sorted({int(e["detector"]) for e in hit})
    names = ", ".join(f"D{d}" for d in dets)
    return ManifestWarning(
        code="SATURATED_CORE",
        detail=(
            f"The target core is saturated in {len(hit)} of {len(epoch_phot)} coadds "
            f"(detectors {names}); saturated pixels are excluded from centroids and photometry."
        ),
    )


async def build_sequence(ctx: dict[str, Any], params: dict[str, Any], force: bool = False) -> str:
    """arq job entry point. `params` is SequenceParams.to_dict(). Enqueue with _job_id=<sequence_id>
    so that identical requests are deduplicated. `force` rebuilds a sequence that already has a
    manifest (used when a release gains data)."""
    settings: Settings = ctx.get("settings") or get_settings()
    sp = SequenceParams.from_dict(params)
    seq_id = params_sequence_id(sp, settings)
    redis = ctx.get("redis")
    channel = f"destello:seq:{seq_id}"

    ready_key = f"destello:seq:{seq_id}:detectors_ready"
    if redis is not None:
        await redis.delete(ready_key)  # replay list of this run only

    async def publish(event: str, data: dict[str, Any]) -> None:
        if redis is None:
            return
        payload = json.dumps({"event": event, "data": data})
        if event == "detector_ready":  # replayed to streams that connect later
            await redis.rpush(ready_key, payload)
            await redis.expire(ready_key, 86400)
        await redis.publish(channel, payload)
        await redis.set(f"destello:seq:{seq_id}:last", payload, ex=86400)
        if event in ("status", "completed", "failed"):
            state = {
                "status": data.get("status")
                if event == "status"
                else ("ready" if event == "completed" else "failed")
            }
            await redis.set(f"destello:seq:{seq_id}:state", json.dumps(state), ex=86400)

    return await run_build(sp, settings, publish, ctx.get("irsa"), force=force, s3=ctx.get("s3"))
