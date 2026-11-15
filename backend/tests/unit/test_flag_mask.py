"""Unit tests for the per-frame flag mask (F-13): mask PNG, masked flag names, grid footprint."""

from __future__ import annotations

import io

import astropy.units as u
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image

from destello.models.manifest import ManifestFrame
from destello.pipeline.calibrate import masked_flag_names, parse_flag_bits
from destello.pipeline.coadd import coadd_stack
from destello.pipeline.render import mask_png
from destello.pipeline.reproject import grid_footprint, make_grid


def flags_header(names: list[str]) -> fits.Header:
    """A FLAGS header in the IRSA layout (MSKN/MSKM triplets), bits in list order."""
    hdr = fits.Header()
    for i, name in enumerate(names):
        hdr[f"MSKN{i}"] = name
        hdr[f"MSKM{i}"] = 1 << i
    return hdr


def test_mask_png_alpha_marks_masked_pixels_north_up() -> None:
    mask = np.zeros((5, 4), dtype=bool)
    mask[0, 1] = True  # first FITS row is the southern edge
    data = mask_png(mask)
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    with Image.open(io.BytesIO(data)) as im:
        assert im.mode == "RGBA" and im.size == (4, 5)
        alpha = np.asarray(im)[..., 3]
    assert alpha.sum() == 255
    assert alpha[4, 1] == 255  # flipped: south at the bottom of the image
    assert set(np.unique(alpha)) == {0, 255}


def test_mask_png_rejects_non_2d() -> None:
    with pytest.raises(ValueError):
        mask_png(np.zeros((2, 2, 2), dtype=bool))


def test_mask_png_matches_coadd_blank_fraction() -> None:
    img = np.ones((6, 6))
    img[0:2, :] = np.nan  # masked in every exposure
    c = coadd_stack([img, img.copy()], [np.ones((6, 6)), np.ones((6, 6))])
    with Image.open(io.BytesIO(mask_png(c.blank))) as im:
        alpha = np.asarray(im)[..., 3]
    assert float(np.mean(alpha == 255)) == pytest.approx(c.blank_fraction)
    assert c.blank_fraction == pytest.approx(2 / 6)


def test_masked_flag_names_reads_bits_from_header_and_skips_non_masking() -> None:
    # Bit numbers deliberately differ from any real file: meanings come from the header only.
    bits = parse_flag_bits(flags_header(["SOURCE", "HOT", "PERSIST", "FULLSAMPLE", "COLD"]))
    flags = np.zeros((4, 4), dtype=np.int64)
    flags[0, 0] = (1 << bits["SOURCE"]) | (1 << bits["HOT"])
    flags[1, 1] = 1 << bits["FULLSAMPLE"]
    flags[3, 3] = 1 << bits["PERSIST"]
    everywhere = np.ones((4, 4), dtype=bool)
    assert masked_flag_names(flags, bits, everywhere) == ["HOT", "PERSIST"]
    region = np.zeros((4, 4), dtype=bool)
    region[0:2, 0:2] = True
    assert masked_flag_names(flags, bits, region) == ["HOT"]
    assert masked_flag_names(flags, bits, np.zeros((4, 4), dtype=bool)) == []
    assert masked_flag_names(flags, bits, everywhere, mask_flags=("PERSIST",)) == ["PERSIST"]


def test_masked_flag_names_ignores_flags_undefined_in_header() -> None:
    bits = parse_flag_bits(flags_header(["HOT"]))
    flags = np.full((2, 2), 0b110, dtype=np.int64)  # bits 1 and 2 are not defined
    assert masked_flag_names(flags, bits, np.ones((2, 2), dtype=bool)) == []


def test_grid_footprint_selects_input_pixels_inside_the_grid() -> None:
    grid = make_grid(150.0 * u.deg, 2.0 * u.deg, 1.0 * u.arcmin)  # about 19 pixels of 3.1 arcsec
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [150.0, 2.0]
    w.wcs.crpix = [30.5, 30.5]  # 60 x 60 input pixels, same scale, centered on the grid
    s = grid.pixel_scale_arcsec / 3600.0
    w.wcs.cdelt = [-s, s]
    fp = grid_footprint(w, (60, 60), grid)
    assert fp.shape == (60, 60)
    assert fp[30, 30] and not fp[0, 0] and not fp[59, 59]
    assert abs(int(fp.sum()) - grid.nx * grid.ny) <= 2 * (grid.nx + grid.ny)


def test_manifest_frame_without_flag_fields_still_validates() -> None:
    old = {
        "detector": 3,
        "kind": "coadd",
        "url": "/frames/0123456789abcdef.webp",
        "n_images": 2,
        "flagged_fraction": 0.01,
        "obs_ids": ["a"],
        "collections": ["spherex_qr2"],
        "dois": [],
        "t_start": "2025-05-01T00:00:00Z",
        "t_end": "2025-05-02T00:00:00Z",
        "t_mid_mjd": 60796.5,
    }
    f = ManifestFrame.model_validate(old)
    assert f.flags_url is None and f.mask_flags is None
