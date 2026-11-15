"""Catalog propagation to observation epochs (docs/03 section 4.4).

Positions are propagated with proper motion (and radial velocity when known) from the catalog
reference epoch to each frame mid-time using astropy. Parallax displacement as seen from low
Earth orbit is approximated as geocentric: the observer is placed at the Earth center, whose
barycentric position is taken from the built-in astropy ephemeris.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.coordinates import (
    SkyCoord,
    get_body_barycentric,
    solar_system_ephemeris,
)
from astropy.time import Time
from astropy.utils.exceptions import AstropyWarning


@dataclass(frozen=True)
class Astrometry:
    """Catalog astrometry of one source at its reference epoch (ICRS)."""

    ra: u.Quantity  # degrees
    dec: u.Quantity  # degrees
    pmra_cosdec: u.Quantity  # mu_alpha* = mu_alpha cos(dec), mas/yr
    pmdec: u.Quantity  # mas/yr
    parallax: u.Quantity  # mas (0 when unknown)
    ref_epoch: Time
    rv: u.Quantity | None = None  # km/s, optional


def propagate_space_motion(astrometry: Astrometry, obstimes: Time) -> SkyCoord:
    """Propagate a source from its reference epoch to each time in `obstimes`.

    Returns a SkyCoord (ICRS, barycentric space motion only: no parallax shift). Uses the
    parallax as the distance when it is positive so that radial motion is applied consistently.
    """
    kwargs: dict[str, object] = {
        "ra": astrometry.ra,
        "dec": astrometry.dec,
        "pm_ra_cosdec": astrometry.pmra_cosdec,
        "pm_dec": astrometry.pmdec,
        "obstime": astrometry.ref_epoch,
        "frame": "icrs",
    }
    plx = astrometry.parallax.to_value(u.mas)
    if plx > 0:
        kwargs["distance"] = (1.0 / (plx / 1000.0)) * u.pc
        kwargs["radial_velocity"] = astrometry.rv if astrometry.rv is not None else 0 * u.km / u.s
    else:
        kwargs["distance"] = 1.0e6 * u.pc  # effectively infinite; no radial motion
        kwargs["radial_velocity"] = 0 * u.km / u.s
    coord = SkyCoord(**kwargs)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        moved = coord.apply_space_motion(new_obstime=obstimes)
    return moved


def earth_barycentric_au(times: Time) -> npt.NDArray[np.float64]:
    """Earth barycentric ICRS position in AU, shape (3, N), using the built-in ephemeris."""
    with solar_system_ephemeris.set("builtin"):
        pos = get_body_barycentric("earth", times)
    xyz = np.vstack([pos.x.to_value(u.AU), pos.y.to_value(u.AU), pos.z.to_value(u.AU)])
    return np.atleast_2d(xyz.reshape(3, -1)).astype(np.float64)


def parallax_factors(
    ra: u.Quantity, dec: u.Quantity, times: Time
) -> tuple[npt.NDArray[np.float64], npt.NDArray[np.float64]]:
    """Parallax factors (P_alpha*, P_delta), dimensionless (AU / AU), shape (N,).

    The parallax displacement in arcsec on the sky is `parallax_arcsec * P`. Earth center is
    used as the observer (geocentric approximation for a satellite in low Earth orbit).
    """
    a = ra.to_value(u.rad)
    d = dec.to_value(u.rad)
    x, y, z = earth_barycentric_au(times)
    p_alpha = x * np.sin(a) - y * np.cos(a)
    p_delta = x * np.cos(a) * np.sin(d) + y * np.sin(a) * np.sin(d) - z * np.cos(d)
    return p_alpha.astype(np.float64), p_delta.astype(np.float64)


def apparent_positions(astrometry: Astrometry, obstimes: Time) -> SkyCoord:
    """Space motion plus geocentric parallax at each observation time (ICRS)."""
    moved = propagate_space_motion(astrometry, obstimes)
    plx = astrometry.parallax.to_value(u.arcsec)
    if plx <= 0:
        return moved
    pa, pd = parallax_factors(moved.ra, moved.dec, obstimes)
    if obstimes.isscalar:
        pa, pd = pa[0], pd[0]
    dra = (plx * pa) * u.arcsec / np.cos(moved.dec.to_value(u.rad))
    ddec = (plx * pd) * u.arcsec
    return SkyCoord(ra=moved.ra + dra, dec=moved.dec + ddec, frame="icrs")


def mean_position(positions: SkyCoord) -> SkyCoord:
    """Mean of a set of positions (via unit vectors), used to center a sequence on a mover."""
    cart = positions.cartesian.xyz.value
    mean = np.mean(cart, axis=1)
    mean = mean / np.linalg.norm(mean)
    ra = np.degrees(np.arctan2(mean[1], mean[0])) % 360.0
    dec = np.degrees(np.arcsin(mean[2]))
    return SkyCoord(ra=ra * u.deg, dec=dec * u.deg, frame="icrs")
