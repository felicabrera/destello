"""NEOSSat matching, cutouts and the CADC client (F-33). The CAOM rows are a recorded real answer
of ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync (2026-11-14); the frame is synthetic."""

from __future__ import annotations

from pathlib import Path

import httpx
import numpy as np
import pytest
import respx
from astropy.time import Time
from astropy.wcs import WCS

from destello.core.config import DataMode, Settings
from destello.pipeline import neossat as ns
from destello.sources.cadc import (
    CADC_FILES_URL,
    CADC_TAP_URL,
    CadcClient,
    CadcError,
    NeossatPlane,
    parse_polygon,
    plane_from_row,
)

CSV = (
    "observationID,target_name,productID,time_bounds_lower,time_bounds_upper,time_exposure,"
    "position_bounds,publisherID\n"
    "2025324000013,3I,cor,60999.00015496528,60999.000328622686,15.004,polygon 188.8955031944217 "
    "-2.3420149903688525 189.52727268362796 -2.236739108067809 189.6328363523281 "
    "-2.8679737695407113 189.00075886351613 -2.973302497157704,ivo://cadc.nrc.ca/NEOSSAT?2025324000013/cor\n"
    "2025324000153,3I,cor,60999.001312650464,60999.00148630787,15.004,polygon 188.90976319615396 "
    "-2.382563449351693 189.54159236158537 -2.2775370334769036 189.64691254122263 "
    "-2.9088128465447767 189.01477046383755 -3.0138928101552125,ivo://cadc.nrc.ca/NEOSSAT?2025324000153/cor\n"
    "2025324000300,DARK,cor,60999.002,60999.0021,15.0,,ivo://x\n"
    "abc,3I,cor,60999.0,60999.1,15.0,polygon 1 1 2 1 2 2,ivo://y\n"
)

SQUARE = ((10.0, 10.0), (11.0, 10.0), (11.0, 11.0), (10.0, 11.0))


def settings(tmp: Path) -> Settings:
    return Settings(data_dir=tmp, data_mode=DataMode.ONLINE)


def test_polygon_parsing_and_rows() -> None:
    assert len(parse_polygon("polygon 1 2 3 4 5 6")) == 3
    assert parse_polygon("polygon 1 2 3") == ()
    assert parse_polygon("") == ()
    rows = [dict(r) for r in __import__("csv").DictReader(__import__("io").StringIO(CSV))]
    planes = [plane_from_row(r) for r in rows]
    assert [p is not None for p in planes] == [True, True, False, False]
    p = planes[0]
    assert p is not None
    assert p.file_name == "NEOS_SCI_2025324000013_cor.fits"
    assert p.access_url == f"{CADC_FILES_URL}/NEOS_SCI_2025324000013_cor.fits"
    assert p.t_mid_mjd == pytest.approx(60999.00024, abs=1e-5)


def test_point_in_polygon() -> None:
    assert ns.point_in_polygon(SQUARE, 10.5, 10.5)
    assert not ns.point_in_polygon(SQUARE, 12.0, 10.5)
    assert not ns.point_in_polygon(SQUARE, 10.5, 9.0)


def cand(key: str, t: float, inside: bool = True) -> ns.Candidate:
    return ns.Candidate(key, t, SQUARE, 10.5 if inside else 20.0, 10.5)


def test_nearest_in_window_picks_closest_with_footprint() -> None:
    cs = [cand("far", 100.8), cand("near", 100.1), cand("off", 100.01, inside=False)]
    best = ns.nearest_in_window(100.0, cs, 24.0)
    assert best is not None and best.key == "near"
    assert ns.nearest_in_window(100.0, [cand("late", 101.5)], 24.0) is None
    assert ns.nearest_in_window(100.0, [], 24.0) is None
    assert ns.nearest_in_window(100.0, [cand("x", 100.9)], 24.0) is not None
    assert ns.nearest_in_window(100.0, [cand("x", 100.9)], 12.0) is None


def test_track_interpolation_handles_ra_wrap() -> None:
    t = np.array([0.0, 1.0])
    ra, dec = ns.interp_track(0.5, t, np.array([359.9, 0.1]), np.array([1.0, 2.0]))
    assert ra == pytest.approx(0.0, abs=1e-6) or ra == pytest.approx(360.0, abs=1e-6)
    assert dec == pytest.approx(1.5)


def test_cutout_is_centered_on_the_requested_position_and_north_up() -> None:
    # A synthetic frame (not NEOSSat data) with one bright pixel at a known sky position.
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [180.0, 0.0]
    w.wcs.crpix = [200.5, 200.5]
    w.wcs.cdelt = [-3.0 / 3600, 3.0 / 3600]
    data = np.zeros((400, 400))
    bx, by = w.all_world2pix(180.0 + 30 * 3.0 / 3600, 20 * 3.0 / 3600, 0)  # 30 px east, 20 px north
    data[int(round(float(by))), int(round(float(bx)))] = 100.0
    cut = ns.make_cutout(data, w, 180.0, 0.0)
    assert cut.shape == (ns.CUTOUT_PIXELS, ns.CUTOUT_PIXELS)
    y, x = np.unravel_index(np.nanargmax(cut), cut.shape)
    c = ns.CUTOUT_PIXELS / 2
    assert x == pytest.approx(c - 30, abs=1.5)  # east is left
    assert y == pytest.approx(c + 20, abs=1.5)  # north is up in array rows after the webp flip
    img, st = ns.render_cutout(np.where(np.isfinite(cut), cut, 0.0))
    assert img.dtype == np.uint8 and st.unit == "ADU"
    with pytest.raises(ValueError):
        ns.cutout_stretch(np.full((4, 4), np.nan))
    fw, fh = ns.frame_fov_arcmin(w, (400, 400))
    assert fw == pytest.approx(20.0, rel=1e-3) and fh == pytest.approx(20.0, rel=1e-3)


@pytest.mark.asyncio
@respx.mock
async def test_client_lists_planes_and_fetches_a_file(tmp_path: Path) -> None:
    respx.post(CADC_TAP_URL).mock(return_value=httpx.Response(200, text=CSV))
    plane_file = respx.get(f"{CADC_FILES_URL}/NEOS_SCI_2025324000013_cor.fits").mock(
        return_value=httpx.Response(200, content=b"SIMPLE")
    )
    c = CadcClient(settings(tmp_path))
    planes = await c.cor_planes(
        Time(60998.5, format="mjd", scale="utc"), Time(61000.5, format="mjd", scale="utc")
    )
    assert [p.observation_id for p in planes] == ["2025324000013", "2025324000153"]
    body = respx.calls[0].request.content.decode()
    assert "NEOSSAT" in body and "DARK" in body and "60998.5" in body
    assert len(respx.calls) == 4  # the 2-day window is read in four half-day slices
    assert await c.fetch_file(planes[0]) == b"SIMPLE"
    assert plane_file.called
    bad = NeossatPlane("../etc", "x", 0.0, 1.0, None, SQUARE)
    with pytest.raises(CadcError):
        await c.fetch_file(bad)
    with pytest.raises(ValueError):
        await c.cor_planes(
            Time(61000.5, format="mjd", scale="utc"), Time(60998.5, format="mjd", scale="utc")
        )
    await c.aclose()
