"""SIA2 rows mapped to the TAP discovery columns (fallback when IRSA TAP does not answer)."""

from __future__ import annotations

from destello.pipeline.query import latest_versions, parse_rows, sia_rows_as_tap

# One row as IRSA SIA2 returned it on 2026-11-14 for WISE 0855 (columns not used are omitted).
ROW = {
    "dataproduct_subtype": "science",
    "energy_bandpassname": "SPHEREx-D3",
    "obs_id": "2025W19_1B_0116_1",
    "em_min": "1.63010e-06",
    "em_max": "2.43460e-06",
    "access_url": (
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/2025W19_1B/"
        "l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
    ),
    "access_estsize": "65791",
    "t_exptime": "113.582600",
    "obs_collection": "spherex_dr1",
    "t_min": "60800.700028",
    "t_max": "60800.701361",
}


def test_sia_row_becomes_an_image_record() -> None:
    rows = sia_rows_as_tap([ROW])
    assert rows[0]["uri"].startswith("ibe/data/spherex/dr1/level2/")
    (rec,) = latest_versions(parse_rows(rows))
    assert rec.detector == 3 and rec.collection == "spherex_dr1"
    assert rec.observation_id == "2025W19_1B_0116_1"
    assert rec.obs_id == "level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197"
    assert abs(rec.t_start.mjd - 60800.700028) < 1e-9
    assert abs(rec.wave_min.value - 1.6301) < 1e-6 and abs(rec.exposure_s - 113.5826) < 1e-9
    assert rec.content_length == 65791 * 1024


def test_sia_rows_that_are_not_science_images_are_dropped() -> None:
    other = dict(ROW, dataproduct_subtype="calibration")
    foreign = dict(ROW, access_url="https://example.org/x.fits")
    band = dict(ROW, energy_bandpassname="WISE-W1")
    assert sia_rows_as_tap([other, foreign, band]) == []
