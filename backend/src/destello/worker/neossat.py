"""NEOSSat optical view of a moving-target sequence (F-33).

For each SPHEREx exposure of a built sequence, the nearest NEOSSat frame within a stated time window
(24 hours) whose footprint contains the Horizons position at the frame's own mid time is cut around
that position and stored. Result: data/movers/<seq>/neossat.json and the cutouts in frames/.

Run after the mover build: python -m destello.worker.neossat <sequence_id> [--window-hours 24]
A frame is downloaded once even when it is the nearest one for several exposures. NEOSSat is a
different telescope, band and time: the document says so, and carries the credit line.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import warnings as pywarnings
from collections.abc import Sequence
from typing import Any

import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning

from destello.core.cache import atomic_write_bytes
from destello.core.config import Settings, get_settings
from destello.core.logging import get_logger
from destello.models.manifest import Manifest
from destello.pipeline import neossat as ns
from destello.pipeline.render import to_webp
from destello.sources.base import SourceError
from destello.sources.cadc import (
    NEOSSAT_CREDIT,
    SERVICE_CADC_FILES,
    SERVICE_CADC_TAP,
    CadcClient,
    NeossatPlane,
)
from destello.sources.horizons import HorizonsClient

NEOSSAT_DOC_VERSION = 1
TRACK_STEP_HOURS = 1.0
# Header positions of NEOSSat frames were found about 30 arcsec off the ephemeris on a spike
# frame (no plate solution is attempted): a statement for the interface, not a measurement.
HEADER_POSITION_NOTE_ARCSEC = 30.0


def cutout_name(observation_id: str) -> str:
    h = hashlib.sha256(f"neossat|{observation_id}|{ns.CUTOUT_PIXELS}".encode()).hexdigest()[:16]
    return f"{h}.webp"


def _read_frame(blob: bytes) -> tuple[Any, WCS, tuple[int, int]]:
    with fits.open(io.BytesIO(blob)) as hdul:
        hdu = next(h for h in hdul if h.data is not None and h.data.ndim == 2)
        data = np.asarray(hdu.data, dtype=np.float64)
        with pywarnings.catch_warnings():
            pywarnings.simplefilter("ignore", FITSFixedWarning)
            wcs = WCS(hdu.header).celestial
    return data, wcs, (data.shape[1], data.shape[0])


async def build_neossat(
    seq_id: str,
    settings: Settings | None = None,
    *,
    window_hours: float = ns.NEOSSAT_WINDOW_HOURS,
    cadc: CadcClient | None = None,
    horizons: HorizonsClient | None = None,
) -> dict[str, Any]:
    settings = settings or get_settings()
    log = get_logger(sequence_id=seq_id)
    manifest = Manifest.model_validate_json(
        (settings.manifests_dir / f"{seq_id}.json").read_text(encoding="utf-8")
    )
    mt = manifest.moving_target
    if mt is None:
        raise SourceError("The sequence is not a moving-target sequence")
    # One SPHEREx time per exposure (observation id), in manifest order.
    exposures: dict[str, float] = {}
    for e in manifest.epochs:
        for f in e.frames:
            if f.kind == "exposure" and f.obs_ids and f.t_mid_mjd is not None:
                exposures[f.obs_ids[0]] = float(f.t_mid_mjd)
    if not exposures:
        raise SourceError("The sequence has no single exposures")
    t_lo = min(exposures.values()) - window_hours / 24.0
    t_hi = max(exposures.values()) + window_hours / 24.0
    own_cadc, own_hz = cadc is None, horizons is None
    cadc = cadc or CadcClient(settings)
    horizons = horizons or HorizonsClient(settings)
    try:
        eph = await horizons.ephemeris_range(
            mt.horizons_record,
            Time(t_lo - 0.1, format="mjd", scale="utc"),
            Time(t_hi + 0.1, format="mjd", scale="utc"),
            TRACK_STEP_HOURS,
        )
        track_t = np.array([r.time.mjd for r in eph.rows])
        track_ra = np.array([r.ra_deg for r in eph.rows])
        track_dec = np.array([r.dec_deg for r in eph.rows])
        planes = await cadc.cor_planes(
            Time(t_lo, format="mjd", scale="utc"), Time(t_hi, format="mjd", scale="utc")
        )
        cands = []
        by_key: dict[str, NeossatPlane] = {}
        for p in planes:
            ra, dec = ns.interp_track(p.t_mid_mjd, track_t, track_ra, track_dec)
            cands.append(ns.Candidate(p.observation_id, p.t_mid_mjd, p.polygon_deg, ra, dec))
            by_key[p.observation_id] = p
        cand_by_key = {c.key: c for c in cands}
        chosen: dict[str, str | None] = {
            obs: (m.key if (m := ns.nearest_in_window(t, cands, window_hours)) else None)
            for obs, t in exposures.items()
        }
        frames: dict[str, dict[str, Any]] = {}
        for key in sorted({k for k in chosen.values() if k}):
            p, c = by_key[key], cand_by_key[key]
            try:
                blob = await cadc.fetch_file(p)
                data, wcs, naxis = _read_frame(blob)
                cut = ns.make_cutout(data, wcs, c.ra_deg, c.dec_deg)
                img, _ = ns.render_cutout(cut)
            except (SourceError, ValueError, StopIteration, OSError) as exc:
                log.warning("neossat_frame_failed", observation_id=key, error=str(exc))
                continue
            atomic_write_bytes(settings.frames_dir / cutout_name(key), to_webp(img))
            fw, fh = ns.frame_fov_arcmin(wcs, naxis)
            size = ns.CUTOUT_PIXELS * ns.CUTOUT_SCALE_ARCSEC / 60.0
            frames[key] = {
                "observation_id": key,
                "t_mid_mjd": round(p.t_mid_mjd, 6),
                "exposure_s": p.exposure_s,
                "fov_arcmin": [round(size, 2), round(size, 2)],
                "frame_fov_arcmin": [round(fw, 1), round(fh, 1)],
                "cutout_url": f"/frames/{cutout_name(key)}",
                "access_url": p.access_url,
                "target_name": p.target_name,
            }
        items = []
        for oid, t in exposures.items():
            fk = chosen[oid]
            fr = frames.get(fk) if fk else None
            items.append(
                {
                    "obs_id": oid,
                    "t_mid_mjd": round(t, 6),
                    "neossat": (
                        {**fr, "dt_hours": round((fr["t_mid_mjd"] - t) * 24.0, 3)} if fr else None
                    ),
                }
            )
        doc = {
            "version": NEOSSAT_DOC_VERSION,
            "sequence_id": seq_id,
            "window_hours": window_hours,
            "credit": NEOSSAT_CREDIT,
            "position_accuracy_arcsec": HEADER_POSITION_NOTE_ARCSEC,
            "services": [SERVICE_CADC_TAP, SERVICE_CADC_FILES],
            "n_planes_in_window": len(planes),
            "items": items,
        }
        out = settings.data_dir / "movers" / seq_id / "neossat.json"
        atomic_write_bytes(out, json.dumps(doc, indent=1).encode("utf-8"))
        log.info(
            "neossat_done",
            exposures=len(items),
            matched=sum(1 for i in items if i["neossat"]),
            frames=len(frames),
        )
        return doc
    finally:
        if own_cadc:
            await cadc.aclose()
        if own_hz:
            await horizons.aclose()


def _main(argv: Sequence[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("sequence_id")
    ap.add_argument("--window-hours", type=float, default=ns.NEOSSAT_WINDOW_HOURS)
    a = ap.parse_args(argv)
    doc = asyncio.run(build_neossat(a.sequence_id, window_hours=a.window_hours))
    matched = sum(1 for i in doc["items"] if i["neossat"])
    total = len(doc["items"])
    print(f"{matched} of {total} exposures have a NEOSSat frame within {a.window_hours} h")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
