"""NEOSSat matching and cutouts (F-33). Pure functions: arrays and metadata in and out.

For each SPHEREx exposure the nearest NEOSSat frame (in time, within a stated window) whose
footprint contains the ephemeris position at the frame's own mid time is chosen. The cutout is
reprojected to a north up grid centered on the ephemeris position. The header astrometry of
NEOSSat frames can be tens of arcseconds off the ephemeris, so the cutout carries no marker.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales
from reproject import reproject_interp

from destello.pipeline.render import Stretch, apply_stretch

NEOSSAT_WINDOW_HOURS = 24.0
CUTOUT_PIXELS = 128
CUTOUT_SCALE_ARCSEC = 3.0  # close to the native NEOSSat scale (about 3.0 arcsec per pixel)
STRETCH_LOW_PCT = 1.0
STRETCH_HIGH_PCT = 99.7
ASINH_SOFTENING = 0.1

FloatArray = npt.NDArray[np.float64]


def point_in_polygon(
    poly_deg: Sequence[tuple[float, float]], ra_deg: float, dec_deg: float
) -> bool:
    """Whether (ra, dec) lies inside the polygon, on the gnomonic plane centered at the point."""
    ra0, dec0 = math.radians(ra_deg), math.radians(dec_deg)
    arr = np.asarray(poly_deg, dtype=float)
    a, d = np.radians(arr[:, 0]), np.radians(arr[:, 1])
    cosc = math.sin(dec0) * np.sin(d) + math.cos(dec0) * np.cos(d) * np.cos(a - ra0)
    if np.any(cosc <= 0):
        return False
    x = np.cos(d) * np.sin(a - ra0) / cosc
    y = (math.cos(dec0) * np.sin(d) - math.sin(dec0) * np.cos(d) * np.cos(a - ra0)) / cosc
    inside = False
    n = len(x)
    for i in range(n):
        x1, y1, x2, y2 = x[i], y[i], x[(i + 1) % n], y[(i + 1) % n]
        if (y1 > 0) != (y2 > 0) and x1 + (0 - y1) * (x2 - x1) / (y2 - y1) > 0:
            inside = not inside
    return inside


@dataclass(frozen=True)
class Candidate:
    """A plane reduced to what matching needs; ra_deg, dec_deg are the ephemeris at its mid time."""

    key: str
    t_mid_mjd: float
    polygon_deg: tuple[tuple[float, float], ...]
    ra_deg: float
    dec_deg: float


def nearest_in_window(
    t_spherex_mjd: float,
    candidates: Sequence[Candidate],
    window_hours: float = NEOSSAT_WINDOW_HOURS,
) -> Candidate | None:
    """The candidate closest in time within +/- window_hours whose footprint holds the target."""
    best: Candidate | None = None
    best_dt = math.inf
    for c in candidates:
        dt = abs(c.t_mid_mjd - t_spherex_mjd) * 24.0
        if dt > window_hours or dt >= best_dt:
            continue
        if point_in_polygon(c.polygon_deg, c.ra_deg, c.dec_deg):
            best, best_dt = c, dt
    return best


def interp_track(
    t_mjd: float, track_mjd: FloatArray, ra_deg: FloatArray, dec_deg: FloatArray
) -> tuple[float, float]:
    """Ephemeris position at `t_mjd` by linear interpolation of a sampled track (RA unwrapped)."""
    ra = np.unwrap(np.radians(ra_deg))
    return (
        float(np.degrees(np.interp(t_mjd, track_mjd, ra)) % 360.0),
        float(np.interp(t_mjd, track_mjd, dec_deg)),
    )


def cutout_wcs(ra_deg: float, dec_deg: float, size: int = CUTOUT_PIXELS) -> WCS:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [ra_deg, dec_deg]
    w.wcs.crpix = [size / 2.0 + 0.5, size / 2.0 + 0.5]
    scale = (CUTOUT_SCALE_ARCSEC * u.arcsec).to_value(u.deg)
    w.wcs.cdelt = [-scale, scale]
    return w


def make_cutout(
    data: FloatArray, wcs: WCS, ra_deg: float, dec_deg: float, size: int = CUTOUT_PIXELS
) -> FloatArray:
    """Reproject the frame onto a north up grid centered on the ephemeris position (NaN outside)."""
    out, _ = reproject_interp(
        (data, wcs), cutout_wcs(ra_deg, dec_deg, size), shape_out=(size, size)
    )
    return np.asarray(out, dtype=np.float64)


def cutout_stretch(cut: FloatArray) -> Stretch:
    """Percentile asinh stretch of one cutout. It is an optical quick look of a single frame, not
    a shared SPHEREx stretch (no comparison between frames is made from it)."""
    good = cut[np.isfinite(cut)]
    if good.size < 16:
        raise ValueError("Too few finite pixels in the NEOSSat cutout")
    lo, hi = np.percentile(good, [STRETCH_LOW_PCT, STRETCH_HIGH_PCT])
    if not hi > lo:
        hi = lo + 1.0
    return Stretch("asinh", float(lo), float(hi), ASINH_SOFTENING, "ADU")


def render_cutout(cut: FloatArray) -> tuple[npt.NDArray[np.uint8], Stretch]:
    st = cutout_stretch(cut)
    return apply_stretch(cut, st), st


def frame_fov_arcmin(wcs: WCS, naxis: tuple[int, int]) -> tuple[float, float]:
    """Field of view of a whole frame in arcminutes from its WCS pixel scale; naxis is (nx, ny)."""
    sx, sy = proj_plane_pixel_scales(wcs.celestial)
    return (float(sx * 60.0 * naxis[0]), float(sy * 60.0 * naxis[1]))
