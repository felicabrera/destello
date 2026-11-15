"""Data volume cleanup: whole sequences are evicted, pins and shared files are kept."""

from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path

from destello.core.config import Settings
from destello.worker.cron import ORPHAN_MIN_AGE_S, PINS_FILE, cleanup


def _write(root: Path, rel: str, size: int = 100) -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def _sequence(root: Path, seq: str, cutouts: list[str], frames: list[str], age_s: float) -> None:
    for rel in [*cutouts, *frames, f"manifests/{seq}.json"]:
        _write(root, rel)
    side = root / "builds" / f"{seq}.json"
    side.parent.mkdir(parents=True, exist_ok=True)
    doc = {"exposures": [{"path": c} for c in cutouts], "frames": [f"/{f}" for f in frames]}
    side.write_text(json.dumps(doc), encoding="utf-8")
    stamp = time.time() - age_s
    os.utime(side, (stamp, stamp))


def _settings(tmp_path: Path, quota_bytes: int) -> Settings:
    return Settings(
        data_dir=tmp_path,
        data_quota_gb=quota_bytes / 1e9,
        db_url=f"sqlite:///{tmp_path / 'db.sqlite'}",
    )


def test_cleanup_removes_the_oldest_sequence_as_a_unit(tmp_path: Path) -> None:
    _sequence(tmp_path, "a" * 16, ["cutouts/a.fits", "cutouts/shared.fits"], ["frames/a.webp"], 500)
    _sequence(tmp_path, "b" * 16, ["cutouts/b.fits", "cutouts/shared.fits"], ["frames/b.webp"], 100)
    # 7 files of 100 bytes; a quota of 450 needs one sequence to go (3 files unique to it).
    out = asyncio.run(cleanup({"settings": _settings(tmp_path, 450)}))
    assert out["removed_sequences"] == 1
    for rel in ("cutouts/a.fits", "frames/a.webp", f"manifests/{'a' * 16}.json"):
        assert not (tmp_path / rel).exists()
    assert not (tmp_path / "builds" / f"{'a' * 16}.json").exists()
    # The newer sequence is whole, including the cutout both sequences use.
    for rel in ("cutouts/b.fits", "cutouts/shared.fits", "frames/b.webp"):
        assert (tmp_path / rel).exists()
    assert (tmp_path / f"manifests/{'b' * 16}.json").exists()
    assert out["remaining_bytes"] == 400


def test_cleanup_never_removes_a_pinned_sequence(tmp_path: Path) -> None:
    pin = "c" * 16
    _sequence(tmp_path, pin, ["cutouts/c.fits"], ["frames/c.webp"], 900)
    _sequence(tmp_path, "d" * 16, ["cutouts/d.fits"], ["frames/d.webp"], 10)
    (tmp_path / PINS_FILE).write_text(
        json.dumps({"presets": {"barnard": {"sequence_id": pin}}}), encoding="utf-8"
    )
    out = asyncio.run(cleanup({"settings": _settings(tmp_path, 0)}))
    assert out["removed_sequences"] == 1
    assert (tmp_path / "cutouts/c.fits").exists() and (tmp_path / "frames/c.webp").exists()
    assert (tmp_path / f"manifests/{pin}.json").exists()
    assert not (tmp_path / "frames/d.webp").exists()


def test_cleanup_keeps_young_orphans_and_removes_old_ones(tmp_path: Path) -> None:
    _write(tmp_path, "frames/young.webp")
    _write(tmp_path, "frames/old.webp")
    stamp = time.time() - ORPHAN_MIN_AGE_S - 60
    os.utime(tmp_path / "frames/old.webp", (stamp, stamp))
    out = asyncio.run(cleanup({"settings": _settings(tmp_path, 0)}))
    assert (tmp_path / "frames/young.webp").exists()  # may belong to a running build
    assert not (tmp_path / "frames/old.webp").exists()
    assert out["removed_files"] == 1


def test_cleanup_does_nothing_under_the_quota(tmp_path: Path) -> None:
    _sequence(tmp_path, "e" * 16, ["cutouts/e.fits"], ["frames/e.webp"], 900)
    out = asyncio.run(cleanup({"settings": _settings(tmp_path, 10_000)}))
    assert out == {"removed_files": 0, "removed_sequences": 0, "remaining_bytes": 300}
