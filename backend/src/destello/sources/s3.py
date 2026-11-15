"""SPHEREx cutouts read from the AWS open data copy (bucket nasa-irsa-spherex) with range requests.

The Level 2 files in the bucket are uncompressed multi extension FITS (about 66 to 72 MB): PRIMARY,
IMAGE (2040 x 2040 float32), FLAGS (int32), VARIANCE, ZODI, PSF or EPSF (about 4 to 5 MB) and
WCS-WAVE (small binary table). This source reads only the headers, the rows of IMAGE, FLAGS,
VARIANCE and ZODI that the cutout box needs, and the WCS-WAVE table; the PSF is never read.

The output file is assembled byte for byte like an IRSA IBE cutout of the same box: every header
card is copied, NAXIS1/NAXIS2 become the box size and every CRPIX1*/CRPIX2* keyword (celestial,
detector "A" and spectral "W" systems) is shifted by the box origin. Data bytes are copied raw, so
pixel values are identical to the IRSA cutout (verified live, backend/data-notes.md). The box rule
was fitted against IBE cutouts: center from the full WCS including SIP, per axis pixel scale from
the PC/CDELT columns, first pixel ceil(c - h), length round(2h), clipped to the image. Measured on
16 images (32 axes): the box equals the IBE box on 30 axes (14 images); on the other 2 axes the
size is equal and IBE starts one pixel later. That offset is within the cutout margin
(CUTOUT_MARGIN_ARCMIN) and does not change any pixel value on the overlap.

Security (docs/10 section 3.3): requests go through the egress checked client to the exact
virtual hosted HTTPS host; object keys come only from the `cloud_access` field of IRSA SIA2
results (IrsaClient.cloud_keys) and must equal the key derived from the record URI; no
credentials, no SDK. Concurrency is bounded by its own global limiter (core.limiter.s3_limiter).
"""

from __future__ import annotations

import asyncio
import io
import math
import re
import time
import warnings
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.wcs import WCS, FITSFixedWarning

from destello.core.cache import atomic_write_bytes
from destello.core.config import DataMode, Settings
from destello.core.egress import EgressClient
from destello.core.limiter import Limiter
from destello.pipeline.query import ImageRecord
from destello.sources.base import OfflineMiss, SourceBase, SourceError
from destello.sources.irsa import S3_BUCKET, S3_KEY_RE, SOURCE_KEYWORD, IrsaClient

S3_HOST = f"{S3_BUCKET}.s3.us-east-1.amazonaws.com"
S3_BASE = f"https://{S3_HOST}/"
URI_PREFIX = "ibe/data/spherex/"
BLOCK = 2880
# First read: PRIMARY (1 block) and the IMAGE header (measured 7 to 9 blocks).
HEAD_WINDOW = 12 * BLOCK
# Read used for each later header at its known offset (measured 4 to 6 blocks); grows x4 if short.
HEADER_WINDOW = 8 * BLOCK
# Suffix reads that hold the WCS-WAVE table at the end of the file (measured: 2 blocks).
TAIL_WINDOWS = (16 * 1024, 256 * 1024)
CUT_EXTENSIONS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI")
KEY_RETRY_S = 60.0
# Upper bound on the heap span read for the rows of a tile compressed extension.
MAX_HEAP_SPAN = 16 * 1024 * 1024
_CARD_END = b"END" + b" " * 77
_CONTENT_RANGE_RE = re.compile(r"bytes (\d+)-(\d+)/(\d+)")
_TFORM_RE = re.compile(r"^1?([PQ])([BIJKED])")
_HEAP_ELEMENT_BYTES = {"B": 1, "I": 2, "J": 4, "K": 8, "E": 4, "D": 8}
_RAW_DTYPES = {8: ">u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}


class S3Unavailable(SourceError):
    """The object is not in the bucket, not listed by cloud_access, or could not be read."""

    code = "S3_UNAVAILABLE"


@dataclass(frozen=True)
class Hdu:
    """One HDU located in the remote file."""

    name: str
    offset: int  # absolute offset of the header
    header: fits.Header
    header_bytes: bytes  # raw header blocks as stored
    data_offset: int
    data_size: int  # unpadded data size in bytes (including any heap)


@dataclass(frozen=True)
class Box:
    """Cutout box in 0-based pixel indices of the full image."""

    x0: int
    y0: int
    nx: int
    ny: int


def object_key(record: ImageRecord) -> str:
    """S3 key derived from the IRSA URI (documented mapping); validated, never user supplied."""
    if not record.uri.startswith(URI_PREFIX) or ".." in record.uri or "?" in record.uri:
        raise S3Unavailable(f"Unexpected IRSA URI for {record.obs_id}")
    key = record.uri.removeprefix(URI_PREFIX)
    if not S3_KEY_RE.match(key):
        raise S3Unavailable(f"Unexpected S3 key for {record.obs_id}")
    return key


def _padded(n: int) -> int:
    return (n + BLOCK - 1) // BLOCK * BLOCK


def _data_size(h: fits.Header) -> int:
    naxis = int(h.get("NAXIS", 0))
    if naxis == 0:
        return 0
    n = 1
    for k in range(1, naxis + 1):
        n *= int(h[f"NAXIS{k}"])
    return abs(int(h["BITPIX"])) // 8 * int(h.get("GCOUNT", 1)) * (n + int(h.get("PCOUNT", 0)))


def parse_header_at(buf: bytes, rel: int) -> tuple[fits.Header, bytes] | None:
    """Parse the header starting at buf[rel:]; None when its END card is not inside buf."""
    i = rel
    while i + 80 <= len(buf):
        if buf[i : i + 80] == _CARD_END:
            end = rel + _padded(i + 80 - rel)
            raw = buf[rel:end] if end <= len(buf) else buf[rel : i + 80]
            header = fits.Header.fromstring(buf[rel : i + 80].decode("latin-1"))
            return header, raw.ljust(_padded(len(raw)), b" ")
        i += 80
    return None


def find_hdu(buf: bytes, buf_offset: int, extname: str) -> Hdu | None:
    """Find the extension `extname` in a buffer read at absolute `buf_offset` (block aligned)."""
    start = (-buf_offset) % BLOCK
    for rel in range(start, len(buf) - 80, BLOCK):
        if not buf.startswith(b"XTENSION=", rel):
            continue
        parsed = parse_header_at(buf, rel)
        if parsed is None:
            return None
        header, raw = parsed
        if str(header.get("EXTNAME", "")).strip().upper() != extname:
            continue
        off = buf_offset + rel
        return Hdu(extname, off, header, raw, off + len(raw), _data_size(header))
    return None


def _box_axes(
    header: fits.Header, ra_deg: float, dec_deg: float, size_deg: float
) -> list[tuple[int, int, int]]:
    """Unclipped (first, last, axis length) per pixel axis of the IBE style box."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        wcs = WCS(header)
    cx, cy = (float(v) for v in wcs.all_world2pix([[ra_deg, dec_deg]], 0, quiet=True)[0])
    cd = wcs.wcs.get_pc() * wcs.wcs.cdelt[:, None]
    scales = np.sqrt((cd**2).sum(axis=0))  # degrees per pixel along each pixel axis
    nax = (int(header["NAXIS1"]), int(header["NAXIS2"]))
    out: list[tuple[int, int, int]] = []
    for c, scale, n_full in zip((cx, cy), scales, nax, strict=True):
        if not math.isfinite(c):
            raise S3Unavailable("Cutout center does not project onto the image")
        h = size_deg / float(scale) / 2.0
        first = math.ceil(c - h)
        out.append((first, first + math.floor(2.0 * h + 0.5) - 1, n_full))
    return out


def cutout_box(header: fits.Header, ra_deg: float, dec_deg: float, size_deg: float) -> Box:
    """Pixel box of an IBE style cutout centered on (ra, dec) with full width `size_deg`."""
    out: list[tuple[int, int]] = []
    for first, last, n_full in _box_axes(header, ra_deg, dec_deg, size_deg):
        first, last = max(first, 0), min(last, n_full - 1)
        if last < first:
            raise S3Unavailable("Cutout box does not intersect the image")
        out.append((first, last - first + 1))
    return Box(out[0][0], out[1][0], out[0][1], out[1][1])


def inner_box(header: fits.Header, ra_deg: float, dec_deg: float, size_deg: float) -> Box | None:
    """The box when it lies entirely inside the image of `header`, otherwise None (no clipping)."""
    axes = _box_axes(header, ra_deg, dec_deg, size_deg)
    if any(first < 0 or last > n_full - 1 or last < first for first, last, n_full in axes):
        return None
    (x0, x1, _), (y0, y1, _) = axes
    return Box(x0, y0, x1 - x0 + 1, y1 - y0 + 1)


def crop_cutout(raw: bytes, ra_deg: float, dec_deg: float, size_deg: float) -> bytes | None:
    """A smaller cutout cut from a cached larger one with the same center, or None.

    The box rule is the IBE rule applied to the cached cutout's own WCS (its CRPIX values are
    shifted by its origin, so the box is the one the full image would give). Data bytes are copied
    raw and every CRPIX is shifted again, exactly as for a remote cut, so pixel values equal a
    fresh cutout. Returns None when the box would need pixels outside the cached cutout (a cached
    cutout clipped at the image edge, for example) or the file layout is not the expected one.
    """
    parsed = parse_header_at(raw, 0)
    if parsed is None or not raw.startswith(b"SIMPLE"):
        return None
    primary, praw = parsed
    hdus: dict[str, Hdu] = {}
    offset = len(praw)
    while offset < len(raw):
        found = parse_header_at(raw, offset)
        if found is None:
            return None
        header, hraw = found
        name = str(header.get("EXTNAME", "")).strip().upper()
        size = _data_size(header)
        hdus[name] = Hdu(name, offset, header, hraw, offset + len(hraw), size)
        offset += len(hraw) + _padded(size)
    if any(n not in hdus for n in (*CUT_EXTENSIONS, "WCS-WAVE")):
        return None
    image = hdus["IMAGE"]
    if any(is_compressed(hdus[n].header) for n in CUT_EXTENSIONS):
        return None
    box = inner_box(image.header, round(ra_deg, 6), round(dec_deg, 6), round(size_deg, 5))
    if box is None:
        return None
    shape = image_shape(image.header)
    cuts: list[tuple[fits.Header, bytes]] = []
    for name in CUT_EXTENSIONS:
        hdu = hdus[name]
        if image_shape(hdu.header) != shape:
            return None
        row = int(hdu.header["NAXIS1"]) * abs(int(hdu.header["BITPIX"])) // 8
        first = hdu.data_offset + box.y0 * row
        block = raw[first : first + box.ny * row]
        if len(block) != box.ny * row:
            return None
        cuts.append((cutout_header(hdu.header, box), cut_rows(block, hdu, box)))
    wave = hdus["WCS-WAVE"]
    table_data = raw[wave.data_offset : wave.data_offset + wave.data_size]
    source = str(primary.get(SOURCE_KEYWORD, "irsa")).strip() or "irsa"
    return assemble(primary, cuts, wave, table_data, source=source)


def cutout_header(header: fits.Header, box: Box) -> fits.Header:
    """Header of the cut extension: the IBE changes (size and every CRPIX shifted), nothing else."""
    h = header.copy()
    h["NAXIS1"] = box.nx
    h["NAXIS2"] = box.ny
    for key in list(h.keys()):
        if key.startswith("CRPIX1"):
            h[key] = float(h[key]) - box.x0
        elif key.startswith("CRPIX2"):
            h[key] = float(h[key]) - box.y0
    for key in ("CHECKSUM", "DATASUM"):
        h.remove(key, ignore_missing=True)
    return h


def cut_rows(block: bytes, hdu: Hdu, box: Box) -> bytes:
    """Columns of the box from a block of full rows (raw big endian bytes, no conversion)."""
    bpp = abs(int(hdu.header["BITPIX"])) // 8
    width = int(hdu.header["NAXIS1"])
    rows = np.frombuffer(block, dtype=np.uint8).reshape(box.ny, width * bpp)
    return rows[:, box.x0 * bpp : (box.x0 + box.nx) * bpp].tobytes()


def is_compressed(header: fits.Header) -> bool:
    """True for a tile compressed image stored as a binary table (ZIMAGE = T)."""
    return str(header.get("XTENSION", "")).strip() == "BINTABLE" and bool(header.get("ZIMAGE"))


def image_shape(header: fits.Header) -> tuple[int, int]:
    """(NAXIS1, NAXIS2) of the image, read from ZNAXISn for a compressed extension."""
    prefix = "Z" if is_compressed(header) else ""
    if int(header.get(f"{prefix}NAXIS", 0)) != 2:
        raise S3Unavailable(f"{header.get('EXTNAME', '?')} is not a 2D image")
    return int(header[f"{prefix}NAXIS1"]), int(header[f"{prefix}NAXIS2"])


def descriptor_format(header: fits.Header) -> tuple[str, int]:
    """Descriptor dtype and heap element size of a row tiled compressed image.

    Only the layout measured in the bucket is supported (one compressed column, one tile per
    image row); anything else raises S3Unavailable so the image falls back to IRSA.
    """
    nx, _ = image_shape(header)
    if int(header.get("ZTILE1", nx)) != nx or int(header.get("ZTILE2", 1)) != 1:
        raise S3Unavailable("Compressed extension is not tiled by rows")
    if int(header.get("TFIELDS", 0)) != 1 or str(header.get("TTYPE1", "")).strip() != (
        "COMPRESSED_DATA"
    ):
        raise S3Unavailable("Compressed extension has an unsupported column layout")
    m = _TFORM_RE.match(str(header.get("TFORM1", "")).strip().upper())
    if m is None:
        raise S3Unavailable("Compressed extension has an unsupported TFORM1")
    dtype = ">i4" if m.group(1) == "P" else ">i8"
    if int(header["NAXIS1"]) != 2 * np.dtype(dtype).itemsize:
        raise S3Unavailable("Compressed extension has an unexpected row size")
    return dtype, _HEAP_ELEMENT_BYTES[m.group(2)]


def heap_span(descriptors: np.ndarray[Any, Any], element_bytes: int) -> tuple[int, int]:
    """[first, end) byte span of the heap that holds the tiles listed in `descriptors`."""
    if descriptors.size == 0 or int(descriptors[:, 0].min()) <= 0:
        raise S3Unavailable("Compressed extension has an empty tile")
    first = int(descriptors[:, 1].min())
    end = int((descriptors[:, 1] + descriptors[:, 0] * element_bytes).max())
    if end - first > MAX_HEAP_SPAN:
        raise S3Unavailable("Compressed rows are spread over too large a heap span")
    return first, end


def decompress_rows(
    header: fits.Header,
    descriptors: np.ndarray[Any, Any],
    descriptor_dtype: str,
    heap: bytes,
    heap_first: int,
    box: Box,
) -> tuple[fits.Header, bytes]:
    """Decompress the tiles (rows) of the box and return an uncompressed extension.

    A minimal compressed HDU holding only these rows is rebuilt (descriptors rebased onto the
    partial heap) and decoded by astropy with scaling disabled, so the stored integers are copied
    unchanged. The output header is the decompressed image header (as the IRSA cutout service
    returns it) with the cutout size and shifted CRPIX keywords.
    """
    h = header.copy()
    nrows = int(descriptors.shape[0])
    h["NAXIS2"] = nrows
    h["PCOUNT"] = len(heap)
    h["ZNAXIS2"] = nrows
    for key in ("THEAP", "CHECKSUM", "DATASUM", "ZHECKSUM", "ZDATASUM"):
        h.remove(key, ignore_missing=True)
    rebased = descriptors.astype(np.int64)
    rebased[:, 1] -= heap_first
    table = rebased.astype(descriptor_dtype).tobytes() + heap
    raw = (
        fits.PrimaryHDU().header.tostring().encode("latin-1")
        + h.tostring().encode("latin-1")
        + table
        + b"\0" * (_padded(len(table)) - len(table))
    )
    with fits.open(io.BytesIO(raw), do_not_scale_image_data=True) as hdul:
        hdu = hdul[1]
        image_header = hdu.header.copy()
        data = np.asarray(hdu.data)
    bitpix = int(image_header["BITPIX"])
    if bitpix not in _RAW_DTYPES or data.shape != (nrows, image_shape(header)[0]):
        raise S3Unavailable("Decompressed rows have an unexpected shape or type")
    cut = np.ascontiguousarray(data[:, box.x0 : box.x0 + box.nx]).astype(_RAW_DTYPES[bitpix])
    out = cutout_header(image_header, box)
    for key in ("ZHECKSUM", "ZDATASUM"):
        out.remove(key, ignore_missing=True)
    return out, cut.tobytes()


def assemble(
    primary: fits.Header,
    cuts: Sequence[tuple[fits.Header, bytes]],
    table: Hdu | None,
    table_data: bytes,
    *,
    source: str = "s3",
) -> bytes:
    """Serialise PRIMARY, the cut extensions and the WCS-WAVE table as raw FITS blocks."""
    prim = primary.copy()
    prim[SOURCE_KEYWORD] = (source, "Cutout service that produced this file")
    parts = [prim.tostring().encode("latin-1")]
    for header, data in cuts:
        parts.append(header.tostring().encode("latin-1"))
        parts.append(data + b"\0" * (_padded(len(data)) - len(data)))
    if table is not None:
        parts.append(table.header.tostring().encode("latin-1"))
        parts.append(table_data + b"\0" * (_padded(len(table_data)) - len(table_data)))
    out = b"".join(parts)
    # Structural check before the file enters the cache.
    with fits.open(io.BytesIO(out)) as hdul:
        names = [h.name for h in hdul]
        for header, _ in cuts:
            hdu = hdul[str(header["EXTNAME"]).strip()]
            if hdu.data is None or hdu.data.shape != (header["NAXIS2"], header["NAXIS1"]):
                raise S3Unavailable("Assembled cutout has an unexpected shape")
    if names[:1] != ["PRIMARY"]:
        raise S3Unavailable("Assembled cutout has no primary HDU")
    return out


class S3CutoutSource(SourceBase):
    """Cutout source backed by HTTP range requests to the SPHEREx S3 bucket."""

    namespace = "s3"

    def __init__(
        self,
        settings: Settings | None = None,
        client: EgressClient | None = None,
        *,
        irsa: IrsaClient,
        limiter: Limiter | None = None,
        max_attempts: int = 3,
        wait_initial_s: float = 0.5,
        wait_max_s: float = 8.0,
    ) -> None:
        super().__init__(
            settings,
            client,
            limiter=limiter,
            max_attempts=max_attempts,
            wait_initial_s=wait_initial_s,
            wait_max_s=wait_max_s,
        )
        self.irsa = irsa
        self._keys: dict[tuple[str, str], tuple[float, asyncio.Task[frozenset[str]]]] = {}

    # ------------------------------------------------------------------ keys
    async def _allowed_keys(self, collection: str, ra_deg: float, dec_deg: float) -> frozenset[str]:
        """Keys listed by SIA2 cloud_access for this collection and position (one call each)."""
        tag = (collection, f"{ra_deg:.5f},{dec_deg:.5f}")
        now = time.monotonic()
        entry = self._keys.get(tag)
        # A failed lookup is reused for KEY_RETRY_S so that every image falls back to IRSA at
        # once instead of repeating a failing SIA2 query; successes are cached by IrsaClient.
        if entry is None or (entry[1].done() and now - entry[0] > KEY_RETRY_S):

            async def load() -> frozenset[str]:
                return frozenset(await self.irsa.cloud_keys(ra_deg, dec_deg, collection))

            entry = (now, asyncio.create_task(load()))
            self._keys[tag] = entry
        return await asyncio.shield(entry[1])

    async def resolve_key(self, record: ImageRecord, ra_deg: float, dec_deg: float) -> str:
        key = object_key(record)
        allowed = await self._allowed_keys(record.collection, ra_deg, dec_deg)
        if key not in allowed:
            raise S3Unavailable(f"{record.obs_id} has no cloud_access entry for {S3_BUCKET}")
        return key

    # ------------------------------------------------------------------ reads
    async def _range(self, key: str, first: int, last: int | None) -> tuple[bytes, int]:
        """Bytes [first, last] (inclusive) or the last `-first` bytes when last is None.

        Returns the content and the absolute offset of its first byte.
        """
        spec = f"bytes={first}-{last}" if last is not None else f"bytes=-{-first}"
        response = await self.request(
            "GET", S3_BASE + key, headers={"Range": spec}, timeout_s=self.settings.http_timeout_s
        )
        if response.status_code != 206:
            raise S3Unavailable(f"S3 HTTP {response.status_code} for {key}")
        m = _CONTENT_RANGE_RE.match(response.headers.get("content-range", ""))
        if m is None:
            raise S3Unavailable("S3 response without a valid Content-Range")
        return response.content, int(m.group(1))

    async def _header_exact(self, key: str, offset: int, extname: str) -> Hdu:
        span = HEADER_WINDOW
        while span <= 64 * HEADER_WINDOW:
            buf, at = await self._range(key, offset, offset + span - 1)
            hdu = find_hdu(buf, at, extname)
            if hdu is not None and hdu.offset == offset:
                return hdu
            if parse_header_at(buf, 0) is not None:
                break  # a complete header that is not the one expected
            span *= 4
        raise S3Unavailable(f"{extname} header not found at {offset} in {key}")

    async def _head(self, key: str) -> tuple[fits.Header, Hdu]:
        """PRIMARY header and the IMAGE extension that follows it."""
        head, _ = await self._range(key, 0, HEAD_WINDOW - 1)
        parsed = parse_header_at(head, 0)
        if parsed is None or not head.startswith(b"SIMPLE"):
            raise S3Unavailable(f"Unexpected primary header in {key}")
        primary, praw = parsed
        if int(primary.get("NAXIS", 0)) != 0:
            raise S3Unavailable("Primary HDU with data is not supported")
        image = find_hdu(head, 0, "IMAGE")
        if image is None or image.offset != len(praw):
            image = await self._header_exact(key, len(praw), "IMAGE")
        if is_compressed(image.header):
            raise S3Unavailable("Compressed IMAGE extensions are not supported")
        return primary, image

    async def _wcs_wave(self, key: str) -> tuple[Hdu, bytes]:
        """The WCS-WAVE table, the last HDU of the file, from a short suffix read."""
        for window in TAIL_WINDOWS:
            tail, tail_at = await self._range(key, -window, None)
            wave = find_hdu(tail, tail_at, "WCS-WAVE")
            if wave is None:
                if tail_at == 0:
                    break  # the whole file was read
                continue
            rel = wave.data_offset - tail_at
            table_data = tail[rel : rel + wave.data_size]
            if len(table_data) != wave.data_size:
                raise S3Unavailable(f"WCS-WAVE is not the last HDU of {key}")
            return wave, table_data
        raise S3Unavailable(f"WCS-WAVE not found at the end of {key}")

    async def _cut(self, key: str, hdu: Hdu, box: Box) -> tuple[fits.Header, bytes]:
        """Header and raw data of the box for one image extension (plain or tile compressed)."""
        if is_compressed(hdu.header):
            dtype, element = descriptor_format(hdu.header)
            row = int(hdu.header["NAXIS1"])
            first = hdu.data_offset + box.y0 * row
            raw, _ = await self._range(key, first, first + box.ny * row - 1)
            if len(raw) != box.ny * row:
                raise S3Unavailable(f"Short descriptor read for {hdu.name} in {key}")
            descriptors = np.frombuffer(raw, dtype=dtype).reshape(box.ny, 2)
            lo, hi = heap_span(descriptors, element)
            heap_at = hdu.data_offset + int(
                hdu.header.get("THEAP", row * int(hdu.header["NAXIS2"]))
            )
            heap, _ = await self._range(key, heap_at + lo, heap_at + hi - 1)
            if len(heap) != hi - lo:
                raise S3Unavailable(f"Short heap read for {hdu.name} in {key}")
            return await asyncio.to_thread(
                decompress_rows, hdu.header, descriptors, dtype, heap, lo, box
            )
        row = int(hdu.header["NAXIS1"]) * abs(int(hdu.header["BITPIX"])) // 8
        first = hdu.data_offset + box.y0 * row
        block, _ = await self._range(key, first, first + box.ny * row - 1)
        if len(block) != box.ny * row:
            raise S3Unavailable(f"Short read for {hdu.name} in {key}")
        return cutout_header(hdu.header, box), cut_rows(block, hdu, box)

    # ------------------------------------------------------------------ cutouts
    def cutout_path(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        return self.irsa.cutout_path(record, ra_deg, dec_deg, size)

    async def download_cutout(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        """Return the cached cutout path, building it from S3 range reads when needed.

        Reads are pipelined: the rows of each extension are requested as soon as its header is
        located, while the next header (at the offset that follows) and the WCS-WAVE suffix are
        read concurrently. About 10 requests and 2.2 MB per 7 arcmin cutout.
        """
        path = self.cutout_path(record, ra_deg, dec_deg, size)
        if path.exists():
            return path
        if self.mode == DataMode.OFFLINE:
            raise OfflineMiss(f"Cutout for {record.obs_id} not cached")
        # Same rounding as the IRSA cutout URL (pipeline.query.cutout_url).
        ra, dec = round(ra_deg, 6), round(dec_deg, 6)
        size_deg = round(float(size.to_value(u.deg)), 5)
        key = await self.resolve_key(record, ra_deg, dec_deg)
        try:
            async with asyncio.TaskGroup() as tg:
                wave_task = tg.create_task(self._wcs_wave(key))
                primary, image = await self._head(key)
                shape = image_shape(image.header)
                box = await asyncio.to_thread(cutout_box, image.header, ra, dec, size_deg)
                cut_tasks = [tg.create_task(self._cut(key, image, box))]
                hdu = image
                for name in CUT_EXTENSIONS[1:]:
                    after = hdu.data_offset + _padded(hdu.data_size)
                    hdu = await self._header_exact(key, after, name)
                    if image_shape(hdu.header) != shape:
                        raise S3Unavailable(f"{name} shape differs from IMAGE")
                    cut_tasks.append(tg.create_task(self._cut(key, hdu, box)))
        except ExceptionGroup as group:
            raise _first_error(group) from None
        cuts = [t.result() for t in cut_tasks]
        wave, table_data = wave_task.result()
        data = await asyncio.to_thread(assemble, primary, cuts, wave, table_data)
        atomic_write_bytes(path, data)
        return path


def _first_error(group: BaseExceptionGroup[BaseException]) -> BaseException:
    """The first leaf exception of a task group failure (keeps error types for the router)."""
    first = group.exceptions[0]
    while isinstance(first, BaseExceptionGroup):
        first = first.exceptions[0]
    return first


def cutout_source_of(path: Path) -> str:
    """Return "s3" or "irsa" for a cached cutout (files cached before the keyword are IRSA)."""
    try:
        value: Any = fits.getval(path, SOURCE_KEYWORD, ext=0)
    except (KeyError, OSError):
        return "irsa"
    return "s3" if str(value).strip() == "s3" else "irsa"
