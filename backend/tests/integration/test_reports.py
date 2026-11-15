"""F-22 candidate reports: checks, validation, Turnstile, rate limit, storage, downloads, backup.

Catalog, SIMBAD and SBIdent clients are fakes holding real published astrometry (Barnard's Star,
Gaia DR3 J2016.0); Turnstile is mocked with respx. No network is used.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import astropy.units as u
import httpx
import numpy as np
import pytest
import respx
from astropy.time import Time

from destello.api import report_checks as rc
from destello.api import reports as rp
from destello.api.derived import propagate_to_epoch
from destello.api.errors import ApiError
from destello.core.db import backup_sqlite, make_engine, sqlite_path
from destello.models.catalog import CatalogSource
from destello.sources.sbident import SmallBody
from destello.sources.simbad import cone_adql
from destello.sources.turnstile import TURNSTILE_VERIFY_URL
from destello.worker.cron import backup_reports
from destello.worker.main import WorkerSettings
from tests.integration.test_api_endpoints import (
    SID,
    Env,
    FakeCatalog,
    assert_problem,
    write_manifest,
)

# Barnard's Star, Gaia DR3 4472832130942575872 (J2016.0).
BARNARD = CatalogSource(
    catalog="gaia_dr3",
    source_id="4472832130942575872",
    ra_deg=269.44850252543836,
    dec_deg=4.739420051112412,
    pmra_masyr=-801.551,
    pmdec_masyr=10362.394,
    parallax_mas=546.976,
    ref_epoch_jyear=2016.0,
    mag=8.19,
    mag_band="G",
)


class FakeSimbadCone:
    def __init__(self, sources: list[CatalogSource] | None = None, fail: bool = False) -> None:
        self.sources = sources or []
        self.fail = fail
        self.calls: list[dict[str, Any]] = []

    async def cone(self, *a: Any, **k: Any) -> list[CatalogSource]:
        self.calls.append(k)
        if self.fail:
            raise OSError("cds unreachable")
        return self.sources

    async def aclose(self) -> None:
        return None


class FakeSBIdent:
    def __init__(self, bodies: list[SmallBody] | None = None) -> None:
        self.bodies = bodies or []
        self.calls: list[tuple[float, float, float]] = []

    async def identify(
        self, ra: float, dec: float, t: Time, hw: u.Quantity, vmag_limit: float = 22.0
    ) -> list[SmallBody]:
        self.calls.append((ra, dec, float(t.mjd)))
        return self.bodies

    async def aclose(self) -> None:
        return None


def make_env(tmp_path: Path, *, turnstile: bool = False, env: str = "development") -> Env:
    e = Env(tmp_path, env=env)
    e.settings.db_url = f"sqlite:///{(tmp_path / 'db' / 'destello.sqlite').as_posix()}"
    e.settings.turnstile_disabled = not turnstile
    e.state.simbad = FakeSimbadCone()  # type: ignore[assignment]
    e.state.sbident = FakeSBIdent()  # type: ignore[assignment]
    return e


def barnard_marks(
    manifest: dict[str, Any], epochs: tuple[int, ...] = (0, 2)
) -> list[dict[str, Any]]:
    """Marks on the Gaia DR3 position of Barnard's Star propagated to each epoch mid time."""
    out = []
    for ep in epochs:
        t = Time(manifest["epochs"][ep]["t_mid_mjd"], format="mjd", scale="utc")
        ra, dec = propagate_to_epoch([BARNARD], t, apply_parallax=True)
        out.append({"epoch": ep, "ra_deg": float(ra[0]), "dec_deg": float(dec[0])})
    return out


def body(manifest: dict[str, Any], **over: Any) -> dict[str, Any]:
    b: dict[str, Any] = {"sequence_id": SID, "marks": barnard_marks(manifest), "notes": ""}
    b.update(over)
    return b


# ------------------------------------------------------------------ pure helpers
def _mark(i: int, ep: int, ra: float, dec: float, mjd: float) -> rc.Mark:
    return rc.Mark(i, ep, ra, dec, Time(mjd, format="mjd", scale="utc"))


def test_estimate_motion_recovers_barnard_proper_motion() -> None:
    times = [60913.0, 61113.0, 61313.0]
    marks = []
    for i, mjd in enumerate(times):
        ra, dec = propagate_to_epoch(
            [BARNARD], Time(mjd, format="mjd", scale="utc"), apply_parallax=False
        )
        marks.append(_mark(i, i, float(ra[0]), float(dec[0]), mjd))
    m = rc.estimate_motion(marks)
    assert m["total_arcsec_yr"] == pytest.approx(10.393, abs=0.02)
    assert m["pmra_cosdec_arcsec_yr"] == pytest.approx(-0.8016, abs=0.01)
    assert m["pmdec_arcsec_yr"] == pytest.approx(10.362, abs=0.02)
    assert m["position_angle_deg"] == pytest.approx(355.6, abs=0.2)
    assert m["rms_residual_arcsec"] == pytest.approx(0.0, abs=0.01)
    assert m["parallax_fitted"] is False and m["n_marks"] == 3
    # sigma = 3.1 / sqrt(sum (t - tbar)^2), baseline 400 days
    t = np.array(times) / 365.25
    assert m["sigma_arcsec_yr"] == pytest.approx(3.1 / np.sqrt(np.sum((t - t.mean()) ** 2)), 1e-2)


def test_estimate_motion_two_marks_has_no_residual() -> None:
    m = rc.estimate_motion([_mark(0, 0, 10.0, 0.0, 60000.0), _mark(1, 1, 10.0, 0.001, 60365.25)])
    assert m["total_arcsec_yr"] == pytest.approx(3.6, abs=1e-3)
    assert m["position_angle_deg"] == pytest.approx(0.0, abs=0.1)
    assert m["rms_residual_arcsec"] is None


def test_match_needs_propagation_to_each_mark_date() -> None:
    """Barnard's Star is matched at every mark only because positions are propagated."""
    doc = write_manifest_doc()
    marks = rc.resolve_marks(doc, barnard_marks(doc, (0, 1, 2)))
    res = rc.match_sources([BARNARD], marks, rc.CATALOG_MATCH_ARCSEC, apply_parallax=True)
    assert res["status"] == "match"
    assert [h["mark"] for h in res["matches"][0]["marks"]] == [0, 1, 2]
    assert all(h["sep_arcsec"] < 0.5 for h in res["matches"][0]["marks"])
    # Without propagation the J2016.0 position is about 100 arcsec away from every mark.
    frozen = CatalogSource(**{**BARNARD.to_dict(), "pmra_masyr": 0.0, "pmdec_masyr": 0.0})
    res0 = rc.match_sources([frozen], marks, rc.CATALOG_MATCH_ARCSEC, apply_parallax=False)
    assert res0["status"] == "no_match" and res0["nearest"]["sep_arcsec"] > 60


def test_partial_match_and_empty_catalog() -> None:
    doc = write_manifest_doc()
    raw = barnard_marks(doc, (0, 2))
    raw[1]["dec_deg"] += 30 / 3600.0  # second mark 30 arcsec off the star
    marks = rc.resolve_marks(doc, raw)
    res = rc.match_sources([BARNARD], marks, rc.CATALOG_MATCH_ARCSEC, apply_parallax=True)
    assert res["status"] == "partial"
    assert rc.match_sources([], marks, 10.0, apply_parallax=True)["status"] == "no_match"


def test_verdict_never_claims_more_than_the_checks() -> None:
    s = {c: {"status": "no_match"} for c in rc.CATALOGS}
    assert rc.verdict(s) == "no_match"
    s["sbident"] = {"status": "unavailable"}
    assert rc.verdict(s) == "incomplete"
    s["simbad"] = {"status": "partial"}
    assert rc.verdict(s) == "partial"
    s["gaia_dr3"] = {"status": "match"}
    assert rc.verdict(s) == "match"


def test_a_match_with_a_check_that_did_not_run_is_not_cached() -> None:
    s = {c: {"status": "no_match"} for c in rc.CATALOGS}
    assert rc.complete({"summary": s})
    s["gaia_dr3"] = {"status": "match"}
    s["sbident"] = {"status": "unavailable"}
    assert rc.verdict(s) == "match"
    assert not rc.complete({"summary": s})


def write_manifest_doc() -> dict[str, Any]:
    return {
        "sequence_id": SID,
        "grid": {"crval_deg": [269.44635, 4.76841], "pixel_scale_arcsec": 3.1, "naxis": [116, 116]},
        "epochs": [
            {
                "index": i,
                "t_mid_mjd": 60913.0 + 200.0 * i,
                "frames": [
                    {"detector": 5, "t_mid_mjd": 60913.5 + 200.0 * i, "url": f"/frames/{i}.webp"},
                    {"detector": "all", "t_mid_mjd": 60913.2 + 200.0 * i},
                ],
            }
            for i in range(3)
        ],
    }


def test_resolve_marks_validation() -> None:
    doc = write_manifest_doc()
    good = barnard_marks(doc, (2, 0))
    marks = rc.resolve_marks(doc, good, detector=5)
    assert [m.epoch for m in marks] == [0, 2] and [m.index for m in marks] == [0, 1]
    assert marks[0].t_mid.mjd == pytest.approx(60913.5)  # the detector 5 frame time
    assert rc.resolve_marks(doc, good)[0].t_mid.mjd == pytest.approx(60913.2)  # broadband
    with pytest.raises(ApiError) as e1:
        rc.resolve_marks(doc, [good[0], {**good[0]}])
    assert e1.value.code == "INVALID_MARKS"
    with pytest.raises(ApiError) as e2:
        rc.resolve_marks(doc, [good[0], {**good[1], "epoch": 7}])
    assert e2.value.code == "INVALID_MARKS"
    with pytest.raises(ApiError) as e3:
        rc.resolve_marks(doc, [good[0], {**good[1], "dec_deg": 6.0}])
    assert e3.value.code == "POSITION_OUTSIDE_FIELD"
    with pytest.raises(ApiError):
        rc.resolve_marks(doc, good[:1])


def test_clean_notes_and_contact() -> None:
    assert rp.clean_notes("  a\r\nb\x00c\x1b  ") == "a\nbc"
    assert rp.clean_contact(" someone@example.org ") == "someone@example.org"
    assert rp.clean_contact("") is None and rp.clean_contact(None) is None
    for bad in ("not-an-email", "a@b", "<x>@example.org", "a b@example.org", "x" * 250 + "@a.org"):
        with pytest.raises(ValueError):
            rp.clean_contact(bad)
    assert rp.REPORT_ID_RE.match(rp.new_report_id())


def test_simbad_cone_adql_only_interpolates_numbers() -> None:
    q = cone_adql(269.4485, 4.7394, 30 * u.arcsec, 100.0, 200)
    assert "CIRCLE('ICRS', 269.4485000, 4.7394000, 0.008333)" in q
    assert "(pmra*pmra + pmdec*pmdec) > 10000.000" in q
    assert q.startswith("SELECT TOP 200 ") and q.endswith("ORDER BY dist")


# ------------------------------------------------------------------ API
def test_check_endpoint_runs_every_check(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    e.gaia.sources = [BARNARD]
    e.state.sbident = FakeSBIdent(  # type: ignore[assignment]
        [SmallBody("(12345) Example", "17:57:48", "+04 44 00", 19.5, 20.1, -3.0, sep_arcsec=41.0)]
    )
    with e.client() as c:
        r = c.post("/api/v1/reports/check", json={"sequence_id": SID, "marks": barnard_marks(doc)})
    assert r.status_code == 200, r.text
    out = r.json()
    checks = out["checks"]
    assert checks["summary"]["gaia_dr3"]["status"] == "match"
    assert checks["gaia_dr3"][0]["source_id"] == BARNARD.source_id
    assert checks["summary"]["catwise2020"]["status"] == "no_match"
    assert checks["summary"]["simbad"]["status"] == "no_match"
    assert checks["summary"]["sbident"]["status"] == "match"
    assert checks["summary"]["sbident"]["observer"] == "geocentric"
    assert checks["sbident"][0]["name"] == "(12345) Example"
    assert checks["verdict"] == "match"
    assert checks["estimated_motion_arcsec_yr"] == pytest.approx(10.39, abs=0.15)
    assert [m["epoch"] for m in out["marks"]] == [0, 2]
    # SIMBAD: a near cone and a wide high proper motion cone.
    assert any(k.get("min_pm_masyr") == rc.SIMBAD_WIDE_MIN_PM_MASYR for k in e.state.simbad.calls)  # type: ignore[union-attr]


def test_unavailable_catalog_is_reported_not_hidden(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    e.state.catwise = FakeCatalog(fail=True)  # type: ignore[assignment]
    e.state.simbad = FakeSimbadCone(fail=True)  # type: ignore[assignment]
    with e.client() as c:
        r = c.post("/api/v1/reports/check", json={"sequence_id": SID, "marks": barnard_marks(doc)})
    checks = r.json()["checks"]
    assert checks["summary"]["catwise2020"]["status"] == "unavailable"
    assert checks["summary"]["simbad"]["status"] == "unavailable"
    assert checks["verdict"] == "incomplete"


def test_report_roundtrip_downloads_and_private_contact(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    e.gaia.sources = [BARNARD]
    notes = "Dipole in D5.\n<script>alert(1)</script>"
    with e.client() as c:
        r = c.post(
            "/api/v1/reports",
            json=body(doc, notes=notes, contact="someone@example.org", detector=5),
        )
        assert r.status_code == 201, r.text
        created = r.json()
        rid = created["report_id"]
        assert rp.REPORT_ID_RE.match(rid) and created["url"] == f"/r/{rid}"
        assert created["checks"]["summary"]["gaia_dr3"]["status"] == "match"
        g = c.get(f"/api/v1/reports/{rid}")
        j = c.get(f"/api/v1/reports/{rid}.json")
        t = c.get(f"/api/v1/reports/{rid}.txt")
    assert g.status_code == 200 and j.status_code == 200 and t.status_code == 200
    rep = g.json()
    assert rep["report_id"] == rid and rep["status"] == "unconfirmed"
    assert rep["notes"] == notes  # stored as plain text, rendered escaped by the frontend
    assert rep["detector"] == 5 and rep["sequence"]["sequence_id"] == SID
    assert "contact" not in rep
    assert j.headers["content-disposition"] == f'attachment; filename="destello-report-{rid}.json"'
    assert j.json() == rep
    assert t.headers["content-type"].startswith("text/plain")
    text = t.text
    assert f"Destello candidate report {rid}" in text and "Status: unconfirmed" in text
    assert "Backyard Worlds" in text and "Minor Planet Center" in text
    assert "does not review reports or send them anywhere" in text
    for resp in (g, j, t):
        assert "someone@example.org" not in resp.text
        assert "discover" not in resp.text.lower()
    # The contact is stored, in its own column only.
    path = sqlite_path(e.settings.db_url)
    assert path is not None
    with sqlite3.connect(path) as con:
        contact, public = con.execute(
            "SELECT contact, public_json FROM reports WHERE id = ?", (rid,)
        ).fetchone()
        mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    assert contact == "someone@example.org" and "someone@example.org" not in public
    assert mode == "wal"


def test_report_validation_errors(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    with e.client() as c:
        assert_problem(
            c.post("/api/v1/reports", json=body(doc, notes="x" * 2001)), 422, "VALIDATION_ERROR"
        )
        assert_problem(
            c.post("/api/v1/reports", json=body(doc, contact="nope")), 422, "VALIDATION_ERROR"
        )
        assert_problem(c.post("/api/v1/reports", json=body(doc, extra=1)), 422, "VALIDATION_ERROR")
        assert_problem(
            c.post("/api/v1/reports", json=body(doc, sequence_id="../../etc")),
            422,
            "VALIDATION_ERROR",
        )
        one = body(doc)
        one["marks"] = one["marks"][:1]
        assert_problem(c.post("/api/v1/reports", json=one), 422, "VALIDATION_ERROR")
        dup = body(doc)
        dup["marks"][1]["epoch"] = dup["marks"][0]["epoch"]
        assert_problem(c.post("/api/v1/reports", json=dup), 422, "INVALID_MARKS")
        far = body(doc)
        far["marks"][1]["dec_deg"] = 10.0
        assert_problem(c.post("/api/v1/reports", json=far), 422, "POSITION_OUTSIDE_FIELD")
        assert_problem(
            c.post("/api/v1/reports", json=body(doc, sequence_id="f" * 16)), 404, "NOT_FOUND"
        )
        assert_problem(
            c.post("/api/v1/reports", json=body(doc, detector=9)), 422, "VALIDATION_ERROR"
        )
        # Exactly 2000 characters after cleaning is accepted.
        assert c.post("/api/v1/reports", json=body(doc, notes="y" * 2000)).status_code == 201


def test_unknown_or_malformed_report_ids(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    with e.client() as c:
        for name in ("abcdefghij", "abcdefghij.json", "abcdefghij.txt", "abc", "abcdefghij.exe",
                     "..%2F..%2Fx", "abcdefghi!"):  # fmt: skip
            assert c.get(f"/api/v1/reports/{name}").status_code == 404


def test_report_rate_limit_ten_per_hour(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    with e.client() as c:
        codes = [c.post("/api/v1/reports", json=body(doc)).status_code for _ in range(11)]
        last = c.post("/api/v1/reports", json=body(doc))
    assert codes[:10] == [201] * 10 and codes[10] == 429
    assert_problem(last, 429, "RATE_LIMITED")
    assert last.headers["RateLimit-Limit"] == "10" and "Retry-After" in last.headers


def test_checks_are_cached_between_preview_and_submit(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    doc = write_manifest(e.settings)
    with e.client() as c:
        c.post("/api/v1/reports/check", json={"sequence_id": SID, "marks": barnard_marks(doc)})
        n = len(e.state.sbident.calls)  # type: ignore[union-attr]
        assert c.post("/api/v1/reports", json=body(doc)).status_code == 201
    assert len(e.state.sbident.calls) == n  # type: ignore[union-attr]


@respx.mock
def test_turnstile_enforced(tmp_path: Path) -> None:
    e = make_env(tmp_path, turnstile=True)
    e.settings.turnstile_secret = "test-secret"
    doc = write_manifest(e.settings)
    route = respx.post(TURNSTILE_VERIFY_URL).mock(
        side_effect=lambda req: httpx.Response(200, json={"success": b"good-token" in req.content})
    )
    with e.client() as c:
        assert_problem(c.post("/api/v1/reports", json=body(doc)), 403, "TURNSTILE_FAILED")
        bad = c.post("/api/v1/reports", json=body(doc, turnstile_token="bad-token"))
        good = c.post("/api/v1/reports", json=body(doc, turnstile_token="good-token"))
    assert_problem(bad, 403, "TURNSTILE_FAILED")
    assert good.status_code == 201
    assert route.call_count == 2
    sent = route.calls[-1].request.content.decode()
    assert "secret=test-secret" in sent and "remoteip" not in sent


@respx.mock
def test_turnstile_hostname_checked_in_production(tmp_path: Path) -> None:
    e = make_env(tmp_path, turnstile=True, env="production")
    e.settings.turnstile_secret = "test-secret"
    e.settings.public_url = "https://destello.example.org"
    doc = write_manifest(e.settings)
    hosts = iter(["other.example.org", "destello.example.org"])
    respx.post(TURNSTILE_VERIFY_URL).mock(
        side_effect=lambda req: httpx.Response(200, json={"success": True, "hostname": next(hosts)})
    )
    with e.client() as c:
        other = c.post("/api/v1/reports", json=body(doc, turnstile_token="token-a"))
        own = c.post("/api/v1/reports", json=body(doc, turnstile_token="token-b"))
    assert_problem(other, 403, "TURNSTILE_FAILED")
    assert own.status_code == 201


def test_turnstile_without_secret_refuses_reports(tmp_path: Path) -> None:
    e = make_env(tmp_path, turnstile=True)
    doc = write_manifest(e.settings)
    with e.client() as c:
        assert_problem(c.post("/api/v1/reports", json=body(doc)), 503, "REPORTS_UNAVAILABLE")


def test_production_never_skips_turnstile(tmp_path: Path) -> None:
    e = make_env(tmp_path, env="production")
    e.settings.turnstile_disabled = True
    doc = write_manifest(e.settings)
    with e.client() as c:
        assert_problem(c.post("/api/v1/reports", json=body(doc)), 503, "REPORTS_UNAVAILABLE")


# ------------------------------------------------------------------ storage and backup
def test_backup_keeps_newest_copies(tmp_path: Path) -> None:
    url = f"sqlite:///{(tmp_path / 'db' / 'r.sqlite').as_posix()}"
    engine = make_engine(url)
    doc = write_manifest_doc()
    marks = rc.resolve_marks(doc, barnard_marks(doc))
    saved = rp.insert_report(engine, doc, marks, {"verdict": "no_match"}, "n", None, None)
    src = sqlite_path(url)
    assert src is not None
    dest = tmp_path / "bk"
    for day in range(1, 5):
        backup_sqlite(src, dest, keep=3, now=datetime(2026, 11, day, tzinfo=UTC))
    files = sorted(p.name for p in dest.glob("reports-*.sqlite"))
    assert files == [f"reports-202611{d:02d}T000000Z.sqlite" for d in (2, 3, 4)]
    with sqlite3.connect(dest / files[-1]) as con:
        assert con.execute("SELECT id FROM reports").fetchone()[0] == saved["report_id"]
    assert rp.get_report(engine, saved["report_id"]) == saved
    engine.dispose()


async def test_backup_cron_job(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    e.settings.reports_backup_dir = str(tmp_path / "second-disk")
    assert (await backup_reports({"settings": e.settings}))["status"] == "skipped"
    make_engine(e.settings.db_url).dispose()
    out = await backup_reports({"settings": e.settings})
    assert out["status"] == "ok" and Path(out["path"]).parent == tmp_path / "second-disk"
    assert any(getattr(c, "name", "") == "backup_reports" or "backup_reports" in repr(c)
               for c in WorkerSettings.cron_jobs)  # fmt: skip


def test_text_export_has_no_discovery_claim() -> None:
    doc = write_manifest_doc()
    marks = rc.resolve_marks(doc, barnard_marks(doc))
    checks: dict[str, Any] = {
        "summary": {},
        "motion": rc.estimate_motion(marks),
        "verdict": "no_match",
    }
    d = rp.build_document("abcdefghij", "2026-11-11T00:00:00Z", doc, marks, checks, "", None)
    text = rp.render_text(d, "https://example.org")
    assert "discover" not in text.lower() and "not proof of a new object" in text
    assert json.loads(json.dumps(d))["status"] == "unconfirmed"


def test_cleanup_keeps_the_frames_and_manifest_a_report_points_to(tmp_path: Path) -> None:
    import asyncio
    import os
    import time

    from destello.worker.cron import ORPHAN_MIN_AGE_S, cleanup, reported_files

    e = make_env(tmp_path)
    doc = write_manifest(e.settings, frames=True)
    for ep in doc["epochs"]:
        for fr in ep["frames"]:
            fr["url"] = f"/frames/{ep['index']}{fr['detector']}{'a' * 14}.webp"
    (e.settings.manifests_dir / f"{SID}.json").write_text(json.dumps(doc), encoding="utf-8")
    with e.client() as c:
        rid = c.post("/api/v1/reports", json=body(doc)).json()["report_id"]
        rep = c.get(f"/api/v1/reports/{rid}").json()
    urls = {m["frame"]["url"].lstrip("/") for m in rep["marks"]}
    assert urls and all(u.startswith("frames/") for u in urls)
    kept = reported_files(e.settings)
    assert urls <= kept and f"manifests/{SID}.json" in kept
    data = e.settings.data_dir
    for rel in [*urls, "frames/ffffffffffffffff.webp"]:
        (data / rel).parent.mkdir(parents=True, exist_ok=True)
        (data / rel).write_bytes(b"x" * 10)
    # An unreferenced file is only removed once it is too old to belong to a running build.
    old = time.time() - ORPHAN_MIN_AGE_S - 60
    os.utime(data / "frames/ffffffffffffffff.webp", (old, old))
    e.settings.data_quota_gb = 0.0
    asyncio.run(cleanup({"settings": e.settings}))
    assert all((data / u).exists() for u in urls)
    assert (data / f"manifests/{SID}.json").exists()
    assert not (data / "frames/ffffffffffffffff.webp").exists()
