#!/usr/bin/env python3
"""Fail when design placeholder values or secrets reach production code paths.

Policy: docs/16 section 4. Numbers in the design files are placeholders and must never ship.

Checks (each violation is reported as path:line: [rule] detail):
  placeholder-string   strings from frontend/scripts/placeholder-strings.json
  placeholder-value    coordinates and HUD copy extracted from
                       design/export/handoff/strings/destello-targets.js
  fixture-import       any import of dev-fixtures outside an import.meta.env.DEV guarded dynamic import
  dev-fixture-bundle   DEV FIXTURE or dev-fixtures text in the built bundle (frontend/dist)
  raw-color            raw hex colors in frontend/src (tokens.css and dev-fixtures exempt)
  secret               common secret patterns in code, deploy files and workflows

Scanned: backend/src, frontend/src, frontend/dist (when present). Excluded: dev-fixtures and tests.
Secrets are also searched in deploy/, scripts/ and .github/.

Usage: python scripts/check_placeholders.py [--root PATH] [--no-dist]
Exit code 0 when clean, 1 when violations exist, 2 on usage errors.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

TEXT_EXTS = {".py", ".ts", ".tsx", ".js", ".mjs", ".css", ".html", ".json", ".yaml", ".yml", ".toml", ".sh"}
SKIP_DIRS = {"node_modules", "__pycache__", ".venv", "dev-fixtures", "tests", "test-results"}
HEX_RE = re.compile(r"(?<![&\w])#[0-9a-fA-F]{3,8}\b")
JSON_KEY_RE = re.compile(r'^\s*"[^"]*"\s*:')
FIXTURE_IMPORT_RE = re.compile(r"""(?:from\s+|import\s*\(\s*|import\s+)['"][^'"]*dev-fixtures[^'"]*['"]""")
DESIGN_FILE = Path("design/export/handoff/strings/destello-targets.js")
STRINGS_FILE = Path("frontend/scripts/placeholder-strings.json")

SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-token", re.compile(r"\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private-key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----")),
    ("turnstile-secret", re.compile(r"\b0x4[A-Za-z0-9_-]{30,}\b")),
    (
        "credential-assignment",
        re.compile(
            r"""(?ix)\b(?:secret|passw(?:or)?d|token|api[_-]?key|salt)\w*\s*[:=]\s*['"]
            (?!\$|\{|<|changeme|example|test|dummy|placeholder)[A-Za-z0-9/+_\-]{20,}['"]"""
        ),
    ),
]


@dataclass(frozen=True)
class Violation:
    path: str
    line: int
    rule: str
    detail: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}: [{self.rule}] {self.detail}"


def _rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _iter_files(base: Path, exts: set[str] = TEXT_EXTS):
    if not base.exists():
        return
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.suffix not in exts:
            continue
        if any(part in SKIP_DIRS for part in p.relative_to(base).parts[:-1]):
            continue
        if p.name.endswith((".test.ts", ".test.tsx", ".spec.ts")) or p.name.startswith("test_"):
            continue
        yield p


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def load_forbidden(root: Path) -> list[dict[str, object]]:
    f = root / STRINGS_FILE
    if not f.exists():
        return []
    data = json.loads(f.read_text(encoding="utf-8"))
    items = data.get("forbidden", [])
    return [i for i in items if isinstance(i, dict) and i.get("text")]


def extract_design_values(root: Path) -> list[tuple[str, str]]:
    """Return (text, label) pairs for the placeholder numbers in destello-targets.js."""
    f = root / DESIGN_FILE
    if not f.exists():
        return []
    src = f.read_text(encoding="utf-8", errors="replace")
    out: dict[str, str] = {}
    for m in re.finditer(r"\b(ra|dec|raNow|decNow):\s*(-?\d+\.\d{4,})", src):
        out[m.group(2)] = f"placeholder {m.group(1)}"
    for m in re.finditer(r"\b(pm|motion|plx|offset):\s*'([^']{4,})'", src):
        # HUD and propagation copy that bakes numbers in ("10.4″/yr N", "μα* -0.80, ...").
        if re.search(r"\d", m.group(2)):
            out[m.group(2)] = f"placeholder {m.group(1)} copy"
    return sorted(out.items())


def _allowed(rel: str, item: dict[str, object]) -> bool:
    for pattern in item.get("allow_in", []) or []:  # type: ignore[union-attr]
        p = str(pattern)
        if rel == p or rel.startswith(p.rstrip("/") + "/") or rel.endswith("/" + p) or "/" + p + "/" in "/" + rel:
            return True
    return False


def check_strings(root: Path, files: list[tuple[Path, str]], in_dist: bool) -> list[Violation]:
    """files: (path, scope-relative path under frontend such as src/lib/x.ts)."""
    out: list[Violation] = []
    forbidden = load_forbidden(root)
    design = extract_design_values(root)
    for path, rel_scope in files:
        text = _read(path)
        lines = text.splitlines()
        rel = _rel(path, root)
        is_i18n = "/i18n/" in rel
        for item in forbidden:
            needle = str(item["text"])
            scope = item.get("scope")
            if scope == "i18n" and not is_i18n:
                continue
            if not in_dist and _allowed(rel_scope, item):
                continue
            if in_dist and needle in ("dev-fixtures", "DEV FIXTURE"):
                continue  # handled by the dedicated bundle rule
            if in_dist and scope == "i18n":
                continue  # the word is only meaningful in source i18n files
            for n, line in enumerate(lines, 1):
                probe = JSON_KEY_RE.sub("", line, count=1) if rel.endswith(".json") else line
                if needle in probe:
                    out.append(Violation(rel, n, "placeholder-string", f"{needle!r}: {item.get('reason', '')}"))
        for needle, label in design:
            rx = re.compile(r"(?<![\d.])" + re.escape(needle) + r"(?![\d])")
            for n, line in enumerate(lines, 1):
                if line.lstrip().startswith(("#", "//", "*", "/*")):
                    continue  # comments are not shipped copy
                if rx.search(line):
                    out.append(Violation(rel, n, "placeholder-value", f"{needle!r} ({label})"))
    return out


def check_fixture_imports(root: Path, files: list[Path]) -> list[Violation]:
    out: list[Violation] = []
    for path in files:
        if path.suffix not in {".ts", ".tsx", ".js", ".mjs"}:
            continue
        lines = _read(path).splitlines()
        for n, line in enumerate(lines, 1):
            if not FIXTURE_IMPORT_RE.search(line):
                continue
            dynamic = "import(" in line.replace(" ", "")
            window = "\n".join(lines[max(0, n - 6) : n])
            if dynamic and "import.meta.env.DEV" in window:
                continue
            kind = "static import" if not dynamic else "dynamic import without import.meta.env.DEV guard"
            out.append(Violation(_rel(path, root), n, "fixture-import", kind))
    return out


def check_dist(root: Path, dist: Path) -> list[Violation]:
    out: list[Violation] = []
    for path in _iter_files(dist, {".js", ".css", ".html", ".json"}):
        for n, line in enumerate(_read(path).splitlines(), 1):
            for needle in ("DEV FIXTURE", "dev-fixtures"):
                if needle in line:
                    out.append(Violation(_rel(path, root), n, "dev-fixture-bundle", f"{needle!r} in built bundle"))
    return out


def check_colors(root: Path, src: Path) -> list[Violation]:
    out: list[Violation] = []
    for path in _iter_files(src, {".ts", ".tsx", ".css"}):
        rel = _rel(path, root)
        if rel.endswith("styles/tokens.css"):
            continue
        for n, line in enumerate(_read(path).splitlines(), 1):
            if "allow-raw-color" in line:
                continue
            m = HEX_RE.search(line)
            if m:
                out.append(Violation(rel, n, "raw-color", f"raw hex {m.group(0)}; use a token from tokens.css"))
    return out


def check_secrets(root: Path, bases: list[Path]) -> list[Violation]:
    out: list[Violation] = []
    for base in bases:
        for path in _iter_files(base, TEXT_EXTS | {".env", ".pem", ".key", ".md"}):
            if path.suffix == ".map":
                continue
            for n, line in enumerate(_read(path).splitlines(), 1):
                if len(line) > 4000:  # minified bundles: scan in chunks
                    chunks = [line[i : i + 4000] for i in range(0, len(line), 3500)]
                else:
                    chunks = [line]
                for chunk in chunks:
                    for name, rx in SECRET_PATTERNS:
                        if rx.search(chunk):
                            out.append(Violation(_rel(path, root), n, "secret", f"matches {name}"))
    return out


def scan(root: Path, include_dist: bool = True) -> list[Violation]:
    root = root.resolve()
    backend_src = root / "backend" / "src"
    frontend_src = root / "frontend" / "src"
    dist = root / "frontend" / "dist"
    violations: list[Violation] = []

    string_files: list[tuple[Path, str]] = []
    for p in _iter_files(backend_src):
        string_files.append((p, _rel(p, root / "backend")))
    fe_files = list(_iter_files(frontend_src))
    for p in fe_files:
        string_files.append((p, _rel(p, root / "frontend")))
    violations += check_strings(root, string_files, in_dist=False)
    violations += check_fixture_imports(root, fe_files)
    violations += check_colors(root, frontend_src)

    secret_bases = [backend_src, frontend_src, root / "deploy", root / "scripts", root / ".github"]
    if include_dist and dist.exists():
        dist_files = [(p, _rel(p, root / "frontend")) for p in _iter_files(dist, {".js", ".css", ".html", ".json"})]
        violations += check_strings(root, dist_files, in_dist=True)
        violations += check_dist(root, dist)
        secret_bases.append(dist)
    violations += check_secrets(root, secret_bases)

    # Stable order, no duplicates.
    seen: set[tuple[str, int, str, str]] = set()
    unique: list[Violation] = []
    for v in violations:
        key = (v.path, v.line, v.rule, v.detail)
        if key not in seen:
            seen.add(key)
            unique.append(v)
    return sorted(unique, key=lambda v: (v.rule, v.path, v.line))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument("--no-dist", action="store_true", help="skip frontend/dist")
    args = ap.parse_args(argv)
    if not args.root.is_dir():
        print(f"root not found: {args.root}", file=sys.stderr)
        return 2
    root = args.root.resolve()
    notes = []
    if not (root / DESIGN_FILE).exists():
        notes.append(f"note: {DESIGN_FILE.as_posix()} not found, design value extraction skipped")
    if not (root / "frontend" / "dist").exists():
        notes.append("note: frontend/dist not found, bundle checks skipped (run pnpm build)")
    for note in notes:
        print(note, file=sys.stderr)
    violations = scan(root, include_dist=not args.no_dist)
    for v in violations:
        print(v)
    if violations:
        by_rule: dict[str, int] = {}
        for v in violations:
            by_rule[v.rule] = by_rule.get(v.rule, 0) + 1
        summary = ", ".join(f"{k}={n}" for k, n in sorted(by_rule.items()))
        print(f"FAILED: {len(violations)} violation(s) ({summary})", file=sys.stderr)
        return 1
    print("OK: no placeholder values, fixture leaks, raw colors or secrets found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
