"""Spectrum and astrometry endpoints on the stored real preset sequences (marker `science`).

These tests need the built preset data (DESTELLO_DATA_DIR with pins.json, manifests, builds,
frames, cutouts, calibration and the cached Gaia DR3 cone results). They are skipped when that
data is absent. Thresholds are the product tolerances from docs/11, never adjusted to the data.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient

from destello.api.deps import AppState
from destello.api.main import create_app
from destello.core.config import Settings
from destello.models.targets import load_targets
from destello.sources.catwise import CatwiseClient
from destello.sources.gaia import GaiaClient
from tests.integration.test_api_endpoints import FakeIrsa, FakeQueue, FakeSimbad

DATA = Path(os.environ.get("DESTELLO_DATA_DIR", "/data"))
pytestmark = [
    pytest.mark.science,
    pytest.mark.skipif(not (DATA / "pins.json").is_file(), reason="preset data not available"),
]


def _pins() -> dict[str, Any]:
    presets: dict[str, Any] = json.loads((DATA / "pins.json").read_text("utf-8"))["presets"]
    return presets


@pytest.fixture(scope="module")
def client() -> Any:
    settings = Settings(data_dir=DATA, ip_hash_salt="science-tests")
    state = AppState(
        settings=settings,
        redis=fakeredis.aioredis.FakeRedis(),
        queue=FakeQueue(),
        irsa=FakeIrsa(),  # type: ignore[arg-type]
        gaia=GaiaClient(settings),
        catwise=CatwiseClient(settings),
        simbad=FakeSimbad(),  # type: ignore[arg-type]
    )
    with TestClient(create_app(settings, state=state), raise_server_exceptions=False) as c:
        yield c


def test_spectrum_rdra(client: TestClient) -> None:
    sid = _pins()["rdra"]["sequence_id"]
    a = load_targets()["rdra"].astrometry
    r = client.get(
        f"/api/v1/sequences/{sid}/spectrum", params={"ra_deg": a.ra_deg, "dec_deg": a.dec_deg}
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["unit"] == "Jy"
    pts = doc["points"]
    assert len(pts) > 20
    for p in pts:
        assert 0.7 < p["wavelength_um"] < 5.1
        assert p["bandwidth_um"] > 0
        assert isinstance(p["flagged"], bool) and isinstance(p["saturated"], bool)
        if p["flux"] is not None:
            assert p["flux_err"] > 0
    # R Dra is bright in the near infrared: in the stored release almost every exposure has an
    # early overflow in the source core. Saturated points must be flagged and must not carry a
    # flux; every flagged point states why, and usable points have no reason.
    for p in pts:
        if p["saturated"]:
            assert p["flagged"] is True and p["flux"] is None
            assert p["reason"] == "saturated_core"
        assert (p["reason"] is not None) == p["flagged"]
        assert isinstance(p["aperture_flags"], list) and isinstance(p["core_flags"], list)
    assert sum(p["saturated"] for p in pts) > len(pts) // 2
    assert all(e["n_images"] <= e["n_total"] for e in doc["epoch_photometry"])
    codes = {w["code"] for w in doc["warnings"]}
    assert "PRESET_ASTROMETRY_USED" in codes
    if any(p["saturated"] for p in pts):
        assert "SATURATION" in codes


def test_spectrum_validation_errors(client: TestClient) -> None:
    sid = _pins()["rdra"]["sequence_id"]
    r = client.get(f"/api/v1/sequences/{sid}/spectrum", params={"ra_deg": 400, "dec_deg": 0})
    assert r.status_code == 422
    r = client.get("/api/v1/sequences/zzzz/spectrum", params={"ra_deg": 1, "dec_deg": 0})
    assert r.status_code == 422


def test_astrometry_barnard_against_gaia(client: TestClient) -> None:
    sid = _pins()["barnard"]["sequence_id"]
    a = load_targets()["barnard"].astrometry
    r = client.post(
        f"/api/v1/sequences/{sid}/astrometry",
        json={"ra_deg": a.ra_deg, "dec_deg": a.dec_deg, "reference": "literature"},
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["reference"]["source"].startswith("Gaia DR3")
    assert doc["fit"]["n_epochs"] >= 2
    assert doc["fit"]["parallax_fixed"] is True
    measured = [e for e in doc["epochs"] if e["measured"]]
    assert all(e["recalibration_stars"] >= 3 for e in measured)
    # docs/11 V-02: within 3 combined sigma of Gaia DR3, relative error below 20 percent
    assert doc["agreement_sigma"] <= 3.0
    assert doc["fit"]["pm_total_err_masyr"] / doc["fit"]["pm_total_masyr"] < 0.2


def test_astrometry_saturated_core_uses_psf_wings(client: TestClient) -> None:
    # R Dra is saturated on detector 1 in every exposure. The pipeline measures it from the
    # unflagged PSF wings (docs/03, saturation) and must say so, with an uncertainty that does not
    # claim a motion the data cannot support. The too-few-epochs outcome is covered with
    # synthetic data in test_api_endpoints.py.
    sid = _pins()["rdra"]["sequence_id"]
    a = load_targets()["rdra"].astrometry
    r = client.post(
        f"/api/v1/sequences/{sid}/astrometry",
        json={"ra_deg": a.ra_deg, "dec_deg": a.dec_deg, "detector": 1, "reference": "none"},
    )
    assert r.status_code == 200, r.text
    doc = r.json()
    codes = {w["code"] for w in doc["warnings"]}
    assert {"SATURATION", "PSF_WINGS_CENTROID"} <= codes
    if doc["status"] == "not_measurable":
        assert doc["fit"] is None and "TOO_FEW_EPOCHS" in codes
    else:
        fit = doc["fit"]
        assert doc["status"] == "ok" and fit["n_epochs"] >= 2
        # R Dra moves a few tens of mas/yr (Gaia DR3): over one year with ~6 arcsec pixels the
        # wings fit cannot resolve that, so the result must be consistent with it within 3 sigma.
        assert fit["pm_total_masyr"] <= 3 * fit["pm_total_err_masyr"]


def test_positions_outside_the_field_are_client_errors(client: TestClient) -> None:
    # docs/06 section 3.5: a position off the sequence grid is a client error on both endpoints
    sid = _pins()["wise0855"]["sequence_id"]
    manifest = json.loads((DATA / "manifests" / f"{sid}.json").read_text("utf-8"))
    ra0, dec0 = manifest["grid"]["crval_deg"]
    for ra, dec in ((ra0 + 0.5, dec0), (10.0, 60.0)):
        r = client.post(
            f"/api/v1/sequences/{sid}/astrometry",
            json={"ra_deg": ra, "dec_deg": dec, "reference": "none"},
        )
        assert r.status_code == 422, r.text
        assert r.json()["code"] == "POSITION_OUTSIDE_FIELD"
        r = client.get(f"/api/v1/sequences/{sid}/spectrum", params={"ra_deg": ra, "dec_deg": dec})
        assert r.status_code == 422, r.text
        assert r.json()["code"] == "POSITION_OUTSIDE_FIELD"
