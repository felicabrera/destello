"""Tests for scripts/check_placeholders.py (positive and negative cases on synthetic trees)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load() -> ModuleType:
    for candidate in (Path(__file__).resolve().parents[3] / "scripts", Path("/scripts")):
        f = candidate / "check_placeholders.py"
        if f.exists():
            spec = importlib.util.spec_from_file_location("check_placeholders", f)
            assert spec and spec.loader
            mod = importlib.util.module_from_spec(spec)
            sys.modules["check_placeholders"] = mod
            spec.loader.exec_module(mod)
            return mod
    pytest.skip("scripts/check_placeholders.py not reachable (mount ./scripts at /scripts)")


cp = _load()

STRINGS = {
    "forbidden": [
        {"text": "0.3σ", "reason": "placeholder"},
        {"text": "placeholder", "reason": "copy", "scope": "i18n"},
        {
            "text": "DEV FIXTURE",
            "reason": "marker",
            "allow_in": ["src/i18n/en.json", "src/dev-fixtures"],
        },
    ]
}
DESIGN = """
catalogId: 'x', ra: 269.45207, dec: 4.69339, raNow: 1.0, decNow: 2.0, pm: '10.4″/yr N',
"""


def make_root(tmp_path: Path) -> Path:
    (tmp_path / "frontend/scripts").mkdir(parents=True)
    (tmp_path / "frontend/scripts/placeholder-strings.json").write_text(
        json.dumps(STRINGS), encoding="utf-8"
    )
    d = tmp_path / "design/export/handoff/strings"
    d.mkdir(parents=True)
    (d / "destello-targets.js").write_text(DESIGN, encoding="utf-8")
    (tmp_path / "frontend/src/lib").mkdir(parents=True)
    (tmp_path / "backend/src/destello").mkdir(parents=True)
    return tmp_path


def write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def rules(root: Path) -> set[str]:
    return {v.rule for v in cp.scan(root)}


def test_clean_tree_passes(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/src/lib/a.ts", "export const x = 1;\n")
    assert cp.scan(root) == []
    assert cp.main(["--root", str(root)]) == 0


def test_forbidden_string_detected(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/src/lib/a.ts", 'const s = "Agrees 0.3σ";\n')
    assert "placeholder-string" in rules(root)
    assert cp.main(["--root", str(root)]) == 1


def test_design_coordinate_detected_but_real_value_with_longer_digits_is_not(
    tmp_path: Path,
) -> None:
    root = make_root(tmp_path)
    write(root, "backend/src/destello/a.py", "RA = 269.45207\n")
    assert "placeholder-value" in rules(root)
    write(root, "backend/src/destello/a.py", "RA = 269.452071234\n")
    assert "placeholder-value" not in rules(root)


def test_design_value_inside_comment_ignored(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "backend/src/destello/a.py", "# design used 269.45207 as a placeholder\n")
    assert rules(root) == set()


def test_i18n_scope_matches_values_not_keys(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/src/i18n/en.json", '{\n "placeholder": "Search"\n}\n')
    assert rules(root) == set()
    write(root, "frontend/src/i18n/en.json", '{\n "hint": "placeholder text"\n}\n')
    assert "placeholder-string" in rules(root)


def test_allow_in_exempts_listed_file(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/src/i18n/en.json", '{"badge": "DEV FIXTURE"}\n')
    assert rules(root) == set()
    write(root, "frontend/src/features/x.tsx", 'const l = "DEV FIXTURE";\n')
    assert "placeholder-string" in rules(root)


def test_fixture_imports(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(
        root,
        "frontend/src/lib/api.ts",
        "if (import.meta.env.DEV) {\n  const m = await import('../dev-fixtures');\n}\n",
    )
    assert rules(root) == set()
    write(root, "frontend/src/lib/b.ts", "import { x } from '../dev-fixtures';\n")
    assert "fixture-import" in rules(root)
    write(root, "frontend/src/lib/b.ts", "const m = await import('../dev-fixtures');\n")
    assert "fixture-import" in rules(root)


def test_dev_fixtures_directory_is_excluded(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(
        root,
        "frontend/src/dev-fixtures/index.ts",
        'export const c = "#ff00ff"; const s = "0.3σ"; // DEV FIXTURE\n',
    )
    assert rules(root) == set()


def test_raw_hex_color(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/src/styles/tokens.css", ":root { --a: #ff00ff; }\n")
    assert rules(root) == set()
    write(root, "frontend/src/features/c.tsx", 'const c = "#12abef";\n')
    assert "raw-color" in rules(root)
    write(root, "frontend/src/features/c.tsx", 'const c = "#12abef"; // allow-raw-color\n')
    assert rules(root) == set()


def test_built_bundle_checks(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "frontend/dist/assets/a.js", 'var a="Hello";')
    assert rules(root) == set()
    write(root, "frontend/dist/assets/a.js", 'var a={x:"DEV FIXTURE"};')
    assert "dev-fixture-bundle" in rules(root)
    assert cp.scan(root, include_dist=False) == []


@pytest.mark.parametrize(
    "line",
    [
        "KEY = 'AKIAABCDEFGHIJKLMNOP'",
        "t = 'ghp_" + "a" * 36 + "'",
        "-----BEGIN PRIVATE KEY-----",
        'api_key = "' + "Ab1" * 8 + '"',
    ],
)
def test_secret_patterns_detected(tmp_path: Path, line: str) -> None:
    root = make_root(tmp_path)
    write(root, "backend/src/destello/s.py", line + "\n")
    assert "secret" in rules(root)


def test_empty_or_templated_secrets_pass(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "backend/src/destello/s.py", 'secret = ""\ntoken = os.environ["TOKEN"]\n')
    write(root, "deploy/env.example", "DESTELLO_TURNSTILE_SECRET=\n")
    assert rules(root) == set()


def test_secret_in_deploy_dir_detected(tmp_path: Path) -> None:
    root = make_root(tmp_path)
    write(root, "deploy/x.yml", "password: 'abcdefghijklmnopqrstuvwxyz0123'\n")
    assert "secret" in rules(root)


def test_missing_root_returns_usage_error(tmp_path: Path) -> None:
    assert cp.main(["--root", str(tmp_path / "nope")]) == 2
