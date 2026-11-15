"""F-33 moving-target routes: stored spectrum and ephemeris check, listing, id validation."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.integration.test_api_endpoints import Env

SID = "185a019a79afea27"
OLD = "a051a453da11f79b"


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def store(env: Env, sid: str, t_start: str) -> None:
    d = env.settings.data_dir
    (d / "manifests").mkdir(parents=True, exist_ok=True)
    (d / "movers" / sid).mkdir(parents=True, exist_ok=True)
    manifest = {
        "sequence_id": sid,
        "moving_target": {
            "designation": "3I/ATLAS",
            "name": "ATLAS (C/2025 N1)",
            "horizons_record": 90004937,
            "solution": "JPL#55",
            "campaigns": [{"index": 0, "t_start": t_start}],
            "spectrum_url": f"/api/v1/movers/{sid}/spectrum",
            "ephemeris_check_url": f"/api/v1/movers/{sid}/ephemeris-check",
        },
    }
    (d / "manifests" / f"{sid}.json").write_text(json.dumps(manifest), encoding="utf-8")
    (d / "manifests" / "ffffffffffffffff.json").write_text(
        json.dumps({"sequence_id": "ffffffffffffffff"}), encoding="utf-8"
    )
    (d / "movers" / sid / "spectrum.json").write_text(
        json.dumps({"sequence_id": sid, "points": [], "bands": {}}), encoding="utf-8"
    )
    (d / "movers" / sid / "ephemeris_check.json").write_text(
        json.dumps({"sequence_id": sid, "campaigns": {"0": {"status": "pass"}}}), encoding="utf-8"
    )


def test_spectrum_and_check_serve_stored_json(env: Env) -> None:
    store(env, SID, "2025-12-08T00:00:00Z")
    with env.client() as c:
        a = c.get(f"/api/v1/movers/{SID}/spectrum")
        b = c.get(f"/api/v1/movers/{SID}/ephemeris-check")
    assert a.status_code == 200 and a.json()["sequence_id"] == SID
    assert b.status_code == 200 and b.json()["campaigns"]["0"]["status"] == "pass"


def test_unknown_and_malformed_ids(env: Env) -> None:
    with env.client() as c:
        missing = c.get(f"/api/v1/movers/{SID}/spectrum")
        bad = c.get("/api/v1/movers/..%2F..%2Fvalidation/spectrum")
        short = c.get("/api/v1/movers/abc/ephemeris-check")
    assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"
    assert bad.status_code in (404, 422)
    assert short.status_code == 422 and short.json()["code"] == "INVALID_SEQUENCE_ID"


def test_listing_groups_campaigns_newest_first(env: Env) -> None:
    store(env, SID, "2025-12-08T00:00:00Z")
    store(env, OLD, "2025-08-05T00:00:00Z")
    with env.client() as c:
        r = c.get("/api/v1/movers")
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 1 and items[0]["designation"] == "3I/ATLAS"
    assert items[0]["kind"]["en"] == "Moving target" and set(items[0]["kind"]) == {"en", "es"}
    assert [s["sequence_id"] for s in items[0]["sequences"]] == [SID, OLD]


def test_listing_empty_without_builds(env: Env) -> None:
    with env.client() as c:
        assert c.get("/api/v1/movers").json() == []


def test_neossat_document_is_served_or_not_found(env: Env) -> None:
    store(env, SID, "2025-12-08T00:00:00Z")
    with env.client() as c:
        missing = c.get(f"/api/v1/movers/{SID}/neossat")
    assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"
    doc = {"sequence_id": SID, "window_hours": 24.0, "credit": "x", "items": []}
    (env.settings.data_dir / "movers" / SID / "neossat.json").write_text(
        json.dumps(doc), encoding="utf-8"
    )
    with env.client() as c:
        ok = c.get(f"/api/v1/movers/{SID}/neossat")
        bad = c.get("/api/v1/movers/xyz/neossat")
    assert ok.status_code == 200 and ok.json()["window_hours"] == 24.0
    assert bad.status_code == 422
