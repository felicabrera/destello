"""Tests for scripts/export_demo.py (file-only mode, no API)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest


def _load() -> ModuleType:
    for candidate in (Path(__file__).resolve().parents[3] / "scripts", Path("/scripts")):
        f = candidate / "export_demo.py"
        if f.exists():
            spec = importlib.util.spec_from_file_location("export_demo", f)
            assert spec and spec.loader
            mod = importlib.util.module_from_spec(spec)
            sys.modules["export_demo"] = mod
            spec.loader.exec_module(mod)
            return mod
    pytest.skip("scripts/export_demo.py not reachable (mount ./scripts at /scripts)")


ed = _load()
SID = "0123456789abcdef"
FRAME = "fedcba9876543210"


def make_data(tmp_path: Path) -> Path:
    data = tmp_path / "data"
    (data / "manifests").mkdir(parents=True)
    (data / "frames").mkdir()
    pins = {"pipeline_version": "0.3.0", "presets": {"barnard": {"sequence_id": SID, "params": {}}}}
    (data / "pins.json").write_text(json.dumps(pins), encoding="utf-8")
    manifest = {
        "epochs": [
            {"frames": [{"url": f"/frames/{FRAME}.webp", "fits_url": f"/frames/{FRAME}.fits"}]}
        ]
    }
    (data / "manifests" / f"{SID}.json").write_text(json.dumps(manifest), encoding="utf-8")
    (data / "manifests" / f"{SID}.photometry.json").write_text("{}", encoding="utf-8")
    (data / "frames" / f"{FRAME}.webp").write_bytes(b"webp")
    (data / "frames" / f"{FRAME}.fits").write_bytes(b"fits")
    (data / "frames" / "aaaaaaaaaaaaaaaa.webp").write_bytes(b"unreferenced")
    return data


def run(data: Path, out: Path, *extra: str) -> int:
    return ed.main(
        ["--data-dir", str(data), "--out", str(out), "--no-api", "--no-frontend", *extra]
    )


def test_file_only_layout(tmp_path: Path) -> None:
    data, out = make_data(tmp_path), tmp_path / "demo"
    assert run(data, out) == 0
    assert (out / "manifests" / f"{SID}.json").is_file()
    assert (out / "manifests" / f"{SID}.photometry.json").is_file()
    assert (out / "frames" / f"{FRAME}.webp").read_bytes() == b"webp"
    assert (out / "frames" / f"{FRAME}.fits").is_file()
    assert not (out / "frames" / "aaaaaaaaaaaaaaaa.webp").exists()  # only referenced frames
    health = json.loads((out / "health.json").read_text(encoding="utf-8"))
    assert health["irsa"] == "ok" and health["pipeline_version"] == "0.3.0"
    assert not (out / "targets.json").exists()  # needs the API


def test_idempotent_and_stale_removed(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    data, out = make_data(tmp_path), tmp_path / "demo"
    run(data, out)
    (out / "frames" / "stale.webp").write_bytes(b"x")
    capsys.readouterr()
    run(data, out)
    text = capsys.readouterr().out
    assert "0 written" in text and "1 removed" in text
    assert not (out / "frames" / "stale.webp").exists()


def test_refuses_to_clean_foreign_directory(tmp_path: Path) -> None:
    data, out = make_data(tmp_path), tmp_path / "other"
    out.mkdir()
    (out / "precious.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(SystemExit):
        run(data, out)
    assert (out / "precious.txt").exists()


def test_mount_prefix(tmp_path: Path) -> None:
    data, out = make_data(tmp_path), tmp_path / "demo"
    run(data, out, "--mount", "demo")
    assert (out / "demo" / "health.json").is_file()


def test_difference_pairs() -> None:
    assert ed.difference_pairs(3, False) == [(1, 0), (2, 0), (2, 1)]
    assert len(ed.difference_pairs(3, True)) == 6
    assert ed.difference_pairs(1, False) == []


def test_missing_pins_is_usage_error(tmp_path: Path) -> None:
    assert ed.main(["--data-dir", str(tmp_path), "--out", str(tmp_path / "d"), "--no-api"]) == 2


def _companion_data(tmp_path: Path) -> Path:
    data = make_data(tmp_path)
    mover = "1111111111111111"
    img = "2222222222222222"
    (data / "manifests" / f"{mover}.json").write_text(
        json.dumps({"f": [{"url": f"/frames/{img}.webp", "fits_url": f"/frames/{img}.fits"}]}),
        encoding="utf-8",
    )
    (data / "frames" / f"{img}.webp").write_bytes(b"w")
    (data / "frames" / f"{img}.fits").write_bytes(b"f")
    return data


def test_collect_frames_can_skip_fits(tmp_path: Path) -> None:
    data = _companion_data(tmp_path)
    plan = ed.Plan()
    text = '"/frames/2222222222222222.webp" "/frames/2222222222222222.fits"'
    assert ed.collect_frames(plan, data, text, "t", fits=False)
    assert sorted(plan.files) == ["frames/2222222222222222.webp"]


def test_movers_and_wise_are_exported_through_the_api(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = _companion_data(tmp_path)
    mover = "1111111111111111"
    neossat_frame = "fedcba9876543210"
    docs: dict[str, object] = {
        "/api/v1/movers": [{"sequences": [{"sequence_id": mover}]}],
        f"/api/v1/movers/{mover}/spectrum": {"ok": 1},
        f"/api/v1/movers/{mover}/ephemeris-check": {"ok": 2},
        f"/api/v1/movers/{mover}/neossat": {"items": [{"url": f"/frames/{neossat_frame}.webp"}]},
        f"/api/v1/sequences/{SID}/wise": {"frames": [f"/frames/{neossat_frame}.webp"]},
        f"/api/v1/sequences/{SID}/wise/astrometry": {"fit": {}},
    }

    def fake(_base: str, path: str, timeout: float = 0) -> tuple[int, bytes]:
        if path in docs:
            return 200, json.dumps(docs[path]).encode()
        return 204 if path.endswith("/wise") else 404, b""

    monkeypatch.setattr(ed, "api_get", fake)
    plan = ed.Plan()
    plan.data_dir = data
    args = type("A", (), {"api": "http://x"})()
    ed.add_movers(plan, args, True)  # type: ignore[arg-type]
    ed.add_wise(plan, args, True, {"barnard": SID})  # type: ignore[arg-type]
    names = set(plan.files)
    assert {"movers.json", f"movers/{mover}/spectrum.json", f"movers/{mover}/neossat.json"} <= names
    assert f"movers/{mover}/ephemeris-check.json" in names
    assert f"manifests/{mover}.json" in names
    assert "frames/2222222222222222.webp" in names and "frames/2222222222222222.fits" not in names
    assert f"wise/{SID}.json" in names and f"wise/{SID}.astrometry.json" in names
    index = json.loads(plan.files["wise/index.json"])  # type: ignore[arg-type]
    assert index == {"sequences": {SID: {"astrometry": True, "manifest": True}}}


def test_wise_index_is_empty_without_companions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(ed, "api_get", lambda *a, **k: (204, b""))
    plan = ed.Plan()
    plan.data_dir = make_data(tmp_path)
    ed.add_wise(plan, type("A", (), {"api": "http://x"})(), True, {"barnard": SID})  # type: ignore[arg-type]
    assert json.loads(plan.files["wise/index.json"]) == {"sequences": {}}  # type: ignore[arg-type]
