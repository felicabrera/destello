"""Notebook generator (F-36): valid nbformat, manifest content present, route behavior."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import nbformat
import pytest
from fastapi.testclient import TestClient

from destello.api.deps import AppState
from destello.api.main import create_app
from destello.core.config import Settings
from destello.models.manifest import Manifest
from destello.pipeline import notebook as nb

FIXTURE = Path(__file__).parent.parent / "fixtures" / "notebook" / "barnard_manifest.json"
DOC17 = Path(__file__).resolve().parents[3] / "docs" / "17-data-resources.md"
SID = "9e2430a33e56af09"
PUBLIC = "https://destello.test"


def manifest() -> Manifest:
    return Manifest.model_validate(json.loads(FIXTURE.read_text(encoding="utf-8")))


def source_text(doc: dict[str, Any]) -> str:
    return "\n".join(c["source"] for c in doc["cells"])


def test_valid_nbformat_and_cell_kinds() -> None:
    doc = nb.build_notebook(manifest(), PUBLIC)
    node = nbformat.from_dict(doc)
    nbformat.validate(node)
    kinds = [c["cell_type"] for c in doc["cells"]]
    assert kinds.count("code") >= 6 and kinds.count("markdown") >= 6
    for c in doc["cells"]:
        if c["cell_type"] == "code":
            compile(
                c["source"].replace("%matplotlib inline", "").replace("%pip", "#"), c["id"], "exec"
            )


def test_manifest_content_is_present() -> None:
    m = manifest()
    text = source_text(nb.build_notebook(m, PUBLIC))
    ids = {o for e in m.epochs for f in e.frames for o in f.obs_ids}
    assert ids and all(o in text for o in ids)
    assert all(d in text for d in m.provenance.dois)
    assert all(c in text for c in m.provenance.collections)
    assert f"{PUBLIC}/?seq={SID}" in text
    assert "ibe/data/spherex/qr2/level2/2025W33_2C/l2b-v20-2025-266/6/" in text
    assert "mast.stsci.edu/vo-tap/api/v0.1/gaiadr3" in text and "dbo.gaia_source" in text
    assert "simplified reproduction" in text


def test_no_em_dash_no_placeholders() -> None:
    raw = nb.notebook_json(manifest(), PUBLIC)
    assert "—" not in json.loads(raw)["cells"][0]["source"]
    assert "—" not in source_text(json.loads(raw))
    for word in ("TODO", "FIXME", "lorem", "placeholder", "__"):
        body = re.sub(r"__init__|__name__", "", source_text(json.loads(raw)))
        assert word not in body or word == "__" and "__" not in body, word


def test_flag_bits_not_hardcoded() -> None:
    text = source_text(nb.build_notebook(manifest(), PUBLIC))
    assert "MSKN" in text and "FLAGS" in text
    assert not re.search(r">>\s*\d+\b", text)


def test_free_text_is_rejected_or_escaped() -> None:
    m = manifest()
    bad = m.model_copy(deep=True)
    bad.epochs[0].frames[0].obs_ids[0] = "x'); import os; ('"
    with pytest.raises(nb.NotebookError):
        nb.build_notebook(bad, PUBLIC)
    warn = m.model_copy(deep=True)
    warn.warnings[0].detail = "a — b <script>alert(1)</script> `x`"
    text = source_text(nb.build_notebook(warn, PUBLIC))
    assert "—" not in text and "<script>" not in text


def test_acknowledgement_strings_match_docs17() -> None:
    if not DOC17.exists():
        pytest.skip("docs/17 is not available")
    doc = " ".join(DOC17.read_text(encoding="utf-8").split())
    for s in nb.DOCS17_STRINGS:
        assert s in doc, s


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    settings = Settings(data_dir=tmp_path, env="development", ip_hash_salt="s", public_url=PUBLIC)
    (tmp_path / "manifests").mkdir()
    (tmp_path / "manifests" / f"{SID}.json").write_text(FIXTURE.read_text(encoding="utf-8"))
    state = AppState(settings=settings, redis=fakeredis.aioredis.FakeRedis(), queue=object())
    return TestClient(create_app(settings, state=state), raise_server_exceptions=False)


def test_route_returns_attachment(client: TestClient) -> None:
    r = client.get(f"/api/v1/sequences/{SID}/notebook")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ipynb+json")
    assert f'filename="destello-{SID}.ipynb"' in r.headers["content-disposition"]
    nbformat.validate(nbformat.reads(r.text, as_version=4))
    assert SID in r.text


def test_route_errors(client: TestClient) -> None:
    bad = client.get("/api/v1/sequences/NOT-AN-ID/notebook")
    assert bad.status_code == 422 and bad.json()["code"] == "INVALID_SEQUENCE_ID"
    missing = client.get("/api/v1/sequences/0000000000000000/notebook")
    assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"


def test_openapi_lists_route(client: TestClient) -> None:
    spec = client.get("/api/v1/openapi.json").json()
    assert "/api/v1/sequences/{sid}/notebook" in spec["paths"]
