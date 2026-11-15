"""Store the V-15 long-baseline fit next to a WISE companion (route /wise/astrometry).

Reads the `results.long_baseline.<target>` block of a validation JSON written by
`scripts/run_validation.py` (V-15) and writes `<data_dir>/builds/<wise_sid>.longbaseline.json`.
Usage: uv run python scripts/export_longbaseline.py VALIDATION_JSON TARGET_ID [--data-dir DIR]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("validation_json", type=Path)
    ap.add_argument("target_id")
    ap.add_argument("--data-dir", type=Path, required=True)
    a = ap.parse_args()
    block = json.loads(a.validation_json.read_text("utf-8"))["results"]["long_baseline"][
        a.target_id
    ]
    if block.get("status") not in ("pass", "fail"):
        raise SystemExit(
            f"V-15 for {a.target_id} has status {block.get('status')}: nothing to store"
        )
    dest = a.data_dir / "builds" / f"{block['wise_sequence_id']}.longbaseline.json"
    dest.write_text(json.dumps(block, indent=1), encoding="utf-8")
    print(dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
