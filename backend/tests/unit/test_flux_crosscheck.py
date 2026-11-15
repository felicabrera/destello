"""Band flux interpolation and the 2MASS client used by the flux cross-check (docs/11, V-08)."""

import astropy.units as u
import numpy as np

from destello.pipeline.photometry import band_flux_at
from destello.sources.twomass import cone_adql, parse_row


def test_band_flux_at_power_law_is_exact() -> None:
    wl = np.linspace(1.11, 1.36, 12)
    f = 0.05 * (wl / 1.235) ** -2.0
    bf = band_flux_at(wl, f, 1.235)
    assert bf is not None
    assert abs(bf.flux_jy - 0.05) < 1e-12
    assert bf.n_used == 12 and bf.n_total == 12


def test_band_flux_at_rejects_outlier_and_reports_scatter() -> None:
    rng = np.random.default_rng(1)
    wl = np.linspace(2.0, 2.32, 20)
    f = 0.02 * (1.0 + rng.normal(0.0, 0.02, wl.size))
    f[5] = 0.06  # a cosmic ray or blend in one exposure
    bf = band_flux_at(wl, f, 2.159)
    assert bf is not None
    assert bf.n_used == 19
    assert abs(bf.flux_jy / 0.02 - 1.0) < 0.02
    assert 0.0 < bf.flux_err_jy / bf.flux_jy < 0.02


def test_band_flux_at_needs_three_positive_points() -> None:
    assert band_flux_at(np.array([1.2, 1.3, 1.25]), np.array([0.1, -0.1, np.nan]), 1.235) is None


def test_twomass_query_and_row() -> None:
    q = cone_adql(248.1, 66.7, 3.0 * u.arcmin, 16.5, 2000)
    assert "FROM fp_psc" in q and "k_m < 16.50" in q and "TOP 2000" in q
    assert "CIRCLE('ICRS', 248.1000000, 66.7000000, 0.050000)" in q
    row = {
        "designation": "22043113-5646287", "ra": "331.13", "dec": "-56.77", "j_m": "11.746",
        "j_msigcom": "0.023", "h_m": "11.351", "h_msigcom": "0.024", "k_m": "11.277",
        "k_msigcom": "", "ph_qual": "AAA", "rd_flg": "222", "bl_flg": "111", "cc_flg": "000",
        "gal_contam": "0", "mp_flg": "0", "jdate": "2451409.6",
    }  # fmt: skip
    s = parse_row(row)
    assert s.k_m == 11.277 and s.k_err is None and s.ph_qual == "AAA" and s.gal_contam == 0
