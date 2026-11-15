"""F-32 motion search endpoint. Synthetic coadds exist only to exercise the code path; the
product never produces or serves simulated data. No network: catalogs are fakes.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
import pytest
from astropy.io import fits
from astropy.time import Time

from destello.api.derived import grid_from_manifest
from destello.api.motion_search import MIN_PARALLAX_SIGMA, parallax_fields
from destello.models.catalog import CatalogSource
from destello.pipeline.propagate import parallax_factors
from tests.integration.test_api_endpoints import SID, Env, assert_problem, write_manifest

NOISE = 0.02
SCALE = 3.1  # arcsec per grid pixel (write_manifest)
STARS = [(20, 20), (40, 90), (80, 30), (95, 95), (60, 60), (25, 70), (100, 55), (85, 75)]
MOVER = (45.0, 40.0)  # array position at the mean epoch
V_PIX = (2.5, -1.0)  # array pixels per year: +x is west (east left), +y is north
T_MEAN_MJD = 60913.0 + 200.0  # write_manifest epochs at 60913, 61113, 61313
URL = f"/api/v1/sequences/{SID}/motion-search"


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def blob(x: float, y: float, flux: float) -> np.ndarray:
    yy, xx = np.mgrid[0:116, 0:116]
    return flux * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.6**2))


def mover_xy(
    mjd: float, t_mean: float = T_MEAN_MJD, plx: tuple[float, float] = (0.0, 0.0)
) -> tuple[float, float]:
    """`plx`: parallax displacement (alpha*, delta) in arcsec at `mjd`."""
    dt = (mjd - t_mean) / 365.25
    return (
        MOVER[0] + V_PIX[0] * dt - plx[0] / SCALE,
        MOVER[1] + V_PIX[1] * dt + plx[1] / SCALE,
    )


def coadd(det: int, epoch: int, xy: tuple[float, float]) -> np.ndarray:
    rng = np.random.default_rng(det * 10 + epoch)
    img = rng.normal(0.0, NOISE, (116, 116))
    gain = (1.0, 1.2, 0.9, 1.1)[epoch]
    for k, (x, y) in enumerate(STARS):
        img += blob(x, y, gain * (5.0 + k))
    img += blob(*xy, gain * 3.0)
    return img


def make_env(env: Env, epochs: int = 3, parallax_mas: float = 0.0) -> dict[str, Any]:
    doc = write_manifest(env.settings, SID, epochs=epochs, frames=True)
    env.settings.frames_dir.mkdir(parents=True, exist_ok=True)
    builds = env.settings.data_dir / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    (builds / f"{SID}.json").write_text(json.dumps({"exposures": []}), encoding="utf-8")
    header = grid_from_manifest(doc).wcs().to_header()
    mjds = [float(ep["t_mid_mjd"]) for ep in doc["epochs"]]
    ra, dec = sky(doc, MOVER)
    pa, pd = parallax_factors(ra * u.deg, dec * u.deg, Time(mjds, format="mjd", scale="utc"))
    p_arcsec = parallax_mas / 1000.0
    for i, ep in enumerate(doc["epochs"]):
        xy = mover_xy(mjds[i], float(np.mean(mjds)), (p_arcsec * pa[i], p_arcsec * pd[i]))
        for f in ep["frames"]:
            name = f["fits_url"].rsplit("/", 1)[-1]
            img = coadd(f["detector"], i, xy).astype(np.float32)
            var = np.full(img.shape, NOISE**2, dtype=np.float32)
            fits.HDUList(
                [fits.PrimaryHDU(img, header=header), fits.ImageHDU(var, name="VARIANCE")]
            ).writeto(env.settings.frames_dir / name)
    return doc


def sky(doc: dict[str, Any], xy: tuple[float, float]) -> tuple[float, float]:
    ra, dec = grid_from_manifest(doc).wcs().all_pix2world(xy[0], xy[1], 0)
    return float(ra), float(dec)


TRUE_PMRA = -V_PIX[0] * SCALE * 1000.0  # mas/yr, east is left
TRUE_PMDEC = V_PIX[1] * SCALE * 1000.0


def moving_source(doc: dict[str, Any]) -> CatalogSource:
    ra, dec = sky(doc, MOVER)
    t_ref = float(Time(T_MEAN_MJD, format="mjd", scale="utc").tdb.jyear)
    return CatalogSource(
        "gaia_dr3", "mover-1", ra, dec, TRUE_PMRA, TRUE_PMDEC, None, t_ref, 17.0, "G",
        pmra_err_masyr=0.5, pmdec_err_masyr=0.5,
    )  # fmt: skip


def test_motion_search_lists_the_mover_with_its_motion_and_track(env: Env) -> None:
    make_env(env)
    with env.client() as c:
        r = c.get(URL)
        again = c.get(URL)
    assert r.status_code == 200, r.text
    body = r.json()
    assert again.json() == body and env.gaia.calls == 1 and env.catwise.calls == 1
    assert body["catalogs"] == {"gaia_dr3": "ok", "catwise2020": "ok"}
    assert body["epochs"] == [0, 1, 2] and body["min_detectors"] == 2
    # three epochs: the parallax stays fixed and no distance is given
    assert body["parallax_fitted"] is False
    assert 1.0 < body["baseline_years"] < 1.2
    assert [d["detector"] for d in body["detectors"]] == [5, 6]
    assert all(d["usable"] and d["n_moving"] >= 1 for d in body["detectors"])
    assert body["counts"]["listed"] == 1 and body["truncated"] is False
    (src,) = body["sources"]
    assert src["id"] == "m1" and src["status"] == "unmatched" and src["match"] is None
    assert src["detectors"] == [5, 6]
    assert abs(src["pmra_masyr"] - TRUE_PMRA) < 3 * src["pmra_err_masyr"] + 300
    assert abs(src["pmdec_masyr"] - TRUE_PMDEC) < 3 * src["pmdec_err_masyr"] + 300
    assert src["parallax_mas"] is None and src["distance_pc"] is None
    # frame pixel EDGE coordinates, y down from the top edge (north up)
    assert abs(src["x"] - (MOVER[0] + 0.5)) <= 1.0
    assert abs(src["y"] - (116 - MOVER[1] - 0.5)) <= 1.0
    assert [p["epoch"] for p in src["track"]] == [0, 1, 2]
    for p, mjd in zip(src["track"], (60913.0, 61113.0, 61313.0), strict=True):
        mx, my = mover_xy(mjd)
        assert abs(p["x"] - (mx + 0.5)) <= 1.0 and abs(p["y"] - (116 - my - 0.5)) <= 1.0


def test_a_catalog_source_with_the_same_motion_is_known(env: Env) -> None:
    doc = make_env(env)
    env.gaia.sources = [moving_source(doc)]
    with env.client() as c:
        body = c.get(URL).json()
    (src,) = body["sources"]
    assert src["status"] == "known_source" and body["counts"]["known_source"] == 1
    m = src["match"]
    assert m["catalog"] == "gaia_dr3" and m["source_id"] == "mover-1" and m["sep_arcsec"] < 3.0
    assert m["agreement_sigma"] is not None and m["agreement_sigma"] < 3.0


def test_with_a_catalog_down_sources_are_unchecked_and_not_cached(env: Env) -> None:
    make_env(env)
    env.catwise.fail = True
    with env.client() as c:
        body = c.get(URL).json()
        keys = c.portal.call(env.redis.keys, "destello:motion:*")  # type: ignore[union-attr]
        env.catwise.fail = False
        healed = c.get(URL).json()
        keys2 = c.portal.call(env.redis.keys, "destello:motion:*")  # type: ignore[union-attr]
    assert body["catalogs"] == {"gaia_dr3": "ok", "catwise2020": "unavailable"}
    assert [e["status"] for e in body["sources"]] == ["unchecked"] and keys == []
    assert [e["status"] for e in healed["sources"]] == ["unmatched"] and len(keys2) == 1


def test_motion_search_needs_three_full_coverage_epochs(env: Env) -> None:
    make_env(env, epochs=2)
    with env.client() as c:
        assert_problem(c.get(URL), 422, "TOO_FEW_EPOCHS")
        assert_problem(c.get("/api/v1/sequences/ffffffffffffffff/motion-search"), 404, "NOT_FOUND")


def test_a_low_coverage_epoch_is_not_searched(env: Env) -> None:
    make_env(env)
    path = env.settings.manifests_dir / f"{SID}.json"
    doc = json.loads(path.read_text("utf-8"))
    doc["epochs"][2]["coverage"] = "low"
    path.write_text(json.dumps(doc), encoding="utf-8")
    with env.client() as c:
        assert_problem(c.get(URL), 422, "TOO_FEW_EPOCHS")


def test_four_epochs_over_a_year_fit_the_parallax_and_give_a_distance(env: Env) -> None:
    doc = make_env(env, epochs=4, parallax_mas=2500.0)
    src_cat = replace(moving_source(doc), parallax_mas=2500.0, parallax_err_mas=1.0)
    env.gaia.sources = [src_cat]
    with env.client() as c:
        body = c.get(URL).json()
    assert body["parallax_fitted"] is True and body["min_parallax_sigma"] == MIN_PARALLAX_SIGMA
    (src,) = body["sources"]
    assert src["parallax_sigma"] >= MIN_PARALLAX_SIGMA
    assert abs(src["parallax_mas"] - 2500.0) < 3 * src["parallax_err_mas"]
    assert abs(src["distance_pc"] - 0.4) < 3 * src["distance_err_pc"]
    assert src["match"]["parallax_mas"] == 2500.0
    assert src["match"]["parallax_agreement_sigma"] < 3.0
    # the track includes the parallax: every epoch within a pixel of the injected position
    mjds = [float(ep["t_mid_mjd"]) for ep in doc["epochs"]]
    ra, dec = sky(doc, MOVER)
    pa, pd = parallax_factors(ra * u.deg, dec * u.deg, Time(mjds, format="mjd", scale="utc"))
    for k, p in enumerate(src["track"]):
        mx, my = mover_xy(mjds[k], float(np.mean(mjds)), (2.5 * pa[k], 2.5 * pd[k]))
        assert abs(p["x"] - (mx + 0.5)) <= 1.0 and abs(p["y"] - (116 - my - 0.5)) <= 1.0


def test_parallax_fields_quote_a_distance_only_when_significant() -> None:
    assert parallax_fields(None, None)["parallax_mas"] is None
    weak = parallax_fields(200.0, 100.0)
    assert weak["parallax_sigma"] == 2.0 and weak["distance_pc"] is None
    strong = parallax_fields(400.0, 50.0)
    assert strong["distance_pc"] == 2.5 and strong["distance_err_pc"] == round(
        1000 * 50 / 400**2, 2
    )
