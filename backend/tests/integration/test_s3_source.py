"""S3 cutout source against a recorded style bucket (respx): range reads, assembly, fallback.

The multi extension file served here has the layout of a SPHEREx Level 2 file (PRIMARY without
data, IMAGE, FLAGS, VARIANCE, ZODI, PSF, WCS-WAVE last). Its pixel values are random numbers that
exist only to check that the bytes of the assembled cutout equal a plain slice of the full file;
the product never serves such data. No network access.
"""

from __future__ import annotations

import io
from pathlib import Path

import astropy.units as u
import httpx
import numpy as np
import pytest
import respx
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS

from destello.core.config import DataMode, Settings
from destello.pipeline.query import ImageRecord
from destello.sources.base import OfflineMiss
from destello.sources.cutouts import CutoutRouter
from destello.sources.irsa import SIA_URL, IrsaClient
from destello.sources.s3 import (
    S3_BASE,
    TAIL_WINDOWS,
    S3CutoutSource,
    S3Unavailable,
    crop_cutout,
    cutout_box,
    cutout_source_of,
)

NX, NY = 200, 180
KEY = (
    "qr2/level2/2025W33_2C/l2b-v20-2025-266/6/level2_2025W33_2C_0321_1D6_spx_l2b-v20-2025-266.fits"
)
URL = S3_BASE + KEY
RA, DEC = 269.452, 4.6931
SIZE = 7 * u.arcmin
IBE_RE = r"https://irsa\.ipac\.caltech\.edu/ibe/data/spherex/.*"


def record() -> ImageRecord:
    return ImageRecord(
        obs_id="level2_2025W33_2C_0321_1D6_spx_l2b-v20-2025-266",
        observation_id="2025W33_2C_0321_1",
        plane_id="p1",
        detector=6,
        collection="spherex_qr2",
        uri="ibe/data/spherex/" + KEY,
        t_start=Time(60902.864715, format="mjd", scale="utc"),
        t_end=Time(60902.866047, format="mjd", scale="utc"),
        wave_min=4.4115 * u.um,
        wave_max=5.0096 * u.um,
        exposure_s=113.58,
        content_length=0,
    )


def image_header() -> fits.Header:
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [269.45, 4.69]
    w.wcs.crpix = [97.3, 91.8]
    w.wcs.cdelt = [-6.2 / 3600, 6.2 / 3600]
    ang = np.deg2rad(25.0)
    w.wcs.pc = [[np.cos(ang), -np.sin(ang)], [np.sin(ang), np.cos(ang)]]
    h = w.to_header()
    # Detector ("A") and spectral ("W") systems: their reference pixels must move with the box.
    h["CRPIX1A"] = 1021.0
    h["CRPIX2A"] = 1022.0
    h["CRVAL1A"] = 0.0
    h["CRVAL2A"] = 0.0
    h["CRPIX1W"] = 3.5
    h["CRPIX2W"] = 4.5
    h["BUNIT"] = "MJy/sr"
    return h


def l2_file(compressed_flags: bool) -> bytes:
    rng = np.random.default_rng(7)
    hdr = image_header()
    flags = rng.integers(0, 2**21, size=(NY, NX), dtype=np.int32)
    flags_hdu: fits.ImageHDU | fits.CompImageHDU
    if compressed_flags:  # as in the quick release 3 files: RICE, one tile per image row
        flags_hdu = fits.CompImageHDU(flags, header=hdr, name="FLAGS", compression_type="RICE_1")
    else:
        flags_hdu = fits.ImageHDU(flags, header=hdr, name="FLAGS")
    wave = fits.BinTableHDU.from_columns(
        [
            fits.Column(name="X", format="8E", array=rng.random((1, 8), dtype=np.float32)),
            fits.Column(name="VALUES", format="64E", array=rng.random((1, 64), dtype=np.float32)),
        ],
        name="WCS-WAVE",
    )
    primary = fits.PrimaryHDU()
    primary.header["MJD-AVG"] = 60902.86538
    hdul = fits.HDUList(
        [
            primary,
            fits.ImageHDU(rng.normal(size=(NY, NX)).astype(np.float32), header=hdr, name="IMAGE"),
            flags_hdu,
            fits.ImageHDU(rng.random((NY, NX), dtype=np.float32), header=hdr, name="VARIANCE"),
            fits.ImageHDU(rng.random((NY, NX), dtype=np.float32), header=hdr, name="ZODI"),
            fits.ImageHDU(rng.random((60, 51, 51), dtype=np.float32), name="PSF"),
            wave,
        ]
    )
    buf = io.BytesIO()
    hdul.writeto(buf)
    return buf.getvalue()


class Bucket:
    """Serves byte ranges of one object like S3 (206 with Content-Range) and logs them."""

    def __init__(self, blob: bytes) -> None:
        self.blob = blob
        self.ranges: list[tuple[int, int]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        spec = request.headers["range"].removeprefix("bytes=")
        a, b = spec.split("-")
        size = len(self.blob)
        if a == "":
            first, last = max(size - int(b), 0), size - 1
        else:
            first, last = int(a), min(int(b), size - 1)
        self.ranges.append((first, last))
        return httpx.Response(
            206,
            content=self.blob[first : last + 1],
            headers={"content-range": f"bytes {first}-{last}/{size}"},
        )


def sia_csv(*keys: str, bucket: str = "nasa-irsa-spherex") -> str:
    rows = ["obs_id,access_url,cloud_access"]
    for i, key in enumerate(keys):
        blob = f'{{"aws": {{"bucket_name": "{bucket}", "key": "{key}", "region": "us-east-1"}}}}'
        cell = '"' + blob.replace('"', '""') + '"'  # CSV quoting, as IRSA returns it
        rows.append(f"o{i},https://irsa.ipac.caltech.edu/x.fits,{cell}")
    return "\n".join(rows) + "\n"


def ibe_cutout() -> bytes:
    hdul = fits.HDUList(
        [
            fits.PrimaryHDU(),
            fits.ImageHDU(np.ones((4, 4), np.float32), name="IMAGE"),
            fits.ImageHDU(np.ones((4, 4), np.int32), name="FLAGS"),
            fits.ImageHDU(np.ones((8, 9, 9), np.float32), name="PSF"),
        ]
    )
    buf = io.BytesIO()
    hdul.writeto(buf)
    return buf.getvalue()


def make_settings(tmp_path: Path, mode: DataMode = DataMode.HYBRID) -> Settings:
    return Settings(data_dir=tmp_path, data_mode=mode)


def overlap(a: tuple[int, int], b: tuple[int, int]) -> int:
    return max(0, min(a[1], b[1]) - max(a[0], b[0]) + 1)


@pytest.mark.parametrize("compressed_flags", [False, True])
@respx.mock
async def test_s3_cutout_equals_a_slice_of_the_full_file(
    tmp_path: Path, compressed_flags: bool
) -> None:
    blob = l2_file(compressed_flags)
    bucket = Bucket(blob)
    s3_route = respx.get(URL).mock(side_effect=bucket)
    sia = respx.get(SIA_URL).mock(return_value=httpx.Response(200, text=sia_csv(KEY)))
    ibe = respx.get(url__regex=IBE_RE).mock(return_value=httpx.Response(500))
    settings = make_settings(tmp_path)
    async with IrsaClient(settings) as irsa:
        s3 = S3CutoutSource(settings, irsa=irsa, max_attempts=1)
        path = await s3.download_cutout(record(), RA, DEC, SIZE)
        calls = s3_route.call_count
        again = await s3.download_cutout(record(), RA, DEC, SIZE)
        await s3.aclose()
        assert path == again == irsa.cutout_path(record(), RA, DEC, SIZE)
    assert s3_route.call_count == calls  # the second call is served from the cache
    assert sia.call_count == 1 and ibe.call_count == 0
    assert cutout_source_of(path) == "s3"

    with fits.open(io.BytesIO(blob)) as full, fits.open(path) as cut:
        names = [h.name for h in cut]
        assert names == ["PRIMARY", "IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE"]
        assert cut[0].header["MJD-AVG"] == full[0].header["MJD-AVG"]
        full_header = full["IMAGE"].header
        size_deg = round(SIZE.to_value(u.deg), 5)
        box = cutout_box(full_header, round(RA, 6), round(DEC, 6), size_deg)
        ys = slice(box.y0, box.y0 + box.ny)
        xs = slice(box.x0, box.x0 + box.nx)
        for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
            expected = np.asarray(full[name].data)[ys, xs]
            got = np.asarray(cut[name].data)
            assert (got.dtype.kind, got.dtype.itemsize) == (
                expected.dtype.kind,
                expected.dtype.itemsize,
            ), name
            assert np.array_equal(got, expected), name
            h = cut[name].header
            assert (h["NAXIS1"], h["NAXIS2"]) == (box.nx, box.ny)
            for axis, origin in (("1", box.x0), ("2", box.y0)):
                for alt in ("", "A", "W"):
                    key = f"CRPIX{axis}{alt}"
                    assert h[key] == pytest.approx(full_header[key] - origin), (name, key)
        assert np.array_equal(cut["WCS-WAVE"].data["VALUES"], full["WCS-WAVE"].data["VALUES"])
        # The requested position lands at the center of the box (IBE convention), within 1 pixel.
        cx, cy = WCS(cut["IMAGE"].header).all_world2pix(RA, DEC, 0)
        assert abs(float(cx) - (box.nx - 1) / 2) <= 1.0
        assert abs(float(cy) - (box.ny - 1) / 2) <= 1.0
        psf_at = full.fileinfo(5)["datLoc"]
        psf_span = (psf_at, psf_at + full.fileinfo(5)["datSpan"] - 1)
    # Only the needed rows and headers are read: the PSF cube is never downloaded (the suffix
    # read that holds WCS-WAVE may include the last few blocks of the PSF data).
    psf_read = sum(overlap(r, psf_span) for r in bucket.ranges)
    assert psf_read <= TAIL_WINDOWS[0]
    assert sum(b - a + 1 for a, b in bucket.ranges) < len(blob) / 2


@respx.mock
async def test_router_falls_back_to_irsa_when_the_key_is_not_listed(tmp_path: Path) -> None:
    other = KEY.replace("0321", "0999")
    respx.get(SIA_URL).mock(return_value=httpx.Response(200, text=sia_csv(other)))
    s3_route = respx.get(url__regex=r"https://nasa-irsa-spherex\..*").mock(
        return_value=httpx.Response(500)
    )
    ibe = respx.get(url__regex=IBE_RE).mock(return_value=httpx.Response(200, content=ibe_cutout()))
    settings = make_settings(tmp_path)
    async with IrsaClient(settings) as irsa:
        s3 = S3CutoutSource(settings, irsa=irsa, max_attempts=1)
        with pytest.raises(S3Unavailable):
            await s3.download_cutout(record(), RA, DEC, SIZE)
        router = CutoutRouter(irsa, s3)
        path = await router.download_cutout(record(), RA, DEC, SIZE)
        await s3.aclose()
    assert s3_route.call_count == 0 and ibe.call_count == 1
    assert router.counts == {"cached": 0, "cropped": 0, "primary": 0, "fallback": 1}
    assert cutout_source_of(path) == "irsa"
    with fits.open(path) as hdul:
        assert "PSF" not in [h.name for h in hdul]


@respx.mock
async def test_router_falls_back_to_irsa_on_an_s3_error(tmp_path: Path) -> None:
    sia = respx.get(SIA_URL).mock(return_value=httpx.Response(200, text=sia_csv(KEY)))
    s3_route = respx.get(URL).mock(return_value=httpx.Response(403, text="AccessDenied"))
    ibe = respx.get(url__regex=IBE_RE).mock(return_value=httpx.Response(200, content=ibe_cutout()))
    settings = make_settings(tmp_path)
    async with IrsaClient(settings) as irsa:
        s3 = S3CutoutSource(settings, irsa=irsa, max_attempts=1)
        router = CutoutRouter(irsa, s3)
        path = await router.download_cutout(record(), RA, DEC, SIZE)
        cached = await router.download_cutout(record(), RA, DEC, SIZE)
        await s3.aclose()
    assert path == cached and s3_route.call_count >= 1 and ibe.call_count == 1
    assert router.counts == {"cached": 1, "cropped": 0, "primary": 0, "fallback": 1}
    assert sia.call_count == 1


@pytest.mark.parametrize("compressed_flags", [False, True])
@respx.mock
async def test_smaller_cutout_is_cut_from_a_cached_larger_one(
    tmp_path: Path, compressed_flags: bool
) -> None:
    """A field of view change on the same image and center downloads nothing, and the result is
    byte for byte the cutout a fresh S3 read gives (same box rule, raw data copy)."""
    blob = l2_file(compressed_flags)
    s3_route = respx.get(URL).mock(side_effect=Bucket(blob))
    respx.get(SIA_URL).mock(return_value=httpx.Response(200, text=sia_csv(KEY)))
    respx.get(url__regex=IBE_RE).mock(return_value=httpx.Response(500))
    small = 3.5 * u.arcmin
    settings = make_settings(tmp_path)
    fresh_settings = make_settings(tmp_path / "fresh")
    async with IrsaClient(settings) as irsa, IrsaClient(fresh_settings) as irsa_fresh:
        s3 = S3CutoutSource(settings, irsa=irsa, max_attempts=1)
        router = CutoutRouter(irsa, s3)
        await router.download_cutout(record(), RA, DEC, SIZE)
        calls = s3_route.call_count
        cropped = await router.download_cutout(record(), RA, DEC, small)
        assert s3_route.call_count == calls  # no request for the smaller field
        assert router.counts == {"cached": 0, "cropped": 1, "primary": 1, "fallback": 0}
        assert cropped == irsa.cutout_path(record(), RA, DEC, small)
        # A larger field cannot be cut from a smaller cutout: it is read from S3.
        await router.download_cutout(record(), RA, DEC, 9 * u.arcmin)
        assert router.counts["primary"] == 2
        fresh_s3 = S3CutoutSource(fresh_settings, irsa=irsa_fresh, max_attempts=1)
        fresh = await fresh_s3.download_cutout(record(), RA, DEC, small)
        await s3.aclose()
        await fresh_s3.aclose()
    with fits.open(cropped) as a, fits.open(fresh) as b:
        assert [h.name for h in a] == [h.name for h in b]
        assert cutout_source_of(cropped) == "s3"
        for name in ("IMAGE", "FLAGS", "VARIANCE", "ZODI"):
            assert np.array_equal(a[name].data, b[name].data), name
            for key in ("NAXIS1", "NAXIS2", "CRPIX1", "CRPIX2", "CRPIX1A", "CRPIX2A", "CRPIX1W"):
                assert a[name].header[key] == pytest.approx(b[name].header[key]), (name, key)
        assert np.array_equal(a["WCS-WAVE"].data["VALUES"], b["WCS-WAVE"].data["VALUES"])


def test_crop_refuses_a_box_outside_the_cached_cutout() -> None:
    """Near the image edge a cached cutout is clipped; a crop would differ, so it is refused."""
    blob = l2_file(False)
    with fits.open(io.BytesIO(blob)) as full:
        corner = WCS(full["IMAGE"].header).all_pix2world([[2.0, 2.0]], 0)[0]
    out = io.BytesIO()
    fits.HDUList([fits.open(io.BytesIO(blob))[i] for i in (0, 1, 2, 3, 4, 6)]).writeto(out)
    assert crop_cutout(out.getvalue(), float(corner[0]), float(corner[1]), 0.05) is None


@respx.mock
async def test_s3_source_ignores_keys_of_other_buckets(tmp_path: Path) -> None:
    respx.get(SIA_URL).mock(
        return_value=httpx.Response(200, text=sia_csv(KEY, bucket="another-bucket"))
    )
    s3_route = respx.get(url__regex=r"https://.*amazonaws\.com/.*").mock(
        return_value=httpx.Response(500)
    )
    settings = make_settings(tmp_path)
    async with IrsaClient(settings) as irsa:
        s3 = S3CutoutSource(settings, irsa=irsa, max_attempts=1)
        with pytest.raises(S3Unavailable):
            await s3.download_cutout(record(), RA, DEC, SIZE)
        await s3.aclose()
    assert s3_route.call_count == 0


@respx.mock
async def test_s3_source_offline_never_fetches(tmp_path: Path) -> None:
    route = respx.get(url__regex=r"https://.*").mock(return_value=httpx.Response(500))
    settings = make_settings(tmp_path, DataMode.OFFLINE)
    async with IrsaClient(settings) as irsa:
        s3 = S3CutoutSource(settings, irsa=irsa)
        with pytest.raises(OfflineMiss):
            await CutoutRouter(irsa, s3).download_cutout(record(), RA, DEC, SIZE)
        await s3.aclose()
    assert route.call_count == 0
