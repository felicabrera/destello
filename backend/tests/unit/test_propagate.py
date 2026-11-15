import astropy.units as u
import numpy as np
import pytest
from astropy.time import Time

from destello.pipeline.propagate import (
    Astrometry,
    apparent_positions,
    parallax_factors,
    propagate_space_motion,
)

AU_PER_PC = 206264.80624709636

# Gaia DR3 4472832130942575872 (Barnard's Star), pinned in data/targets.yaml.
BARNARD = Astrometry(
    ra=269.44850252543836 * u.deg,
    dec=4.739420051112412 * u.deg,
    pmra_cosdec=-801.5509783684709 * u.mas / u.yr,
    pmdec=10362.394206546573 * u.mas / u.yr,
    parallax=546.975939730948 * u.mas,
    ref_epoch=Time(2016.0, format="jyear", scale="tdb"),
    rv=-110.46822 * u.km / u.s,
)


def independent(a: Astrometry, t: Time) -> tuple[float, float]:
    """Linear 3D space motion computed by hand with unit vectors (no astropy coordinates)."""
    assert a.rv is not None
    d_au = (1000.0 / a.parallax.to_value(u.mas)) * AU_PER_PC
    ra, dec = a.ra.to_value(u.rad), a.dec.to_value(u.rad)
    radial = np.array([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)])
    e_ra = np.array([-np.sin(ra), np.cos(ra), 0.0])
    e_dec = np.array([-np.sin(dec) * np.cos(ra), -np.sin(dec) * np.sin(ra), np.cos(dec)])
    mu_ra = a.pmra_cosdec.to_value(u.mas / u.yr) / 1000.0 / AU_PER_PC  # rad/yr
    mu_dec = a.pmdec.to_value(u.mas / u.yr) / 1000.0 / AU_PER_PC
    rv_au_yr = a.rv.to_value(u.km / u.s) * 0.2108945  # 1 km/s in AU/yr
    r0 = d_au * radial
    v = d_au * (mu_ra * e_ra + mu_dec * e_dec) + rv_au_yr * radial
    dt = t.tdb.jyear - a.ref_epoch.jyear
    r = r0 + v * dt
    return (
        float(np.degrees(np.arctan2(r[1], r[0])) % 360.0),
        float(np.degrees(np.arcsin(r[2] / np.linalg.norm(r)))),
    )


def test_barnard_j2016_to_2026_matches_independent_within_1_mas() -> None:
    t = Time("2026-03-01T00:00:00", scale="utc")
    moved = propagate_space_motion(BARNARD, t)
    ra_i, dec_i = independent(BARNARD, t)
    d_ra = (float(moved.ra.deg) - ra_i) * np.cos(np.radians(dec_i)) * 3.6e6
    d_dec = (float(moved.dec.deg) - dec_i) * 3.6e6
    assert abs(d_ra) < 1.0 and abs(d_dec) < 1.0  # milliarcseconds


def test_barnard_moves_about_105_arcsec_north() -> None:
    t = Time("2026-03-01T00:00:00", scale="utc")
    moved = propagate_space_motion(BARNARD, t)
    d_dec_arcsec = (float(moved.dec.deg) - BARNARD.dec.to_value(u.deg)) * 3600.0
    assert 103.0 < d_dec_arcsec < 107.0


def test_zero_parallax_still_propagates() -> None:
    a = Astrometry(
        ra=10 * u.deg,
        dec=20 * u.deg,
        pmra_cosdec=1000 * u.mas / u.yr,
        pmdec=0 * u.mas / u.yr,
        parallax=0 * u.mas,
        ref_epoch=Time(2016.0, format="jyear", scale="tdb"),
    )
    moved = propagate_space_motion(a, Time("2026-01-01", scale="utc"))
    d = (float(moved.ra.deg) - 10.0) * np.cos(np.radians(20.0)) * 3600.0
    assert d == pytest.approx(10.0, abs=0.05)


def test_parallax_factors_bounded_and_periodic() -> None:
    times = Time("2026-01-01", scale="utc") + np.arange(0, 366, 30) * u.day
    pa, pd = parallax_factors(100 * u.deg, 20 * u.deg, times)
    assert np.all(np.abs(pa) <= 1.02) and np.all(np.abs(pd) <= 1.02)
    assert np.ptp(pa) > 1.5  # a full annual sweep


def test_apparent_positions_scalar_and_array() -> None:
    scalar = apparent_positions(BARNARD, Time("2026-03-01", scale="utc"))
    arr = apparent_positions(BARNARD, Time(["2026-03-01", "2026-09-01"], scale="utc"))
    assert scalar.isscalar and len(arr) == 2
    # parallax shifts the position by at most about 0.55 arcsec
    plain = propagate_space_motion(BARNARD, Time("2026-03-01", scale="utc"))
    assert scalar.separation(plain).arcsec < 0.6
