"""NFR-OBS-01: browser error reports and logging of unhandled server errors."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import APIRouter

from destello.api import errors as errors_mod
from destello.api.routes import client_errors as ce_mod
from destello.api.routes.client_errors import CLIENT_ERROR_LIMIT, scrub
from tests.integration.test_api_endpoints import Env, assert_problem, env  # noqa: F401

URL = "/api/v1/client-errors"


class Recorder:
    """Stands in for a module level structlog logger (those are cached on first use)."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def _add(self, event: str, **kw: Any) -> None:
        self.events.append({"event": event, **kw})

    warning = error = info = _add


@pytest.fixture
def logs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    rec = Recorder()
    monkeypatch.setattr(ce_mod, "log", rec)
    monkeypatch.setattr(errors_mod, "_log", rec)
    return rec.events


def body(**over: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "kind": "error",
        "message": "TypeError: x is undefined",
        "stack": "at draw (https://host/assets/index-abc.js?v=1:10:5)\nat run (app.js#frag:1:1)",
        "route": "/explore?ra=269.4&dec=4.7#x",
        "release": "abc1234",
    }
    out.update(over)
    return out


def test_client_error_is_logged_without_query_strings(
    env: Env,  # noqa: F811
    logs: list[dict[str, Any]],
) -> None:
    r = env.client().post(URL, json=body())
    assert r.status_code == 204
    events = [e for e in logs if e["event"] == "client_error"]
    assert len(events) == 1
    e = events[0]
    assert e["route"] == "/explore"
    assert "?" not in e["stack"] and "#" not in e["stack"]
    assert "index-abc.js:10:5" in e["stack"]
    assert e["kind"] == "error" and e["release"] == "abc1234"
    assert len(e["client"]) == 16  # salted hash, never the address


def test_client_error_schema_is_strict(env: Env) -> None:  # noqa: F811
    c = env.client()
    assert_problem(c.post(URL, json=body(kind="other")), 422, "VALIDATION_ERROR")
    assert_problem(c.post(URL, json=body(message="x" * 501)), 422, "VALIDATION_ERROR")
    assert_problem(c.post(URL, json=body(extra="no")), 422, "VALIDATION_ERROR")


def test_client_errors_over_the_limit_are_dropped(
    env: Env,  # noqa: F811
    logs: list[dict[str, Any]],
) -> None:
    with env.client() as c:
        for _ in range(CLIENT_ERROR_LIMIT.limit + 3):
            assert c.post(URL, json=body()).status_code == 204
    assert sum(e["event"] == "client_error" for e in logs) == CLIENT_ERROR_LIMIT.limit


def test_scrub_removes_control_characters_but_keeps_lines() -> None:
    assert scrub("a\x1b[31mb\nc?d=1") == "a[31mb\nc"


def test_unhandled_error_is_logged_with_the_request_id(
    env: Env,  # noqa: F811
    logs: list[dict[str, Any]],
) -> None:
    boom = APIRouter()

    @boom.get("/api/v1/boom")
    async def _boom() -> None:
        raise RuntimeError("secret internal detail")

    env.app.include_router(boom)
    r = env.client().get("/api/v1/boom", headers={"X-Request-Id": "req-12345678"})
    p = assert_problem(r, 500, "INTERNAL_ERROR")
    assert "secret" not in r.text
    assert p["request_id"] == "req-12345678"
    events = [e for e in logs if e["event"] == "unhandled_error"]
    assert events and events[0]["request_id"] == "req-12345678"
    assert events[0]["error_type"] == "RuntimeError"
