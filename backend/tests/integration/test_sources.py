"""Source clients against recorded HTTP responses (respx). No network access."""

from __future__ import annotations

import asyncio
import io
import time
from pathlib import Path

import astropy.units as u
import httpx
import numpy as np
import pytest
import respx
from astropy.io import fits
from astropy.time import Time

from destello.core.config import DataMode, Settings
from destello.core.egress import EgressError
from destello.models.catalog import CatalogSource
from destello.pipeline.query import ImageRecord, cutout_url, discovery_adql, parse_rows
from destello.sources import gaia as gaia_mod
from destello.sources.base import OfflineMiss, SourceError, SourceUnavailable
from destello.sources.catwise import CatwiseClient
from destello.sources.catwise import parse_row as catwise_row
from destello.sources.gaia import GaiaClient
from destello.sources.irsa import RESOLVE_URL, SIA_URL, TAP_URL, IrsaClient, parse_resolve_body
from destello.sources.sbident import SBIdentClient
from destello.sources.sesame import SESAME_URL, SesameClient, parse_sesame
from destello.sources.simbad import SIMBAD_TAP_URL, SimbadClient, resolve_adql

IRSA_ROWS_CSV = (
    "planeid,obsid,productid,energy_bounds_lower,energy_bounds_upper,time_bounds_lower,"
    "time_bounds_upper,time_exposure,uri,contentlength,collection,observationid\n"
    "p1,o1,D6,4.4115e-06,5.0096e-06,60902.864715,60902.866047,113.58,"
    "ibe/data/spherex/qr2/level2/2025W33_2C/l2b-v20-2025-266/6/"
    "level2_2025W33_2C_0321_1D6_spx_l2b-v20-2025-266.fits,71634240,spherex_qr2,2025W33_2C_0321_1\n"
    "p2,o2,D3,1.6301e-06,2.4346e-06,60908.642174,60908.643506,113.58,"
    "ibe/data/spherex/qr2/level2/2025W34_2B/l2b-v20-2025-267/3/"
    "level2_2025W34_2B_0030_3D3_spx_l2b-v20-2025-267.fits,71634240,spherex_qr2,2025W34_2B_0030_3\n"
)


def settings(tmp_path: Path, mode: DataMode = DataMode.HYBRID) -> Settings:
    return Settings(data_dir=tmp_path, data_mode=mode)


def fast(client: IrsaClient) -> IrsaClient:
    client.wait_initial_s = 0.01
    client.wait_max_s = 0.02
    client.max_attempts = 3
    return client


def test_discovery_adql_is_validated() -> None:
    adql = discovery_adql(133.79, -7.24, ["spherex_qr2"], [6, 5])
    assert "CONTAINS(POINT('ICRS', 133.7900000, -7.2400000), p.poly)" in adql
    assert "'D5', 'D6'" in adql
    with pytest.raises(ValueError):
        discovery_adql(1, 2, ["x'; DROP TABLE"], None)
    with pytest.raises(ValueError):
        discovery_adql(1, 2, ["spherex_qr2"], [7])


def test_parse_rows_and_cutout_url() -> None:
    import csv

    recs = parse_rows(list(csv.DictReader(io.StringIO(IRSA_ROWS_CSV))))
    assert [r.detector for r in recs] == [6, 3]
    assert recs[0].obs_id == "level2_2025W33_2C_0321_1D6_spx_l2b-v20-2025-266"
    assert recs[0].wave_min.to_value(u.um) == pytest.approx(4.4115)
    url = cutout_url(recs[0].uri, 269.45, 4.69, 6 * u.arcmin)
    assert url.endswith("?center=269.450000,4.690000d&size=0.10000")
    assert url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/")
    for bad in ["../etc/passwd", "/abs/path", "ibe/data/spherex/x.fits?evil=1", "other/x.fits"]:
        with pytest.raises(ValueError):
            cutout_url(bad, 1.0, 2.0, 1 * u.arcmin)


@respx.mock
async def test_query_images_and_cache(tmp_path: Path) -> None:
    route = respx.post(TAP_URL).mock(return_value=httpx.Response(200, text=IRSA_ROWS_CSV))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        recs = await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
        again = await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
    assert len(recs) == 2 and len(again) == 2
    assert route.call_count == 1  # second call served from the cache (hybrid mode)


@respx.mock
async def test_offline_mode_uses_cache_only(tmp_path: Path) -> None:
    respx.post(TAP_URL).mock(return_value=httpx.Response(200, text=IRSA_ROWS_CSV))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
    async with fast(IrsaClient(settings(tmp_path, DataMode.OFFLINE))) as irsa:
        assert len(await irsa.query_images(269.45, 4.69, ["spherex_qr2"])) == 2
        with pytest.raises(OfflineMiss):
            await irsa.query_images(1.0, 2.0, ["spherex_qr2"])


@respx.mock
async def test_retries_on_503_then_succeeds(tmp_path: Path) -> None:
    route = respx.post(TAP_URL).mock(
        side_effect=[httpx.Response(503, text="busy"), httpx.Response(200, text=IRSA_ROWS_CSV)]
    )
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        recs = await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
    assert len(recs) == 2 and route.call_count == 2


@respx.mock
async def test_gives_up_after_retries(tmp_path: Path) -> None:
    respx.post(TAP_URL).mock(return_value=httpx.Response(503, text="busy"))
    respx.get(SIA_URL).mock(return_value=httpx.Response(503, text="busy"))  # fallback is down too
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(269.45, 4.69, ["spherex_qr2"])


@respx.mock
async def test_circuit_opens_after_connection_failures(tmp_path: Path) -> None:
    """A host that refused every attempt is not contacted again right away (fast failure)."""
    route = respx.post(TAP_URL).mock(side_effect=httpx.ConnectError("refused"))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
        calls = route.call_count
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(10.0, 20.0, ["spherex_qr2"])
        assert route.call_count == calls  # the second request never reached the network
        irsa._down_until.clear()  # after the pause the host is tried again
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(10.0, 20.0, ["spherex_qr2"])
        assert route.call_count > calls


@respx.mock
async def test_circuit_stays_closed_on_retryable_status(tmp_path: Path) -> None:
    route = respx.post(TAP_URL).mock(return_value=httpx.Response(503, text="busy"))
    respx.get(SIA_URL).mock(return_value=httpx.Response(503, text="busy"))  # fallback is down too
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(269.45, 4.69, ["spherex_qr2"])
        calls = route.call_count
        with pytest.raises(SourceUnavailable):
            await irsa.query_images(10.0, 20.0, ["spherex_qr2"])
        assert route.call_count > calls


def fake_cutout_bytes() -> bytes:
    h = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(np.ones((4, 4), np.float32), name="IMAGE"),
            fits.ImageHDU(np.ones((4, 4), np.int32), name="FLAGS"),
            fits.ImageHDU(np.ones((101, 101, 5), np.float32), name="PSF"),
        ]
    )
    buf = io.BytesIO()
    h.writeto(buf)
    return buf.getvalue()


@respx.mock
async def test_cutout_download_drops_psf_and_is_content_addressed(tmp_path: Path) -> None:
    rec = parse_rows(__import__("csv").DictReader(io.StringIO(IRSA_ROWS_CSV)))[0]
    route = respx.get(url__regex=r"https://irsa\.ipac\.caltech\.edu/ibe/data/spherex/.*").mock(
        return_value=httpx.Response(200, content=fake_cutout_bytes())
    )
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        p1 = await irsa.download_cutout(rec, 269.45, 4.69, 7 * u.arcmin)
        p2 = await irsa.download_cutout(rec, 269.45, 4.69, 7 * u.arcmin)
    assert p1 == p2 and route.call_count == 1
    with fits.open(p1) as hdul:
        assert [h.name for h in hdul] == ["PRIMARY", "IMAGE", "FLAGS"]
    assert "cutouts" in p1.parts


@respx.mock
async def test_cutout_host_outside_allowlist_is_blocked(tmp_path: Path) -> None:
    rec = parse_rows(__import__("csv").DictReader(io.StringIO(IRSA_ROWS_CSV)))[0]
    respx.get(url__regex=r"https://irsa\.ipac\.caltech\.edu/.*").mock(
        return_value=httpx.Response(302, headers={"location": "https://evil.example/x.fits"})
    )
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        with pytest.raises(EgressError):
            await irsa.download_cutout(rec, 269.45, 4.69, 7 * u.arcmin)


GAIA_CSV = (
    "source_id,ra,dec,pmra,pmdec,parallax,parallax_error,pmra_error,pmdec_error,"
    "phot_g_mean_mag,ref_epoch,radial_velocity,ruwe\n"
    "4472832130942575872,269.44850252543836,4.739420051112412,-801.5509783684709,"
    "10362.394206546573,546.975939730948,0.040116355,0.031820867,0.036070455,8.1939745,2016.0,"
    "-110.46822,1.0848505\n"
)


MAST_URL = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync"
ESA_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
IRSA_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
GAIA_FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "gaia"


@pytest.fixture(autouse=True)
def _reset_gaia_skips() -> None:
    gaia_mod.reset_skips()


@respx.mock
async def test_gaia_cone_prefers_mast(tmp_path: Path) -> None:
    mast = respx.post(MAST_URL).mock(
        return_value=httpx.Response(200, content=(GAIA_FIXTURES / "barnard_mast.xml").read_bytes())
    )
    esa = respx.post(ESA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    async with GaiaClient(settings(tmp_path)) as gaia:
        src = (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0]
    assert mast.call_count == 1 and esa.call_count == 0
    query = mast.calls[0].request.content.decode()
    assert "dbo.gaia_source" in query and "gaiadr3.gaia_source" not in query
    assert src.source_id == "4472832130942575872" and src.ref_epoch_jyear == 2016.0
    assert src.archive == "MAST"
    assert src.pmdec_masyr == pytest.approx(10362.394206546573)
    assert src.astrometry().parallax.to_value(u.mas) == pytest.approx(546.975939730948)
    # The copy is kept in the cache entry, so a cached answer still names it.
    async with GaiaClient(settings(tmp_path)) as gaia:
        assert (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0].archive == "MAST"
    assert mast.call_count == 1


@respx.mock
async def test_gaia_falls_back_from_mast_to_esa(tmp_path: Path) -> None:
    mast = respx.post(MAST_URL).mock(return_value=httpx.Response(503))
    esa = respx.post(ESA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    irsa = respx.post(IRSA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    async with GaiaClient(settings(tmp_path)) as gaia:
        gaia.wait_initial_s, gaia.wait_max_s = 0.01, 0.02
        src = (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0]
    assert mast.call_count == 2 and esa.call_count == 1 and irsa.call_count == 0
    assert "gaiadr3.gaia_source" in esa.calls[0].request.content.decode()
    assert src.archive == "ESA" and src.ref_epoch_jyear == 2016.0
    # The next query skips the failing MAST copy.
    async with GaiaClient(settings(tmp_path / "b")) as gaia:
        await gaia.cone(269.46, 4.75, 0.1 * u.deg)
    assert mast.call_count == 2 and esa.call_count == 2


@respx.mock
async def test_gaia_falls_back_to_the_irsa_copy(tmp_path: Path) -> None:
    mast = respx.post(MAST_URL).mock(return_value=httpx.Response(503))
    esa = respx.post(ESA_URL).mock(return_value=httpx.Response(503))
    irsa = respx.post(IRSA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    async with GaiaClient(settings(tmp_path)) as gaia:
        gaia.wait_initial_s, gaia.wait_max_s = 0.01, 0.02
        src = (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0]
    assert mast.call_count == 2 and esa.call_count == 2 and irsa.call_count == 1
    query = irsa.calls[0].request.content.decode()
    assert "gaia_dr3_source" in query and "gaiadr3.gaia_source" not in query
    assert src.archive == "IRSA" and src.source_id == "4472832130942575872"
    # The next query goes straight to IRSA.
    async with GaiaClient(settings(tmp_path / "b")) as gaia:
        await gaia.cone(269.46, 4.75, 0.1 * u.deg)
    assert mast.call_count == 2 and esa.call_count == 2 and irsa.call_count == 2


@respx.mock
async def test_gaia_all_copies_failing_raises(tmp_path: Path) -> None:
    for url in (MAST_URL, ESA_URL, IRSA_URL):
        respx.post(url).mock(return_value=httpx.Response(502))
    async with GaiaClient(settings(tmp_path)) as gaia:
        gaia.wait_initial_s, gaia.wait_max_s = 0.01, 0.02
        with pytest.raises(SourceUnavailable):
            await gaia.cone(269.45, 4.74, 0.1 * u.deg)


@respx.mock
async def test_gaia_mast_error_votable_falls_back(tmp_path: Path) -> None:
    error = (
        '<?xml version="1.0"?><VOTABLE><RESOURCE type="results">'
        '<INFO name="QUERY_STATUS" value="ERROR">Not Found</INFO></RESOURCE></VOTABLE>'
    )
    respx.post(MAST_URL).mock(return_value=httpx.Response(200, text=error))
    respx.post(ESA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    async with GaiaClient(settings(tmp_path)) as gaia:
        src = (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0]
    assert src.archive == "ESA"


@respx.mock
async def test_gaia_hedges_a_slow_mast_service(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(2.0)
        return httpx.Response(200, content=(GAIA_FIXTURES / "barnard_mast.xml").read_bytes())

    monkeypatch.setattr(gaia_mod, "HEDGE_S", 0.05)
    respx.post(MAST_URL).mock(side_effect=slow)
    esa = respx.post(ESA_URL).mock(return_value=httpx.Response(200, text=GAIA_CSV))
    async with GaiaClient(settings(tmp_path)) as gaia:
        t0 = time.monotonic()
        src = (await gaia.cone(269.45, 4.74, 0.1 * u.deg))[0]
        assert time.monotonic() - t0 < 1.5
    assert esa.call_count == 1 and src.archive == "ESA"


# Real answers for Barnard's Star (Gaia DR3 4472832130942575872), recorded 2026-11-14 with the
# query `by_source_id` sends. MAST and ESA were reached; the IRSA TAP service answered HTTP 502
# for every attempt that day, so no IRSA answer was recorded (and none is invented).
BARNARD_ID = 4472832130942575872
IRSA_FIXTURE = GAIA_FIXTURES / "barnard_irsa.csv"
ASTROMETRY_FIELDS = (
    "ra_deg", "dec_deg", "pmra_masyr", "pmdec_masyr", "parallax_mas", "ref_epoch_jyear",
)  # fmt: skip


COPIES = {
    "MAST": (MAST_URL, GAIA_FIXTURES / "barnard_mast.xml", ()),
    "ESA": (ESA_URL, GAIA_FIXTURES / "barnard_esa.csv", ("MAST",)),
    "IRSA": (IRSA_URL, IRSA_FIXTURE, ("MAST", "ESA")),
}


async def _barnard_from(tmp_path: Path, copy: str) -> CatalogSource:
    """Query one copy only: the copies tried before it are marked as recently failing."""
    url, fixture, skipped = COPIES[copy]
    gaia_mod.reset_skips()
    for name in skipped:
        gaia_mod._skip_until[name] = time.monotonic() + 600.0
    with respx.mock:
        route = respx.post(url).mock(return_value=httpx.Response(200, content=fixture.read_bytes()))
        async with GaiaClient(settings(tmp_path)) as gaia:
            src = await gaia.by_source_id(BARNARD_ID)
    assert route.call_count == 1 and src is not None
    return src


@pytest.mark.parametrize(
    "copy",
    [
        "ESA",
        pytest.param(
            "IRSA",
            marks=pytest.mark.skipif(
                not IRSA_FIXTURE.exists(),
                reason="no recorded IRSA answer: the IRSA TAP service returned HTTP 502 on "
                "2026-11-14 and nothing is fabricated",
            ),
        ),
    ],
)
async def test_gaia_copies_return_the_same_barnard_astrometry(tmp_path: Path, copy: str) -> None:
    mast = await _barnard_from(tmp_path / "mast", "MAST")
    other = await _barnard_from(tmp_path / "other", copy)
    assert (mast.archive, other.archive) == ("MAST", copy)
    assert mast.source_id == other.source_id == str(BARNARD_ID)
    for field in ASTROMETRY_FIELDS:
        assert getattr(other, field) == pytest.approx(getattr(mast, field), rel=1e-9, abs=1e-9), (
            field
        )
    assert mast.ref_epoch_jyear == 2016.0


CATWISE_CSV = (
    "source_name,ra,dec,ra_pm,dec_pm,pmra,pmdec,sigpmra,sigpmdec,par_pm,par_pmsig,w1mpro,w2mpro,"
    "meanobsmjd,pmcode\n"
    "J085507.96-071439.3,133.7831722,-7.2442516,133.7839240,-7.2443404,-8.02120,1.03570,0.0892,"
    "0.1412,,,19.577,15.787,57338.571065,2N047\n"
)


@respx.mock
async def test_catwise_cone_units_and_epoch(tmp_path: Path) -> None:
    respx.post("https://irsa.ipac.caltech.edu/TAP/sync").mock(
        return_value=httpx.Response(200, text=CATWISE_CSV)
    )
    async with CatwiseClient(settings(tmp_path)) as cw:
        src = (await cw.cone(133.78, -7.24, 0.05 * u.deg, min_pm_arcsec_yr=4.0))[0]
    assert src.pmra_masyr == pytest.approx(-8021.2) and src.pmdec_masyr == pytest.approx(1035.7)
    # The reference position is the motion-fit position (ra_pm, dec_pm) at MJD 57170 (2015.405),
    # not the stationary-fit (ra, dec) paired with meanobsmjd (about 1 arcsec off for this source).
    assert (src.ra_deg, src.dec_deg) == (133.7839240, -7.2443404)
    # MJD 57170 is J2015.4018 (Julian years; IRSA labels it 2015.405 in calendar decimal years).
    assert src.ref_epoch_jyear == pytest.approx(2015.4018, abs=1e-4)
    # Without a motion fit, the stationary position at the mean observation epoch is the fallback.
    assert catwise_row(
        {"source_name": "x", "ra": "1", "dec": "2", "meanobsmjd": "57170"}
    ).ref_epoch_jyear == pytest.approx(2015.4, abs=0.05)


def test_simbad_query_is_escaped() -> None:
    assert "id = 'Barnard''s star'" in resolve_adql("Barnard's star")
    with pytest.raises(ValueError):
        resolve_adql("x" * 101)


@respx.mock
async def test_simbad_resolve(tmp_path: Path) -> None:
    csv_text = (
        "main_id,ra,dec,pmra,pmdec,plx_value,rvz_radvel\n"
        "NAME Barnard's star,269.4520769,4.6933649,-802.8,10362.5,546.98,-110.6\n"
    )
    respx.post(SIMBAD_TAP_URL).mock(return_value=httpx.Response(200, text=csv_text))
    async with SimbadClient(settings(tmp_path)) as s:
        obj = await s.resolve("Barnard's star")
    assert obj is not None and obj.ref_epoch == "J2000.0"
    assert obj.pmdec_masyr == pytest.approx(10362.5)


IRSA_RESOLVE_OK = '[{"data":"10.68479292;41.269065;EQ_J2000;M31;ned;G","success":"true"}]'
IRSA_RESOLVE_FAIL = '[{"success":"false","error":"Could not resolve"}]'


def test_irsa_resolve_body_parser() -> None:
    found = parse_resolve_body(IRSA_RESOLVE_OK)
    assert found is not None
    assert (found.name, found.resolver) == ("M31", "ned")
    assert found.ra_deg == pytest.approx(10.68479292) and found.dec_deg == pytest.approx(41.269065)
    assert parse_resolve_body(IRSA_RESOLVE_FAIL) is None
    assert parse_resolve_body(IRSA_RESOLVE_OK.replace("EQ_J2000", "GAL")) is None
    assert parse_resolve_body(IRSA_RESOLVE_OK.replace("10.68479292", "400")) is None
    with pytest.raises(SourceError):
        parse_resolve_body("<html>busy</html>")


@respx.mock
async def test_irsa_resolve_name_sends_name_as_param_and_caches(tmp_path: Path) -> None:
    route = respx.get(RESOLVE_URL).mock(return_value=httpx.Response(200, text=IRSA_RESOLVE_OK))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        found = await irsa.resolve_name("M 31 & x=1")
        again = await irsa.resolve_name("M 31 & x=1")
    assert found is not None and found == again and route.call_count == 1
    sent = route.calls[0].request.url
    assert sent.host == "irsa.ipac.caltech.edu" and sent.path.endswith("/CmdSrv")
    assert sent.params["objName"] == "M 31 & x=1" and sent.params["cmd"] == "CmdResolveName"
    assert "x" not in sent.params


@respx.mock
async def test_irsa_resolve_name_unresolved_is_none_and_not_cached(tmp_path: Path) -> None:
    route = respx.get(RESOLVE_URL).mock(return_value=httpx.Response(200, text=IRSA_RESOLVE_FAIL))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        assert await irsa.resolve_name("Nowhere") is None
        assert await irsa.resolve_name("Nowhere") is None
    assert route.call_count == 2


SESAME_OK = (
    "# Betelgeuse\t#Q1\n#=Sca=Simbad (CfA, via client/server): 1 0ms\n"
    "%@ 2943\n%I.0 * alf Ori\n%J 88.79293899 +7.40706400 = 05 55 10.305  +07 24 25.43\n"
    "%P 27.54 11.30 [1.03 0.65 0] A 2007A&A...474..653V\n"
    "%X 6.55 [0.83] A 2007A&A...474..653V\n\n#====Done\n"
)
SESAME_UNKNOWN = "# zzz\t#Q2\n#! *** NNNothing found *** \n\n#====Done\n"
MIRROR = "vizier.idia.ac.za"


def test_sesame_parser() -> None:
    obj = parse_sesame(SESAME_OK, "Betelgeuse")
    assert obj is not None and obj.main_id == "alf Ori" and obj.ref_epoch == "J2000.0"
    assert (obj.ra_deg, obj.dec_deg) == (88.79293899, 7.407064)
    assert (obj.pmra_masyr, obj.pmdec_masyr, obj.parallax_mas) == (27.54, 11.3, 6.55)
    bare = parse_sesame("#=x\n%J 10.0 -5.0 = a b\n", "Foo")
    assert bare is not None and bare.pmra_masyr is None and bare.parallax_mas is None
    assert bare.main_id == "Foo"
    assert parse_sesame(SESAME_UNKNOWN, "zzz") is None
    for bad in ("<html>oops</html>", "#=x\n%J abc def\n", "#=x\n%J 400 10\n", ""):
        with pytest.raises(SourceError):
            parse_sesame(bad, "x")


@respx.mock
async def test_sesame_client_encodes_name_and_hits_only_the_mirror(tmp_path: Path) -> None:
    route = respx.get(url__startswith=SESAME_URL).mock(
        return_value=httpx.Response(200, text=SESAME_OK)
    )
    st = Settings(data_dir=tmp_path, data_mode=DataMode.HYBRID, egress_allowlist=MIRROR)
    async with fast(SesameClient(st)) as s:  # type: ignore[arg-type]
        obj = await s.resolve("alf Ori/../x?y=1")
    assert obj is not None
    sent = str(route.calls[0].request.url)
    assert sent.startswith(SESAME_URL + "?alf%20Ori%2F..%2Fx%3Fy%3D1")


@respx.mock
async def test_sesame_unknown_is_none_and_not_cached(tmp_path: Path) -> None:
    route = respx.get(url__startswith=SESAME_URL).mock(
        return_value=httpx.Response(200, text=SESAME_UNKNOWN)
    )
    st = Settings(data_dir=tmp_path, data_mode=DataMode.HYBRID, egress_allowlist=MIRROR)
    async with fast(SesameClient(st)) as s:  # type: ignore[arg-type]
        assert await s.resolve("zzz") is None
        assert await s.resolve("zzz") is None
    assert route.call_count == 2


@respx.mock
async def test_sbident_parses_rows(tmp_path: Path) -> None:
    payload = {
        "fields_first": ["Object name"],
        "data_first_pass": [
            ["433 Eros (A898 PA)", "10:00:01", "+05 00 10", "1", "2", "3", "15.2", "10.5", "-3.1"]
        ],
    }
    respx.get("https://ssd-api.jpl.nasa.gov/sb_ident.api").mock(
        return_value=httpx.Response(200, json=payload)
    )
    async with SBIdentClient(settings(tmp_path)) as sb:
        bodies = await sb.identify(
            150.0, 5.0, Time("2026-03-01T00:00:00"), 0.05 * u.deg, vmag_limit=20
        )
    assert bodies[0].name.startswith("433 Eros") and bodies[0].vmag == pytest.approx(15.2)
    assert bodies[0].approximate is True


@respx.mock
async def test_sbident_empty_second_pass_means_no_body(tmp_path: Path) -> None:
    """Shape of a live answer (2026-11-11): the first pass lists coarse candidates thousands of
    arcseconds away and the second pass finds nothing in the field; no body is reported."""
    payload = {
        "fields_first": [
            "Object name",
            "Astrometric RA (hh:mm:ss)",
            "Astrometric Dec (dd mm'ss\")",
        ],
        "n_first_pass": 1,
        "data_first_pass": [
            ["(1927 LA)", "17:17:41", "-02 47'33\"", "-4.E4", "-3.E4", "4.5E4", "16.7", "14.5"]
        ],
        "n_second_pass": 0,
    }
    respx.get("https://ssd-api.jpl.nasa.gov/sb_ident.api").mock(
        return_value=httpx.Response(200, json=payload)
    )
    async with SBIdentClient(settings(tmp_path)) as sb:
        bodies = await sb.identify(269.45, 4.74, Time("2025-08-26T02:19:06"), 60 * u.arcsec)
    assert bodies == []


@respx.mock
async def test_sbident_drops_bodies_outside_the_field(tmp_path: Path) -> None:
    row = ["X", "10:00:01", "+05 00 10", "1", "2", "{}", "15.2", "10.5", "-3.1"]
    payload = {
        "n_second_pass": 2,
        "data_second_pass": [
            [c.format("40.0") for c in row],
            [c.format("9000.0") for c in row],
        ],
    }
    respx.get("https://ssd-api.jpl.nasa.gov/sb_ident.api").mock(
        return_value=httpx.Response(200, json=payload)
    )
    async with SBIdentClient(settings(tmp_path)) as sb:
        bodies = await sb.identify(150.0, 5.0, Time("2026-03-01T00:00:00"), 60 * u.arcsec)
    assert [b.sep_arcsec for b in bodies] == [40.0]


def test_record_t_mid() -> None:
    rec = ImageRecord(
        "o", "obs", "p", 6, "spherex_qr2", "ibe/data/spherex/a.fits",
        Time(60000.0, format="mjd"), Time(60000.002, format="mjd"),
        4.4 * u.um, 5.0 * u.um, 113.0, 1,
    )  # fmt: skip
    assert rec.t_mid.mjd == pytest.approx(60000.001)


@respx.mock
async def test_discovery_falls_back_to_sia_when_tap_is_down(tmp_path: Path) -> None:
    respx.post(TAP_URL).mock(return_value=httpx.Response(502, text="Proxy Error"))
    sia_csv = (
        "dataproduct_subtype,energy_bandpassname,obs_id,em_min,em_max,access_url,"
        "access_estsize,t_exptime,obs_collection,t_min,t_max\n"
        "science,SPHEREx-D3,2025W19_1B_0116_1,1.63010e-06,2.43460e-06,"
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/"
        "l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits,"
        "65791,113.582600,spherex_dr1,60800.700028,60800.701361\n"
    )
    sia = respx.get(SIA_URL).mock(return_value=httpx.Response(200, text=sia_csv))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        records = await irsa.query_images(133.76, -7.24, ["spherex_dr1"])
        assert [r.detector for r in records] == [3] and sia.called
        assert await irsa.query_images(133.76, -7.24, ["spherex_dr1"], detectors=[6]) == []


@respx.mock
async def test_discovery_skips_tap_while_it_is_marked_slow(tmp_path: Path) -> None:
    """After TAP hung, a batch goes straight to SIA2 instead of waiting on every query."""
    import time

    tap = respx.post(TAP_URL).mock(return_value=httpx.Response(200, text=IRSA_ROWS_CSV))
    sia = respx.get(SIA_URL).mock(return_value=httpx.Response(200, text="obs_id\n"))
    async with fast(IrsaClient(settings(tmp_path))) as irsa:
        irsa._tap_skip_until = time.monotonic() + 100.0
        assert await irsa.query_images(10.0, 20.0, ["spherex_dr1"]) == []
        assert sia.called and not tap.called
        irsa._tap_skip_until = 0.0
        assert len(await irsa.query_images(269.45, 4.69, ["spherex_qr2"])) == 2 and tap.called
