import fakeredis.aioredis
import httpx
import respx
from fastapi.testclient import TestClient

from destello.api.main import create_app
from destello.core.config import Settings


def _app(tmp_path):  # type: ignore[no-untyped-def]
    settings = Settings(data_dir=tmp_path, env="development")
    return create_app(settings, redis=fakeredis.aioredis.FakeRedis(), queue=object())


@respx.mock
def test_health_ok(tmp_path) -> None:  # type: ignore[no-untyped-def]
    route = respx.get("https://irsa.ipac.caltech.edu/TAP/availability").mock(
        return_value=httpx.Response(
            200, text="<vosi:availability><available>true</available></vosi:availability>"
        )
    )
    with TestClient(_app(tmp_path)) as client:
        r = client.get("/api/v1/health")
        assert r.status_code == 200
        body = r.json()
        assert set(body) == {"status", "version", "pipeline_version", "irsa"}
        assert body["status"] == "ok" and body["irsa"] == "ok"
        # the IRSA probe is cached for 60 seconds
        client.get("/api/v1/health")
        assert route.call_count == 1


@respx.mock
def test_health_reports_irsa_down(tmp_path) -> None:  # type: ignore[no-untyped-def]
    respx.get("https://irsa.ipac.caltech.edu/TAP/availability").mock(
        side_effect=httpx.ConnectError("refused")
    )
    with TestClient(_app(tmp_path)) as client:
        r = client.get("/api/v1/health")
        assert r.status_code == 200 and r.json()["irsa"] == "down"


def test_problem_json_for_404_and_validation(tmp_path) -> None:  # type: ignore[no-untyped-def]
    with TestClient(_app(tmp_path), raise_server_exceptions=False) as client:
        r = client.get("/api/v1/does-not-exist")
        assert r.status_code == 404
        assert r.headers["content-type"].startswith("application/problem+json")
        body = r.json()
        assert body["code"] == "NOT_FOUND" and body["status"] == 404
        assert body["instance"] == "/api/v1/does-not-exist"
        assert {"type", "title", "detail"} <= set(body)
