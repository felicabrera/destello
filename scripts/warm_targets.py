"""Build and pin the five preset sequences (offline-first: hybrid data mode by default).

Usage (from backend/): uv run python ../scripts/warm_targets.py [--targets barnard,rdra]
                       [--force] [--report-only]

Writes DATA_DIR/pins.json (preset id -> sequence_id and request parameters) and
DATA_DIR/cache-report.md (epochs per detector per target, built from the manifests).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from destello.core.config import Settings, get_settings
from destello.models.targets import load_targets
from destello.sources.irsa import IrsaClient
from destello.sources.s3 import S3CutoutSource
from destello.worker.cron import write_pins
from destello.worker.jobs import params_sequence_id, preset_params, run_build


async def _publish(event: str, data: dict[str, Any]) -> None:
    if event == "progress":
        if data["done"] in (0, data["total"]) or data["done"] % 20 == 0:
            print(f"  [{data['stage']}] {data['done']}/{data['total']}", flush=True)
    else:
        print(f"  <{event}> {json.dumps(data)[:200]}", flush=True)


def write_report(settings: Settings, built: dict[str, str]) -> Path:
    lines = [
        "# Cache report",
        "",
        f"Generated {datetime.now(UTC).strftime('%Y-%m-%d %H:%M UTC')} by scripts/warm_targets.py. "
        "Counts are real values read from the manifests (images actually used in coadds).",
        "",
    ]
    for tid, seq in built.items():
        mpath = settings.manifests_dir / f"{seq}.json"
        lines.append(f"## {tid} ({seq})")
        lines.append("")
        if not mpath.exists():
            lines += ["No manifest (build failed or not run).", ""]
            continue
        m = json.loads(mpath.read_text(encoding="utf-8"))
        lines.append(
            f"Epochs: {len(m['epochs'])}. Collections: {', '.join(m['provenance']['collections'])}. "
            f"Grid: {m['grid']['naxis'][0]} x {m['grid']['naxis'][1]} px at "
            f"{m['grid']['pixel_scale_arcsec']} arcsec/px."
        )
        lines.append("")
        dets = sorted({f["detector"] for e in m["epochs"] for f in e["frames"] if f["kind"] == "coadd"})
        lines.append("| Epoch | Start (UTC) | End (UTC) | Images | " + " | ".join(f"D{d}" for d in dets) + " |")
        lines.append("|---|---|---|---|" + "---|" * len(dets))
        for e in m["epochs"]:
            per = {f["detector"]: f["n_images"] for f in e["frames"] if f["kind"] == "coadd"}
            lines.append(
                f"| {e['index'] + 1} | {e['t_start']} | {e['t_end']} | {e['n_images']} | "
                + " | ".join(str(per.get(d, 0)) for d in dets)
                + " |"
            )
        lines.append("")
        for w in m["warnings"]:
            lines.append(f"- Warning {w['code']}: {w['detail']}")
        lines.append("")
    out = settings.data_dir / "cache-report.md"
    out.write_text("\n".join(lines), encoding="utf-8")
    return out


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--targets", default="", help="comma separated preset ids (default: all)")
    ap.add_argument("--force", action="store_true", help="rebuild even if the manifest exists")
    ap.add_argument("--report-only", action="store_true")
    args = ap.parse_args(argv)
    settings = get_settings()
    wanted = [t for t in args.targets.split(",") if t] or list(load_targets())
    built: dict[str, str] = {}
    for tid in wanted:
        target = load_targets()[tid]
        params = preset_params(target)
        seq = params_sequence_id(params, settings)
        built[tid] = seq
        if args.report_only:
            continue
        print(f"== {tid}: sequence {seq} center=({params.ra_deg}, {params.dec_deg}) "
              f"fov={params.fov_arcmin}", flush=True)
        async with IrsaClient(settings) as irsa:
            s3 = S3CutoutSource(settings, irsa=irsa) if settings.cutout_source == "s3" else None
            try:
                await run_build(params, settings, _publish, irsa, force=args.force, s3=s3)
            except Exception as exc:  # report and continue with the next target
                print(f"  FAILED {tid}: {type(exc).__name__}: {exc}", flush=True)
                built.pop(tid)
            finally:
                if s3 is not None:
                    await s3.aclose()
    pins_path = settings.data_dir / "pins.json"
    existing: dict[str, Any] = {}
    if pins_path.exists():
        existing = json.loads(pins_path.read_text(encoding="utf-8")).get("presets", {})
    merged = {t: v["sequence_id"] for t, v in existing.items()}
    merged.update(built)
    write_pins(settings, merged)
    report = write_report(settings, {t: s for t, s in merged.items()})
    print(f"Pins written to {pins_path}; report at {report}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
