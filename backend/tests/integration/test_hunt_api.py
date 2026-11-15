"""F-35 Hunt API: next field, votes, gold secrecy, limits, Turnstile, counters, candidates."""

from __future__ import annotations

import json
import math
import time
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from destello.api import hunt as hu
from destello.api.routes.hunt import mark_in_field
from destello.models.hunt import HuntCountryRow, HuntVoteRow
from destello.models.hunt_bank import load_bank
from destello.sources.turnstile import TURNSTILE_VERIFY_URL
from tests.integration.test_api_endpoints import Env
from tests.integration.test_reports import make_env


def sess(i: int) -> str:
    return f"session-token-{i:04d}"


def ip_of(i: int) -> str:
    """A distinct client address for session i (honoured: the test peer is a private address)."""
    return f"198.51.{i // 250}.{i % 250 + 1}"


def build_status(env: Env, ids: list[str] | None = None) -> list[str]:
    bank = load_bank()
    ids = ids or [f.id for f in bank.fields]
    fields = {}
    for n, fid in enumerate(ids):
        fields[fid] = {
            "sequence_id": f"{n:016x}",
            "epochs": 3,
            "status": "ready",
            "ra_deg": 100.0 + n,
            "dec_deg": 10.0,
            "updated": "2026-11-14T00:00:00Z",
            "error": None,
        }
    p = env.settings.data_dir / "hunt" / "bank_status.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"bank_version": 1, "fields": fields}), encoding="utf-8")
    return ids


@pytest.fixture
def env(tmp_path: Path) -> Env:
    e = make_env(tmp_path)
    build_status(e)
    e.client = lambda: TestClient(  # type: ignore[method-assign]
        e.app, raise_server_exceptions=False, client=("10.0.0.1", 5000)
    )
    return e


def vote(
    env: Env,
    c: Any,
    i: int,
    field: str,
    label: str,
    token: str | None = None,
    ip: str | None = None,
    **kw: Any,
) -> httpx.Response:
    """Vote on an internal field id with a valid token (or the given one)."""
    tok = token or tok_for(env, i, field)
    return c.post(
        "/api/v1/hunt/votes",
        json={
            "session": sess(i),
            "field_id": hu.public_id(env.settings, sess(i), field),
            "vote_token": tok,
            "label": label,
            **kw,
        },
        headers={"X-Forwarded-For": ip or ip_of(i)},
    )


def pub(env: Env, field: str, i: int | None = None) -> str:
    """Opaque id of a field for session i (the public candidate scope when i is None)."""
    scope = hu.CANDIDATE_SCOPE if i is None else sess(i)
    return hu.public_id(env.settings, scope, field)


def tok_for(env: Env, i: int, field: str, **kw: Any) -> str:
    """Valid token for session i at its current vote count."""
    n = hu.session_vote_count(env.state.get_reports_engine(), sess(i))
    return hu.issue_vote_token(env.settings, sess(i), field, n, **kw)


def vote_served(c: Any, i: int, f: dict[str, Any], label: str) -> httpx.Response:
    """Vote on a field exactly as /next served it (opaque id and token)."""
    return c.post(
        "/api/v1/hunt/votes",
        json={
            "session": sess(i),
            "field_id": f["field_id"],
            "vote_token": f["vote_token"],
            "label": label,
        },
        headers={"X-Forwarded-For": ip_of(i)},
    )


def kinds() -> dict[str, str]:
    return {f.id: f.kind for f in load_bank().fields}


def test_next_never_repeats_and_mixes_gold(env: Env) -> None:
    k = kinds()
    n_gold = sum(v == "gold" for v in k.values())
    with env.client() as c:
        for i in (1, 2):
            seen: list[str] = []
            while True:
                f = c.post("/api/v1/hunt/next", json={"session": sess(i)}).json()["field"]
                if f is None:
                    break
                assert f["field_id"] not in seen
                seen.append(f["field_id"])
                assert vote_served(c, i, f, "nothing").status_code == 201
            assert len(seen) == len(k)
            kind = {pub(env, fid, i): v for fid, v in k.items()}
            pos = [n for n, f in enumerate(seen) if kind[f] == "gold"]
            assert len(pos) == n_gold and 0 not in pos  # never the first field
            assert [p // 5 for p in pos] == list(range(n_gold))  # one in every block of five
    # The slot is stable per session and varies between sessions and blocks (not a fixed rhythm).
    secret = hu.hunt_secret(env.settings)
    assert hu.gold_slot(secret, sess(1), 3) == hu.gold_slot(secret, sess(1), 3)
    slots = {hu.gold_slot(secret, sess(i), b) for i in range(30) for b in range(1, 6)}
    assert slots == {0, 1, 2, 3, 4}
    assert all(1 <= hu.gold_slot(secret, sess(i), 0) <= 4 for i in range(50))


def test_public_field_hides_everything_secret(env: Env) -> None:
    internal = {f.id for f in load_bank().fields}
    with env.client() as c:
        for _ in range(10):
            r = c.post("/api/v1/hunt/next", json={"session": sess(2)})
            f = r.json()["field"]
            assert set(f) == {
                "field_id",
                "vote_token",
                "sequence_id",
                "epochs",
                "center_deg",
                "fov_arcmin",
                "manifest_url",
            }
            assert f["field_id"] not in internal and len(f["field_id"]) == 16
            assert not any(i in r.text for i in internal)
            vote_served(c, 2, f, "nothing")
    bank = load_bank()
    text = json.dumps(r.json())
    for g in (x for x in bank.fields if x.kind == "gold"):
        assert g.astrometry is not None
        assert g.astrometry.source.split()[-1] not in text


def test_opaque_ids_are_stable_and_secret_dependent(env: Env, tmp_path: Path) -> None:
    ids = [pub(env, f.id, 1) for f in load_bank().fields]
    assert len(set(ids)) == len(ids) and ids == [pub(env, f.id, 1) for f in load_bank().fields]
    # Different for every session: a gold id seen in one session is not recognizable in another.
    assert not set(ids) & {pub(env, f.id, 2) for f in load_bank().fields}
    other = make_env(tmp_path / "other")
    other.settings.hunt_secret = "another-secret"
    assert hu.public_id(other.settings, sess(1), "rnd-01") != pub(env, "rnd-01", 1)
    assert hu.public_id(other.settings, sess(1), "rnd-01") == hu.public_id(
        other.settings, sess(1), "rnd-01"
    )


def test_gold_answer_only_after_vote(env: Env) -> None:
    by_pub = {pub(env, f.id, 3): f for f in load_bank().fields}
    with env.client() as c:
        served_gold = None
        for _ in range(len(by_pub)):
            r = c.post("/api/v1/hunt/next", json={"session": sess(3)})
            f = r.json()["field"]
            # Nothing in the response tells a gold field from another one.
            assert "gold" not in r.text and "answer" not in r.text
            assert set(f) == {
                "field_id", "vote_token", "sequence_id", "epochs", "center_deg", "fov_arcmin",
                "manifest_url",
            }  # fmt: skip
            field = by_pub[f["field_id"]]
            if field.kind == "gold":
                served_gold = (f, field)
                break
            ok = vote_served(c, 3, f, "nothing")
            assert ok.json() == {"accepted": True, "gold": None}
        assert served_gold is not None, "no gold field was served"
        f, field = served_gold
        for url in ("/api/v1/hunt/counters", "/api/v1/hunt/candidates"):
            assert "answer" not in c.get(url).text
        r = vote_served(c, 3, f, "artifact")
        assert r.status_code == 201
        assert r.json() == {"accepted": True, "gold": {"answer": "mover", "correct": False}}


def test_duplicate_unknown_and_invalid(env: Env) -> None:
    fid = next(iter(kinds()))
    with env.client() as c:
        assert vote(env, c, 5, fid, "nothing").status_code == 201
        d = vote(env, c, 5, fid, "mover")
        assert d.status_code == 409 and d.json()["code"] == "ALREADY_VOTED"
        unknown = c.post(
            "/api/v1/hunt/votes",
            json={
                "session": sess(5),
                "field_id": "0" * 16,
                "vote_token": tok_for(env, 5, fid),
                "label": "nothing",
            },
        )
        assert unknown.status_code == 404
        assert vote(env, c, 5, fid, "bogus").status_code == 422
        bad = c.post(
            "/api/v1/hunt/votes",
            json={"session": "short", "field_id": pub(env, fid, 5), "label": "nothing"},
        )
        assert bad.status_code == 422
        assert c.post("/api/v1/hunt/next", json={"session": "x"}).status_code == 422


def test_unbuilt_fields_are_not_served(tmp_path: Path) -> None:
    e = make_env(tmp_path)
    ids = build_status(e, ["rnd-01", "rnd-02"])
    with e.client() as c:
        got = {
            c.post("/api/v1/hunt/next", json={"session": sess(i)}).json()["field"]["field_id"]
            for i in range(20)
        }
        assert got <= {pub(e, i, k) for i in ids for k in range(20)}
        assert vote(e, c, 1, "rnd-03", "nothing").status_code == 404
    e2 = make_env(tmp_path / "empty")
    with e2.client() as c:
        assert c.post("/api/v1/hunt/next", json={"session": sess(1)}).json()["field"] is None


def test_mark_must_be_inside_field(env: Env) -> None:
    with env.client() as c:
        fid = "rnd-01"
        entry = json.loads((env.settings.data_dir / "hunt" / "bank_status.json").read_text())[
            "fields"
        ][fid]
        ra, dec = entry["ra_deg"], entry["dec_deg"]
        assert (
            vote(env, c, 6, fid, "mover", mark={"ra_deg": ra + 0.01, "dec_deg": dec}).status_code
            == 201
        )
        far = vote(env, c, 7, fid, "mover", mark={"ra_deg": ra + 2.0, "dec_deg": dec})
        assert far.status_code == 422
        # The field is a square of width fov_arcmin: a mark inside the old radius (the full width)
        # but beyond the half width on one axis is rejected, and just inside the edge is accepted.
        fov = float(load_bank().fov_arcmin)
        cosd = math.cos(math.radians(dec))
        edge = (fov / 2.0) / 60.0 / cosd
        beyond = vote(env, c, 8, fid, "mover", mark={"ra_deg": ra + edge * 1.05, "dec_deg": dec})
        assert beyond.status_code == 422
        north = vote(
            env, c, 9, fid, "mover", mark={"ra_deg": ra, "dec_deg": dec + (fov / 2.0) * 1.05 / 60}
        )
        assert north.status_code == 422
        inside = vote(env, c, 10, fid, "mover", mark={"ra_deg": ra + edge * 0.95, "dec_deg": dec})
        assert inside.status_code == 201
        corner = vote(
            env,
            c,
            11,
            fid,
            "mover",
            mark={"ra_deg": ra + edge * 0.95, "dec_deg": dec + (fov / 2.0) * 0.95 / 60},
        )
        assert corner.status_code == 201


def test_mark_in_field_wraps_ra_and_scales_with_dec() -> None:
    assert mark_in_field(359.99, 60.0, 0.01, 60.0, 6.0)  # across RA 0, 0.02 deg * cos = 0.6 arcmin
    assert not mark_in_field(1.0, 60.0, 359.0, 60.0, 6.0)  # 2 deg * cos(60) = 60 arcmin
    assert mark_in_field(10.0, 0.0, 10.0, 0.0, 6.0)


def test_no_per_person_data_stored(env: Env) -> None:
    with env.client() as c:
        r = c.post(
            "/api/v1/hunt/votes",
            json={
                "session": sess(8),
                "field_id": pub(env, "rnd-01", 8),
                "vote_token": tok_for(env, 8, "rnd-01"),
                "label": "nothing",
            },
            headers={
                "CF-IPCountry": "ES",
                "X-Forwarded-For": "203.0.113.9",
                "User-Agent": "ua-test",
            },
        )
        assert r.status_code == 201
    engine = env.state.get_reports_engine()
    with Session(engine) as s:
        row = s.exec(select(HuntVoteRow)).one()
        cols = set(HuntVoteRow.model_fields)
        assert cols == {
            "id",
            "session",
            "field_id",
            "label",
            "mark_ra_deg",
            "mark_dec_deg",
            "gold_correct",
            "created_at",
            "client_hash",
        }
        assert "203.0.113.9" not in repr(row) and "ES" not in repr(row)
        # Development: the header is ignored, the counter is "unknown".
        assert {c_.code: c_.votes for c_ in s.exec(select(HuntCountryRow))} == {"unknown": 1}


def test_country_counter_in_production(tmp_path: Path) -> None:
    e = make_env(tmp_path, env="production", turnstile=False)
    e.settings.turnstile_disabled = True
    build_status(e)
    with e.client() as c:
        for i, code in enumerate(["ES", "ES", "MX", "XX", "zz9"]):
            vote_r = c.post(
                "/api/v1/hunt/votes",
                json={
                    "session": sess(i),
                    "field_id": pub(e, "rnd-01", i),
                    "vote_token": tok_for(e, i, "rnd-01"),
                    "label": "nothing",
                },
                headers={"CF-IPCountry": code},
            )
            assert vote_r.status_code == 201, vote_r.text
        counts = c.get("/api/v1/hunt/counters").json()
    assert counts["countries"] == 2 and counts["classifications"] == 5


def test_counters_and_gold_accuracy(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]
    with env.client() as c:
        assert c.get("/api/v1/hunt/counters").json() == {
            "fields_reviewed": 0, "classifications": 0, "gold_votes": 0,
            "gold_accuracy": None, "countries": 0,
        }  # fmt: skip
        vote(env, c, 1, golds[0], "mover")
        vote(env, c, 2, golds[0], "nothing")
        vote(env, c, 1, "rnd-01", "nothing")
        out = c.get("/api/v1/hunt/counters").json()
    assert out["fields_reviewed"] == 2 and out["classifications"] == 3
    assert out["gold_votes"] == 2 and out["gold_accuracy"] == 0.5


def test_counters_ignore_fields_removed_from_the_bank(env: Env) -> None:
    engine = env.state.get_reports_engine()
    with Session(engine) as s:
        for sid, fid, ok in ((1, "gold-98", True), (2, "gold-98", False), (1, "rnd-97", None)):
            s.add(
                HuntVoteRow(
                    session=sess(sid), field_id=fid, label="mover", gold_correct=ok, created_at="t"
                )
            )
        s.commit()
    with env.client() as c:
        vote(env, c, 3, "rnd-01", "nothing")
        out = c.get("/api/v1/hunt/counters").json()
    assert out["fields_reviewed"] == 1 and out["classifications"] == 1
    assert out["gold_votes"] == 0 and out["gold_accuracy"] is None


def test_candidates_from_consensus_excluding_gold(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]
    ra0 = 100.0 + [f.id for f in load_bank().fields].index("ecl-01")  # centre set by build_status
    with env.client() as c:
        for i in range(6):
            vote(env, c, i, "ecl-01", "mover", mark={"ra_deg": ra0 + 0.001 * i, "dec_deg": 10.0})
            vote(env, c, i, "rnd-02", "nothing")
            vote(env, c, i, golds[0], "mover")  # gold is never listed as a candidate
            vote(env, c, i, golds[1], "mover")
        for i in range(3):
            vote(env, c, 20 + i, "ecl-02", "mover")  # too few votes
        out = c.get("/api/v1/hunt/candidates").json()
    assert out["status"] == "volunteer_consensus_unconfirmed"
    assert [x["field_id"] for x in out["candidates"]] == [pub(env, "ecl-01")]
    cand = out["candidates"][0]
    assert cand["label"] == "mover" and cand["share"] == 1.0 and cand["n_votes"] == 6
    assert cand["mark"]["n_marks"] == 6 and cand["mark"]["rms_arcsec"] < 10
    assert set(cand) == {
        "field_id",
        "status",
        "label",
        "share",
        "n_votes",
        "sequence_id",
        "center_deg",
        "mark",
    }


def test_sessions_below_the_gold_minimum_do_not_count(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]
    with env.client() as c:
        for i in range(10):  # no gold answers at all: weight 0.5 each would reach 2.5 alone
            vote(env, c, i, "ecl-01", "mover")
        assert c.get("/api/v1/hunt/candidates").json()["candidates"] == []
        for i in range(10):  # one gold answer is still below the minimum of two
            vote(env, c, i, golds[0], "mover")
        assert c.get("/api/v1/hunt/candidates").json()["candidates"] == []
        for i in range(4):
            vote(env, c, i, golds[1], "mover")
        assert c.get("/api/v1/hunt/candidates").json()["candidates"] == []  # only 4 eligible
        vote(env, c, 4, golds[1], "mover")
        out = c.get("/api/v1/hunt/candidates").json()["candidates"]
    assert [x["field_id"] for x in out] == [pub(env, "ecl-01")] and out[0]["n_votes"] == 5


def test_vote_token_rules(env: Env) -> None:
    fid = "rnd-01"
    good = tok_for(env, 1, fid)
    with env.client() as c:
        # Wrong session, wrong field, malformed, tampered.
        other_session = tok_for(env, 2, fid)
        wrong_field = tok_for(env, 1, "rnd-02")
        for bad in (
            other_session,
            wrong_field,
            "garbage",
            good[:-1] + ("0" if good[-1] != "0" else "1"),
        ):
            r = vote(env, c, 1, fid, "nothing", token=bad)
            if bad == "garbage":
                assert r.status_code == 422
            else:
                assert r.status_code == 403 and r.json()["code"] == "VOTE_TOKEN_INVALID", bad
        # Expired (issued three hours ago) and issued in the future.
        old = tok_for(env, 1, fid, now=time.time() - 3 * 3600)
        r = vote(env, c, 1, fid, "nothing", token=old)
        assert r.status_code == 403 and r.json()["code"] == "VOTE_TOKEN_EXPIRED"
        future = tok_for(env, 1, fid, now=time.time() + 3600)
        assert vote(env, c, 1, fid, "nothing", token=future).json()["code"] == "VOTE_TOKEN_EXPIRED"
        # Nothing was stored by the rejected attempts; the valid token works once.
        assert c.get("/api/v1/hunt/counters").json()["classifications"] == 0
        assert vote(env, c, 1, fid, "nothing", token=good).status_code == 201
        # The used token is stale now (vote count moved); a fresh one reaches the duplicate check.
        assert vote(env, c, 1, fid, "nothing", token=good).status_code == 403
        assert vote(env, c, 1, fid, "nothing").status_code == 409


def test_only_the_served_field_can_be_voted(env: Env) -> None:
    with env.client() as c:
        f = c.post("/api/v1/hunt/next", json={"session": sess(1)}).json()["field"]
        other = next(x.id for x in load_bank().fields if pub(env, x.id, 1) != f["field_id"])
        # The token of the served field does not authorize another field.
        r = vote(env, c, 1, other, "nothing", token=f["vote_token"])
        assert r.status_code == 403 and r.json()["code"] == "VOTE_TOKEN_INVALID"
        assert vote_served(c, 1, f, "nothing").status_code == 201


def test_burst_requires_turnstile_then_hard_limit(tmp_path: Path) -> None:
    e = make_env(tmp_path, turnstile=True)
    e.settings.turnstile_secret = "secret"
    build_status(e)
    ids = [f.id for f in load_bank().fields]
    with respx.mock(assert_all_called=False) as mock, e.client() as c:
        mock.post(TURNSTILE_VERIFY_URL).mock(
            side_effect=lambda req: httpx.Response(200, json={"success": b"good" in req.content})
        )
        # The first 40 votes need no token (fewer fields exist, so reuse them with new sessions).
        for i in range(40):
            assert vote(e, c, i, ids[i % len(ids)], "nothing").status_code == 201
        no = vote(e, c, 100, ids[0], "nothing")
        assert no.status_code == 403 and no.json()["code"] == "TURNSTILE_FAILED"
        bad = vote(e, c, 100, ids[0], "nothing", turnstile_token="bad")
        assert bad.status_code == 403
        good = vote(e, c, 100, ids[0], "nothing", turnstile_token="good")
        assert good.status_code == 201


def test_hard_rate_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from destello.api.routes import hunt as routes
    from destello.core import ratelimit

    monkeypatch.setattr(routes, "VOTE_HARD_LIMIT", ratelimit.Limit("hunt_votes", 15, 3600))
    e = make_env(tmp_path)
    build_status(e)
    with e.client() as c:
        codes = [vote(e, c, i, "rnd-01", "nothing").status_code for i in range(20)]
    assert codes.count(201) == 15 and codes[-1] == 429


def test_weights_ignore_fields_removed_from_gold(tmp_path: Path) -> None:
    from destello.api.hunt import volunteer_weights
    from destello.core.db import make_engine

    engine = make_engine(f"sqlite:///{tmp_path / 'w.sqlite'}")
    with Session(engine) as s:
        for fid, ok in (
            ("gold-01", True),
            ("gold-02", True),
            ("gold-09", False),
            ("gold-10", False),
        ):
            s.add(
                HuntVoteRow(
                    session=sess(1), field_id=fid, label="mover", gold_correct=ok, created_at="t"
                )
            )
        s.commit()
    # gold-09 and gold-10 left the bank in version 2: only the two current answers count.
    assert volunteer_weights(engine, {"gold-01", "gold-02"}) == {sess(1): 4 / 6}
    # One current gold answer is below the minimum of two: the session has no weight.
    assert volunteer_weights(engine, {"gold-01"}) == {}
    assert volunteer_weights(engine, set()) == {}


def test_next_is_repeatable_and_token_bound_to_vote_count(env: Env) -> None:
    with env.client() as c:
        first = [
            c.post("/api/v1/hunt/next", json={"session": sess(1)}).json()["field"] for _ in range(6)
        ]
        # Same session and vote count: the same field, so tokens cannot be collected for others.
        assert len({f["field_id"] for f in first}) == 1
        by_pub = {pub(env, f.id, 1): f.id for f in load_bank().fields}
        stale = first[0]["vote_token"]
        assert vote_served(c, 1, first[0], "nothing").status_code == 201
        # A token from before the vote no longer matches the session's vote count.
        nxt = c.post("/api/v1/hunt/next", json={"session": sess(1)}).json()["field"]
        assert nxt["field_id"] != first[0]["field_id"]
        r = c.post(
            "/api/v1/hunt/votes",
            json={
                "session": sess(1),
                "field_id": nxt["field_id"],
                "vote_token": stale,
                "label": "nothing",
            },
        )
        assert r.status_code == 403 and r.json()["code"] == "VOTE_TOKEN_INVALID"
        assert by_pub[nxt["field_id"]]
        assert vote_served(c, 1, nxt, "nothing").status_code == 201


def test_concurrent_votes_with_the_same_count_admit_exactly_one(env: Env) -> None:
    """Two votes holding tokens for the same vote count: the guarded insert lets one through."""
    import threading
    from concurrent.futures import ThreadPoolExecutor

    bank = load_bank().by_id()
    engine = env.state.get_reports_engine()
    for round_ in range(5):
        session = sess(500 + round_)
        a, b = bank["rnd-01"], bank["rnd-02"]
        barrier = threading.Barrier(2)

        def attempt(
            field: Any, session: str = session, barrier: threading.Barrier = barrier
        ) -> str:
            barrier.wait()
            try:
                hu.insert_vote(engine, session, field, "nothing", None, "unknown", 0)
            except hu.VoteTokenError as e:
                return e.code
            return "ok"

        with ThreadPoolExecutor(2) as pool:
            out = sorted(pool.map(attempt, [a, b]))
        assert out == ["VOTE_TOKEN_INVALID", "ok"]
        assert hu.session_vote_count(engine, session) == 1


def test_concurrent_http_votes_with_the_same_token_count(env: Env) -> None:
    from concurrent.futures import ThreadPoolExecutor

    with env.client() as c:
        tokens = [(f, tok_for(env, 600, f)) for f in ("rnd-01", "rnd-02")]

        def go(item: tuple[str, str]) -> int:
            return vote(env, c, 600, item[0], "nothing", token=item[1]).status_code

        with ThreadPoolExecutor(2) as pool:
            codes = sorted(pool.map(go, tokens))
        assert codes == [201, 403]
        assert c.get("/api/v1/hunt/counters").json()["classifications"] == 1


def test_next_depends_only_on_the_session_and_its_votes(env: Env) -> None:
    with env.client() as c:
        before = c.post("/api/v1/hunt/next", json={"session": sess(700)}).json()["field"]
        for i in range(8):  # other sessions vote on many fields in between
            f = c.post("/api/v1/hunt/next", json={"session": sess(710 + i)}).json()["field"]
            vote_served(c, 710 + i, f, "nothing")
        after = c.post("/api/v1/hunt/next", json={"session": sess(700)}).json()["field"]
    assert before["field_id"] == after["field_id"]


# ---------------------------------------------------------------- coverage balancing (hunt_served)
def test_next_is_stable_while_other_sessions_vote(env: Env) -> None:
    with env.client() as c:
        first = c.post("/api/v1/hunt/next", json={"session": sess(800)}).json()["field"]
        for i in range(6):
            f = c.post("/api/v1/hunt/next", json={"session": sess(810 + i)}).json()["field"]
            assert vote_served(c, 810 + i, f, "nothing").status_code == 201
            again = c.post("/api/v1/hunt/next", json={"session": sess(800)}).json()["field"]
            assert again["field_id"] == first["field_id"]
    engine = env.state.get_reports_engine()
    assert hu.served_field(engine, sess(800), 0) is not None


def test_next_prefers_fields_with_fewest_votes(env: Env) -> None:
    bank = load_bank()
    ready = hu.ready_fields(env.settings, bank)
    fields = bank.by_id()
    engine = env.state.get_reports_engine()
    secret = hu.hunt_secret(env.settings)
    non_gold = [f.id for f in bank.fields if f.kind != "gold"]
    low = non_gold[0]
    with Session(engine) as s:  # every other non gold field has votes
        for k, fid in enumerate(non_gold[1:]):
            s.add(
                HuntVoteRow(
                    session=f"x-session-{k:08d}-aaaa", field_id=fid, label="nothing", created_at="t"
                )
            )
        s.commit()
    for i in range(10):  # the first field of a session is never gold
        fid, n = hu.serve_field(engine, secret, sess(900 + i), fields, ready)
        assert n == 0 and fid == low


def test_concurrent_next_agrees(env: Env) -> None:
    from concurrent.futures import ThreadPoolExecutor

    bank = load_bank()
    ready = hu.ready_fields(env.settings, bank)
    fields = bank.by_id()
    engine = env.state.get_reports_engine()
    secret = hu.hunt_secret(env.settings)
    for r in range(5):
        session = sess(950 + r)
        with ThreadPoolExecutor(6) as pool:
            out = list(
                pool.map(
                    lambda _, s=session: hu.serve_field(engine, secret, s, fields, ready), range(6)
                )
            )
        assert len({o[0] for o in out}) == 1
        with Session(engine) as s:
            from destello.models.hunt import HuntServedRow

            assert (
                len(s.exec(select(HuntServedRow).where(HuntServedRow.session == session)).all())
                == 1
            )


def test_served_rows_are_pruned_after_seven_days(env: Env) -> None:
    from destello.models.hunt import HuntServedRow

    engine = env.state.get_reports_engine()
    with Session(engine) as s:
        s.add(
            HuntServedRow(session=sess(1), n=0, field_id="rnd-01", issued_at="2020-01-01T00:00:00Z")
        )
        s.commit()
    with env.client() as c:
        c.post("/api/v1/hunt/next", json={"session": sess(2)})
    with Session(engine) as s:
        assert s.exec(select(HuntServedRow).where(HuntServedRow.session == sess(1))).all() == []


# ------------------------------------------------------------------ per-address cap
def test_consensus_counts_two_sessions_per_address(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]

    def run(ips: list[str]) -> list[Any]:
        with env.client() as c:
            for i, ip in enumerate(ips):
                for g in golds[:2]:
                    vote(env, c, i, g, "mover", ip=ip)
                vote(env, c, i, "ecl-01", "mover", ip=ip)
            return c.get("/api/v1/hunt/candidates").json()["candidates"]

    # Six sessions on one address: only two count, below the minimum of five votes.
    assert run(["203.0.113.7"] * 6) == []


def test_consensus_cap_keeps_the_first_and_spreads_over_addresses(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]
    ips = ["203.0.113.7"] * 4 + ["203.0.113.8", "203.0.113.9", "203.0.113.10"]
    with env.client() as c:
        for i, ip in enumerate(ips):
            for g in golds[:2]:
                vote(env, c, i, g, "mover", ip=ip)
            vote(env, c, i, "ecl-01", "mover", ip=ip)
        out = c.get("/api/v1/hunt/candidates").json()["candidates"]
    # 2 of 4 from the shared address plus 3 others: five counted votes.
    assert len(out) == 1 and out[0]["n_votes"] == 5


def test_legacy_rows_without_a_hash_are_not_capped(env: Env) -> None:
    golds = [f.id for f in load_bank().fields if f.kind == "gold"]
    engine = env.state.get_reports_engine()
    with Session(engine) as s:
        for i in range(6):
            for g in [*golds[:2], "ecl-01"]:
                s.add(
                    HuntVoteRow(
                        session=sess(i),
                        field_id=g,
                        label="mover",
                        gold_correct=True if g in golds else None,
                        created_at="t",
                    )
                )
        s.commit()
    with env.client() as c:
        out = c.get("/api/v1/hunt/candidates").json()["candidates"]
    assert len(out) == 1 and out[0]["n_votes"] == 6


def test_missing_column_is_added(tmp_path: Path) -> None:
    import sqlite3

    from destello.core.db import make_engine

    db = tmp_path / "old.sqlite"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE hunt_votes (id INTEGER PRIMARY KEY, session VARCHAR, field_id VARCHAR,"
        " label VARCHAR, mark_ra_deg FLOAT, mark_dec_deg FLOAT, gold_correct BOOLEAN,"
        " created_at VARCHAR)"
    )
    con.commit()
    con.close()
    engine = make_engine(f"sqlite:///{db}")
    with engine.connect() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(hunt_votes)")}
    assert "client_hash" in cols


def test_vote_client_key_is_per_field_and_groups_an_ipv6_prefix() -> None:
    from destello.api import hunt as hu
    from destello.core.config import Settings

    st = Settings(hunt_secret="k")
    a = hu.vote_client_key(st, "2001:db8:1:2::1", "f1")
    assert a == hu.vote_client_key(st, "2001:db8:1:2:ffff::9", "f1")
    assert a != hu.vote_client_key(st, "2001:db8:1:3::1", "f1")
    assert a != hu.vote_client_key(st, "2001:db8:1:2::1", "f2")
    assert hu.vote_client_key(st, "203.0.113.9", "f1") != hu.vote_client_key(
        st, "203.0.113.10", "f1"
    )
    assert "203.0.113.9" not in hu.vote_client_key(st, "203.0.113.9", "f1")
    assert hu.vote_client_key(st, "::ffff:203.0.113.9", "f1") == hu.vote_client_key(
        st, "203.0.113.9", "f1"
    )
