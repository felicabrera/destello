"""API integration tests: every endpoint, validation, rate limits, SSRF and path traversal.

Redis is fakeredis, the arq queue and the source clients are fakes, the data directory is a
temporary directory. No network is used. The synthetic FITS files in these tests exist only to
exercise the image code paths; the product itself never produces or serves simulated data.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import fakeredis.aioredis
import numpy as np
import pytest
from astropy.io import fits
from astropy.time import Time
from fastapi.testclient import TestClient
from PIL import Image

from destello.api.deps import AppState
from destello.api.derived import propagate_to_epoch, to_frame_pixels
from destello.api.main import create_app
from destello.core import ratelimit
from destello.core.config import Settings
from destello.models.catalog import CatalogSource
from destello.models.targets import load_targets
from destello.pipeline.propagate import apparent_positions
from destello.pipeline.reproject import GridSpec
from destello.sources.base import SourceUnavailable
from destello.sources.irsa import ReleaseInfo
from destello.sources.simbad import SimbadObject
from destello.worker import jobs
from destello.worker.jobs import (
    SequenceParams,
    params_sequence_id,
    preset_params,
)
from destello.worker.main import WorkerSettings

SALT = "test-salt"
SID = "0123456789abcdef"


class FakeQueue:
    def __init__(self) -> None:
        self.jobs: list[tuple[str, dict[str, Any], str]] = []
        self.ids: set[str] = set()
        self.kwargs: list[dict[str, Any]] = []

    async def enqueue_job(
        self, name: str, params: dict[str, Any], _job_id: str, **kwargs: Any
    ) -> object | None:
        if _job_id in self.ids:
            return None
        self.ids.add(_job_id)
        self.jobs.append((name, params, _job_id))
        self.kwargs.append(kwargs)
        return object()


class FakeIrsa:
    def __init__(self, n: int = 40, fail: bool = False) -> None:
        self.n = n
        self.fail = fail
        self.calls = 0
        self.resolved: Any = None
        self.resolve_fail = False
        self.resolve_names: list[str] = []

    async def resolve_name(self, name: str) -> Any:
        self.resolve_names.append(name)
        if self.resolve_fail:
            raise SourceUnavailable("irsa resolver down")
        return self.resolved

    async def query_images(self, *_a: Any, **_k: Any) -> list[Any]:
        self.calls += 1
        if self.fail:
            raise SourceUnavailable("irsa down")
        return [
            SimpleNamespace(t_mid=Time(60800.0 + i * 0.01, format="mjd"), detector=i % 6 + 1)
            for i in range(self.n)
        ]

    async def health(self) -> str:
        return "ok"

    async def list_releases(self) -> list[ReleaseInfo]:
        return [
            ReleaseInfo("spherex_qr3", 10, "2026-11-05T00:00:00", 61300.0),
            ReleaseInfo("spherex_qr3_deep", 1, "2026-10-01T00:00:00", 61290.0),
            ReleaseInfo("spherex_dr1", 10, "2026-10-09T00:00:00", 61174.0),
        ]

    async def aclose(self) -> None:
        return None


class FakeCatalog:
    def __init__(self, sources: list[CatalogSource] | None = None, fail: bool = False) -> None:
        self.sources = sources or []
        self.fail = fail
        self.calls = 0

    async def cone(self, *_a: Any, **_k: Any) -> list[CatalogSource]:
        self.calls += 1
        if self.fail:
            raise SourceUnavailable("catalog down")
        return self.sources

    async def aclose(self) -> None:
        return None


class FakeSimbad:
    def __init__(self, obj: SimbadObject | None = None, fail: bool = False) -> None:
        self.obj = obj
        self.fail = fail
        self.names: list[str] = []

    async def resolve(self, name: str) -> SimbadObject | None:
        self.names.append(name)
        if self.fail:
            raise SourceUnavailable("cds unreachable")
        return self.obj

    async def aclose(self) -> None:
        return None


class FakeSesame:
    """Defaults to a failing mirror so tests that do not care keep the SIMBAD-only behaviour."""

    def __init__(self, obj: SimbadObject | None = None, fail: bool = True) -> None:
        self.obj = obj
        self.fail = fail
        self.names: list[str] = []

    async def resolve(self, name: str) -> SimbadObject | None:
        self.names.append(name)
        if self.fail:
            raise SourceUnavailable("mirror down")
        return self.obj

    async def aclose(self) -> None:
        return None


class Env:
    def __init__(self, tmp: Path, env: str = "development") -> None:
        self.settings = Settings(data_dir=tmp, env=env, ip_hash_salt=SALT)
        self.redis = fakeredis.aioredis.FakeRedis()
        self.queue = FakeQueue()
        self.irsa = FakeIrsa()
        self.gaia = FakeCatalog()
        self.catwise = FakeCatalog()
        self.simbad = FakeSimbad()
        self.sesame = FakeSesame()
        self.state = AppState(
            settings=self.settings,
            redis=self.redis,
            queue=self.queue,
            irsa=self.irsa,  # type: ignore[arg-type]
            gaia=self.gaia,  # type: ignore[arg-type]
            catwise=self.catwise,  # type: ignore[arg-type]
            simbad=self.simbad,  # type: ignore[arg-type]
            sesame=self.sesame,  # type: ignore[arg-type]
        )
        self.app = create_app(self.settings, state=self.state)

    def client(self) -> TestClient:
        return TestClient(self.app, raise_server_exceptions=False)


@pytest.fixture
def env(tmp_path: Path) -> Env:
    return Env(tmp_path)


def write_manifest(
    settings: Settings, sid: str = SID, epochs: int = 3, frames: bool = False
) -> dict[str, Any]:
    settings.manifests_dir.mkdir(parents=True, exist_ok=True)
    eps = []
    for i in range(epochs):
        fr: list[dict[str, Any]] = []
        if frames:
            for det in (5, 6):
                fr.append(
                    {
                        "detector": det,
                        "kind": "coadd",
                        "url": f"/frames/{i}{det}00000000000000.webp"[:25],
                        "fits_url": f"/frames/{det}{i}{'0' * 14}.fits",
                        "n_images": 18,
                    }
                )
        eps.append({"index": i, "t_mid_mjd": 60913.0 + 200.0 * i, "n_images": 100, "frames": fr})
    doc = {
        "sequence_id": sid,
        "grid": {
            "projection": "TAN",
            "crval_deg": [269.44635, 4.76841],
            "pixel_scale_arcsec": 3.1,
            "naxis": [116, 116],
        },
        "epochs": eps,
    }
    (settings.manifests_dir / f"{sid}.json").write_text(json.dumps(doc), encoding="utf-8")
    return doc


def post(client: TestClient, **over: Any) -> Any:
    body = {"ra_deg": 133.79513, "dec_deg": -7.24515, "fov_arcmin": 4, "detectors": [1, 2]}
    body.update(over)
    return client.post("/api/v1/sequences", json=body)


def assert_problem(r: Any, status: int, code: str) -> dict[str, Any]:
    assert r.status_code == status, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == code and body["status"] == status
    assert {"type", "title", "detail", "instance"} <= set(body)
    return body  # type: ignore[no-any-return]


# ------------------------------------------------------------------ meta
def test_releases(env: Env) -> None:
    with env.client() as c:
        r = c.get("/api/v1/releases")
    assert r.status_code == 200
    body = r.json()
    assert body["default"] == "all"  # what a sequence request without `release` uses
    by = {x["collection"]: x for x in body["releases"]}
    assert by["spherex_qr3"]["data_as_of"] == "2026-11-05"
    assert by["spherex_qr3"]["doi"] == "10.26131/IRSA662"
    assert by["spherex_dr1"]["label"] == "Data Release 1"
    assert by["spherex_dr1"]["doi"] == "10.26131/IRSA678"
    assert by["spherex_dr1"]["data_as_of"] == "2026-10-09"
    assert "spherex_qr2" not in by  # retired by IRSA, never offered


def test_releases_survive_irsa_failure(env: Env) -> None:
    async def boom() -> list[ReleaseInfo]:
        raise SourceUnavailable("down")

    env.irsa.list_releases = boom  # type: ignore[method-assign]
    with env.client() as c:
        r = c.get("/api/v1/releases")
    assert r.status_code == 200 and r.json()["releases"][0]["data_as_of"] == ""


def test_releases_read_the_cron_cache_before_irsa(env: Env) -> None:
    calls: list[int] = []

    async def counted() -> list[ReleaseInfo]:
        calls.append(1)
        raise SourceUnavailable("down")

    env.irsa.list_releases = counted  # type: ignore[method-assign]
    rows = [
        {"collection": "spherex_qr3", "n_planes": 9, "latest_pub_date": "2026-11-09T10:00:00"},
        {"collection": "spherex_qr3_deep", "n_planes": 1, "latest_pub_date": "2026-11-10"},
    ]
    with env.client() as c:
        c.portal.call(env.redis.set, "destello:releases", json.dumps(rows))  # type: ignore[union-attr]
        r = c.get("/api/v1/releases")
    by = {x["collection"]: x for x in r.json()["releases"]}
    assert by["spherex_qr3"]["data_as_of"] == "2026-11-10" and calls == []


def test_releases_store_a_fresh_irsa_answer(env: Env) -> None:
    with env.client() as c:
        c.get("/api/v1/releases")
        raw = c.portal.call(env.redis.get, "destello:releases")  # type: ignore[union-attr]
    assert any(row["collection"] == "spherex_qr3" for row in json.loads(raw))


def test_targets_shape_and_no_invented_results(env: Env) -> None:
    with env.client() as c:
        r = c.get("/api/v1/targets")
    assert r.status_code == 200
    items = r.json()
    assert [t["id"] for t in items] == list(load_targets())
    b = next(t for t in items if t["id"] == "barnard")
    assert set(b["names"]) == {"en", "es"}
    assert 0 <= b["ra_deg"] < 360 and -90 <= b["dec_deg"] <= 90
    assert b["astrometry"]["ref_epoch"] == "J2016.0" and b["astrometry"]["pmdec_masyr"] > 10000
    assert b["default_view"]["fov_arcmin"] == 6
    assert b["sequence_id"] is None and b["result"] is None
    assert all(t["result"] is None for t in items)


def test_targets_report_built_sequence_and_measured_result(env: Env) -> None:
    t = load_targets()["barnard"]
    sid = params_sequence_id(preset_params(t), env.settings)
    write_manifest(env.settings, sid)
    (env.settings.data_dir / "validation.json").write_text(
        json.dumps(
            {
                "tests": [
                    {
                        "target": "barnard",
                        "status": "pass",
                        "measured": 10.4,
                        "unit": "arcsec/yr",
                        "reference": 10.39,
                        "source": "Gaia DR3",
                        "sigma": 0.3,
                        "err": 0.2,
                    },
                    {"target": "rdra", "status": "not_measurable", "reason": "x"},
                ]
            }
        ),
        encoding="utf-8",
    )
    with env.client() as c:
        items = {x["id"]: x for x in c.get("/api/v1/targets").json()}
        v = c.get("/api/v1/validation")
    assert items["barnard"]["sequence_id"] == sid
    res = items["barnard"]["result"]
    assert res["kind"] == "motion" and res["value"] == 10.4 and res["agreement_sigma"] == 0.3
    assert items["rdra"]["result"] is None
    assert v.status_code == 200 and v.json()["tests"][0]["target"] == "barnard"


def test_targets_never_publish_counts_or_offsets_as_results(env: Env) -> None:
    (env.settings.data_dir / "validation.json").write_text(
        json.dumps(
            {
                "tests": [
                    {
                        "target": "rdra",
                        "id": "V-10",
                        "measured": 2.0,
                        "unit": "count",
                        "reference": 0.0,
                    },
                    {"target": "rwaur", "id": "V-01", "measured": 0.4, "unit": "arcsec"},
                    {
                        "target": "rwaur",
                        "id": "V-07",
                        "measured": -0.4,
                        "unit": "mag",
                        "sigma": 14.0,
                    },
                ],
                "results": {"epsindib": {"kind": "variability", "value": 3.0, "unit": "count"}},
            }
        ),
        encoding="utf-8",
    )
    with env.client() as c:
        items = {x["id"]: x for x in c.get("/api/v1/targets").json()}
    assert items["rdra"]["result"] is None
    assert items["epsindib"]["result"] is None
    assert items["rwaur"]["result"]["unit"] == "mag"


def test_target_result_is_the_targeted_measurement_not_the_blind_search(env: Env) -> None:
    blind = {"target": "epsindib", "id": "V-11", "measured": 4542.7, "unit": "mas/yr"}
    targeted = {"target": "epsindib", "id": "V-04", "measured": 4650.0, "unit": "mas/yr"}
    (env.settings.data_dir / "validation.json").write_text(
        json.dumps({"tests": [blind, targeted]}), encoding="utf-8"
    )
    with env.client() as c:
        items = {x["id"]: x for x in c.get("/api/v1/targets").json()}
    assert items["epsindib"]["result"]["value"] == 4650.0


def test_validation_absent_is_404(env: Env) -> None:
    with env.client() as c:
        assert_problem(c.get("/api/v1/validation"), 404, "NOT_FOUND")


def test_resolve_preset_alias_is_local(env: Env) -> None:
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "gj 699"})
    assert r.status_code == 200
    body = r.json()
    assert body["main_id"] == "Barnard's Star" and body["ref_epoch"] == "J2016.0"
    p = preset_params(load_targets()["barnard"])
    assert body["propagated"]["ra_deg"] == p.ra_deg and body["propagated"]["dec_deg"] == p.dec_deg
    assert env.simbad.names == []


def test_resolve_simbad_and_redis_cache(env: Env) -> None:
    env.simbad.obj = SimbadObject("hd 1", "HD 1", 10.5, -20.25, "J2000.0", None, None, None, None)
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "HD 1"})
        r2 = c.get("/api/v1/resolve", params={"name": "HD 1"})
    assert r.status_code == 200 and r.json()["ra_deg"] == 10.5
    assert r.json()["propagated"] is None  # no proper motion known
    assert r2.json() == r.json() and env.simbad.names == ["HD 1"]


def test_resolve_propagates_to_mean_data_epoch(env: Env) -> None:
    class Rec:
        t_start = Time(61000.0, format="mjd")
        t_end = Time(61000.0, format="mjd")

    async def q(*_a: Any, **_k: Any) -> list[Rec]:
        return [Rec()]

    env.irsa.query_images = q  # type: ignore[method-assign]
    env.simbad.obj = SimbadObject(
        "mover", "Mover", 100.0, 10.0, "J2000.0", 0.0, 1000.0, 100.0, None
    )
    with env.client() as c:
        body = c.get("/api/v1/resolve", params={"name": "mover"}).json()
    assert body["propagated"]["epoch"].startswith("2025-11-21")
    # 1000 mas/yr over about 25.9 years is about 26 arcsec north
    assert 0.006 < body["propagated"]["dec_deg"] - 10.0 < 0.009


def test_resolve_not_found_and_unavailable(env: Env) -> None:
    with env.client() as c:
        assert_problem(c.get("/api/v1/resolve", params={"name": "nothing"}), 404, "RESOLVE_FAILED")
        env.simbad.fail = True
        r = c.get("/api/v1/resolve", params={"name": "other thing"})
    body = assert_problem(r, 502, "RESOLVER_UNAVAILABLE")
    assert r.headers["retry-after"] == "60" and "SIMBAD" in body["detail"]


def test_resolve_falls_back_to_irsa_when_simbad_fails(env: Env) -> None:
    from destello.sources.irsa import ResolvedName

    env.simbad.fail = True
    env.irsa.resolved = ResolvedName("Vega", 279.2347, 38.7837, "ned")
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "vega star"})
        again = c.get("/api/v1/resolve", params={"name": "vega star"})
    body = r.json()
    assert r.status_code == 200
    assert body["main_id"] == "Vega" and body["ra_deg"] == 279.2347
    assert body["ref_epoch"] == "J2000.0" and body["resolver"] == "irsa:ned"
    assert body["pmra_masyr"] is None and body["parallax_mas"] is None
    assert body["propagated"] is None
    assert again.json() == body and env.irsa.resolve_names == ["vega star"]  # cached


def test_resolve_fallback_unresolved_or_failing_keeps_502(env: Env) -> None:
    env.simbad.fail = True
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "unknown one"})
        env.irsa.resolve_fail = True
        r2 = c.get("/api/v1/resolve", params={"name": "unknown two"})
    for resp in (r, r2):
        assert_problem(resp, 502, "RESOLVER_UNAVAILABLE")
        assert resp.headers["retry-after"] == "60"
    assert env.irsa.resolve_names == ["unknown one", "unknown two"]


def test_resolve_fallback_not_used_when_simbad_answers(env: Env) -> None:
    env.simbad.obj = SimbadObject("hd 2", "HD 2", 1.0, 2.0, "J2000.0", None, None, None, None)
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "HD 2"})
        assert r.status_code == 200 and r.json()["resolver"] == "simbad"
        env.simbad.obj = None
        assert_problem(c.get("/api/v1/resolve", params={"name": "nothing"}), 404, "RESOLVE_FAILED")
    assert env.irsa.resolve_names == []


def test_resolve_uses_sesame_before_irsa_and_propagates(env: Env) -> None:
    from destello.sources.irsa import ResolvedName

    class Rec:
        t_start = Time(61000.0, format="mjd")
        t_end = Time(61000.0, format="mjd")

    async def q(*_a: Any, **_k: Any) -> list[Rec]:
        return [Rec()]

    env.irsa.query_images = q  # type: ignore[method-assign]
    env.irsa.resolved = ResolvedName("Other", 1.0, 2.0, "ned")
    env.simbad.fail = True
    env.sesame.fail = False
    env.sesame.obj = SimbadObject(
        "mover", "* mov", 100.0, 10.0, "J2000.0", 0.0, 1000.0, 100.0, None
    )
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "mover"})
    body = r.json()
    assert r.status_code == 200 and body["resolver"].startswith("sesame:")
    assert body["pmdec_masyr"] == 1000.0 and body["propagated"] is not None
    assert env.irsa.resolve_names == []


def test_resolve_sesame_unknown_then_irsa_resolves(env: Env) -> None:
    from destello.sources.irsa import ResolvedName

    env.simbad.fail = True
    env.sesame.fail = False  # answers "unknown"
    env.irsa.resolved = ResolvedName("Vega", 279.2, 38.8, "ned")
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": "vega star"})
    assert r.status_code == 200 and r.json()["resolver"] == "irsa:ned"
    assert env.sesame.names == ["vega star"] and env.irsa.resolve_names == ["vega star"]


def test_resolve_404_only_when_sesame_and_irsa_both_answer_unknown(env: Env) -> None:
    env.simbad.fail = True
    env.sesame.fail = False
    with env.client() as c:
        assert_problem(c.get("/api/v1/resolve", params={"name": "no such"}), 404, "RESOLVE_FAILED")
        env.irsa.resolve_fail = True  # IRSA failed: no definite answer, so 502
        assert_problem(
            c.get("/api/v1/resolve", params={"name": "no such 2"}), 502, "RESOLVER_UNAVAILABLE"
        )
        env.irsa.resolve_fail = False
        env.sesame.fail = True  # Sesame failed, IRSA does not know it: 502
        assert_problem(
            c.get("/api/v1/resolve", params={"name": "no such 3"}), 502, "RESOLVER_UNAVAILABLE"
        )


def test_resolve_sesame_not_used_when_simbad_answers(env: Env) -> None:
    env.simbad.obj = SimbadObject("hd 3", "HD 3", 1.0, 2.0, "J2000.0", None, None, None, None)
    with env.client() as c:
        assert c.get("/api/v1/resolve", params={"name": "HD 3"}).status_code == 200
    assert env.sesame.names == []


def test_resolve_is_capped_and_failure_cached_for_60s(
    env: Env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    import destello.api.routes.meta as meta

    monkeypatch.setattr(meta, "RESOLVE_TIMEOUT_S", 0.2)

    async def hang(name: str) -> None:
        env.simbad.names.append(name)
        await asyncio.sleep(30)

    env.simbad.resolve = hang  # type: ignore[method-assign]
    with env.client() as c:
        t0 = time.monotonic()
        first = c.get("/api/v1/resolve", params={"name": "slow object"})
        elapsed = time.monotonic() - t0
        second = c.get("/api/v1/resolve", params={"name": "slow object"})
    assert_problem(first, 502, "RESOLVER_UNAVAILABLE")
    assert elapsed < 2
    assert_problem(second, 502, "RESOLVER_UNAVAILABLE")
    assert env.simbad.names == ["slow object"]  # the second answer came from the negative cache


@pytest.mark.parametrize("name", ["", "x" * 101, "bad\x00name", "tab\tname"])
def test_resolve_validation(env: Env, name: str) -> None:
    with env.client() as c:
        r = c.get("/api/v1/resolve", params={"name": name})
    assert r.status_code == 422 and r.json()["code"] in ("VALIDATION_ERROR", "INVALID_NAME")


def test_resolve_never_treats_a_url_as_a_fetch_target(env: Env) -> None:
    with env.client() as c:
        c.get("/api/v1/resolve", params={"name": "http://169.254.169.254/latest"})
    # the string reaches only the resolver client as an identifier, never an HTTP client
    assert env.simbad.names == ["http://169.254.169.254/latest"]


# ------------------------------------------------------------------ POST /sequences
def test_post_ready_when_manifest_exists(env: Env) -> None:
    body = {"ra_deg": 133.79513, "dec_deg": -7.24515, "fov_arcmin": 4, "detectors": [2, 1]}
    sp = SequenceParams(133.79513, -7.24515, 4.0, (1, 2), "all")
    sid = params_sequence_id(sp, env.settings)
    write_manifest(env.settings, sid)
    with env.client() as c:
        r = c.post("/api/v1/sequences", json=body)
    assert r.status_code == 200
    assert r.json() == {
        "sequence_id": sid,
        "status": "ready",
        "manifest_url": f"/manifests/{sid}.json",
        "refreshing": False,
    }
    assert env.queue.jobs == []


def test_ready_sequence_is_refreshed_once_when_irsa_published_newer_data(env: Env) -> None:
    import os
    import time

    from destello.worker.cron import RELEASES_CHANGED_AT_KEY

    body = {"ra_deg": 133.79513, "dec_deg": -7.24515, "fov_arcmin": 4, "detectors": [2, 1]}
    sp = SequenceParams(133.79513, -7.24515, 4.0, (1, 2), "all")
    sid = params_sequence_id(sp, env.settings)
    write_manifest(env.settings, sid)
    mpath = env.settings.manifests_dir / f"{sid}.json"
    built = time.time() - 7200
    os.utime(mpath, (built, built))
    with env.client() as c:
        # No release change recorded: nothing is queued.
        assert c.post("/api/v1/sequences", json=body).status_code == 200
        assert env.queue.jobs == []
        # IRSA published data after the manifest was written: the answer is still the ready
        # manifest, and one forced rebuild is queued under the sequence id.
        c.portal.call(env.redis.set, RELEASES_CHANGED_AT_KEY, str(time.time() - 60))  # type: ignore[union-attr]
        r = c.post("/api/v1/sequences", json=body)
        assert r.status_code == 200 and r.json()["status"] == "ready"
        assert r.json()["refreshing"] is True
        assert [(n, j) for n, _p, j in env.queue.jobs] == [("build_sequence", sid)]
        assert env.queue.kwargs == [{"force": True}]
        # A second request within the guard window does not queue again.
        env.queue.ids.clear()
        again = c.post("/api/v1/sequences", json=body)
        assert again.status_code == 200 and again.json()["refreshing"] is True
        assert len(env.queue.jobs) == 1
        # A manifest written after the change is current, even without the guard.
        os.utime(mpath, None)
        c.portal.call(env.redis.delete, f"destello:seq:{sid}:refresh")  # type: ignore[union-attr]
        fresh = c.post("/api/v1/sequences", json=body)
        assert fresh.status_code == 200 and fresh.json()["refreshing"] is False
        assert len(env.queue.jobs) == 1


def test_post_enqueues_once_and_dedupes(env: Env) -> None:
    with env.client() as c:
        r = post(c)
        r2 = post(c)
    assert r.status_code == 202
    body = r.json()
    sid = body["sequence_id"]
    assert body["status"] == "queued" and body["events_url"] == f"/api/v1/sequences/{sid}/events"
    assert body["estimate"]["images"] == 40 and body["estimate"]["seconds"] > 0
    assert r2.status_code == 202 and r2.json()["sequence_id"] == sid
    assert len(env.queue.jobs) == 1
    name, params, job_id = env.queue.jobs[0]
    assert name == "build_sequence" and job_id == sid
    assert (
        params["release"] == "all" and params["detectors"] == [1, 2] and params["target_id"] is None
    )
    assert params_sequence_id(SequenceParams.from_dict(params), env.settings) == sid


def test_post_preset_request_reuses_the_preset_sequence(env: Env) -> None:
    t = load_targets()["barnard"]
    p = preset_params(t)
    sid = params_sequence_id(p, env.settings)
    pins = {"presets": {"barnard": {"sequence_id": sid, "params": p.to_dict()}}}
    (env.settings.data_dir / "pins.json").write_text(json.dumps(pins), encoding="utf-8")
    with env.client() as c:
        r = post(
            c,
            ra_deg=p.ra_deg,
            dec_deg=p.dec_deg,
            fov_arcmin=p.fov_arcmin,
            detectors=[1, 2, 3, 4, 5, 6],
        )
    assert r.status_code == 202 and r.json()["sequence_id"] == sid
    assert env.queue.jobs[0][1]["target_id"] == "barnard"


def test_post_failed_sequence_is_requeued(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        env.queue.ids.discard(sid)
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "failed"})
        )
        r = post(c)
    assert r.status_code == 202 and len(env.queue.jobs) == 2


@pytest.mark.parametrize(
    "over",
    [
        {"fov_arcmin": 1.99},
        {"fov_arcmin": 30.01},
        {"ra_deg": 360.0},
        {"ra_deg": -0.1},
        {"dec_deg": 90.5},
        {"detectors": [0]},
        {"detectors": [7]},
        {"detectors": []},
        {"detectors": [1, 2, 3, 4, 5, 6, 1]},
        {"release": "https://evil.example/x"},
        {"release": "spherex_qr9"},
        {"fits_url": "http://169.254.169.254/latest/meta-data"},
        {"url": "http://localhost:6379"},
        {"ra_deg": "abc"},
        {"track": {"pmra_masyr": 1, "pmdec_masyr": 1, "ref_epoch": "never"}},
    ],
)
def test_post_validation_errors(env: Env, over: dict[str, Any]) -> None:
    with env.client() as c:
        r = post(c, **over)
    assert r.status_code == 422
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["code"] in ("VALIDATION_ERROR", "INVALID_RELEASE", "INVALID_DETECTORS")
    assert env.queue.jobs == []


def test_post_rejects_non_json_and_unknown_track_fields(env: Env) -> None:
    with env.client() as c:
        r = c.post(
            "/api/v1/sequences", content=b"not json", headers={"content-type": "application/json"}
        )
        r2 = post(c, track={"pmra_masyr": 1, "pmdec_masyr": 1, "evil": 1})
    assert r.status_code == 422 and r2.status_code == 422


def test_post_no_coverage(env: Env) -> None:
    env.irsa.n = 0
    with env.client() as c:
        assert_problem(post(c), 422, "NO_COVERAGE")
    assert env.queue.jobs == []


def test_post_irsa_unavailable(env: Env) -> None:
    env.irsa.fail = True
    with env.client() as c:
        r = post(c)
    assert_problem(r, 503, "IRSA_UNAVAILABLE")
    assert r.headers["retry-after"] == "300"


def test_post_build_rate_limit_429(env: Env) -> None:
    with env.client() as c:
        for i in range(6):
            assert post(c, ra_deg=10.0 + i).status_code == 202
        r = post(c, ra_deg=99.0)
    assert_problem(r, 429, "RATE_LIMITED")
    assert int(r.headers["retry-after"]) >= 1
    assert r.headers["ratelimit-limit"] == "6" and r.headers["ratelimit-remaining"] == "0"
    assert len(env.queue.jobs) == 6


def test_post_queue_full_503(env: Env) -> None:
    with env.client() as c:
        for i in range(50):
            c.portal.call(env.redis.zadd, "arq:queue", {f"job{i}": i})  # type: ignore[union-attr]
        r = post(c)
    assert_problem(r, 503, "QUEUE_FULL")
    assert r.headers["retry-after"] == "120"


def test_post_queue_unreachable_503(env: Env) -> None:
    class Broken:
        async def enqueue_job(self, *_a: Any, **_k: Any) -> None:
            raise ConnectionError("redis down")

    env.state.queue = Broken()
    with env.client() as c:
        assert_problem(post(c), 503, "QUEUE_UNAVAILABLE")


def test_worker_consumes_what_the_api_publishes() -> None:
    names = {f.__name__ for f in WorkerSettings.functions}  # type: ignore[attr-defined]
    assert "build_sequence" in names
    assert getattr(WorkerSettings, "queue_name", "arq:queue") == "arq:queue"
    assert jobs.build_sequence.__name__ == "build_sequence"


# ------------------------------------------------------------------ status, estimate
def test_get_sequence_states(env: Env) -> None:
    write_manifest(env.settings, SID)
    with env.client() as c:
        ready = c.get(f"/api/v1/sequences/{SID}")
        sid = post(c).json()["sequence_id"]
        queued = c.get(f"/api/v1/sequences/{sid}")
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "running"})
        )
        running = c.get(f"/api/v1/sequences/{sid}")
        missing = c.get("/api/v1/sequences/ffffffffffffffff")
        bad = c.get("/api/v1/sequences/not-a-sequence")
    assert ready.json() == {
        "sequence_id": SID,
        "status": "ready",
        "manifest_url": f"/manifests/{SID}.json",
    }
    assert queued.json()["status"] == "queued" and queued.json()["events_url"].endswith("/events")
    assert running.json()["status"] == "running" and "position" not in running.json()
    assert_problem(missing, 404, "NOT_FOUND")
    assert_problem(bad, 422, "INVALID_SEQUENCE_ID")


def test_estimate(env: Env) -> None:
    q = {"ra_deg": 10, "dec_deg": 20, "fov_arcmin": 6}
    with env.client() as c:
        r = c.get("/api/v1/sequences/estimate", params=q)
        c.get("/api/v1/sequences/estimate", params=q)
        too_big = c.get("/api/v1/sequences/estimate", params={**q, "fov_arcmin": 31})
        bad_rel = c.get("/api/v1/sequences/estimate", params={**q, "release": "x"})
        env.irsa.n = 5000
        capped = c.get("/api/v1/sequences/estimate", params={**q, "ra_deg": 11})
    assert r.json()["images"] == 40
    assert env.irsa.calls == 2  # second identical call came from the cache
    assert too_big.status_code == 422 and bad_rel.status_code == 422
    assert capped.json()["images"] == 240  # 6 detectors x 40 images per group


def test_estimate_depends_on_fov(env: Env) -> None:
    out = []
    with env.client() as c:
        for fov in (2, 6, 15, 30):
            q = {"ra_deg": 10, "dec_deg": 20, "fov_arcmin": fov}
            out.append(c.get("/api/v1/sequences/estimate", params=q).json())
    assert len({(o["megabytes"], o["seconds"]) for o in out}) == 4
    assert [o["megabytes"] for o in out] == sorted(o["megabytes"] for o in out)
    assert env.irsa.calls == 1  # discovery is FoV independent and cached


# ------------------------------------------------------------------ SSE
def sse_events(lines: Any) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    event = ""
    for line in lines:
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            out.append((event, json.loads(line[6:])))
            if event in ("completed", "failed"):
                break
    return out


def test_events_ready_sequence_emits_status_and_completed(env: Env) -> None:
    write_manifest(env.settings, SID)
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/events")
    assert r.headers["content-type"].startswith("text/event-stream")
    assert sse_events(r.text.splitlines()) == [
        ("status", {"status": "ready"}),
        ("completed", {"manifest_url": f"/manifests/{SID}.json"}),
    ]


def test_events_relay_pubsub(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        with c.stream("GET", f"/api/v1/sequences/{sid}/events") as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            chan = f"destello:seq:{sid}"

            def pub(event: str, data: dict[str, Any]) -> None:
                c.portal.call(  # type: ignore[union-attr]
                    env.redis.publish, chan, json.dumps({"event": event, "data": data})
                )

            seen: list[tuple[str, dict[str, Any]]] = []
            lines = r.iter_lines()
            first = sse_events_until(lines, 1)
            seen += first
            pub("progress", {"stage": "cutouts", "done": 3, "total": 10})
            pub(
                "epoch_ready",
                {
                    "epoch": 0,
                    "frames": [
                        {
                            "detector": 1,
                            "kind": "coadd",
                            "n_images": 18,
                            "t_start": "2025-08-15T00:00:00Z",
                            "t_end": "2025-09-05T00:00:00Z",
                        }
                    ],
                },
            )
            pub("completed", {"manifest_url": f"/manifests/{sid}.json"})
            seen += sse_events(lines)
    names = [e for e, _ in seen]
    assert names[0] == "status" and seen[0][1]["status"] == "queued"
    assert names[-4:] == ["progress", "epoch_ready", "status", "completed"]
    ep = dict(seen)["epoch_ready"]
    assert ep["t_start"] == "2025-08-15T00:00:00Z" and ep["n_images"] == 18


def sse_events_until(lines: Any, n: int) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = []
    event = ""
    for line in lines:
        if line.startswith("event: "):
            event = line[7:]
        elif line.startswith("data: "):
            out.append((event, json.loads(line[6:])))
            if len(out) >= n:
                break
    return out


def test_events_failed_sequence_and_unknown(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "failed"})
        )
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set,
            f"destello:seq:{sid}:last",
            json.dumps(
                {"event": "failed", "data": {"code": "IRSA_UNAVAILABLE", "retry_after_s": 300}}
            ),
        )
        r = c.get(f"/api/v1/sequences/{sid}/events")
        missing = c.get("/api/v1/sequences/ffffffffffffffff/events")
    ev = sse_events(r.text.splitlines())
    assert ev[-1] == ("failed", {"code": "IRSA_UNAVAILABLE", "retry_after_s": 300})
    assert_problem(missing, 404, "NOT_FOUND")


def test_events_stream_cap_per_client(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        key = f"destello:sse:{ratelimit.hash_ip('testclient', SALT)}"
        live = time.time() + 40
        c.portal.call(  # type: ignore[union-attr]
            env.redis.zadd, key, {"a": live, "b": live, "c": live}
        )
        r = c.get(f"/api/v1/sequences/{sid}/events")
        left = c.portal.call(env.redis.zcard, key)  # type: ignore[union-attr]
    body = assert_problem(r, 429, "TOO_MANY_STREAMS")
    assert "3" in body["detail"] and r.headers["retry-after"] == "10"
    assert int(left) == 3  # the rejected attempt released its slot


def test_events_stream_releases_slot_and_expired_slots_heal(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "failed"})
        )
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set,
            f"destello:seq:{sid}:last",
            json.dumps({"event": "failed", "data": {"code": "X", "retry_after_s": 1}}),
        )
        key = f"destello:sse:{ratelimit.hash_ip('testclient', SALT)}"
        stale = time.time() - 5
        c.portal.call(  # type: ignore[union-attr]
            env.redis.zadd, key, {"a": stale, "b": stale, "c": stale}
        )
        for _ in range(4):  # more streams than the cap, sequentially
            assert c.get(f"/api/v1/sequences/{sid}/events").status_code == 200
        left = c.portal.call(env.redis.zrange, key, 0, -1)  # type: ignore[union-attr]
    assert left == []


# ------------------------------------------------------------------ progressive builds
def write_partial(settings: Settings, sid: str, ready: list[int], pending: list[int]) -> None:
    doc = write_manifest(settings, sid, epochs=2)
    (settings.manifests_dir / f"{sid}.json").unlink()  # only the partial exists while running
    doc["stretch"] = {
        str(d): {"vmin": 0.0, "vmax": 1.0, "softening": 0.1, "unit": "MJy/sr"} for d in ready
    }
    doc["build"] = {
        "status": "partial",
        "priority_detector": ready[0],
        "detectors_ready": ready,
        "detectors_pending": pending,
    }
    path = jobs.partial_manifest_path(settings, sid)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc), encoding="utf-8")


def test_manifest_endpoint_serves_the_partial_then_the_final_manifest(env: Env) -> None:
    write_partial(env.settings, SID, [6], [2, 5])
    with env.client() as c:
        partial = c.get(f"/api/v1/sequences/{SID}/manifest")
        doc = write_manifest(env.settings, SID, epochs=2)
        doc["stretch"] = {"5": {}, "6": {}, "2": {}, "all": {}}
        (env.settings.manifests_dir / f"{SID}.json").write_text(json.dumps(doc), encoding="utf-8")
        final = c.get(f"/api/v1/sequences/{SID}/manifest")
        missing = c.get("/api/v1/sequences/ffffffffffffffff/manifest")
        bad = c.get("/api/v1/sequences/not-a-sequence/manifest")
    assert partial.status_code == 200 and partial.headers["cache-control"] == "no-store"
    assert partial.json()["build"] == {
        "status": "partial",
        "priority_detector": 6,
        "detectors_ready": [6],
        "detectors_pending": [2, 5],
    }
    assert set(partial.json()["stretch"]) == {"6"}
    # The final manifest wins as soon as it exists, even if the partial file is still there.
    assert final.status_code == 200 and final.headers["cache-control"] == "no-cache"
    assert final.json()["build"] == {
        "status": "complete",
        "priority_detector": None,
        "detectors_ready": [2, 5, 6],
        "detectors_pending": [],
    }
    assert final.json()["sequence_id"] == SID
    assert_problem(missing, 404, "NOT_FOUND")
    assert_problem(bad, 422, "INVALID_SEQUENCE_ID")


def test_get_sequence_reports_the_detectors_already_viewable(env: Env) -> None:
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "running"})
        )
        before = c.get(f"/api/v1/sequences/{sid}").json()
        write_partial(env.settings, sid, [2], [1])
        during = c.get(f"/api/v1/sequences/{sid}").json()
    assert "detectors_ready" not in before and "partial_manifest_url" not in before
    assert during == {
        "sequence_id": sid,
        "status": "running",
        "events_url": f"/api/v1/sequences/{sid}/events",
        "detectors_ready": [2],
        "partial_manifest_url": f"/api/v1/sequences/{sid}/manifest",
    }


def test_events_replay_detector_ready_to_late_streams(env: Env) -> None:
    ready = {
        "detector": 2,
        "stretch": {"method": "asinh", "vmin": 0.0, "vmax": 1.0, "softening": 0.1, "unit": "x"},
        "frames": [{"epoch": 0, "detector": 2, "kind": "coadd", "url": "/frames/a.webp"}],
        "manifest_url": "/api/v1/sequences/x/manifest",
        "detectors_ready": [2],
        "detectors_pending": [1],
    }
    with env.client() as c:
        sid = post(c).json()["sequence_id"]
        c.portal.call(  # type: ignore[union-attr]
            env.redis.set, f"destello:seq:{sid}:state", json.dumps({"status": "running"})
        )
        c.portal.call(  # type: ignore[union-attr]
            env.redis.rpush,
            f"destello:seq:{sid}:detectors_ready",
            json.dumps({"event": "detector_ready", "data": ready}),
            "not json",
        )
        with c.stream("GET", f"/api/v1/sequences/{sid}/events") as r:
            lines = r.iter_lines()
            seen = sse_events_until(lines, 2)
            c.portal.call(  # type: ignore[union-attr]
                env.redis.publish,
                f"destello:seq:{sid}",
                json.dumps({"event": "completed", "data": {"manifest_url": "/m.json"}}),
            )
            seen += sse_events(lines)
    assert seen[0] == ("status", {"status": "running"})
    assert seen[1] == ("detector_ready", ready)
    assert [e for e, _ in seen[2:]] == ["status", "completed"]


def test_post_priority_detector_changes_the_order_not_the_sequence(env: Env) -> None:
    plain = SequenceParams(133.79513, -7.24515, 4.0, (1, 2), "all")
    with env.client() as c:
        r = post(c, priority_detector=2)
        r_other = post(c, ra_deg=10.0, priority_detector=5)  # 5 is not requested: ignored
        r_bad = post(c, priority_detector=7)
    assert r.status_code == 202
    assert r.json()["sequence_id"] == params_sequence_id(plain, env.settings)
    assert env.queue.jobs[0][1]["priority_detector"] == 2
    assert r_other.status_code == 202 and env.queue.jobs[1][1]["priority_detector"] is None
    assert r_bad.status_code == 422 and len(env.queue.jobs) == 2


# ------------------------------------------------------------------ overlays
def barnard_gaia() -> CatalogSource:
    a = load_targets()["barnard"].astrometry
    return CatalogSource(
        "gaia_dr3", "4472832130942575872", a.ra_deg, a.dec_deg, a.pmra_masyr, a.pmdec_masyr,
        a.parallax_mas, 2016.0, 9.5, "G",
    )  # fmt: skip


def test_edge_coordinates_of_the_grid_center() -> None:
    g = GridSpec(ra_deg=100.0, dec_deg=20.0, pixel_scale_arcsec=3.1, ny=116, nx=116)
    x, y = to_frame_pixels(g, np.array([100.0]), np.array([20.0]))
    assert (x[0], y[0]) == pytest.approx((58.0, 58.0), abs=1e-6)
    # a source 31 arcsec north appears 10 pixels higher in the image (smaller y), east is left
    north = to_frame_pixels(g, np.array([100.0]), np.array([20.0 + 31 / 3600]))
    east = to_frame_pixels(
        g, np.array([100.0 + 31 / 3600 / np.cos(np.radians(20))]), np.array([20.0])
    )
    assert north[1][0] == pytest.approx(48.0, abs=0.05)
    assert east[0][0] == pytest.approx(48.0, abs=0.05)


def test_vectorised_propagation_matches_astropy_for_barnard() -> None:
    src = barnard_gaia()
    for mjd in (60913.1, 61116.2, 61274.1):
        t = Time(mjd, format="mjd", scale="utc")
        ra, dec = propagate_to_epoch([src], t, apply_parallax=True)
        ref = apparent_positions(src.astrometry(), t)
        sep = (
            np.hypot((ra[0] - ref.ra.deg) * np.cos(np.radians(dec[0])), dec[0] - ref.dec.deg) * 3600
        )
        assert sep < 0.3  # arcsec, below a tenth of a 3.1 arcsec grid pixel


def test_overlay_gaia_barnard_moves_north_between_epochs(env: Env) -> None:
    write_manifest(env.settings, SID)
    env.gaia.sources = [barnard_gaia()]
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/overlays/gaia_dr3")
        again = c.get(f"/api/v1/sequences/{SID}/overlays/gaia_dr3")
    assert r.status_code == 200 and again.json() == r.json() and env.gaia.calls == 1
    body = r.json()
    assert body["catalog"] == "gaia_dr3" and [e["index"] for e in body["epochs"]] == [0, 1, 2]
    pts = [e["sources"][0] for e in body["epochs"]]
    assert all(0 <= p["x"] <= 116 and 0 <= p["y"] <= 116 for p in pts)
    assert (
        pts[0]["y"] > pts[1]["y"] > pts[2]["y"]
    )  # moving north means smaller y (frame is north up)
    assert pts[0]["id"] == "4472832130942575872" and pts[0]["mag"] == 9.5
    assert pts[0]["pmdec_masyr"] == pytest.approx(10362.39, abs=0.1)


def test_overlay_catwise_and_filtering(env: Env) -> None:
    write_manifest(env.settings, SID)
    far = CatalogSource("catwise2020", "far", 270.5, 4.7, 0.0, 0.0, None, 2015.0, 14.0, "W2")
    near = CatalogSource(
        "catwise2020", "near", 269.44635, 4.76841, 0.0, 0.0, None, 2015.0, 14.0, "W2"
    )
    env.catwise.sources = [far, near]
    with env.client() as c:
        body = c.get(f"/api/v1/sequences/{SID}/overlays/catwise2020").json()
    for e in body["epochs"]:
        assert [s["id"] for s in e["sources"]] == ["near"]
        assert e["sources"][0]["x"] == pytest.approx(58.0, abs=0.01)


def test_overlay_cache_key_carries_the_overlay_method_version(env: Env) -> None:
    # A change in catalog parsing (e.g. the CatWISE reference position) must not keep serving
    # overlays cached with the previous positions: the cache key carries OVERLAY_METHOD_VERSION.
    from destello.api.derived import OVERLAY_METHOD_VERSION

    write_manifest(env.settings, SID)
    env.catwise.sources = [
        CatalogSource("catwise2020", "near", 269.44635, 4.76841, 0.0, 0.0, None, 2015.0, 14.0, "W2")
    ]
    with env.client() as c:
        body = c.get(f"/api/v1/sequences/{SID}/overlays/catwise2020").json()
        keys = c.portal.call(env.redis.keys, "destello:overlay:*")  # type: ignore[union-attr]
    assert body["epochs"][0]["sources"][0]["id"] == "near"
    assert len(keys) == 1 and f":m{OVERLAY_METHOD_VERSION}:{SID}:catwise2020" in keys[0].decode()


def test_overlay_errors(env: Env) -> None:
    write_manifest(env.settings, SID)
    with env.client() as c:
        assert c.get(f"/api/v1/sequences/{SID}/overlays/wise").status_code == 422
        assert_problem(
            c.get("/api/v1/sequences/ffffffffffffffff/overlays/gaia_dr3"), 404, "NOT_FOUND"
        )
        env.gaia.fail = True
        r = c.get(f"/api/v1/sequences/{SID}/overlays/gaia_dr3")
    assert_problem(r, 503, "CATALOG_UNAVAILABLE")


# ------------------------------------------------------------------ predicted path (F-27)
BARNARD_PATH_Q = {
    "ra_deg": 269.44850252543836,
    "dec_deg": 4.739420051112412,
    "pmra_masyr": -801.5509783684709,
    "pmdec_masyr": 10362.394206546573,
    "parallax_mas": 546.975939730948,
    "ref_epoch": "J2016.0",
}


def test_path_follows_the_overlay_transform_and_includes_parallax(env: Env) -> None:
    write_manifest(env.settings, SID)
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/path", params=BARNARD_PATH_Q)
        again = c.get(f"/api/v1/sequences/{SID}/path", params=BARNARD_PATH_Q)
    assert r.status_code == 200, r.text
    assert again.json() == r.json()
    assert r.headers["cache-control"] == "public, max-age=3600"
    body = r.json()
    assert body["observer"] == "geocentric" and body["ref_epoch"] == "J2016.0"
    assert body["t_start_mjd"] == pytest.approx(60913.0)
    assert body["t_end_mjd"] == pytest.approx(61313.0)
    assert [e["index"] for e in body["epochs"]] == [0, 1, 2]
    # Each epoch marker matches the overlay propagation (motion plus parallax) at its mid time.
    src = CatalogSource(
        "gaia_dr3",
        "barnard",
        BARNARD_PATH_Q["ra_deg"],
        BARNARD_PATH_Q["dec_deg"],
        BARNARD_PATH_Q["pmra_masyr"],
        BARNARD_PATH_Q["pmdec_masyr"],
        BARNARD_PATH_Q["parallax_mas"],
        2016.0,
        9.5,
        "G",
    )
    from destello.api.derived import grid_from_manifest

    doc = json.loads((env.settings.manifests_dir / f"{SID}.json").read_text(encoding="utf-8"))
    grid = grid_from_manifest(doc)
    for e in body["epochs"]:
        t = Time(e["t_mjd"], format="mjd", scale="utc")
        ra, dec = propagate_to_epoch([src], t, apply_parallax=True)
        x, y = to_frame_pixels(grid, ra, dec)
        assert e["x"] == pytest.approx(float(x[0]), abs=0.02)  # grid pixels (0.06 arcsec)
        assert e["y"] == pytest.approx(float(y[0]), abs=0.02)
    # Moving north: smaller y later. The dense path starts and ends on the sequence span.
    ys = [p["y"] for p in body["path"]]
    assert ys[0] > ys[-1]
    assert body["path"][0]["t_mjd"] == pytest.approx(60913.0)
    assert body["path"][-1]["t_mjd"] == pytest.approx(61313.0)
    ell = body["ellipse"]
    assert ell is not None
    assert ell["semi_major_arcsec"] == pytest.approx(0.547, rel=0.03)
    assert 0 < ell["semi_minor_arcsec"] < ell["semi_major_arcsec"]
    assert len(ell["points"]) > 20


def test_path_without_parallax_has_no_ellipse(env: Env) -> None:
    write_manifest(env.settings, SID)
    q = {**BARNARD_PATH_Q, "parallax_mas": 0}
    with env.client() as c:
        body = c.get(f"/api/v1/sequences/{SID}/path", params=q).json()
    assert body["ellipse"] is None and body["parallax_mas"] == 0


@pytest.mark.parametrize(
    "over",
    [
        {"ref_epoch": "yesterday"},
        {"pmra_masyr": 40000},
        {"parallax_mas": -1},
        {"dec_deg": 91},
        {"ref_epoch": None},
    ],
)
def test_path_validation(env: Env, over: dict[str, Any]) -> None:
    write_manifest(env.settings, SID)
    q = {k: v for k, v in {**BARNARD_PATH_Q, **over}.items() if v is not None}
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/path", params=q)
    assert r.status_code == 422
    assert r.headers["cache-control"] == "no-store"


def test_path_unknown_sequence(env: Env) -> None:
    with env.client() as c:
        assert_problem(
            c.get("/api/v1/sequences/ffffffffffffffff/path", params=BARNARD_PATH_Q),
            404,
            "NOT_FOUND",
        )


# ------------------------------------------------------------------ difference
def write_fits(path: Path, img: np.ndarray) -> None:
    fits.PrimaryHDU(img.astype(np.float32)).writeto(path)


def synthetic_field(seed: int, gain: float, mover_x: int | None) -> np.ndarray:
    rng = np.random.default_rng(seed)
    img = rng.normal(0.0, 0.02, (116, 116))
    yy, xx = np.mgrid[0:116, 0:116]
    for k, (x, y) in enumerate(
        [(20, 20), (40, 90), (80, 30), (95, 95), (60, 60), (25, 70), (100, 55)]
    ):
        img += gain * (5.0 + k) * np.exp(-((xx - x) ** 2 + (yy - y) ** 2) / (2 * 1.6**2))
    if mover_x is not None:
        img += 8.0 * np.exp(-((xx - mover_x) ** 2 + (yy - 50) ** 2) / (2 * 1.6**2))
    return img


def make_diff_env(env: Env) -> None:
    doc = write_manifest(env.settings, SID, epochs=2, frames=True)
    env.settings.frames_dir.mkdir(parents=True, exist_ok=True)
    for i, ep in enumerate(doc["epochs"]):
        for f in ep["frames"]:
            name = f["fits_url"].rsplit("/", 1)[-1]
            write_fits(
                env.settings.frames_dir / name,
                synthetic_field(
                    f["detector"] * 10 + i, 1.0 if i == 0 else 1.2, 40 if i == 0 else 70
                ),
            )


def test_difference_detector_and_broadband(env: Env) -> None:
    make_diff_env(env)
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/difference", params={"a": 1, "b": 0, "detector": 6})
        again = c.get(f"/api/v1/sequences/{SID}/difference", params={"a": 1, "b": 0, "detector": 6})
        bb = c.get(f"/api/v1/sequences/{SID}/difference", params={"a": 1, "b": 0})
    assert r.status_code == 200 and again.json() == r.json()
    body = r.json()
    assert set(body) == {"url", "scale", "n_stars_used", "registration", "method_version"}
    assert 1.1 < body["scale"] < 1.3 and body["n_stars_used"] >= 3
    reg = body["registration"]
    assert set(reg) == {"dx_pix", "dy_pix", "dx_err_pix", "dy_err_pix", "n_stars", "applied"}
    # the synthetic epochs are aligned: no significant shift may be applied
    assert reg["applied"] is False and abs(reg["dx_pix"]) < 0.1 and abs(reg["dy_pix"]) < 0.1
    img = Image.open(env.settings.frames_dir / body["url"].rsplit("/", 1)[-1])
    assert img.size == (116, 116) and img.convert("RGBA").mode == "RGBA"
    px = np.asarray(img)
    # the mover is at x=70 in epoch 1 (a): positive (orange, red channel above blue). North up.
    new = px[116 - 1 - 50, 70]
    old = px[116 - 1 - 50, 40]
    assert new[0] > new[2] and old[2] > old[0]
    assert bb.status_code == 200 and bb.json()["url"].endswith(".webp")


def test_difference_cache_hit_with_missing_file_is_recomputed(env: Env) -> None:
    make_diff_env(env)
    p = {"a": 1, "b": 0, "detector": 6}
    with env.client() as c:
        first = c.get(f"/api/v1/sequences/{SID}/difference", params=p).json()
        f = env.settings.frames_dir / first["url"].rsplit("/", 1)[-1]
        assert f.is_file()
        f.unlink()  # the redis key outlives the file (presets rebuilt)
        again = c.get(f"/api/v1/sequences/{SID}/difference", params=p)
    assert again.status_code == 200 and f.is_file()
    assert again.json()["url"] == first["url"]


def test_difference_cache_key_follows_the_manifest(env: Env) -> None:
    make_diff_env(env)
    p = {"a": 1, "b": 0, "detector": 6}
    with env.client() as c:
        c.get(f"/api/v1/sequences/{SID}/difference", params=p)
        keys = c.portal.call(env.redis.keys, "destello:diff:*")  # type: ignore[union-attr]
        mp = env.settings.manifests_dir / f"{SID}.json"
        doc = json.loads(mp.read_text())
        doc["rebuilt"] = True
        mp.write_text(json.dumps(doc))
        c.get(f"/api/v1/sequences/{SID}/difference", params=p)
        keys2 = c.portal.call(env.redis.keys, "destello:diff:*")  # type: ignore[union-attr]
    assert len(keys) == 1 and len(keys2) == 2


@pytest.mark.parametrize(
    "q,code",
    [
        ({"a": 0, "b": 0, "detector": 6}, "INVALID_EPOCHS"),
        ({"a": 0, "b": 5, "detector": 6}, "INVALID_EPOCHS"),
        ({"a": 0, "b": 1, "detector": 1}, "NOT_FOUND"),
    ],
)
def test_difference_errors(env: Env, q: dict[str, int], code: str) -> None:
    make_diff_env(env)
    with env.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/difference", params=q)
    assert r.json()["code"] == code


def test_difference_validation_and_missing(env: Env) -> None:
    write_manifest(env.settings, SID, epochs=1)
    with env.client() as c:
        assert (
            c.get(
                f"/api/v1/sequences/{SID}/difference", params={"a": 0, "b": 1, "detector": 7}
            ).status_code
            == 422
        )
        assert (
            c.get(f"/api/v1/sequences/{SID}/difference", params={"a": -1, "b": 1}).status_code
            == 422
        )
        assert_problem(
            c.get(f"/api/v1/sequences/{SID}/difference", params={"a": 0, "b": 1}),
            422,
            "TOO_FEW_EPOCHS",
        )
        assert_problem(
            c.get("/api/v1/sequences/ffffffffffffffff/difference", params={"a": 0, "b": 1}),
            404,
            "NOT_FOUND",
        )


# ------------------------------------------------------------------ static, headers, limits
def test_static_frames_and_manifests_and_traversal(env: Env) -> None:
    write_manifest(env.settings, SID)
    env.settings.frames_dir.mkdir(parents=True, exist_ok=True)
    (env.settings.frames_dir / "aaaaaaaaaaaaaaaa.webp").write_bytes(b"RIFFxxxxWEBP")
    (env.settings.frames_dir / "bbbbbbbbbbbbbbbb.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    (env.settings.data_dir / "secret.txt").write_text("secret", encoding="utf-8")
    with env.client() as c:
        ok = c.get("/frames/aaaaaaaaaaaaaaaa.webp")
        mask = c.get("/frames/bbbbbbbbbbbbbbbb.png")
        man = c.get(f"/manifests/{SID}.json")
        attempts = [
            "/frames/../secret.txt",
            "/frames/..%2fsecret.txt",
            "/frames/%2e%2e%2fsecret.txt",
            "/frames/..%5csecret.txt",
            "/frames/aaaaaaaaaaaaaaaa.webp%00.png",
            "/frames/aaaaaaaaaaaaaaaa..webp",
            "/frames/AAAAAAAAAAAAAAAA.webp",
            "/frames/secret.txt",
            "/frames/C:%5Cwindows%5Cwin.ini",
            "/manifests/%2e%2e/secret.txt",
            "/frames/aaaaaaaaaaaaaaaa.webp/../../secret.txt",
        ]
        results = [c.get(path) for path in attempts]
    assert ok.status_code == 200 and ok.headers["content-type"] == "image/webp"
    assert "immutable" in ok.headers["cache-control"]
    assert mask.status_code == 200 and mask.headers["content-type"] == "image/png"
    assert man.status_code == 200 and man.json()["sequence_id"] == SID
    for path, r in zip(attempts, results, strict=True):
        assert r.status_code in (404, 400, 422), path
        assert b"secret" not in r.content or r.status_code != 200, path


def test_static_not_mounted_in_production(tmp_path: Path) -> None:
    prod = Env(tmp_path, env="production")
    with prod.client() as c:
        assert c.get("/frames/aaaaaaaaaaaaaaaa.webp").status_code == 404


def test_security_headers_request_id_and_cors(env: Env) -> None:
    with env.client() as c:
        r = c.get("/api/v1/releases")
        r2 = c.get("/api/v1/releases", headers={"X-Request-ID": "abc12345-req"})
        r3 = c.get("/api/v1/releases", headers={"X-Request-ID": "bad id\x01"})
        ok = c.get("/api/v1/releases", headers={"Origin": "http://localhost:5173"})
        evil = c.get("/api/v1/releases", headers={"Origin": "https://evil.example"})
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"]
    assert "camera=()" in r.headers["permissions-policy"]
    assert "frame-ancestors 'self'" in r.headers["content-security-policy"]
    assert len(r.headers["x-request-id"]) == 32
    assert r2.headers["x-request-id"] == "abc12345-req"
    assert r3.headers["x-request-id"] != "bad id\x01"
    assert r.headers["ratelimit-limit"] == "120" and "ratelimit-remaining" in r.headers
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "access-control-allow-origin" not in evil.headers


def test_global_rate_limit_429(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ratelimit, "GLOBAL_LIMIT", ratelimit.Limit("all", 3, 60))
    with env.client() as c:
        codes = [c.get("/api/v1/releases").status_code for _ in range(4)]
        r = c.get("/api/v1/releases")
    assert codes == [200, 200, 200, 429]
    body = assert_problem(r, 429, "RATE_LIMITED")
    assert int(r.headers["retry-after"]) >= 1 and "x-request-id" in r.headers
    assert body["instance"] == "/api/v1/releases"


def test_forwarded_for_only_trusted_from_private_peers() -> None:
    assert ratelimit.pick_client_ip("10.0.0.5", "203.0.113.9, 10.0.0.5") == "203.0.113.9"
    assert ratelimit.pick_client_ip("8.8.8.8", "203.0.113.9") == "8.8.8.8"
    assert ratelimit.pick_client_ip("10.0.0.5", "not an ip") == "10.0.0.5"
    h = ratelimit.hash_ip("203.0.113.9", SALT)
    assert len(h) == 16 and "203" not in h


def test_unhandled_error_is_problem_json_without_internals(env: Env) -> None:
    async def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("secret internal path /srv/x")

    env.simbad.resolve = boom  # type: ignore[method-assign]
    env.irsa.health = boom  # type: ignore[method-assign]
    with env.client() as c:
        r = c.get("/api/v1/health")
    assert_problem(r, 500, "INTERNAL_ERROR")
    assert "secret" not in r.text


def test_openapi_lists_the_endpoints(env: Env) -> None:
    with env.client() as c:
        paths = set(c.get("/api/v1/openapi.json").json()["paths"])
    expect = {
        "/api/v1/health",
        "/api/v1/releases",
        "/api/v1/targets",
        "/api/v1/resolve",
        "/api/v1/sequences",
        "/api/v1/sequences/estimate",
        "/api/v1/sequences/{sid}",
        "/api/v1/sequences/{sid}/events",
        "/api/v1/sequences/{sid}/overlays/{catalog}",
        "/api/v1/sequences/{sid}/difference",
    }
    assert expect <= paths
