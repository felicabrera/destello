"""API Cache-Control policy (middleware.cache_policy)."""

from __future__ import annotations

import pytest

from destello.api.middleware import cache_policy

SID = "3271567e0e33ed2b"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("/api/v1/targets", "public, max-age=300"),
        ("/api/v1/validation", "public, max-age=300"),
        ("/api/v1/releases", "public, max-age=300"),
        ("/api/v1/resolve", "public, max-age=3600"),
        (f"/api/v1/sequences/{SID}/overlays/gaia_dr3", "public, max-age=3600"),
        (f"/api/v1/sequences/{SID}/difference", "public, max-age=3600"),
        (f"/api/v1/sequences/{SID}/spectrum", "public, max-age=3600"),
        ("/api/v1/health", "no-store"),
        (f"/api/v1/sequences/{SID}", "no-store"),
        (f"/api/v1/sequences/{SID}/events", "no-store"),
        ("/api/v1/sequences/estimate", "no-store"),
        ("/api/v1/sequences/NOTHEX0000000000/spectrum", "no-store"),
    ],
)
def test_successful_get(path: str, expected: str) -> None:
    assert cache_policy("GET", path, 200) == expected


@pytest.mark.parametrize("status", [202, 404, 422, 429, 500, 502, 503])
def test_non_200_is_never_cached(status: int) -> None:
    assert cache_policy("GET", "/api/v1/targets", status) == "no-store"
    assert cache_policy("GET", f"/api/v1/sequences/{SID}/spectrum", status) == "no-store"


def test_writes_are_never_cached() -> None:
    assert cache_policy("POST", f"/api/v1/sequences/{SID}/spectrum", 200) == "no-store"
    assert cache_policy("POST", "/api/v1/sequences", 200) == "no-store"
