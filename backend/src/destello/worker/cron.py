"""Scheduled jobs (arq cron): warm_presets, check_releases, cleanup."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

from destello.core.config import Settings, get_settings
from destello.core.db import backup_sqlite, sqlite_path
from destello.core.logging import get_logger
from destello.models.targets import load_targets
from destello.sources.irsa import IrsaClient
from destello.worker.jobs import build_sequence, preset_params

PINS_FILE = "pins.json"
# Release metadata shared with the API (/releases reads it) and the last seen release signature.
RELEASES_KEY = "destello:releases"
RELEASES_TTL_S = 7 * 3600
RELEASES_SIGNATURE_KEY = "destello:releases:signature"
# Unix time of the last change of that signature. A sequence whose manifest is older is rebuilt in
# the background the next time it is requested (api/routes/sequences.py).
RELEASES_CHANGED_AT_KEY = "destello:releases:changed_at"


def pinned_sequence_ids(settings: Settings) -> set[str]:
    """Sequence ids that cleanup must never delete (the preset pin list)."""
    path = settings.data_dir / PINS_FILE
    if not path.exists():
        return set()
    doc = json.loads(path.read_text(encoding="utf-8"))
    return {str(v["sequence_id"]) for v in doc.get("presets", {}).values()}


_REPORTED_FILE_RE = re.compile(
    r"/((?:frames/[0-9a-f]{16}\.(?:webp|fits|png))|(?:manifests/[0-9a-f]{16}\.json))"
)


def reported_files(settings: Settings) -> set[str]:
    """Data files that public reports point to (mark frames and manifests), relative paths.

    Only these few files are kept, not whole sequences, so the reports' disk use stays small."""
    path = sqlite_path(settings.db_url)
    if path is None or not path.is_file():
        return set()
    try:
        with closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True)) as conn:
            rows = conn.execute("SELECT public_json FROM reports WHERE deleted = 0").fetchall()
    except sqlite3.Error:  # no reports table yet, or a locked file: keep nothing extra this run
        return set()
    return {m.group(1) for (doc,) in rows for m in _REPORTED_FILE_RE.finditer(str(doc))}


async def warm_presets(ctx: dict[str, Any], force: bool = False) -> dict[str, str]:
    """Build the five preset sequences for the current pipeline version and pin them.

    A preset that already has a manifest is reused unless `force` is set. check_releases sets it
    when IRSA publishes new data: the sequence id does not change with the data, so only a forced
    build picks the new images up. The previous manifest stays served until the new one replaces it.
    """
    settings: Settings = ctx.get("settings") or get_settings()
    log = get_logger(job="warm_presets")
    out: dict[str, str] = {}
    for tid, target in load_targets().items():
        params = preset_params(target)
        try:
            out[tid] = await build_sequence(ctx, params.to_dict(), force=force)
        except Exception as exc:  # keep warming the other presets
            log.error("warm_failed", target=tid, error=str(exc))
    write_pins(settings, {t: s for t, s in out.items()})
    return out


def write_pins(settings: Settings, built: dict[str, str]) -> None:
    from destello.core.cache import atomic_write_bytes

    presets: dict[str, dict[str, Any]] = {}
    for tid, seq in built.items():
        target = load_targets()[tid]
        presets[tid] = {
            "sequence_id": seq,
            "params": preset_params(target).to_dict(),
        }
    doc = {"pipeline_version": settings.pipeline_version, "presets": presets}
    atomic_write_bytes(settings.data_dir / PINS_FILE, json.dumps(doc, indent=1).encode())


async def check_releases(ctx: dict[str, Any]) -> list[dict[str, Any]]:
    """Refresh the release metadata (collections, counts, latest publication date) in Redis."""
    settings: Settings = ctx.get("settings") or get_settings()
    shared = ctx.get("irsa")
    if isinstance(shared, IrsaClient):  # the worker's client: global IRSA limiter
        releases = await shared.list_releases()
    else:
        async with IrsaClient(settings) as irsa:
            releases = await irsa.list_releases()  # type: ignore[attr-defined]
    data = [
        {
            "collection": r.collection,
            "n_planes": r.n_planes,
            "latest_pub_date": r.latest_pub_date,
            "t_max_mjd": r.t_max_mjd,
        }
        for r in releases
    ]
    redis = ctx.get("redis")
    if redis is not None:
        await redis.set(RELEASES_KEY, json.dumps(data), ex=RELEASES_TTL_S)
        last = await redis.get(RELEASES_SIGNATURE_KEY)
        signature = release_signature(data)
        await redis.set(RELEASES_SIGNATURE_KEY, signature)
        if last is not None and _text(last) != signature:
            # A new release or new images for a collection: rebuild the presets (docs/09 section 9).
            get_logger(job="check_releases").info("release_changed", signature=signature[:16])
            await redis.set(RELEASES_CHANGED_AT_KEY, str(time.time()))
            await redis.enqueue_job(
                "warm_presets", force=True, _job_id=f"warm_presets:{signature[:16]}"
            )
    return data


def _text(value: bytes | str) -> str:
    return value.decode() if isinstance(value, bytes) else value


def release_signature(data: list[dict[str, Any]]) -> str:
    """Stable digest of the collections, their plane counts and latest publication dates."""
    rows = sorted(
        (str(r["collection"]), int(r.get("n_planes") or 0), str(r.get("latest_pub_date") or ""))
        for r in data
    )
    return hashlib.sha256(json.dumps(rows).encode()).hexdigest()


def _dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) if path.exists() else 0


# Files younger than this are never treated as orphans: a running build writes cutouts and frames
# before its sidecar exists.
ORPHAN_MIN_AGE_S = 6 * 3600
_DATA_DIRS = ("cutouts", "frames", "manifests")


def _sidecar_files(seq: str, doc: dict[str, Any]) -> tuple[set[str], set[str]]:
    """(cutout paths, frame and manifest paths) of one built sequence, relative to the data dir."""
    cutouts = {str(e["path"]).replace("\\", "/") for e in doc.get("exposures", [])}
    derived = {str(u).lstrip("/") for u in doc.get("frames", [])}
    derived |= {f"manifests/{seq}.json", f"manifests/{seq}.photometry.json"}
    return cutouts, derived


def _unlink(path: Path) -> int:
    """Delete a file and return the bytes freed (0 when it is already gone)."""
    try:
        size = path.stat().st_size
        path.unlink()
    except OSError:
        return 0
    return size


async def cleanup(ctx: dict[str, Any]) -> dict[str, int]:
    """Keep the data volume under the quota by deleting whole sequences, least recently built first.

    A sequence is removed as a unit (manifest, frames, sidecar and the cutouts no other sequence
    uses), so a manifest never outlives the frames it lists. Pinned presets (data/pins.json) are
    never deleted, nor are the frames and manifests that stored reports point to. Files that no
    sidecar references (difference images, leftovers of failed builds) go last, oldest first, and
    only once they are old enough not to belong to a running build.
    """
    settings: Settings = ctx.get("settings") or get_settings()
    quota = int(settings.data_quota_gb * 1e9)
    data = settings.data_dir
    pinned = pinned_sequence_ids(settings)
    builds = data / "builds"

    sequences: dict[str, tuple[float, set[str], set[str]]] = {}
    if builds.exists():
        for side in builds.glob("*.json"):
            if side.name.endswith(".partial.json"):
                continue
            try:
                doc = json.loads(side.read_text(encoding="utf-8"))
                sequences[side.stem] = (side.stat().st_mtime, *_sidecar_files(side.stem, doc))
            except (OSError, ValueError, KeyError, TypeError):
                continue  # unreadable sidecar: its files are handled as orphans

    keep_files = reported_files(settings)
    for seq in pinned & sequences.keys():
        keep_files |= sequences[seq][1] | sequences[seq][2]

    total = sum(_dir_size(data / d) for d in _DATA_DIRS)
    removed = 0
    removed_sequences = 0
    if total > quota:
        # How many surviving sequences use each file (cutouts and frames are content addressed and
        # can be shared between sequences).
        uses: dict[str, int] = {}
        for _, cutouts, derived in sequences.values():
            for rel in cutouts | derived:
                uses[rel] = uses.get(rel, 0) + 1
        for seq in sorted(sequences.keys() - pinned, key=lambda s: sequences[s][0]):
            if total <= quota:
                break
            _, cutouts, derived = sequences.pop(seq)
            for rel in cutouts | derived:
                uses[rel] -= 1
                if uses[rel] == 0 and rel not in keep_files:
                    freed = _unlink(data / rel)
                    total -= freed
                    removed += 1 if freed else 0
            _unlink(builds / f"{seq}.json")
            removed_sequences += 1

    if total > quota:
        referenced = set(keep_files)
        for _, cutouts, derived in sequences.values():
            referenced |= cutouts | derived
        now = time.time()
        orphans: list[tuple[float, Path]] = []
        for d in _DATA_DIRS:
            root = data / d
            if not root.exists():
                continue
            for f in root.rglob("*"):
                if not f.is_file() or f.relative_to(data).as_posix() in referenced:
                    continue
                mtime = f.stat().st_mtime
                if now - mtime >= ORPHAN_MIN_AGE_S:
                    orphans.append((mtime, f))
        for _, f in sorted(orphans):
            if total <= quota:
                break
            freed = _unlink(f)
            total -= freed
            removed += 1 if freed else 0
    return {
        "removed_files": removed,
        "removed_sequences": removed_sequences,
        "remaining_bytes": total,
    }


async def backup_reports(ctx: dict[str, Any]) -> dict[str, str]:
    """Daily SQLite online backup of the report database (docs/09 section 9).

    Writes to DESTELLO_REPORTS_BACKUP_DIR (default <data_dir>/backups/reports) and keeps the
    newest DESTELLO_REPORTS_BACKUP_KEEP copies. Local only: no cloud upload."""
    settings: Settings = ctx.get("settings") or get_settings()
    log = get_logger(job="backup_reports")
    src = sqlite_path(settings.db_url)
    if src is None or not src.is_file():
        log.info("backup_reports_skipped", reason="no database yet")
        return {"status": "skipped"}
    dest = await asyncio.to_thread(
        backup_sqlite, src, settings.backups_dir, settings.reports_backup_keep
    )
    log.info("backup_reports_done", path=str(dest), bytes=dest.stat().st_size)
    return {"status": "ok", "path": str(dest)}
