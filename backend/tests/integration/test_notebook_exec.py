"""Headless execution of the generated notebook on recorded real data (F-36).

The cutouts are the real SPHEREx cutouts in tests/fixtures/cutouts and the Gaia answer is the
recorded MAST VOTable in tests/fixtures/gaia. They are placed in the notebook cache directory, so
the notebook runs without any network access. Nothing is simulated.
"""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

import pytest

from destello.models.manifest import Manifest
from destello.pipeline.notebook import build_notebook

FIX = Path(__file__).parent.parent / "fixtures"
MANIFEST = FIX / "notebook" / "barnard_manifest.json"
GAIA = FIX / "gaia" / "barnard_mast.xml"
CUTOUTS = FIX / "cutouts"

nbclient = pytest.importorskip("nbclient")
nbformat = pytest.importorskip("nbformat")
pytest.importorskip("matplotlib")


def cutout_file(obs_id: str) -> Path:
    m = re.match(r"level2_(.+)D(\d)_spx_", obs_id)
    assert m
    return CUTOUTS / f"{m[1]}_D{m[2]}.fits"


def missing_fixtures(manifest: Manifest) -> str | None:
    if not GAIA.exists():
        return f"recorded Gaia answer missing: {GAIA}"
    for e in manifest.epochs:
        for f in e.frames:
            for o in f.obs_ids:
                if not cutout_file(o).exists():
                    return f"recorded cutout missing: {cutout_file(o)}"
    return None


def test_notebook_runs_headless_on_recorded_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    if not MANIFEST.exists():
        pytest.skip(f"recorded manifest missing: {MANIFEST}")
    manifest = Manifest.model_validate(json.loads(MANIFEST.read_text(encoding="utf-8")))
    reason = missing_fixtures(manifest)
    if reason:
        pytest.skip(reason)
    cache = tmp_path / "cache"
    cache.mkdir()
    for e in manifest.epochs:
        for f in e.frames:
            for o in f.obs_ids:
                shutil.copy(cutout_file(o), cache / f"{o}.fits")
    shutil.copy(GAIA, cache / "gaia_dr3.vot")
    monkeypatch.setenv("DESTELLO_CACHE_DIR", str(cache))

    node = nbformat.from_dict(build_notebook(manifest, "https://destello.test"))
    client = nbclient.NotebookClient(
        node, timeout=300, kernel_name="python3", resources={"metadata": {"path": str(tmp_path)}}
    )
    client.execute()

    out = "\n".join(
        o.get("text", "")
        for c in node.cells
        if c.cell_type == "code"
        for o in c.outputs
        if o.get("output_type") == "stream"
    )
    assert "12 images: 12 from the local cache, 0 downloaded, 0 failed" in out
    assert "bit  0  TRANSIENT" in out  # bits come from the FLAGS header
    assert "Gaia DR3 sources read from the local cache" in out
    assert "Epoch 3, D6" in out
    kinds = {o.get("output_type") for c in node.cells if c.cell_type == "code" for o in c.outputs}
    assert "error" not in kinds
    html = [
        o
        for c in node.cells
        if c.cell_type == "code"
        for o in c.outputs
        if "data" in o and "text/html" in o["data"]
    ]
    assert html, "the blink animation was not produced"
