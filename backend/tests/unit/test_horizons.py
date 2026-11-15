"""JPL Horizons client (F-33) on recorded real answers (ssd.jpl.nasa.gov, 2026-11-14)."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
import respx
from astropy.time import Time

from destello.core.config import DataMode, Settings
from destello.sources.horizons import (
    HORIZONS_URL,
    DesignationError,
    HorizonsAmbiguous,
    HorizonsClient,
    HorizonsNotFound,
    normalize_designation,
    parse_ephemeris,
    parse_lookup,
)

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "horizons"


def result(name: str) -> str:
    text: str = json.loads((FIX / name).read_text())["result"]
    return text


@pytest.mark.parametrize(
    ("text", "command"),
    [
        ("3I/ATLAS", "3I;"),
        ("3I", "3I;"),
        ("C/2025 N1", "C/2025 N1;"),
        ("C/2025 N1 (ATLAS)", "C/2025 N1;"),
        ("Ceres", "Ceres;"),
        ("1", "1;"),
        ("(433)", "433;"),
        ("1P/Halley", "1P;"),
        ("2025 MN45", "2025 MN45;"),
        ("90004937", "90004937;"),
        ("  C/2025   N1 ", "C/2025 N1;"),
    ],
)
def test_designations_accepted(text: str, command: str) -> None:
    assert normalize_designation(text) == command


@pytest.mark.parametrize(
    "text",
    ["", "x'; drop", "http://evil.example", "../../etc", "Ceres;", "a" * 60, "C/2025 N1'", "1;2"],
)
def test_designations_rejected(text: str) -> None:
    with pytest.raises(DesignationError):
        normalize_designation(text)


def test_parse_lookup_single_and_ambiguous() -> None:
    t = parse_lookup(result("lookup_3I.json"))
    assert t.record_id == 90004937
    assert t.name == "ATLAS (C/2025 N1)"
    assert parse_lookup(result("lookup_1.json")).name.startswith("1 Ceres")
    with pytest.raises(HorizonsAmbiguous) as exc:
        parse_lookup(result("lookup_halley.json"))
    cands = exc.value.candidates
    assert cands[0] == {
        "record": "2688",
        "epoch_year": "",
        "designation": "1982 HG1",
        "name": "Halley",
    }
    assert all(c["record"].isdigit() for c in cands)
    with pytest.raises(HorizonsNotFound):
        parse_lookup(result("lookup_nomatch.json"))


def test_parse_ephemeris_real_rows() -> None:
    eph = parse_ephemeris(result("ephem_90004937_tlist.json"), 90004937)
    assert eph.solution == "JPL#55"
    assert eph.target_name == "ATLAS (C/2025 N1)"
    assert len(eph.rows) == 3
    r = eph.rows[1]
    assert r.jd_utc == pytest.approx(2461017.505164)
    assert r.ra_deg == pytest.approx(173.808683729)
    assert r.dec_deg == pytest.approx(2.821144333)
    assert r.delta_au == pytest.approx(1.84526817467333)
    assert r.mag_kind == "T-mag" and r.mag == pytest.approx(15.349)
    assert r.ra_3sigma_arcsec == pytest.approx(0.093)
    assert r.ra_rate_arcsec_h == pytest.approx(-150.790)


@respx.mock
async def test_client_ephemeris_order_and_query_only_values(tmp_path: Path) -> None:
    route = respx.get(HORIZONS_URL).mock(
        return_value=httpx.Response(200, text=(FIX / "ephem_90004937_tlist.json").read_text())
    )
    async with HorizonsClient(Settings(data_dir=tmp_path, data_mode=DataMode.HYBRID)) as c:
        times = [
            Time(2461023.75149362, format="jd", scale="utc"),
            Time(2460900.123, format="jd", scale="utc"),
            Time(2461017.505164, format="jd", scale="utc"),
        ]
        eph = await c.ephemeris(90004937, times)  # type: ignore[attr-defined]
    assert [round(r.jd_utc, 6) for r in eph.rows] == [2461023.751494, 2460900.123, 2461017.505164]
    req = route.calls[0].request
    assert req.url.host == "ssd.jpl.nasa.gov" and req.url.path == "/api/horizons.api"
    assert req.url.params["COMMAND"] == "'90004937;'"
    assert req.url.params["CENTER"] == "'500@399'"


@respx.mock
async def test_client_lookup_sends_normalized_command(tmp_path: Path) -> None:
    route = respx.get(HORIZONS_URL).mock(
        return_value=httpx.Response(200, text=(FIX / "lookup_3I.json").read_text())
    )
    async with HorizonsClient(Settings(data_dir=tmp_path)) as c:
        t = await c.lookup("3I/ATLAS")  # type: ignore[attr-defined]
        with pytest.raises(DesignationError):
            await c.lookup("https://evil.example/x")  # type: ignore[attr-defined]
    assert t.record_id == 90004937
    assert len(route.calls) == 1
    assert route.calls[0].request.url.params["COMMAND"] == "'3I;'"
