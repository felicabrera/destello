"""Reprojection of calibrated cutouts onto a common TAN grid (docs/03 section 4.1 step 6)."""

from __future__ import annotations

import warnings
from dataclasses import dataclass

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS
from reproject import reproject_interp

from destello.core.config import GRID_PIXEL_SCALE_ARCSEC
from destello.pipeline.calibrate import CalibratedCutout

FloatArray = npt.NDArray[np.floating]


@dataclass(frozen=True)
class GridSpec:
    """A gnomonic grid centered on (ra, dec). x increases to the west (East left), y north."""

    ra_deg: float
    dec_deg: float
    pixel_scale_arcsec: float
    ny: int
    nx: int

    @property
    def shape(self) -> tuple[int, int]:
        return self.ny, self.nx

    def wcs(self) -> WCS:
        w = WCS(naxis=2)
        w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
        w.wcs.crval = [self.ra_deg, self.dec_deg]
        w.wcs.crpix = [(self.nx + 1) / 2.0, (self.ny + 1) / 2.0]
        scale = self.pixel_scale_arcsec / 3600.0
        w.wcs.cdelt = [-scale, scale]
        w.wcs.cunit = ["deg", "deg"]
        w.wcs.radesys = "ICRS"
        w.pixel_shape = (self.nx, self.ny)
        return w


def make_grid(
    ra: u.Quantity,
    dec: u.Quantity,
    fov: u.Quantity,
    pixel_scale: u.Quantity = GRID_PIXEL_SCALE_ARCSEC * u.arcsec,
) -> GridSpec:
    """Grid covering `fov` at `pixel_scale`; N = round(FoV / scale) pixels per side."""
    n = max(int(round(float(fov.to_value(u.arcsec) / pixel_scale.to_value(u.arcsec)))), 8)
    return GridSpec(
        ra_deg=float(ra.to_value(u.deg)),
        dec_deg=float(dec.to_value(u.deg)),
        pixel_scale_arcsec=float(pixel_scale.to_value(u.arcsec)),
        ny=n,
        nx=n,
    )


def reproject_mask(mask: npt.NDArray[np.bool_], wcs_in: WCS, grid: GridSpec) -> FloatArray:
    """Bilinear reprojection of a boolean mask to a float map in [0, 1] (outside the cutout: 0)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        out, _ = reproject_interp(
            (mask.astype(np.float32), wcs_in), grid.wcs(), shape_out=grid.shape, order="bilinear"
        )
    return np.nan_to_num(np.asarray(out, dtype=np.float32), nan=0.0)


def grid_footprint(wcs_in: WCS, shape_in: tuple[int, int], grid: GridSpec) -> npt.NDArray[np.bool_]:
    """Pixels of an input image (shape (ny, nx)) whose centers fall inside the output grid."""
    ny, nx = shape_in
    yy, xx = np.mgrid[0:ny, 0:nx]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        ra, dec = wcs_in.all_pix2world(xx.ravel(), yy.ravel(), 0)
        gx, gy = grid.wcs().all_world2pix(ra, dec, 0)
    gx = np.asarray(gx, dtype=np.float64).reshape(ny, nx)
    gy = np.asarray(gy, dtype=np.float64).reshape(ny, nx)
    inside = (gx >= -0.5) & (gx < grid.nx - 0.5) & (gy >= -0.5) & (gy < grid.ny - 0.5)
    return np.asarray(inside & np.isfinite(gx) & np.isfinite(gy), dtype=bool)


@dataclass
class ReprojectedCutout:
    science: FloatArray  # MJy/sr on the grid, NaN where masked or outside the cutout
    variance: FloatArray  # (MJy/sr)^2 on the grid, NaN where science is NaN
    coverage: float  # fraction of grid pixels with valid data


def reproject_cutout(cal: CalibratedCutout, grid: GridSpec) -> ReprojectedCutout:
    """Bilinear reprojection of science and variance; masked pixels become NaN in the output.

    Surface brightness is intensive, so interpolation needs no flux conservation. The variance
    is interpolated with the same kernel (an approximation that ignores pixel correlations).
    """
    # Science and variance share one geometry: both planes go through a single call, so the pixel
    # to pixel transform (the costly part, it evaluates the distortion terms) is computed once.
    planes = np.stack([cal.science, cal.variance])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        out, _ = reproject_interp(
            (planes, cal.cutout.wcs), grid.wcs(), shape_out=(2, *grid.shape), order="bilinear"
        )
    sci, var = out[0], out[1]
    sci = np.asarray(sci, dtype=np.float32)
    var = np.asarray(var, dtype=np.float32)
    invalid = ~np.isfinite(sci) | ~np.isfinite(var) | (var <= 0)
    sci[invalid] = np.nan
    var[invalid] = np.nan
    return ReprojectedCutout(science=sci, variance=var, coverage=float(1.0 - invalid.mean()))
