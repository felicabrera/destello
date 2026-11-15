"""Build a WISE/NEOWISE companion sequence on the grid of a SPHEREx sequence (F-40).

Steps (docs/11 V-15 states the rules; constants in pipeline/wise.py):
1. Read the grid of the SPHEREx manifest (shared TAN grid, north up, east left).
2. List the L1b frames that cover the grid center (sources/wise.py: IRSA TAP, else the NEOWISE-R
   Parquet source table; the source used goes to the manifest).
3. Fetch the intensity, mask and uncertainty planes of each frame (IBE cutouts, cached).
4. Per frame: zero point 22.5, documented mask bits, sky subtraction, reprojection to the grid.
   A frame whose valid pixels cover less than half of the grid is not used.
5. Group by observation time (pipeline.epochs.group_epochs, 20 day gap); a visit with fewer than
   EPOCH_MIN_FRAMES frames is skipped with a warning.
6. Clipped inverse-variance coadd per visit (pipeline.wise.clipped_coadd).
7. Field-star flux scale of each visit against the visit with the most frames
   (pipeline.difference.difference_scale, target excluded), then one asinh stretch over all
   scaled visits of the band. The FITS coadds stay unscaled; the scale is in the manifest.
8. WebP, mask PNG and FITS per visit; the manifest (models/wise_manifest.py) and a sidecar with
   the local cutout paths of every input frame (used by the long-baseline astrometry).
"""

from __future__ import annotations

import hashlib
import json
import time
import warnings
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import numpy as np
import numpy.typing as npt
from astropy.io import fits
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS
from reproject import reproject_interp

from destello.core.cache import atomic_write_bytes
from destello.core.config import Settings
from destello.models.manifest import ManifestGrid, ManifestStretch, ManifestWarning
from destello.models.targets import Target
from destello.models.wise_manifest import (
    WiseCoaddFrame,
    WiseEpoch,
    WiseInputFrame,
    WiseManifest,
    WiseProvenance,
)
from destello.pipeline.difference import difference_scale
from destello.pipeline.epochs import group_epochs
from destello.pipeline.manifest import iso_utc
from destello.pipeline.propagate import apparent_positions
from destello.pipeline.render import (
    apply_stretch,
    coadd_fits_bytes,
    compute_stretch,
    mask_png,
    to_webp,
)
from destello.pipeline.reproject import GridSpec, reproject_mask
from destello.pipeline.wise import (
    EPOCH_MIN_FRAMES,
    FRAME_TABLES,
    RSR_SOURCE,
    WISE_COADD_METHOD_VERSION,
    calibrate_frame,
    clipped_coadd,
    official_band_window,
)
from destello.sources.wise import FrameSet, WiseClient

FloatArray = npt.NDArray[np.floating]
MIN_GRID_COVERAGE = 0.5
NEW_CUTOUT_MARGIN_ARCSEC = 60.0
SERVICES = ["IRSA IBE (WISE L1b cutouts)"]
MASK_TABLE_NAMES = {
    "allsky": "WISE All-Sky Explanatory Supplement IV.4.a table 2",
    "neowise": "NEOWISE Explanatory Supplement IV.2.a table 7",
}
UNIT = "DN at MAGZP 22.5 (Vega)"


def grid_from_manifest(manifest: dict[str, Any]) -> GridSpec:
    g = manifest["grid"]
    nx, ny = (int(v) for v in g["naxis"])
    ra, dec = (float(v) for v in g["crval_deg"])
    return GridSpec(ra, dec, float(g["pixel_scale_arcsec"]), ny, nx)


def wise_sequence_id(spherex_sid: str, band: str, settings: Settings) -> str:
    key = json.dumps(
        ["wise", spherex_sid, band, WISE_COADD_METHOD_VERSION, settings.pipeline_version]
    )
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def wise_manifest_path(settings: Settings, wise_sid: str) -> Path:
    return settings.manifests_dir / f"{wise_sid}.json"


def wise_sidecar_path(settings: Settings, wise_sid: str) -> Path:
    return settings.data_dir / "builds" / f"{wise_sid}.json"


@dataclass
class _Processed:
    fs: FrameSet
    science: FloatArray
    variance: FloatArray
    saturated: FloatArray
    coverage: float


def process_frame(fs: FrameSet, grid: GridSpec) -> _Processed | None:
    """Calibrate one frame set and reproject it to the grid (None when unusable)."""
    table = FRAME_TABLES[fs.frame.table].mask_table
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        with fits.open(fs.paths["int"]) as h:
            img = np.asarray(h[0].data, dtype=np.float64)
            hdr = h[0].header
            wcs = WCS(hdr)
        unc = np.asarray(fits.getdata(fs.paths["unc"]), dtype=np.float64)
        msk = np.asarray(fits.getdata(fs.paths["msk"]))
        try:
            cal = calibrate_frame(img, unc, msk, float(hdr["MAGZP"]), table)
        except (ValueError, KeyError):
            return None
        planes = np.stack([cal.science, cal.variance])
        out, _ = reproject_interp((planes, wcs), grid.wcs(), shape_out=(2, *grid.shape),
                                  order="bilinear")  # fmt: skip
        sat = reproject_mask(cal.saturated, wcs, grid)
    sci = np.asarray(out[0], dtype=np.float32)
    var = np.asarray(out[1], dtype=np.float32)
    bad = ~np.isfinite(sci) | ~np.isfinite(var) | (var <= 0)
    sci[bad] = np.nan
    var[bad] = np.nan
    cov = float(1.0 - bad.mean())
    return _Processed(fs, sci, var, sat, cov)


def _target_xy(target: Target | None, grid: GridSpec, t: Time) -> list[tuple[float, float]]:
    if target is None:
        return []
    pos = apparent_positions(target.to_astrometry(), t)
    x, y = grid.wcs().all_world2pix(float(pos.ra.deg), float(pos.dec.deg), 0)
    return [(float(x), float(y))]


async def build_wise_companion(
    settings: Settings,
    client: WiseClient,
    spherex_manifest: dict[str, Any],
    band: int,
    target: Target | None,
    *,
    threads: int = 4,
) -> tuple[WiseManifest, dict[str, Any]]:
    """Build, write and return the companion manifest and the build statistics."""
    t_all = time.perf_counter()
    band_name = f"W{band}"
    spx_sid = str(spherex_manifest["sequence_id"])
    sid = wise_sequence_id(spx_sid, band_name, settings)
    grid = grid_from_manifest(spherex_manifest)
    side = grid.nx * grid.pixel_scale_arcsec
    stats: dict[str, Any] = {"sequence_id": sid}
    t0 = time.perf_counter()
    flist = await client.discover(grid.ra_deg, grid.dec_deg, band)
    stats["discovery_s"] = round(time.perf_counter() - t0, 1)
    stats["frames_listed"] = len(flist.frames)
    t0 = time.perf_counter()
    sets = await client.fetch_frame_sets(
        flist.frames, grid.ra_deg, grid.dec_deg,
        size_arcsec=side * float(np.sqrt(2.0)) + NEW_CUTOUT_MARGIN_ARCSEC,
        reuse_radius_arcsec=side / 2.0,
    )  # fmt: skip
    stats["download_s"] = round(time.perf_counter() - t0, 1)
    stats["download_mb"] = round(client.bytes_downloaded / 1e6, 1)
    stats["cutouts"] = dict(client.counts)
    t0 = time.perf_counter()
    got = [s for s in sets if s is not None]
    with ThreadPoolExecutor(threads) as ex:
        processed = list(ex.map(lambda s: process_frame(s, grid), got))
    usable = [p for p in processed if p is not None and p.coverage >= MIN_GRID_COVERAGE]
    stats["frames_fetched"] = len(got)
    stats["frames_used"] = len(usable)
    warn: list[ManifestWarning] = []
    if flist.source == "neowiser_parquet":
        warn.append(ManifestWarning(code="WISE_FRAME_LIST_PARQUET", detail=(
            "IRSA TAP did not answer: the frame list comes from the NEOWISE-R single-exposure "
            "source table (Parquet), which covers 2013 December to 2024 only, so the 2010 to "
            "2011 WISE epochs are missing and no frame quality value is available.")))  # fmt: skip
    if any(p.fs.frame.table == "allsky_2band_p1bm_frm" for p in usable):
        warn.append(ManifestWarning(code="WISE_POSTCRYO_MASK_TABLE", detail=(
            "Post-cryogenic (2-band) frames are masked with the bit definitions of the All-Sky "
            "Explanatory Supplement table; the post-cryo supplement was not checked bit by "
            "bit.")))  # fmt: skip
    if not usable:
        raise RuntimeError("No usable WISE frame covers the grid")
    times = Time(np.array([p.fs.frame.mjd_obs for p in usable]), format="mjd", scale="utc")
    groups = [g for g in group_epochs(times)]
    window = official_band_window(band_name)
    built: list[tuple[Any, list[_Processed], Any, int]] = []
    for g in groups:
        members = [usable[i] for i in g.members]
        if len(members) < EPOCH_MIN_FRAMES:
            warn.append(ManifestWarning(code="WISE_EPOCH_SKIPPED", detail=(
                f"A visit at MJD {g.t_mid.mjd:.1f} has {len(members)} usable frames, fewer than "
                f"{EPOCH_MIN_FRAMES}; it is not coadded.")))  # fmt: skip
            continue
        co, rejected = clipped_coadd([m.science for m in members], [m.variance for m in members])
        built.append((g, members, co, rejected))
    if not built:
        raise RuntimeError("No WISE visit has enough frames")
    ref = int(np.argmax([len(b[1]) for b in built]))
    scales: list[tuple[float, int]] = []
    for g, _m, co, _r in built:
        if co is built[ref][2]:
            scales.append((1.0, 0))
            continue
        excl = _target_xy(target, grid, g.t_mid) + _target_xy(target, grid, built[ref][0].t_mid)
        s, n = difference_scale(built[ref][2].mean, co.mean, exclude_xy=excl)
        scales.append((float(s), int(n)))
    st = compute_stretch([co.mean * s for (_g, _m, co, _r), (s, _n) in zip(built, scales,
                                                                           strict=True)],
                         unit=UNIT + ", scaled to the reference epoch")  # fmt: skip
    wcs = grid.wcs()
    frames_dir = settings.frames_dir
    epochs: list[WiseEpoch] = []
    sidecar: list[dict[str, Any]] = []
    for ei, ((_g, members, co, rejected), (s, n)) in enumerate(zip(built, scales, strict=True)):
        tabs = sorted({m.fs.frame.table for m in members})
        phases = sorted({FRAME_TABLES[t].phase for t in tabs})
        phase = "WISE" if phases == ["WISE"] else "NEOWISE"
        rels = sorted({FRAME_TABLES[t].data_release for t in tabs})
        dois = sorted({d for t in tabs if (d := FRAME_TABLES[t].doi)})
        sat = np.max(np.stack([m.saturated for m in members]), axis=0) > 0.5
        stem = hashlib.sha256(f"{sid}:{ei}:{band_name}:{st.vmin}:{st.vmax}".encode()).hexdigest()[
            :16
        ]
        mstem = hashlib.sha256(f"{sid}:{ei}:{band_name}:mask".encode()).hexdigest()[:16]
        mjds = np.array([m.fs.frame.mjd_obs for m in members])
        t_start = Time(float(mjds.min()), format="mjd", scale="utc")
        t_end = Time(float(mjds.max()), format="mjd", scale="utc")
        webp = to_webp(apply_stretch(co.mean * s, st, sat & co.blank))
        fb = coadd_fits_bytes(co.mean, wcs, {
            "DSTLVER": settings.pipeline_version, "DSTLWCOA": WISE_COADD_METHOD_VERSION,
            "DSTLSEQ": sid, "DSTLSPX": spx_sid, "DSTLEPOC": ei + 1, "TELESCOP": "WISE",
            "BAND": band_name, "PHASE": phase, "NIMAGES": len(members),
            "FLUXSCAL": s, "DATE-OBS": iso_utc(t_start), "DATE-END": iso_utc(t_end),
            "MJD-AVG": float(mjds.mean()),
        }, UNIT, co.variance)  # fmt: skip
        atomic_write_bytes(frames_dir / f"{stem}.webp", webp)
        atomic_write_bytes(frames_dir / f"{stem}.fits", fb)
        atomic_write_bytes(frames_dir / f"{mstem}.png", mask_png(co.blank))
        inputs = []
        for m in sorted(members, key=lambda m: m.fs.frame.mjd_obs):
            fr = m.fs.frame
            ft = FRAME_TABLES[fr.table]
            inputs.append(WiseInputFrame(
                frame_id=fr.frame_id, scan_id=fr.scan_id, frame_num=fr.frame_num,
                mjd_obs=fr.mjd_obs, t_obs=iso_utc(Time(fr.mjd_obs, format="mjd", scale="utc")),
                table=fr.table, phase=ft.phase, data_release=ft.data_release,
                cutout_url=m.fs.urls["int"], qual_frame=fr.qual_frame,
            ))  # fmt: skip
            sidecar.append({
                "epoch": ei, "frame_id": fr.frame_id, "mjd_obs": fr.mjd_obs, "table": fr.table,
                "mask_table": ft.mask_table,
                "paths": {k: str(v.relative_to(settings.data_dir)) for k, v in m.fs.paths.items()},
            })  # fmt: skip
        frame = WiseCoaddFrame(
            phase=phase, band=band_name, url=f"/frames/{stem}.webp",
            fits_url=f"/frames/{stem}.fits", flags_url=f"/frames/{mstem}.png",
            wavelength_um=(round(window.lo_um, 4), round(window.hi_um, 4)),
            n_images=len(members), flagged_fraction=round(co.blank_fraction, 5),
            flux_scale=round(s, 5), flux_scale_stars=n, t_start=iso_utc(t_start),
            t_end=iso_utc(t_end), t_mid_mjd=round(float(mjds.mean()), 6), data_releases=rels,
            dois=dois, inputs=inputs,
        )  # fmt: skip
        epochs.append(WiseEpoch(
            index=ei, t_start=frame.t_start, t_end=frame.t_end, t_mid_mjd=frame.t_mid_mjd,
            phase=phase, n_images=len(members), frames=[frame],
        ))  # fmt: skip
        stats.setdefault("clipped_samples", []).append(rejected)
    all_tabs = sorted({p.fs.frame.table for p in usable})
    manifest = WiseManifest(
        sequence_id=sid, spherex_sequence_id=spx_sid, pipeline_version=settings.pipeline_version,
        coadd_method_version=WISE_COADD_METHOD_VERSION,
        created_at=datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        band=band_name,
        target_id=target.id if target is not None else None,
        grid=ManifestGrid(**spherex_manifest["grid"]), reference_epoch=ref, epochs=epochs,
        stretch={f"WISE:{band_name}": ManifestStretch(
            vmin=st.vmin, vmax=st.vmax, softening=st.softening, unit=st.unit)},
        provenance=WiseProvenance(
            frame_list_source=flist.source, frame_list_detail=flist.detail,
            services=SERVICES + ([
                "IRSA TAP" if flist.source == "irsa_tap"
                else "AWS Open Data NEOWISE-R source table (s3://nasa-irsa-wise)"]),
            data_releases=sorted({FRAME_TABLES[t].data_release for t in all_tabs}),
            dois=sorted({d for t in all_tabs if (d := FRAME_TABLES[t].doi)}),
            mask_tables=sorted({MASK_TABLE_NAMES[FRAME_TABLES[t].mask_table] for t in all_tabs}),
            response_curves=RSR_SOURCE.format(n=band),
        ),
        warnings=warn,
    )  # fmt: skip
    atomic_write_bytes(wise_manifest_path(settings, sid),
                       manifest.model_dump_json(indent=1).encode("utf-8"))  # fmt: skip
    side_doc = {"sequence_id": sid, "spherex_sequence_id": spx_sid, "band": band_name,
                "frames": sidecar}  # fmt: skip
    atomic_write_bytes(wise_sidecar_path(settings, sid), json.dumps(side_doc).encode("utf-8"))
    stats["process_s"] = round(time.perf_counter() - t0, 1)
    stats["total_s"] = round(time.perf_counter() - t_all, 1)
    stats["epochs"] = len(epochs)
    return manifest, stats


def register_spike_cache(
    client: WiseClient, files: Sequence[Path], ra_deg: float, dec_deg: float, size_arcsec: float
) -> int:
    """Register intensity cutouts of an earlier run (same request geometry) in the cache."""
    from destello.sources.wise import CutoutGeometry

    geom = CutoutGeometry(round(ra_deg, 6), round(dec_deg, 6), float(round(size_arcsec)))
    n = 0
    for f in files:
        try:
            client.register_local_cutout(f, geom, "neowiser_p1bm_frm")
            n += 1
        except Exception:  # an unreadable file is simply not reused
            continue
    return n
