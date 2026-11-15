"""Predicted sky path of a catalog source over a sequence (F-27, docs/03 section 4.4).

The path is the apparent position (space motion from the catalog reference epoch plus the
geocentric parallax shift, `pipeline.propagate.apparent_positions`) sampled densely between the
first and the last observation of the sequence, so the annual parallax wiggle is visible on top of
the linear proper motion. The parallax ellipse is the yearly loop the parallax alone traces around
the barycentric position at one instant. Pure functions: no network, no I/O.
"""

from __future__ import annotations

from dataclasses import dataclass

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.time import Time, TimeDelta

from destello.pipeline.propagate import (
    Astrometry,
    apparent_positions,
    parallax_factors,
    propagate_space_motion,
)

FloatArray = npt.NDArray[np.float64]

#: Sampling step of the path. Two days resolve the parallax loop (period one year) smoothly.
PATH_STEP = 2.0 * u.day
#: Upper bound on the number of path samples, whatever the span.
PATH_MAX_SAMPLES = 512
#: Samples around the parallax ellipse (one per about five days).
ELLIPSE_SAMPLES = 73


@dataclass(frozen=True)
class SkyTrack:
    """Positions (ICRS degrees) at `times`."""

    times: Time
    ra_deg: FloatArray
    dec_deg: FloatArray


@dataclass(frozen=True)
class ParallaxEllipse:
    """Yearly parallax loop around the barycentric position at `center_time`."""

    center_time: Time
    center_ra_deg: float
    center_dec_deg: float
    ra_deg: FloatArray
    dec_deg: FloatArray
    semi_major: u.Quantity  # arcsec
    semi_minor: u.Quantity  # arcsec


def sample_times(
    t_start: Time,
    t_end: Time,
    step: u.Quantity = PATH_STEP,
    max_samples: int = PATH_MAX_SAMPLES,
) -> Time:
    """Evenly spaced UTC times from `t_start` to `t_end` inclusive, at most `max_samples`."""
    t0 = float(t_start.utc.mjd)
    t1 = float(t_end.utc.mjd)
    if t1 < t0:
        t0, t1 = t1, t0
    span = t1 - t0
    n = int(np.ceil(span / step.to_value(u.day))) + 1
    n = max(2, min(max_samples, n))
    return Time(np.linspace(t0, t1, n), format="mjd", scale="utc")


def predicted_track(astrometry: Astrometry, times: Time) -> SkyTrack:
    """Apparent positions (space motion plus geocentric parallax) at each time."""
    pos = apparent_positions(astrometry, times)
    ra = np.atleast_1d(np.asarray(pos.ra.to_value(u.deg), dtype=np.float64)) % 360.0
    dec = np.atleast_1d(np.asarray(pos.dec.to_value(u.deg), dtype=np.float64))
    return SkyTrack(times=times, ra_deg=ra, dec_deg=dec)


def parallax_ellipse(
    astrometry: Astrometry, center_time: Time, samples: int = ELLIPSE_SAMPLES
) -> ParallaxEllipse | None:
    """The loop traced over one year by the parallax shift alone, around the barycentric position
    at `center_time`. None when the parallax is unknown or not positive.

    The semi-axes are measured on the sampled loop: the largest and smallest shift from the
    centre. For an observer at 1 AU they approach the parallax and the parallax times the sine of
    the ecliptic latitude."""
    plx = float(astrometry.parallax.to_value(u.arcsec))
    if plx <= 0:
        return None
    centre = propagate_space_motion(astrometry, center_time)
    ra0 = float(np.atleast_1d(centre.ra.to_value(u.deg))[0])
    dec0 = float(np.atleast_1d(centre.dec.to_value(u.deg))[0])
    offsets = np.linspace(-0.5, 0.5, samples) * 365.25
    times = center_time + TimeDelta(offsets, format="jd")
    ra_q = np.full(samples, ra0) * u.deg
    dec_q = np.full(samples, dec0) * u.deg
    pa, pd = parallax_factors(ra_q, dec_q, times)
    d_east = plx * pa  # arcsec, along +RA (east)
    d_north = plx * pd  # arcsec, along +Dec
    ra = (ra0 + d_east / 3600.0 / np.cos(np.radians(dec0))) % 360.0
    dec = dec0 + d_north / 3600.0
    r = np.hypot(d_east, d_north)
    return ParallaxEllipse(
        center_time=center_time,
        center_ra_deg=ra0 % 360.0,
        center_dec_deg=dec0,
        ra_deg=np.asarray(ra, dtype=np.float64),
        dec_deg=np.asarray(dec, dtype=np.float64),
        semi_major=float(np.max(r)) * u.arcsec,
        semi_minor=float(np.min(r)) * u.arcsec,
    )
