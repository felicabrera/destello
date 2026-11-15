"""Build the WISE/NEOWISE companion sequence of a preset (F-40), on the preset SPHEREx grid.

Usage (from backend/, DESTELLO_DATA_DIR pointing at the data directory):
    uv run python ../scripts/build_wise.py wise0855 --band 2 \
        [--spike-cache DIR --spike-summary FILE]

--spike-cache registers intensity cutouts of an earlier run (spike F-40-0) in the cutout cache,
with the request geometry read from its summary.json; the mask and uncertainty planes are then
fetched with the same geometry. Real data only: every pixel comes from IRSA.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from destello.core.config import get_settings
from destello.models.targets import load_targets
from destello.sources.wise import WiseClient
from destello.worker.wise_build import build_wise_companion, register_spike_cache


async def main(ns: argparse.Namespace) -> int:
    settings = get_settings()
    data = Path(settings.data_dir)
    pins = json.loads((data / "pins.json").read_text("utf-8"))
    sid = pins["presets"][ns.target]["sequence_id"]
    spx = json.loads((settings.manifests_dir / f"{sid}.json").read_text("utf-8"))
    target = load_targets()[ns.target]
    async with WiseClient(settings) as client:
        if ns.spike_cache:
            summ = json.loads(Path(ns.spike_summary).read_text("utf-8"))
            files = sorted(Path(ns.spike_cache).glob("*.fits"))
            n = register_spike_cache(client, files, summ["grid"]["ra"], summ["grid"]["dec"],
                                     summ["cutout_size_arcsec"])  # fmt: skip
            print("registered", n, "cached cutouts", flush=True)
        manifest, stats = await build_wise_companion(settings, client, spx, ns.band, target)
    print(json.dumps(stats, indent=1))
    for e in manifest.epochs:
        f = e.frames[0]
        print(e.index, e.t_start[:10], e.phase, f.n_images, f.flux_scale, f.flux_scale_stars)
    print("manifest", manifest.sequence_id)
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("target")
    ap.add_argument("--band", type=int, default=2, choices=(1, 2))
    ap.add_argument("--spike-cache", default="")
    ap.add_argument("--spike-summary", default="")
    sys.exit(asyncio.run(main(ap.parse_args())))
