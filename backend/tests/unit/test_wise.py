"""WISE/NEOWISE companion (F-40): mask bits, calibration, coadd, band windows, frame discovery."""

from __future__ import annotations

import io

import astropy.units as u
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from astropy.time import Time

from destello.pipeline.astrometry import well_spread_for_parallax
from destello.pipeline.wise import (
    ZP_REF_MAG,
    band_matched,
    band_window,
    calibrate_frame,
    clipped_coadd,
    exclusion_bits,
    official_band_window,
    saturation_bits,
)
from destello.sources.wise import (
    RangeFile,
    WiseFrame,
    frame_adql,
    healpix_k5,
    parquet_frames,
    parquet_key,
    parse_tap_frames,
)


# ------------------------------------------------------------------ mask bits
def test_neowise_nan_bits_match_supplement_decimal() -> None:
    # NEOWISE Explanatory Supplement sec 4.2a table 7: NaN bitstring 1048154 (decimal).
    nan_only = exclusion_bits("neowise") & ~((1 << 21) | (1 << 26) | (1 << 28) | (1 << 30))
    assert nan_only == 1048154


def test_saturation_bits() -> None:
    assert saturation_bits("allsky") == sum(1 << b for b in range(10, 19))
    assert saturation_bits("neowise") == sum(1 << b for b in range(10, 20))


# ------------------------------------------------------------------ calibration
def test_calibrate_frame_zero_point_and_sky() -> None:
    rng = np.random.default_rng(1)
    img = 100.0 + rng.normal(0, 1, (40, 40))
    unc = np.full_like(img, 1.0)
    msk = np.zeros(img.shape, dtype=np.int32)
    msk[5, 5] = 1 << 21  # excluded transient bad pixel
    msk[6, 6] = 1 << 12  # saturated (and NaN bit in both tables)
    magzp = ZP_REF_MAG + 2.5 * np.log10(2.0)  # scale 0.5
    cal = calibrate_frame(img, unc, msk, magzp, "neowise")
    assert cal.scale == pytest.approx(0.5)
    assert cal.sky == pytest.approx(50.0, abs=0.1)
    assert abs(float(np.nanmedian(cal.science))) < 0.1
    assert cal.bad[5, 5] and cal.bad[6, 6] and cal.saturated[6, 6]
    assert np.isnan(cal.science[5, 5])
    assert float(np.nanmedian(cal.variance)) == pytest.approx(0.25)


def test_calibrate_frame_rejects_shape_mismatch() -> None:
    with pytest.raises(ValueError):
        calibrate_frame(np.zeros((4, 4)), np.ones((4, 5)), np.zeros((4, 4)), 20.0, "allsky")


# ------------------------------------------------------------------ coadd
def test_clipped_coadd_rejects_outlier_keeps_varying_star() -> None:
    rng = np.random.default_rng(2)
    n = 8
    imgs, vars_ = [], []
    for i in range(n):
        im = rng.normal(0, 1, (10, 10))
        im[3, 3] += 1000.0 * (1.0 + 0.1 * (i - n / 2))  # star pixel varying 40 percent
        if i == 2:
            im[7, 7] += 500.0  # cosmic ray in one frame
        imgs.append(im)
        vars_.append(np.ones((10, 10)))
    co, rejected = clipped_coadd(imgs, vars_)
    assert co.n_used[3, 3] == n
    assert co.n_used[7, 7] == n - 1
    assert abs(float(co.mean[7, 7])) < 3.0
    assert rejected >= 1


def test_clipped_coadd_no_clip_below_min_frames() -> None:
    imgs = [np.zeros((3, 3)), np.zeros((3, 3)), np.full((3, 3), 100.0)]
    co, rejected = clipped_coadd(imgs, [np.ones((3, 3))] * 3)
    assert rejected == 0
    assert float(co.mean[0, 0]) == pytest.approx(100.0 / 3)


# ------------------------------------------------------------------ band windows
def test_band_window_triangle_interpolates_edges() -> None:
    wl = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    r = np.array([0.0, 0.4, 1.0, 0.6, 0.0])
    w = band_window(wl, r, "W1")
    assert w.lo_um == pytest.approx(2.0 + 0.1 / 0.6)
    assert w.hi_um == pytest.approx(4.0 + 0.1 / 0.6)
    assert w.peak_um == 3.0


def test_official_windows() -> None:
    w1, w2 = official_band_window("W1"), official_band_window("W2")
    assert 2.9 < w1.lo_um < 3.1 and 3.7 < w1.hi_um < 3.9
    assert 4.0 < w2.lo_um < 4.2 and 5.1 < w2.hi_um < 5.3


def test_band_matched_inclusive_and_nan() -> None:
    w = band_window(np.array([1.0, 2.0, 3.0]), np.array([1.0, 1.0, 1.0]), "W2")
    got = band_matched(np.array([0.5, 1.0, 2.5, 3.0, 3.5, np.nan]), w)
    assert got.tolist() == [False, True, True, True, False, False]


# ------------------------------------------------------------------ parallax rule
def test_well_spread_for_parallax() -> None:
    ra, dec = 133.8, -7.2
    t_good = Time(np.linspace(2014.0, 2026.5, 14), format="jyear")
    n = len(t_good)
    assert well_spread_for_parallax(t_good, np.full(n, ra) * u.deg, np.full(n, dec) * u.deg)
    t_few = t_good[:5]
    assert not well_spread_for_parallax(t_few, np.full(5, ra) * u.deg, np.full(5, dec) * u.deg)
    t_short = Time(np.linspace(2025.0, 2026.0, 8), format="jyear")
    assert not well_spread_for_parallax(t_short, np.full(8, ra) * u.deg, np.full(8, dec) * u.deg)
    # Same day of year every time: no parallax factor range.
    t_same = Time([2014.3 + k for k in range(8)], format="jyear")
    assert not well_spread_for_parallax(t_same, np.full(8, ra) * u.deg, np.full(8, dec) * u.deg)


# ------------------------------------------------------------------ discovery
def test_frame_adql_and_validation() -> None:
    q = frame_adql("neowiser_p1bm_frm", 133.76, -7.24, 2)
    assert "FROM neowiser_p1bm_frm WHERE band = 2" in q
    with pytest.raises(ValueError):
        frame_adql("other; drop", 0.0, 0.0, 2)


def _row(**kw: str) -> dict[str, str]:
    base = {
        "scan_id": "45678r", "frame_num": "123", "band": "2", "mjd_obs": "58000.5",
        "qual_frame": "10", "crval1": "133.76", "crval2": "-7.24", "crpix1": "508.5",
        "crpix2": "508.5", "cd1_1": "-0.000763888", "cd1_2": "0", "cd2_1": "0",
        "cd2_2": "0.000763888", "naxis1": "1016", "naxis2": "1016",
    }  # fmt: skip
    base.update(kw)
    return base


def test_parse_tap_frames_filters_quality_and_footprint() -> None:
    rows = [_row(), _row(qual_frame="0"), _row(crval1="134.5"), _row(scan_id="bad id!")]
    got = parse_tap_frames("neowiser_p1bm_frm", rows[:3], 133.76021, -7.24136, 2)
    assert [f.frame_id for f in got] == ["45678r123"]
    assert got[0].qual_frame == 10
    url = got[0].file_url("msk")
    assert url.endswith("neowiser/p1bm_frm/8r/45678r/123/45678r123-w2-msk-1b.fits.gz")


def test_healpix_partition() -> None:
    assert healpix_k5(133.76021, -7.24136) == 10226
    key = parquet_key("year5", 10226)
    assert "year5" in key and "healpix_k0=9/healpix_k5=10226/" in key


def test_parquet_frames_through_range_file() -> None:
    n = 600
    ra = np.concatenate([np.full(300, 10.0), np.full(300, 133.76)])
    dec = np.concatenate([np.full(300, 50.0), np.full(300, -7.24)])
    table = pa.table({
        "scan_id": [f"{1000 + i // 100}r" for i in range(n)],
        "frame_num": [i % 7 for i in range(n)],
        "mjd": [57000.0 + i // 100 for i in range(n)],
        "ra": ra, "dec": dec,
    })  # fmt: skip
    buf = io.BytesIO()
    pq.write_table(table, buf, row_group_size=100)
    data = buf.getvalue()
    calls: list[tuple[int, int]] = []

    def fetch(start: int, end: int) -> bytes:
        calls.append((start, end))
        return data[start : end + 1]

    rf = RangeFile(len(data), fetch, block=4096)
    got = parquet_frames(rf, 133.76, -7.24, 2)
    scans = {s for s, _, _ in got}
    assert scans == {"1003r", "1004r", "1005r"}
    assert len(got) == 3 * 7
    assert all(57003.0 <= m <= 57005.0 for _, _, m in got)
    assert rf.requests == len(calls) > 0


def test_wise_frame_identity() -> None:
    f = WiseFrame("allsky_4band_p1bm_frm", "01234a", 7, 1, 55300.0)
    assert f.frame_id == "01234a007" and f.scangrp == "4a"
    assert f.file_url("int").endswith(
        "allsky/4band_p1bm_frm/4a/01234a/007/01234a007-w1-int-1b.fits"
    )
