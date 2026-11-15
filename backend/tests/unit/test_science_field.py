"""Field membership check of the measurement endpoints (docs/06 section 3.5).

A position whose measurement point lies off the sequence grid is a client error (422
`POSITION_OUTSIDE_FIELD`); a position on the grid is accepted even when nothing can be measured.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from destello.api.science import (
    ScienceError,
    SequenceFiles,
    _core_finite,
    check_in_field,
    request_astrometry,
    require_in_field,
)
from destello.models.targets import load_targets
from destello.pipeline.astrometry import measure_centroid

SCALE = 3.1  # arcsec per grid pixel
# Far from every preset target, so that no preset astrometry is picked up by `require_in_field`.
RA0, DEC0 = 120.0, 30.0
MEAN_MJD = 61113.0  # 2026-03-14; about 10.2 years after J2016.0


def make_seq(ra0: float = RA0, dec0: float = DEC0, n: int = 116) -> SequenceFiles:
    manifest: dict[str, Any] = {
        "sequence_id": "0123456789abcdef",
        "grid": {
            "projection": "TAN",
            "crval_deg": [ra0, dec0],
            "pixel_scale_arcsec": SCALE,
            "naxis": [n, n],
        },
        "epochs": [
            {"index": i, "t_mid_mjd": MEAN_MJD + 200.0 * (i - 1), "frames": []} for i in range(3)
        ],
    }
    return SequenceFiles(
        sid="0123456789abcdef", data_dir=Path("."), manifest=manifest, sidecar={"params": {}}
    )


def offset(ra0: float, dec0: float, east_px: float, north_px: float) -> tuple[float, float]:
    """Sky position `east_px`, `north_px` grid pixels away from (ra0, dec0), small angle."""
    dec = dec0 + north_px * SCALE / 3600.0
    ra = ra0 + east_px * SCALE / 3600.0 / math.cos(math.radians(dec0))
    return ra, dec


def outside(seq: SequenceFiles, ra: float, dec: float, astro: Any = None) -> ScienceError:
    with pytest.raises(ScienceError) as err:
        require_in_field(seq, ra, dec, astro)
    assert err.value.status == 422
    assert err.value.code == "POSITION_OUTSIDE_FIELD"
    return err.value


@pytest.mark.parametrize(
    ("east_px", "north_px"),
    [(0.0, 0.0), (0.0, 57.0), (0.0, -57.0), (57.0, 0.0), (-57.0, 0.0), (56.0, -56.0)],
)
def test_positions_on_the_grid_are_accepted(east_px: float, north_px: float) -> None:
    # 116 pixels: the center is at pixel 57.5 and the field spans 58 pixels to each side
    seq = make_seq()
    ra, dec = offset(RA0, DEC0, east_px, north_px)
    require_in_field(seq, ra, dec, None)


@pytest.mark.parametrize(
    ("east_px", "north_px"),
    [(0.0, 59.0), (0.0, -59.0), (59.0, 0.0), (-59.0, 0.0), (59.0, 59.0)],
)
def test_positions_just_off_the_grid_are_rejected(east_px: float, north_px: float) -> None:
    seq = make_seq()
    ra, dec = offset(RA0, DEC0, east_px, north_px)
    err = outside(seq, ra, dec)
    assert "arcmin from the field center" in err.detail
    assert "6.0 by 6.0 arcmin field" in err.detail


def test_far_and_antipodal_positions_are_rejected() -> None:
    seq = make_seq()
    assert " deg from the field center" in outside(seq, 10.0, -60.0).detail
    # more than 90 degrees away the gnomonic projection is undefined
    assert " deg from the field center" in outside(seq, RA0 + 180.0, -DEC0).detail
    assert " deg from the field center" in outside(seq, 300.0, 89.0).detail


def test_field_wrapping_through_ra_zero() -> None:
    seq = make_seq(ra0=0.01, dec0=10.0)
    ra, dec = offset(0.01, 10.0, -50.0, 0.0)  # west of RA 0
    assert ra < 0.0
    require_in_field(seq, ra % 360.0, dec, None)
    ra_out, _ = offset(0.01, 10.0, -70.0, 0.0)
    outside(seq, ra_out % 360.0, dec)


def test_the_propagated_position_decides() -> None:
    seq = make_seq()
    # 19 arcsec per year to the north: about 194 arcsec (62 grid pixels) since J2016.0
    moved_out = request_astrometry(RA0, DEC0, 0.0, 19000.0, "J2016.0")
    assert moved_out is not None
    err = outside(seq, RA0, DEC0, moved_out)
    assert "propagated" in err.detail
    # the same motion from a start 62 pixels south of the grid center ends on the grid
    ra, dec = offset(RA0, DEC0, 0.0, -62.0)
    outside(seq, ra, dec)  # as a fixed position it is off the grid
    moved_in = request_astrometry(ra, dec, 0.0, 19000.0, "J2016.0")
    require_in_field(seq, ra, dec, moved_in)
    check_in_field(seq, ra, dec, moved_in)


def test_a_matching_preset_is_propagated_before_the_check() -> None:
    # Barnard's Star: the Gaia DR3 position (J2016.0) is about 105 arcsec south of where the star
    # is during the survey. A 2 arcmin grid centered on the propagated position does not contain
    # the catalog position, yet the request is valid because the preset astrometry is used.
    a = load_targets()["barnard"].astrometry
    dt_yr = 10.2
    dec_now = a.dec_deg + a.pmdec_masyr * dt_yr / 3.6e6
    ra_now = a.ra_deg + a.pmra_masyr * dt_yr / 3.6e6 / math.cos(math.radians(a.dec_deg))
    seq = make_seq(ra0=ra_now, dec0=dec_now, n=40)
    with pytest.raises(ScienceError):
        check_in_field(seq, a.ra_deg, a.dec_deg, None)
    require_in_field(seq, a.ra_deg, a.dec_deg, None)


def test_non_finite_pixel_positions_are_not_measured() -> None:
    img = np.ones((21, 21), dtype=np.float64)
    assert measure_centroid(img, None, None, float("nan"), 10.0) is None
    assert measure_centroid(img, None, None, 10.0, float("inf")) is None
    assert _core_finite(img, float("nan"), 10.0) is False
    assert _core_finite(img, 10.0, float("nan")) is False
    assert _core_finite(img, 10.0, 10.0) is True
