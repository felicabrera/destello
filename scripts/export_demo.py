#!/usr/bin/env python3
"""Build the static demo bundle (demo/) from the cached preset data (F-18, docs/09 section 1).

Real data only: everything comes from data/ (manifests, frames) and, when reachable, from the running
API (targets, releases, overlays, difference images). Nothing is simulated or interpolated.

Layout written under --out (matches frontend/src/lib/api.ts demoCall exactly), relative to --mount:
  targets.json, releases.json, health.json, validation.json (only when published)
  manifests/<id>.json and <id>.photometry.json      (preset sequences from data/pins.json)
  frames/<hash>.webp, .fits and .png (flag masks)    (only files referenced by the above)
  overlays/<sequence_id>/<gaia_dr3|catwise2020>.json (API cache; skipped when the API is down or 503)
  difference/<sequence_id>/<a>-<b>-<detector>.json   (a, b 0-based; detector 0 = all) plus its webp frames
  candidates/<sequence_id>/<a>-<b>.json              (F-29; only when every catalog answered)
  motion-search/<sequence_id>.json                   (F-32; only when every catalog answered)
  movers.json, movers/<sid>/{spectrum,ephemeris-check,neossat}.json   (F-33 comet page; manifests and frames as above)
  wise/index.json, wise/<sid>.json, wise/<sid>.astrometry.json         (F-40 16 year timeline; sid is the SPHEREx
      sequence id; index.json lists the sequences that have a companion so the client never probes for a 404)
Mover and WISE frames are exported without their FITS twins (the demo shows the WebP images only).
and, unless --no-frontend, the built SPA (frontend/dist) at the output root plus _headers and _redirects
for Cloudflare Pages. The SPA reads VITE_DEMO_BASE at build time: build it with
VITE_DEMO_BASE=https://<demo host> (Pages) or use --mount demo to produce a folder to copy into dist/demo.

Idempotent: files are rewritten only when content changes and stale files are removed.
Standard library only; the API is optional.

Usage: python scripts/export_demo.py [--data-dir data] [--out demo] [--api http://localhost:8000]
       [--frontend frontend/dist] [--no-frontend] [--mount PATH] [--all-pairs] [--no-api]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

CATALOGS = ("gaia_dr3", "catwise2020")
FRAME_RE = re.compile(r"/frames/([0-9a-f]{16}\.(?:webp|fits|png))")
ID_RE = re.compile(r"^[0-9a-f]{16}$")
HEADERS_FILE = """/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/frames/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
/manifests/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
/*.json
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=300
/overlays/*
  Access-Control-Allow-Origin: *
/difference/*
  Access-Control-Allow-Origin: *
/candidates/*
  Access-Control-Allow-Origin: *
/motion-search/*
  Access-Control-Allow-Origin: *
/movers/*
  Access-Control-Allow-Origin: *
/wise/*
  Access-Control-Allow-Origin: *
"""
MARKER = ".destello-demo-bundle"
REDIRECTS_FILE = "/* /index.html 200\n"


class Plan:
    """Files to materialise: relative path -> bytes or source Path."""

    def __init__(self) -> None:
        self.files: dict[str, bytes | Path] = {}
        self.notes: list[str] = []
        self.data_dir = Path(".")
        self.companion: set[str] = (
            set()
        )  # files added only for the comet page and the 16 year timeline

    def add(self, rel: str, content: bytes | Path) -> None:
        self.files[rel] = content

    def note(self, msg: str) -> None:
        self.notes.append(msg)
        print(msg, file=sys.stderr)


RATE_LIMIT_RETRIES = 8
MAX_RETRY_AFTER_S = 65.0


def api_get(base: str, path: str, timeout: float = 120.0) -> tuple[int, bytes]:
    """GET with the API rate limit honoured: a 429 waits for Retry-After and tries again."""
    req = urllib.request.Request(base.rstrip("/") + path, headers={"Accept": "application/json"})
    for _ in range(RATE_LIMIT_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator supplied base URL
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429:
                return e.code, e.read()
            try:
                wait = float(e.headers.get("Retry-After") or 10)
            except ValueError:
                wait = 10.0
            time.sleep(min(max(wait, 1.0), MAX_RETRY_AFTER_S))
    return 429, b""


def api_up(base: str) -> bool:
    try:
        status, _ = api_get(base, "/api/v1/health", timeout=10)
        return status == 200
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def canonical(obj: object) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode("utf-8")


def load_pins(data_dir: Path) -> dict[str, str]:
    pins = json.loads((data_dir / "pins.json").read_text(encoding="utf-8"))
    out = {
        slug: p["sequence_id"]
        for slug, p in pins["presets"].items()
        if ID_RE.match(p["sequence_id"])
    }
    if not out:
        raise SystemExit("no preset sequence ids in pins.json")
    return out


def collect_frames(plan: Plan, data_dir: Path, text: str, where: str, *, fits: bool = True) -> bool:
    """Add every frame named in text. Returns False when a referenced frame is not on disk.

    With fits=False the FITS files are left out (the comet and WISE views display WebP only)."""
    complete = True
    for name in sorted(set(FRAME_RE.findall(text))):
        if not fits and name.endswith(".fits"):
            continue
        src = data_dir / "frames" / name
        if src.is_file():
            plan.add(f"frames/{name}", src)
        else:
            plan.note(f"missing frame {name} referenced by {where}")
            complete = False
    return complete


CARRY_PREFIXES = (
    "overlays/",
    "difference/",
    "candidates/",
    "motion-search/",
    "movers",
    "wise/",
    "targets.json",
    "releases.json",
    "validation.json",
)


def carry_over(plan: Plan, base: Path) -> None:
    """Without the API, keep API derived files from a previous run instead of pruning them."""
    if not base.is_dir():
        return
    kept = 0
    for p in sorted(base.rglob("*")):
        rel = p.relative_to(base).as_posix()
        if p.is_file() and rel.startswith(CARRY_PREFIXES) and rel not in plan.files:
            if rel.startswith("difference/") and rel.endswith(".json"):
                probe = Plan()
                if not collect_frames(probe, plan.data_dir, p.read_text(encoding="utf-8"), rel):
                    continue  # dangling image: drop it
                plan.files.update(probe.files)
            if rel.startswith(("movers", "wise/")) and rel.endswith(".json"):
                # Companion documents carry their images (and the mover manifests) with them.
                collect_frames(plan, plan.data_dir, p.read_text(encoding="utf-8"), rel, fits=False)
            plan.add(rel, p)
            kept += 1
    if kept:
        plan.note(f"API unavailable: kept {kept} API derived file(s) from the previous export")


def difference_pairs(n_epochs: int, all_pairs: bool) -> list[tuple[int, int]]:
    if all_pairs:
        return [(a, b) for a in range(n_epochs) for b in range(n_epochs) if a != b]
    pairs = {(a, 0) for a in range(1, n_epochs)} | {(a, a - 1) for a in range(1, n_epochs)}
    return sorted(pairs)


MOVER_DOCS = (
    ("spectrum", "spectrum"),
    ("ephemeris-check", "ephemeris-check"),
    ("neossat", "neossat"),
)


def add_movers(plan: Plan, args: argparse.Namespace, use_api: bool) -> None:
    """F-33: the comet page. Needs the API for the listing and the derived documents."""
    data_dir = plan.data_dir
    if not use_api:
        return
    status, body = api_get(args.api, "/api/v1/movers")
    if status != 200:
        plan.note(f"GET /movers returned {status}; the comet page is not cached")
        return
    listing = json.loads(body)
    plan.add("movers.json", canonical(listing))
    for sid in sorted(
        {
            s["sequence_id"]
            for m in listing
            for s in m.get("sequences", [])
            if ID_RE.match(s.get("sequence_id", ""))
        }
    ):
        src = data_dir / "manifests" / f"{sid}.json"
        if not src.is_file():
            plan.note(f"mover {sid}: manifest not on disk, sequence skipped")
            continue
        text = src.read_text(encoding="utf-8")
        plan.add(f"manifests/{sid}.json", src)
        if not collect_frames(plan, data_dir, text, f"mover manifest {sid}", fits=False):
            plan.note(f"mover {sid}: some frames are missing on disk")
        for name, route in MOVER_DOCS:
            status, body = api_get(args.api, f"/api/v1/movers/{sid}/{route}")
            if status != 200:
                plan.note(f"mover {sid} {route}: API returned {status}, skipped")
                continue
            doc_text = body.decode("utf-8")
            plan.add(f"movers/{sid}/{name}.json", canonical(json.loads(doc_text)))
            collect_frames(plan, data_dir, doc_text, f"mover {sid} {route}", fits=False)


def add_wise(plan: Plan, args: argparse.Namespace, use_api: bool, presets: dict[str, str]) -> None:
    """F-40: companion manifests and long-baseline fits of the presets that have one (silent when none)."""
    index: dict[str, dict[str, bool]] = {}
    if use_api:
        for sid in presets.values():
            status, body = api_get(args.api, f"/api/v1/sequences/{sid}/wise")
            if status != 200:  # 204: no companion
                continue
            text = body.decode("utf-8")
            if not collect_frames(plan, plan.data_dir, text, f"wise companion {sid}", fits=False):
                plan.note(f"wise {sid}: some frames are missing on disk")
            plan.add(f"wise/{sid}.json", canonical(json.loads(text)))
            entry = {"manifest": True, "astrometry": False}
            status, body = api_get(args.api, f"/api/v1/sequences/{sid}/wise/astrometry")
            if status == 200:
                plan.add(f"wise/{sid}.astrometry.json", canonical(json.loads(body)))
                entry["astrometry"] = True
            index[sid] = entry
    if use_api or index:
        plan.add("wise/index.json", canonical({"sequences": index}))


def build_plan(args: argparse.Namespace) -> Plan:
    plan = Plan()
    data_dir: Path = args.data_dir
    plan.data_dir = data_dir
    presets = load_pins(data_dir)
    use_api = (not args.no_api) and api_up(args.api)
    if not use_api:
        plan.note(
            "API not reachable (or --no-api): generating from files only; overlays, difference, releases, targets skipped or reduced"
        )

    # Manifests and the frames they reference.
    manifests: dict[str, dict] = {}
    for slug, sid in presets.items():
        for suffix in (".json", ".photometry.json"):
            src = data_dir / "manifests" / f"{sid}{suffix}"
            if not src.is_file():
                plan.note(f"missing manifest file {src.name} for {slug}")
                continue
            text = src.read_text(encoding="utf-8")
            plan.add(f"manifests/{sid}{suffix}", src)
            collect_frames(plan, data_dir, text, src.name)
            if suffix == ".json":
                manifests[sid] = json.loads(text)

    # Targets, releases, health.
    if use_api:
        status, body = api_get(args.api, "/api/v1/targets")
        if status == 200:
            plan.add("targets.json", canonical(json.loads(body)))
        else:
            plan.note(f"GET /targets returned {status}; targets.json not generated")
        status, body = api_get(args.api, "/api/v1/releases")
        if status == 200:
            plan.add("releases.json", canonical(json.loads(body)))
        else:
            plan.note(f"GET /releases returned {status}; releases.json not generated")
        status, body = api_get(args.api, "/api/v1/health")
        version = json.loads(body).get("version", "") if status == 200 else ""
        pipeline = json.loads(body).get("pipeline_version", "") if status == 200 else ""
    else:
        version = pipeline = ""
        pins = json.loads((data_dir / "pins.json").read_text(encoding="utf-8"))
        pipeline = str(pins.get("pipeline_version", ""))
    # Static health: irsa "ok" only means "no degradation banner": the demo never contacts IRSA.
    plan.add(
        "health.json",
        canonical(
            {
                "status": "ok",
                "version": version,
                "pipeline_version": pipeline,
                "irsa": "ok",
                "demo": True,
            }
        ),
    )

    # Validation report, when published.
    vfile = data_dir / "validation.json"
    if vfile.is_file():
        plan.add("validation.json", vfile)
    elif use_api:
        status, body = api_get(args.api, "/api/v1/validation")
        if status == 200:
            plan.add("validation.json", canonical(json.loads(body)))

    # Overlays and difference images from the API.
    if use_api:
        for slug, sid in presets.items():
            for cat in CATALOGS:
                status, body = api_get(args.api, f"/api/v1/sequences/{sid}/overlays/{cat}")
                if status == 200:
                    plan.add(f"overlays/{sid}/{cat}.json", canonical(json.loads(body)))
                else:
                    plan.note(f"overlay {slug}/{cat}: API returned {status}, skipped")
            # F-32 motion search: 422 (fewer than 3 full coverage epochs) is expected and not shipped.
            status, body = api_get(args.api, f"/api/v1/sequences/{sid}/motion-search")
            doc = json.loads(body) if status == 200 else {}
            if status == 200 and all(v == "ok" for v in doc.get("catalogs", {}).values()):
                plan.add(f"motion-search/{sid}.json", canonical(doc))
            else:
                plan.note(
                    f"motion search {slug}: API returned {status} or a catalog was unavailable, skipped"
                )
            man = manifests.get(sid)
            if not man:
                continue
            epochs = man.get("epochs", [])
            dets = sorted({0, *[int(d) for d in man.get("request", {}).get("detectors", [])]})
            for a, b in difference_pairs(len(epochs), args.all_pairs):
                q = f"a={a}&b={b}"
                status, body = api_get(args.api, f"/api/v1/sequences/{sid}/candidates?{q}")
                doc = json.loads(body) if status == 200 else {}
                # A list made while a catalog did not answer is not shipped: it would freeze
                # "unchecked" entries in the demo.
                if status == 200 and all(v == "ok" for v in doc.get("catalogs", {}).values()):
                    plan.add(f"candidates/{sid}/{a}-{b}.json", canonical(doc))
                else:
                    plan.note(
                        f"candidates {slug} {q}: API returned {status} or a catalog was unavailable, skipped"
                    )
                for det in dets:
                    q = f"a={a}&b={b}&detector={det}"
                    status, body = api_get(args.api, f"/api/v1/sequences/{sid}/difference?{q}")
                    if status != 200:
                        plan.note(f"difference {slug} {q}: API returned {status}, skipped")
                        continue
                    text = body.decode("utf-8")
                    # Never ship a difference whose image is not on disk (it would be a dangling link).
                    probe = Plan()
                    if collect_frames(probe, data_dir, text, f"difference {slug} {q}"):
                        plan.files.update(probe.files)
                        plan.add(
                            f"difference/{sid}/{a}-{b}-{det}.json", canonical(json.loads(text))
                        )
                    else:
                        plan.notes.extend(probe.notes)
                        plan.note(f"difference {slug} {q}: not exported (frame missing on disk)")

    before = set(plan.files)
    add_movers(plan, args, use_api)
    add_wise(plan, args, use_api, presets)
    plan.companion = set(plan.files) - before

    if not use_api:
        carry_over(plan, args.out / args.mount.strip("/") if args.mount.strip("/") else args.out)

    # Frontend build.
    if not args.no_frontend:
        dist: Path = args.frontend
        if dist.is_dir():
            for p in sorted(dist.rglob("*")):
                if p.is_file() and not p.name.endswith(".map"):
                    plan.add(p.relative_to(dist).as_posix(), p)
            plan.add("_headers", HEADERS_FILE.encode())
            plan.add("_redirects", REDIRECTS_FILE.encode())
        else:
            plan.note(f"frontend build not found at {dist}; run pnpm build (frontend only skipped)")
    return plan


def _digest(content: bytes | Path) -> str:
    h = hashlib.sha256()
    if isinstance(content, bytes):
        h.update(content)
    else:
        with content.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()


def materialise(plan: Plan, out: Path, mount: str) -> tuple[int, int, int]:
    """Write the plan under out/mount. Returns (written, unchanged, removed)."""
    base = out / mount if mount else out
    base.mkdir(parents=True, exist_ok=True)
    marker = base / MARKER
    if any(base.iterdir()) and not marker.is_file():
        raise SystemExit(
            f"{base} is not empty and is not a demo bundle (no {MARKER}); choose another --out"
        )
    plan.add(
        MARKER,
        b"Bundle written by scripts/export_demo.py. Files not in the plan are removed on the next run.\n",
    )
    written = unchanged = removed = 0
    wanted = {(base / rel).resolve() for rel in plan.files}
    for rel, content in sorted(plan.files.items()):
        dest = (base / rel).resolve()
        if base.resolve() not in dest.parents:
            raise SystemExit(f"refusing to write outside the output directory: {rel}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        if (
            dest.is_file()
            and dest.stat().st_size
            == (len(content) if isinstance(content, bytes) else content.stat().st_size)
            and _digest(dest) == _digest(content)
        ):
            unchanged += 1
            continue
        if isinstance(content, bytes):
            dest.write_bytes(content)
        else:
            shutil.copyfile(content, dest)
        written += 1
    for p in sorted(base.resolve().rglob("*"), reverse=True):
        if p.is_file() and p not in wanted:
            p.unlink()
            removed += 1
        elif p.is_dir() and not any(p.iterdir()):
            p.rmdir()
    return written, unchanged, removed


def human(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    root = Path(__file__).resolve().parent.parent
    ap.add_argument("--data-dir", type=Path, default=root / "data")
    ap.add_argument("--out", type=Path, default=root / "demo")
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--frontend", type=Path, default=root / "frontend" / "dist")
    ap.add_argument("--no-frontend", action="store_true")
    ap.add_argument("--no-api", action="store_true")
    ap.add_argument(
        "--mount",
        default="",
        help="subdirectory of --out that receives everything (for example demo)",
    )
    ap.add_argument(
        "--all-pairs", action="store_true", help="difference for every ordered epoch pair (slow)"
    )
    args = ap.parse_args(argv)
    if not (args.data_dir / "pins.json").is_file():
        print(f"{args.data_dir}/pins.json not found", file=sys.stderr)
        return 2
    plan = build_plan(args)
    written, unchanged, removed = materialise(plan, args.out, args.mount.strip("/"))
    base = args.out / args.mount.strip("/") if args.mount.strip("/") else args.out
    total = sum(p.stat().st_size for p in base.rglob("*") if p.is_file())
    count = sum(1 for p in base.rglob("*") if p.is_file())
    print(f"demo bundle: {base}")
    print(
        f"files: {count} ({written} written, {unchanged} unchanged, {removed} removed); size {human(total)}"
    )
    groups: dict[str, int] = {}
    for rel in plan.files:
        key = rel.split("/")[0] if "/" in rel else rel
        groups[key] = groups.get(key, 0) + 1
    added = sum(
        (c.stat().st_size if isinstance(c, Path) else len(c))
        for rel, c in plan.files.items()
        if rel in plan.companion
    )
    if plan.companion:
        print(
            f"comet page and 16 year timeline add {len(plan.companion)} file(s), {human(added)} (shared frames counted once)"
        )
    print(
        "top level entries: "
        + ", ".join(
            f"{k}={v}"
            for k, v in sorted(groups.items())
            if k in {"manifests", "frames", "overlays", "difference", "assets", "movers", "wise"}
            or k.endswith(".json")
        )
    )
    if plan.notes:
        print(f"{len(plan.notes)} note(s), see stderr above")
    return 0


if __name__ == "__main__":
    sys.exit(main())
