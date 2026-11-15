"""Science checks on small recorded real SPHEREx cutouts of Barnard's Star (tests/fixtures)."""

from __future__ import annotations

from pathlib import Path

import astropy.units as u
import numpy as np
import pytest
from astropy.io import fits

from destello.models.targets import load_targets
from destello.pipeline.astrometry import measure_centroid
from destello.pipeline.calibrate import (
    Cutout,
    calibrate,
    load_cutout,
    wavelength_range,
)
from destello.pipeline.coadd import coadd_stack
from destello.pipeline.photometry import forced_photometry
from destello.pipeline.propagate import apparent_positions
from destello.pipeline.reproject import make_grid, reproject_cutout

pytestmark = pytest.mark.science

CUT = Path(__file__).resolve().parent.parent / "fixtures" / "cutouts"
BARNARD = load_targets()["barnard"].to_astrometry()


def _load(name: str) -> Cutout:
    with fits.open(CUT / f"{name}.fits") as hdul:
        return load_cutout(hdul, name.rsplit("_D", 1)[0])


def test_flag_bits_read_from_header() -> None:
    c = _load("2026W34_1A_0007_4_D6")
    assert c.detector == 6
    assert c.flag_bits["OVERFLOW"] == 1 and c.flag_bits["NONFUNC"] == 6
    assert c.flag_bits["SOURCE"] == 21


def test_wavelength_range_matches_detector_band() -> None:
    lo, hi = wavelength_range(_load("2026W34_1A_0007_4_D6"))
    assert 4.0 * u.um < lo < hi < 5.3 * u.um  # detector 6 covers 4.1 to 5.0 micron
    lo2, hi2 = wavelength_range(_load("2026W34_1A_0363_1_D2"))
    assert 1.3 * u.um < lo2 < hi2 < 2.5 * u.um


@pytest.mark.parametrize("name", ["2026W34_1A_0007_4_D6", "2026W33_2A_0594_4_D6"])
def test_propagated_position_matches_centroid(name: str) -> None:
    """V-05: the propagated Barnard position falls within one native pixel of the centroid."""
    c = _load(name)
    pos = apparent_positions(BARNARD, c.t_mid)
    x, y = c.wcs.all_world2pix(pos.ra.deg, pos.dec.deg, 0, quiet=True)
    cal = calibrate(c)
    cen = measure_centroid(
        cal.cutout.image - cal.cutout.zodi,
        cal.cutout.variance,
        cal.saturated | cal.bad,
        float(x),
        float(y),
    )
    assert cen is not None
    sep_pix = float(np.hypot(cen.x - x, cen.y - y))
    assert sep_pix < 1.0


def test_forced_photometry_flags_saturated_core() -> None:
    """Barnard's core is flagged in D6 (bright source): the result must report that honestly."""
    c = _load("2026W34_1A_0007_4_D6")
    cal = calibrate(c)
    pos = apparent_positions(BARNARD, c.t_mid)
    res = forced_photometry(cal, pos.ra, pos.dec)
    assert res.usable
    assert res.flagged_fraction > 0.5  # most aperture pixels carry mask flags
    assert res.flux_jy > 0.0


def test_reproject_and_coadd() -> None:
    names = ["2026W34_1A_0007_4_D6", "2026W33_2A_0594_4_D6"]
    pos = apparent_positions(BARNARD, _load(names[0]).t_mid)
    grid = make_grid(pos.ra, pos.dec, 3 * u.arcmin)
    rep = [reproject_cutout(calibrate(_load(n)), grid) for n in names]
    assert all(r.coverage > 0.5 for r in rep)
    co = coadd_stack([r.science for r in rep], [r.variance for r in rep])
    assert co.mean.shape == grid.shape
    assert np.isfinite(co.mean).mean() > 0.5
    assert co.n_used.max() == 2


def test_reproject_cutout_matches_independent_reprojections() -> None:
    """Science and variance go through one reproject call; the planes must equal the two
    separate reprojections bit for bit (same transform, same bilinear kernel)."""
    from reproject import reproject_interp

    c = _load("2026W34_1A_0007_4_D6")
    cal = calibrate(c)
    pos = apparent_positions(BARNARD, c.t_mid)
    grid = make_grid(pos.ra, pos.dec, 3 * u.arcmin)
    rep = reproject_cutout(cal, grid)
    sci, _ = reproject_interp(
        (cal.science, c.wcs), grid.wcs(), shape_out=grid.shape, order="bilinear"
    )
    var, _ = reproject_interp(
        (cal.variance, c.wcs), grid.wcs(), shape_out=grid.shape, order="bilinear"
    )
    sci = np.asarray(sci, dtype=np.float32)
    var = np.asarray(var, dtype=np.float32)
    invalid = ~np.isfinite(sci) | ~np.isfinite(var) | (var <= 0)
    sci[invalid] = np.nan
    var[invalid] = np.nan
    assert np.array_equal(rep.science, sci, equal_nan=True)
    assert np.array_equal(rep.variance, var, equal_nan=True)
