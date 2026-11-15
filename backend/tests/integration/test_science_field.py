"""Measurement endpoints reject positions outside the sequence field (docs/06 section 3.5).

Data free: a manifest and an empty sidecar are enough, because the check runs before any catalog
request and before any image is read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.integration.test_api_endpoints import SID, Env, write_manifest

RA0, DEC0 = 269.44635, 4.76841  # grid center written by `write_manifest` (6 arcmin field)


@pytest.fixture
def seeded(tmp_path: Path) -> Env:
    env = Env(tmp_path)
    write_manifest(env.settings, frames=True)
    builds = env.settings.data_dir / "builds"
    builds.mkdir(parents=True, exist_ok=True)
    (builds / f"{SID}.json").write_text(
        json.dumps({"params": {}, "exposures": []}), encoding="utf-8"
    )
    return env


@pytest.mark.parametrize(
    ("ra", "dec"),
    [
        (10.0, -60.0),  # another part of the sky
        (RA0 - 180.0, -DEC0),  # antipode: not projectable
        (RA0 + 0.06, DEC0),  # 3.6 arcmin east: just off a 6 arcmin field
        (RA0, DEC0 - 0.06),
    ],
)
def test_astrometry_outside_the_field_is_a_client_error(seeded: Env, ra: float, dec: float) -> None:
    with seeded.client() as c:
        r = c.post(f"/api/v1/sequences/{SID}/astrometry", json={"ra_deg": ra, "dec_deg": dec})
    assert r.status_code == 422, r.text
    assert r.headers["content-type"].startswith("application/problem+json")
    body = r.json()
    assert body["code"] == "POSITION_OUTSIDE_FIELD"
    assert "field" in body["detail"]
    # rejected before any reference catalog is requested
    assert seeded.gaia.calls == 0 and seeded.catwise.calls == 0


@pytest.mark.parametrize(("ra", "dec"), [(10.0, -60.0), (RA0 - 180.0, -DEC0), (RA0 + 0.06, DEC0)])
def test_spectrum_outside_the_field_is_a_client_error(seeded: Env, ra: float, dec: float) -> None:
    with seeded.client() as c:
        r = c.get(f"/api/v1/sequences/{SID}/spectrum", params={"ra_deg": ra, "dec_deg": dec})
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "POSITION_OUTSIDE_FIELD"


def test_out_of_field_answers_are_not_cached(seeded: Env) -> None:
    with seeded.client() as c:
        for _ in range(2):
            r = c.get(
                f"/api/v1/sequences/{SID}/spectrum", params={"ra_deg": 10.0, "dec_deg": -60.0}
            )
            assert r.status_code == 422


def test_a_position_on_the_grid_passes_the_field_check(seeded: Env) -> None:
    # The seeded sequence lists no exposures, so the request fails later with a different code:
    # the field check itself accepted the position.
    with seeded.client() as c:
        r = c.get(
            f"/api/v1/sequences/{SID}/spectrum",
            params={"ra_deg": RA0 + 0.02, "dec_deg": DEC0 - 0.02},
        )
    assert r.status_code == 422, r.text
    assert r.json()["code"] == "NO_EXPOSURES"
