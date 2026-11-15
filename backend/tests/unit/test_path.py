"""F-27 predicted path and parallax ellipse (pipeline.path)."""

import astropy.units as u
import numpy as np
import pytest
from astropy.coordinates import BarycentricMeanEcliptic, SkyCoord
from astropy.time import Time

from destello.pipeline.path import (
    PATH_MAX_SAMPLES,
    parallax_ellipse,
    predicted_track,
    sample_times,
)
from destello.pipeline.propagate import Astrometry, apparent_positions, propagate_space_motion

# Gaia DR3 4472832130942575872 (Barnard's Star), pinned in data/targets.yaml.
BARNARD = Astrometry(
    ra=269.44850252543836 * u.deg,
    dec=4.739420051112412 * u.deg,
    pmra_cosdec=-801.5509783684709 * u.mas / u.yr,
    pmdec=10362.394206546573 * u.mas / u.yr,
    parallax=546.975939730948 * u.mas,
    ref_epoch=Time(2016.0, format="jyear", scale="tdb"),
)
NO_PLX = Astrometry(
    ra=BARNARD.ra,
    dec=BARNARD.dec,
    pmra_cosdec=BARNARD.pmra_cosdec,
    pmdec=BARNARD.pmdec,
    parallax=0.0 * u.mas,
    ref_epoch=BARNARD.ref_epoch,
)
T0 = Time("2025-05-01T00:00:00", scale="utc")
T1 = Time("2026-05-01T00:00:00", scale="utc")


def offsets_arcsec(
    ra: np.ndarray, dec: np.ndarray, ra0: np.ndarray, dec0: np.ndarray
) -> np.ndarray:
    d_e = (ra - ra0) * np.cos(np.radians(dec0)) * 3600.0
    d_n = (dec - dec0) * 3600.0
    return np.asarray(np.hypot(d_e, d_n))


def test_sample_times_span_and_bounds() -> None:
    t = sample_times(T0, T1)
    assert t[0].utc.mjd == pytest.approx(T0.utc.mjd)
    assert t[-1].utc.mjd == pytest.approx(T1.utc.mjd)
    step = np.diff(t.utc.mjd)
    assert np.all(step > 0) and np.all(step <= 2.0 + 1e-9)
    # Reversed input gives the same span; a long span is capped.
    assert sample_times(T1, T0)[0].utc.mjd == pytest.approx(T0.utc.mjd)
    long = sample_times(T0, Time("2045-01-01T00:00:00", scale="utc"))
    assert len(long) == PATH_MAX_SAMPLES
    assert len(sample_times(T0, T0)) == 2


def test_track_equals_apparent_positions() -> None:
    t = sample_times(T0, T1)
    tr = predicted_track(BARNARD, t)
    ref = apparent_positions(BARNARD, t)
    assert np.allclose(tr.ra_deg, ref.ra.deg, atol=1e-10)
    assert np.allclose(tr.dec_deg, ref.dec.deg, atol=1e-10)


def test_track_wiggles_around_the_space_motion_by_the_parallax() -> None:
    t = sample_times(T0, T1)
    tr = predicted_track(BARNARD, t)
    lin = propagate_space_motion(BARNARD, t)
    r = offsets_arcsec(tr.ra_deg, tr.dec_deg, lin.ra.deg, lin.dec.deg)
    plx = BARNARD.parallax.to_value(u.arcsec)
    # Earth distance to the barycentre stays within 0.98 to 1.02 AU.
    assert r.max() == pytest.approx(plx, rel=0.03)
    # Without parallax the track is the space motion itself.
    flat = predicted_track(NO_PLX, t)
    assert np.allclose(flat.ra_deg, lin.ra.deg, atol=1e-10)
    assert np.allclose(flat.dec_deg, lin.dec.deg, atol=1e-10)


def test_ellipse_axes_follow_the_ecliptic_latitude() -> None:
    centre = Time("2025-11-01T00:00:00", scale="utc")
    ell = parallax_ellipse(BARNARD, centre)
    assert ell is not None
    plx = BARNARD.parallax.to_value(u.arcsec)
    pos = propagate_space_motion(BARNARD, centre)
    beta = (
        SkyCoord(ra=pos.ra, dec=pos.dec, frame="icrs")
        .transform_to(BarycentricMeanEcliptic(equinox="J2000"))
        .lat
    )
    assert ell.semi_major.to_value(u.arcsec) == pytest.approx(plx, rel=0.03)
    assert ell.semi_minor.to_value(u.arcsec) == pytest.approx(
        plx * abs(np.sin(beta.to_value(u.rad))), rel=0.06
    )
    # The loop is closed (one year) and centred on the barycentric position.
    assert ell.center_ra_deg == pytest.approx(float(pos.ra.deg), abs=1e-9)
    c_ra, c_dec = np.full(1, ell.center_ra_deg), np.full(1, ell.center_dec_deg)
    r = offsets_arcsec(ell.ra_deg, ell.dec_deg, c_ra, c_dec)
    assert np.all(r <= ell.semi_major.to_value(u.arcsec) + 1e-9)


def test_no_ellipse_without_parallax() -> None:
    assert parallax_ellipse(NO_PLX, T0) is None
