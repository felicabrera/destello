"""Build the Hunt field bank (F-35) one field at a time through the normal sequence build path.

Usage (from backend/): uv run python ../scripts/build_hunt_bank.py [--fields gold-01,ecl-03]
                       [--retry-failed] [--force] [--status-only]
       uv run python ../scripts/build_hunt_bank.py --emit-generated   (prints the generated fields)

Resumable: a field whose status is `ready` and whose manifest still exists is skipped. The status
file <data_dir>/hunt/bank_status.json holds, per field id: sequence_id, epochs, status
(pending, ready, failed), ra_deg, dec_deg (centre of the request), updated and error. It is rewritten after every field.

The ecliptic and random field lists of data/hunt_fields.yaml are produced by `ecliptic_fields()`
and `random_fields(SEED)` below; a unit test checks the file against them.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.coordinates import BarycentricMeanEcliptic, Galactic, SkyCoord
from astropy.time import Time

from destello.core.config import Settings, get_settings
from destello.models.hunt_bank import HuntBank, HuntField, load_bank, status_path
from destello.pipeline.propagate import Astrometry, apparent_positions
from destello.worker.jobs import PRESET_CENTER_DATE, SequenceParams

SEED = 35
N_EACH = 10
ECLIPTIC_LATS = (-4.0, 3.0, -2.0, 4.0, -3.0, 2.0, -1.0, 1.0, 0.0, -0.5)  # all within +/-5 deg
ECLIPTIC_MIN_GAL_LAT = 20.0  # keep away from the galactic plane
RANDOM_GAL_LAT_RANGE = (30.0, 60.0)


def gal_lat(ra_deg: float, dec_deg: float) -> float:
    c = SkyCoord(ra=ra_deg * u.deg, dec=dec_deg * u.deg, frame="icrs")
    return float(c.transform_to(Galactic()).b.deg)


def ecliptic_fields(n: int = N_EACH) -> list[dict[str, Any]]:
    """`n` fields with |ecliptic latitude| < 5 deg, spread evenly in longitude over the longitudes
    that keep |galactic latitude| >= 20 deg at ecliptic latitude 0 (1 deg grid, even index steps)."""
    lons = np.arange(0.0, 360.0, 1.0)
    ecl0 = SkyCoord(lon=lons * u.deg, lat=0 * u.deg, frame=BarycentricMeanEcliptic)
    b = np.abs(ecl0.transform_to(Galactic()).b.deg)
    allowed = lons[b >= ECLIPTIC_MIN_GAL_LAT + 5.0]  # margin for the latitude offsets
    picks = allowed[np.linspace(0, len(allowed) - 1, n, endpoint=False).astype(int)]
    out: list[dict[str, Any]] = []
    for i, lon in enumerate(picks):
        lat = ECLIPTIC_LATS[i % len(ECLIPTIC_LATS)]
        c = SkyCoord(lon=float(lon) * u.deg, lat=lat * u.deg, frame=BarycentricMeanEcliptic)
        icrs = c.transform_to("icrs")
        out.append(
            {
                "id": f"ecl-{i + 1:02d}",
                "ecl_lon_deg": float(lon),
                "ecl_lat_deg": lat,
                "ra_deg": round(float(icrs.ra.deg), 4),
                "dec_deg": round(float(icrs.dec.deg), 4),
                "gal_lat_deg": round(float(c.transform_to(Galactic()).b.deg), 1),
            }
        )
    return out


def random_fields(seed: int = SEED, n: int = N_EACH) -> list[dict[str, Any]]:
    """`n` fields drawn uniformly on the sphere (z uniform in [-1, 1], RA uniform) with the
    first `n` draws that satisfy 30 <= |galactic latitude| <= 60 deg. numpy default_rng(seed)."""
    rng = np.random.default_rng(seed)
    out: list[dict[str, Any]] = []
    while len(out) < n:
        ra = float(rng.uniform(0.0, 360.0))
        dec = float(np.degrees(np.arcsin(rng.uniform(-1.0, 1.0))))
        b = gal_lat(ra, dec)
        if RANDOM_GAL_LAT_RANGE[0] <= abs(b) <= RANDOM_GAL_LAT_RANGE[1]:
            out.append(
                {
                    "id": f"rnd-{len(out) + 1:02d}",
                    "ra_deg": round(ra, 4),
                    "dec_deg": round(dec, 4),
                    "gal_lat_deg": round(b, 1),
                }
            )
    return out


def field_center(field: HuntField, when: str = PRESET_CENTER_DATE) -> tuple[float, float]:
    """Centre of the request in degrees. Gold stars are centred where the catalog propagation puts
    them at `when` (same rule as the presets); other fields use their fixed centre."""
    if field.kind == "gold":
        a = field.astrometry
        assert a is not None
        ref = Time(float(a.ref_epoch.lstrip("J")), format="jyear", scale="tdb")
        pos = apparent_positions(
            Astrometry(
                ra=a.ra_deg * u.deg,
                dec=a.dec_deg * u.deg,
                pmra_cosdec=a.pmra_masyr * u.mas / u.yr,
                pmdec=a.pmdec_masyr * u.mas / u.yr,
                parallax=a.parallax_mas * u.mas,
                ref_epoch=ref,
            ),
            Time(when, scale="utc"),
        )
        return round(float(pos.ra.deg), 5), round(float(pos.dec.deg), 5)
    assert field.ra_deg is not None and field.dec_deg is not None
    return round(field.ra_deg, 5), round(field.dec_deg, 5)


def field_params(bank: HuntBank, field: HuntField) -> SequenceParams:
    ra, dec = field_center(field)
    return SequenceParams(
        ra_deg=ra,
        dec_deg=dec,
        fov_arcmin=float(bank.fov_arcmin),
        detectors=tuple(bank.detectors),
        release="all",
        target_id=None,
    )


def empty_entry() -> dict[str, Any]:
    return {"sequence_id": None, "epochs": 0, "status": "pending", "updated": None, "error": None}


def load_status(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return dict(data.get("fields", {}))


def save_status(path: Path, bank: HuntBank, fields: dict[str, dict[str, Any]]) -> None:
    """Atomic write, so an interrupted run never leaves a truncated file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    doc = {"bank_version": bank.version, "fields": fields}
    tmp = path.with_suffix(".part")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def select_fields(
    bank: HuntBank,
    status: dict[str, dict[str, Any]],
    *,
    only: set[str] | None,
    retry_failed: bool,
    force: bool,
    manifest_exists: Any,
) -> list[HuntField]:
    """Fields to build, in bank order. `ready` fields with a manifest are skipped unless `force`;
    `failed` ones are retried only with `retry_failed` (or when named explicitly)."""
    todo: list[HuntField] = []
    for f in bank.fields:
        if only is not None and f.id not in only:
            continue
        entry = status.get(f.id) or empty_entry()
        st = entry.get("status")
        if st == "ready" and not force:
            sid = entry.get("sequence_id")
            if sid and manifest_exists(sid):
                continue
        if st == "failed" and not (retry_failed or force or only is not None):
            continue
        todo.append(f)
    return todo


def epochs_in_manifest(settings: Settings, seq_id: str) -> int:
    p = settings.manifests_dir / f"{seq_id}.json"
    if not p.exists():
        return 0
    return len(json.loads(p.read_text(encoding="utf-8")).get("epochs", []))


async def _publish(event: str, data: dict[str, Any]) -> None:
    if event == "progress" and data["done"] in (0, data["total"]):
        print(f"  [{data['stage']}] {data['done']}/{data['total']}", flush=True)


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fields", default="", help="comma separated field ids (default: all)")
    ap.add_argument("--retry-failed", action="store_true")
    ap.add_argument("--force", action="store_true", help="rebuild even when ready")
    ap.add_argument("--status-only", action="store_true", help="print the status and exit")
    ap.add_argument("--emit-generated", action="store_true")
    args = ap.parse_args(argv)
    if args.emit_generated:
        print(json.dumps({"ecliptic": ecliptic_fields(), "random": random_fields()}, indent=1))
        return 0

    from destello.sources.irsa import IrsaClient
    from destello.sources.s3 import S3CutoutSource
    from destello.worker.jobs import params_sequence_id, run_build

    settings = get_settings()
    bank = load_bank()
    spath = status_path(settings)
    status = load_status(spath)
    for f in bank.fields:
        status.setdefault(f.id, empty_entry())
    only = {x for x in args.fields.split(",") if x} or None
    if args.status_only:
        for f in bank.fields:
            e = status[f.id]
            print(f"{f.id}\t{e['status']}\t{e['sequence_id']}\t{e['epochs']}")
        return 0
    todo = select_fields(
        bank,
        status,
        only=only,
        retry_failed=args.retry_failed,
        force=args.force,
        manifest_exists=lambda sid: (settings.manifests_dir / f"{sid}.json").exists(),
    )
    print(f"{len(todo)} field(s) to build", flush=True)
    for f in todo:
        params = field_params(bank, f)
        seq = params_sequence_id(params, settings)
        print(f"== {f.id}: sequence {seq} centre=({params.ra_deg}, {params.dec_deg})", flush=True)
        entry = status[f.id]
        entry["sequence_id"] = seq
        entry["ra_deg"], entry["dec_deg"] = params.ra_deg, params.dec_deg
        async with IrsaClient(settings) as irsa:
            s3 = S3CutoutSource(settings, irsa=irsa) if settings.cutout_source == "s3" else None
            try:
                await run_build(params, settings, _publish, irsa, force=args.force, s3=s3)
                entry.update(
                    status="ready", epochs=epochs_in_manifest(settings, seq), error=None
                )
            except Exception as exc:  # record and continue with the next field
                entry.update(status="failed", error=f"{type(exc).__name__}: {exc}"[:300])
                print(f"  FAILED {f.id}: {entry['error']}", flush=True)
            finally:
                if s3 is not None:
                    await s3.aclose()
        entry["updated"] = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        save_status(spath, bank, status)
    save_status(spath, bank, status)
    print(f"Status written to {spath}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
