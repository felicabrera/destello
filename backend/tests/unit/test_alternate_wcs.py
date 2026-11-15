"""Alternate WCS of a cutout (keys W and A) never carry the celestial SIP distortion.

Real IRSA cutouts from the fixtures; the reference is the procedure of the IRSA SPHEREx tutorial
(`WCS(header, fobj=hdul, key="W")` followed by `sip = None`).
"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from destello.pipeline.calibrate import (
    alternate_wcs_header,
    load_cutout,
    wavelength_at,
    wcs_header,
)

CUTOUTS = sorted((Path(__file__).parents[1] / "fixtures" / "cutouts").glob("*.fits"))


@pytest.mark.parametrize("path", CUTOUTS, ids=lambda p: p.stem)
def test_spectral_and_detector_wcs_are_free_of_sip(path: Path) -> None:
    with warnings.catch_warnings(), fits.open(path) as hdul:
        warnings.simplefilter("ignore")
        cut = load_cutout(hdul, path.stem)
        ref = WCS(hdul["IMAGE"].header, fobj=hdul, key="W")
        ref.sip = None
        assert cut.wcs.sip is not None  # the celestial WCS keeps its distortion
        assert cut.wave_wcs is not None and cut.wave_wcs.sip is None
        assert cut.det_wcs is not None and cut.det_wcs.sip is None
        ny, nx = cut.shape
        for x, y in ((0.0, 0.0), ((nx - 1) / 2, (ny - 1) / 2), (nx - 1.0, ny - 1.0)):
            wl, bw = wavelength_at(cut, x, y)
            rwl, rbw = ref.wcs_pix2world(x, y, 0)
            assert wl.value == pytest.approx(float(rwl), rel=1e-12)
            assert bw.value == pytest.approx(float(rbw), rel=1e-12)
        # Detector coordinates are a pure pixel offset: one cutout pixel is one detector pixel.
        dx, dy = cut.det_wcs.all_pix2world(np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0]), 0)
        assert dx[1] - dx[0] == pytest.approx(1.0, abs=1e-9)
        assert dy[2] - dy[0] == pytest.approx(1.0, abs=1e-9)
        assert dy[1] == pytest.approx(dy[0], abs=1e-9) and dx[2] == pytest.approx(dx[0], abs=1e-9)
        assert float(dx[0]) == pytest.approx(round(float(dx[0])), abs=1e-6)


@pytest.mark.parametrize("path", CUTOUTS[:4], ids=lambda p: p.stem)
def test_header_without_sip_cards_gives_the_same_alternate_wcs(path: Path) -> None:
    with warnings.catch_warnings(), fits.open(path) as hdul:
        warnings.simplefilter("ignore")
        whdr = wcs_header(hdul["IMAGE"].header)
        alt = alternate_wcs_header(whdr)
        assert "A_ORDER" in whdr and "A_ORDER" not in alt and "BP_ORDER" not in alt
        assert "CRPIX1A" in alt and "CRPIX1W" in alt and "CRPIX1" in alt
        ny, nx = hdul["IMAGE"].data.shape
        yy, xx = np.mgrid[0:ny:5, 0:nx:5]
        for key in ("W", "A"):
            full = WCS(whdr, fobj=hdul, key=key)
            full.sip = None
            lean = WCS(alt, fobj=hdul, key=key)
            assert lean.sip is None
            assert lean.to_header_string(relax=True) == full.to_header_string(relax=True)
            for a, b in zip(
                full.all_pix2world(xx, yy, 0), lean.all_pix2world(xx, yy, 0), strict=True
            ):
                assert np.array_equal(a, b, equal_nan=True)


@pytest.mark.parametrize("path", CUTOUTS[:4], ids=lambda p: p.stem)
def test_cutout_wcs_equal_the_ones_built_from_header_objects(path: Path) -> None:
    """`load_cutout` builds its WCS from serialized header text; the objects must not differ."""
    with warnings.catch_warnings(), fits.open(path) as hdul:
        warnings.simplefilter("ignore")
        cut = load_cutout(hdul, path.stem)
        whdr = wcs_header(hdul["IMAGE"].header)
        ref_w = WCS(whdr, fobj=hdul, key="W")
        ref_a = WCS(whdr, key="A")
        ref_w.sip = None
        ref_a.sip = None
        ny, nx = cut.shape
        yy, xx = np.mgrid[0:ny:5, 0:nx:5]
        assert cut.wave_wcs is not None and cut.det_wcs is not None
        for mine, ref in ((cut.wcs, WCS(whdr)), (cut.wave_wcs, ref_w), (cut.det_wcs, ref_a)):
            assert mine.to_header_string(relax=True) == ref.to_header_string(relax=True)
            for a, b in zip(
                mine.all_pix2world(xx, yy, 0), ref.all_pix2world(xx, yy, 0), strict=True
            ):
                assert np.array_equal(a, b, equal_nan=True)
