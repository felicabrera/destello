"""F-29 candidates endpoint. Synthetic coadds exist only to exercise the code path; the product
never produces or serves simulated data. No network: catalogs are fakes.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from astropy.io import fits

from destello.api.derived import grid_from_manifest
from destello.models.catalog import CatalogSource
from tests.integration.test_api_endpoints import SID, Env, assert_problem, write_manifest

NOISE = 0.02
STARS = [(20, 20), (40, 90), (80, 30), (95, 95), (60, 60), (25, 70), (100, 55)]
MOVER_B, MOVER_A = (40, 50), (43, 50)  # epoch 0 (b) and epoch 1 (a)
NEW = (75, 75)  # present only in epoch 1, in both detectors
ONE_DETECTOR = (30, 100)  # present only in epoch 1 of detector 5
URL = f"/api/v1/sequences/{SID}/candidates"


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def blob(x: float, y: float, flux: float) -> np.ndarray:
    yy, xx = np.mgrid[0:116, 0:116]
    return flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.6**2))


def coadd(det: int, epoch: int) -> np.ndarray:
    rng = np.random.default_rng(det * 10 + epoch)
    img = rng.normal(0.0, NOISE, (116, 116))
    gain = 1.0 if epoch == 0 else 1.2
    for k, (x, y) in enumerate(STARS):
        img += blob(x, y, gain * (5.0 + k))
    img += blob(*(MOVER_B if epoch == 0 else MOVER_A), 3.0)
    if epoch == 1:
        img += blob(*NEW, 3.0)
        if det == 5:
            img += blob(*ONE_DETECTOR, 3.0)
    return img


def make_env(env: Env) -> dict[str, Any]:
    doc = write_manifest(env.settings, SID, epochs=2, frames=True)
    env.settings.frames_dir.mkdir(parents=True, exist_ok=True)
    builds = env.settings.data_dir / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    (builds / f"{SID}.json").write_text(json.dumps({"exposures": []}), encoding="utf-8")
    header = grid_from_manifest(doc).wcs().to_header()
    for i, ep in enumerate(doc["epochs"]):
        for f in ep["frames"]:
            name = f["fits_url"].rsplit("/", 1)[-1]
            img = coadd(f["detector"], i).astype(np.float32)
            var = np.full(img.shape, NOISE**2, dtype=np.float32)
            fits.HDUList(
                [fits.PrimaryHDU(img, header=header), fits.ImageHDU(var, name="VARIANCE")]
            ).writeto(env.settings.frames_dir / name)
    return doc


def sky(doc: dict[str, Any], xy: tuple[float, float]) -> tuple[float, float]:
    ra, dec = grid_from_manifest(doc).wcs().all_pix2world(xy[0], xy[1], 0)
    return float(ra), float(dec)


def source(doc: dict[str, Any], xy: tuple[float, float], catalog: str = "gaia_dr3") -> Any:
    ra, dec = sky(doc, xy)
    return CatalogSource(catalog, "known-1", ra, dec, 0.0, 0.0, None, 2016.0, 15.0, "G")


def test_candidates_lists_mover_and_new_source_and_drops_single_detector(env: Env) -> None:
    doc = make_env(env)
    env.gaia.sources = [source(doc, NEW)]
    with env.client() as c:
        r = c.get(URL, params={"a": 1, "b": 0})
        again = c.get(URL, params={"a": 1, "b": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert again.json() == body and env.gaia.calls == 1 and env.catwise.calls == 1
    assert body["catalogs"] == {"gaia_dr3": "ok", "catwise2020": "ok"}
    assert body["threshold_sigma"] == 5.0 and body["min_detectors_unpaired"] == 2
    assert [d["detector"] for d in body["detectors"]] == [5, 6]
    assert all(d["usable"] for d in body["detectors"])
    cands = body["candidates"]
    assert [(e["id"], e["kind"], e["status"]) for e in cands] == [
        ("c1", "moved", "unmatched"),
        ("c2", "brighter_in_a", "known_source"),
    ]
    assert body["counts"]["single_detector_dropped"] == 1 and body["counts"]["listed"] == 2
    assert body["truncated"] is False
    moved, new = cands
    assert moved["detectors"] == [5, 6] and moved["match"] is None
    # frame pixel EDGE coordinates, y down from the top edge (north up)
    assert abs(moved["a"]["x"] - (MOVER_A[0] + 0.5)) <= 1.5
    assert abs(moved["b"]["x"] - (MOVER_B[0] + 0.5)) <= 1.5
    assert abs(moved["a"]["y"] - (116 - MOVER_A[1] - 0.5)) <= 1.0
    assert 6.0 < moved["separation_arcsec"] <= 12.4
    ra, dec = sky(doc, NEW)
    assert abs(new["ra_deg"] - ra) < 1e-3 and abs(new["dec_deg"] - dec) < 1e-3
    assert new["a"] is None and new["separation_arcsec"] is None
    assert new["match"]["catalog"] == "gaia_dr3" and new["match"]["source_id"] == "known-1"
    assert new["match"]["sep_arcsec"] <= 6.2


def test_candidates_with_a_catalog_down_are_unchecked_and_not_cached(env: Env) -> None:
    doc = make_env(env)
    env.gaia.sources = [source(doc, NEW)]
    env.catwise.fail = True
    with env.client() as c:
        body = c.get(URL, params={"a": 1, "b": 0}).json()
        keys = c.portal.call(env.redis.keys, "destello:cand:*")  # type: ignore[union-attr]
        env.catwise.fail = False
        healed = c.get(URL, params={"a": 1, "b": 0}).json()
        keys2 = c.portal.call(env.redis.keys, "destello:cand:*")  # type: ignore[union-attr]
    assert body["catalogs"] == {"gaia_dr3": "ok", "catwise2020": "unavailable"}
    assert [e["status"] for e in body["candidates"]] == ["unchecked", "known_source"]
    assert body["counts"]["unmatched"] == 0 and keys == []
    assert [e["status"] for e in healed["candidates"]] == ["unmatched", "known_source"]
    assert len(keys2) == 1


def test_candidates_swapped_epochs_swap_the_lobes(env: Env) -> None:
    make_env(env)
    with env.client() as c:
        body = c.get(URL, params={"a": 0, "b": 1}).json()
    kinds = {e["kind"] for e in body["candidates"]}
    assert kinds == {"moved", "brighter_in_b"}
    moved = next(e for e in body["candidates"] if e["kind"] == "moved")
    assert abs(moved["a"]["x"] - (MOVER_B[0] + 0.5)) <= 1.5


def test_candidates_errors(env: Env) -> None:
    make_env(env)
    with env.client() as c:
        assert_problem(c.get(URL, params={"a": 0, "b": 0}), 422, "INVALID_EPOCHS")
        assert_problem(c.get(URL, params={"a": 0, "b": 5}), 422, "INVALID_EPOCHS")
        assert c.get(URL, params={"a": -1, "b": 0}).status_code == 422
        assert c.get(URL).status_code == 422
        assert_problem(
            c.get("/api/v1/sequences/ffffffffffffffff/candidates", params={"a": 0, "b": 1}),
            404,
            "NOT_FOUND",
        )


def test_candidates_need_two_epochs(env: Env) -> None:
    write_manifest(env.settings, SID, epochs=1)
    builds = env.settings.data_dir / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    (builds / f"{SID}.json").write_text("{}", encoding="utf-8")
    with env.client() as c:
        assert_problem(c.get(URL, params={"a": 0, "b": 1}), 422, "TOO_FEW_EPOCHS")


def test_unpaired_lobe_three_pixels_from_missing_data_is_not_measurable(env: Env) -> None:
    doc = make_env(env)
    for f in doc["epochs"][1]["frames"]:
        path = env.settings.frames_dir / f["fits_url"].rsplit("/", 1)[-1]
        with fits.open(path, mode="update") as hdul:
            hdul[0].data[NEW[1], NEW[0] + 3] = np.nan
    with env.client() as c:
        body = c.get(URL, params={"a": 1, "b": 0}).json()
    new = next(e for e in body["candidates"] if e["kind"] == "brighter_in_a")
    assert new["status"] == "not_measurable" and body["counts"]["not_measurable"] == 1
    assert body["target_wing_radius_arcsec"] == 30.0


def test_candidates_are_not_searched_in_a_low_coverage_epoch(env: Env) -> None:
    make_env(env)
    path = env.settings.manifests_dir / f"{SID}.json"
    doc = json.loads(path.read_text("utf-8"))
    doc["epochs"][1]["coverage"] = "low"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with env.client() as c:
        assert_problem(c.get(URL, params={"a": 1, "b": 0}), 422, "LOW_COVERAGE_EPOCH")
