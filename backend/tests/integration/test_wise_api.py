"""F-40 routes: WISE companion manifest and stored long-baseline astrometry."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from destello.worker.wise_build import wise_sequence_id
from tests.integration.test_api_endpoints import Env

SID = "3bf0d84f65f4400c"


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def store(env: Env, band: str = "W2", spherex: str = SID) -> str:
    wsid = wise_sequence_id(SID, band, env.settings)
    d = env.settings.data_dir
    (d / "manifests").mkdir(parents=True, exist_ok=True)
    (d / "builds").mkdir(parents=True, exist_ok=True)
    doc = {"kind": "wise_companion", "sequence_id": wsid, "spherex_sequence_id": spherex,
           "band": band, "epochs": [], "stretch": {f"WISE:{band}": {"vmin": 0, "vmax": 1}},
           "warnings": []}  # fmt: skip
    (d / "manifests" / f"{wsid}.json").write_text(json.dumps(doc), encoding="utf-8")
    return wsid


def test_manifest_served_for_the_band(env: Env) -> None:
    store(env)
    r = env.client().get(f"/api/v1/sequences/{SID}/wise")
    assert r.status_code == 200
    assert r.json()["band"] == "W2"
    assert r.headers["cache-control"] == "no-cache"


def test_missing_companion_is_204_without_a_body(env: Env) -> None:
    r = env.client().get(f"/api/v1/sequences/{SID}/wise")
    assert r.status_code == 204
    assert r.content == b""


def test_other_band_is_not_returned_for_w2(env: Env) -> None:
    store(env, band="W1")
    assert env.client().get(f"/api/v1/sequences/{SID}/wise").status_code == 204
    assert env.client().get(f"/api/v1/sequences/{SID}/wise?band=W1").status_code == 200


def test_manifest_of_another_sequence_is_refused(env: Env) -> None:
    store(env, spherex="ffffffffffffffff")
    assert env.client().get(f"/api/v1/sequences/{SID}/wise").status_code == 204


def test_invalid_ids_and_bands(env: Env) -> None:
    c = env.client()
    assert c.get("/api/v1/sequences/zz/wise").status_code == 422
    assert c.get(f"/api/v1/sequences/{SID}/wise?band=W9").status_code == 422


def test_astrometry_strips_recalibration_lists(env: Env) -> None:
    wsid = store(env)
    fit = {"status": "pass", "fit": {"pmra_masyr": 1.0},
           "rows": [{"mission": "WISE", "index": 0, "recalibration": {"star_ids": ["1"]}}],
           "residuals": []}  # fmt: skip
    p = env.settings.data_dir / "builds" / f"{wsid}.longbaseline.json"
    p.write_text(json.dumps(fit), encoding="utf-8")
    r = env.client().get(f"/api/v1/sequences/{SID}/wise/astrometry")
    assert r.status_code == 200
    body = r.json()
    assert body["fit"]["pmra_masyr"] == 1.0
    assert "recalibration" not in body["rows"][0]


def test_astrometry_204_without_stored_fit(env: Env) -> None:
    store(env)
    r = env.client().get(f"/api/v1/sequences/{SID}/wise/astrometry")
    assert r.status_code == 204
    assert r.content == b""
