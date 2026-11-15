"""WISE and NEOWISE single-exposure (L1b) frames at IRSA: frame discovery and IBE cutouts (F-40).

Frame discovery, in order:

1. IRSA TAP on the frame metadata tables `allsky_4band_p1bm_frm`, `allsky_3band_p1bm_frm`,
   `allsky_2band_p1bm_frm` and `neowiser_p1bm_frm` (the only path that covers 2010 to 2011 and
   carries `qual_frame`). Frames with `qual_frame > 0` whose footprint (TAN part of the frame
   WCS from the table) contains the position are kept.
2. When TAP does not answer: the IRSA NEOWISE-R single-exposure source table published as
   Parquet in the open bucket `nasa-irsa-wise` (us-west-2, anonymous). Every frame that covers
   the position has detections next to it, so the distinct (scan_id, frame_num, mjd) of the
   detections within a small box give the NEOWISE-R frame list. It does not cover 2010 to 2011
   and has no frame quality value. Only the HEALPix order 5 partition of the position is read,
   with HTTP range requests through the egress checked client (footer, then the row groups whose
   ra and dec statistics overlap the box).

The source used is returned with the list and must be recorded in the manifest.

Cutouts: IBE (`irsa.ipac.caltech.edu/ibe/data/wise/...?center=..&size=..`) of the intensity
(`-int-1b.fits`), mask (`-msk-1b.fits.gz`) and uncertainty (`-unc-1b.fits.gz`) planes of a frame.
The three planes are always requested with the same center and size, which gives the same pixel
box; `fetch_frame_set` checks that the headers agree. IBE answers 503 under load (spike F-40-0),
so this client has its own low concurrency bound and a longer backoff than the SPHEREx client.
Cutouts are cached on disk, content addressed by (frame, band, plane, center, size); an index
per frame records the geometries already cached, so a cached set whose footprint covers the
requested circle is reused instead of downloading again (`register_local_cutout` adds files from
an earlier run, after reading the frame identity from their headers).
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import math
import time
import warnings
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.utils.exceptions import AstropyWarning
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales

from destello.core.cache import atomic_write_bytes
from destello.core.config import DataMode, Settings
from destello.core.egress import EgressClient
from destello.core.limiter import Limiter
from destello.pipeline.wise import FRAME_TABLES
from destello.sources.base import OfflineMiss, SourceBase, SourceError, opt_float

TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
IBE_BASE = "https://irsa.ipac.caltech.edu/ibe/data/wise/"
PARQUET_HOST = "nasa-irsa-wise.s3.us-west-2.amazonaws.com"
PARQUET_BASE = f"https://{PARQUET_HOST}/"
PARQUET_ROOT = (
    "wise/neowiser/catalogs/p1bs_psd/healpix_k5/{year}/neowiser-healpix_k5-{year}.parquet/"
    "healpix_k0={k0}/healpix_k5={k5}/part0.snappy.parquet"
)
# Partitions listed in the bucket on 2026-11-14 (prefix .../p1bs_psd/healpix_k5/).
PARQUET_YEARS = ("addendum",) + tuple(f"year{i}" for i in range(1, 12))
PARQUET_BOX_DEG = 0.05  # half side of the detection box around the position
PARQUET_READ_BLOCK = 2 * 1024 * 1024  # bytes fetched per range request (read ahead)
FRAME_SEARCH_DEG = 0.55  # frame centres this close can contain the position (47 arcmin frames)
FRAME_EDGE_MARGIN_PIX = 5.0
FRAME_TABLE_ORDER = tuple(FRAME_TABLES)
DISCOVERY_TTL_S = 30 * 24 * 3600  # the WISE archive is final: frame lists do not change
IBE_CONCURRENCY = 3  # lower than the spike (8): IBE throttles with 503
IBE_WAIT_INITIAL_S = 5.0
IBE_WAIT_MAX_S = 120.0
IBE_ATTEMPTS = 8
TAP_ATTEMPTS = 2  # a fallback exists, so TAP is not retried for long

Plane = Literal["int", "msk", "unc"]
PLANES: tuple[Plane, ...] = ("int", "msk", "unc")
FrameSource = Literal["irsa_tap", "neowiser_parquet"]


@dataclass(frozen=True)
class WiseFrame:
    """One single-exposure frame of one band."""

    table: str  # key of pipeline.wise.FRAME_TABLES
    scan_id: str
    frame_num: int
    band: int
    mjd_obs: float
    qual_frame: int | None = None  # None when listed from the Parquet source table

    @property
    def scangrp(self) -> str:
        return self.scan_id[-2:]

    @property
    def frame_id(self) -> str:
        return f"{self.scan_id}{self.frame_num:03d}"

    def file_url(self, plane: Plane) -> str:
        """Archive URL of the full frame plane (no cutout parameters)."""
        path = FRAME_TABLES[self.table].ibe_path
        ext = ".fits" if plane == "int" else ".fits.gz"
        return (
            f"{IBE_BASE}{path}/{self.scangrp}/{self.scan_id}/{self.frame_num:03d}/"
            f"{self.frame_id}-w{self.band}-{plane}-1b{ext}"
        )


@dataclass(frozen=True)
class FrameList:
    frames: list[WiseFrame]
    source: FrameSource
    detail: str  # tables or partitions read, and what failed


@dataclass(frozen=True)
class CutoutGeometry:
    """Center (ICRS degrees) and size (arcsec) of a cutout request, as sent to IBE."""

    ra_deg: float
    dec_deg: float
    size_arcsec: float

    def query(self) -> str:
        return f"center={self.ra_deg:.6f},{self.dec_deg:.6f}&size={self.size_arcsec:.0f}arcsec"

    def key(self) -> str:
        return f"{self.ra_deg:.6f}_{self.dec_deg:.6f}_{self.size_arcsec:.0f}"


@dataclass(frozen=True)
class FrameSet:
    """Cached paths of the three planes of one frame cutout, with their geometry and URLs."""

    frame: WiseFrame
    geometry: CutoutGeometry
    paths: dict[str, Path]
    urls: dict[str, str]


def _sanitize_scan(scan_id: str) -> str:
    s = scan_id.strip()
    if not (5 <= len(s) <= 8 and s.isalnum()):
        raise SourceError(f"Unexpected WISE scan id {scan_id!r}")
    return s


def frame_adql(table: str, ra_deg: float, dec_deg: float, band: int) -> str:
    if table not in FRAME_TABLES or band not in (1, 2, 3, 4):
        raise ValueError("Invalid WISE frame table or band")
    return (
        "SELECT scan_id, frame_num, band, mjd_obs, qual_frame, crval1, crval2, crpix1, crpix2, "
        f"cd1_1, cd1_2, cd2_1, cd2_2, naxis1, naxis2 FROM {table} WHERE band = {int(band)} AND "
        f"CONTAINS(POINT('ICRS', crval1, crval2), CIRCLE('ICRS', {ra_deg:.7f}, {dec_deg:.7f}, "
        f"{FRAME_SEARCH_DEG})) = 1"
    )


def frame_contains(row: dict[str, str], ra_deg: float, dec_deg: float) -> bool:
    """True when the position falls inside the frame (TAN part of the frame WCS from the table)."""
    vals = {k: opt_float(row.get(k)) for k in (
        "crval1", "crval2", "crpix1", "crpix2", "cd1_1", "cd1_2", "cd2_1", "cd2_2", "naxis1",
        "naxis2")}  # fmt: skip
    if any(v is None for v in vals.values()):
        return False
    v = {k: float(x) for k, x in vals.items() if x is not None}
    w = WCS(naxis=2)
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.crval = [v["crval1"], v["crval2"]]
    w.wcs.crpix = [v["crpix1"], v["crpix2"]]
    w.wcs.cd = [[v["cd1_1"], v["cd1_2"]], [v["cd2_1"], v["cd2_2"]]]
    x, y = w.all_world2pix(ra_deg, dec_deg, 1)
    m = FRAME_EDGE_MARGIN_PIX
    return bool(m <= float(x) <= v["naxis1"] - m and m <= float(y) <= v["naxis2"] - m)


def parse_tap_frames(
    table: str, rows: Sequence[dict[str, str]], ra_deg: float, dec_deg: float, band: int
) -> list[WiseFrame]:
    """Frames with qual_frame > 0 that contain the position."""
    out: list[WiseFrame] = []
    for r in rows:
        q = opt_float(r.get("qual_frame"))
        mjd = opt_float(r.get("mjd_obs"))
        if q is None or q <= 0 or mjd is None or not frame_contains(r, ra_deg, dec_deg):
            continue
        out.append(WiseFrame(table, _sanitize_scan(r["scan_id"]), int(float(r["frame_num"])),
                             band, mjd, int(q)))  # fmt: skip
    return out


def healpix_k5(ra_deg: float, dec_deg: float) -> int:
    """HEALPix order 5 (nside 32) nested index of a position, the partition key of the table."""
    from astropy_healpix import HEALPix

    hp = HEALPix(nside=32, order="nested")
    return int(hp.lonlat_to_healpix(ra_deg * u.deg, dec_deg * u.deg))


def parquet_key(year: str, k5: int) -> str:
    if year not in PARQUET_YEARS:
        raise ValueError("Unknown partition")
    return PARQUET_ROOT.format(year=year, k0=k5 // 1024, k5=k5)


class RangeFile(io.RawIOBase):
    """Read-only file object over HTTP range reads, with a read-ahead block cache.

    `fetch(start, end_inclusive)` returns the bytes of the range. Used by pyarrow from a worker
    thread; it never opens a connection itself.
    """

    def __init__(self, size: int, fetch: Callable[[int, int], bytes], block: int) -> None:
        super().__init__()
        self._size = size
        self._fetch = fetch
        self._block = block
        self._pos = 0
        self._cache: dict[int, bytes] = {}
        self.requests = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self._pos, 2: self._size}[whence]
        self._pos = max(0, min(base + offset, self._size))
        return self._pos

    def _block_bytes(self, i: int) -> bytes:
        if i not in self._cache:
            start = i * self._block
            end = min(start + self._block, self._size) - 1
            self._cache[i] = self._fetch(start, end)
            self.requests += 1
        return self._cache[i]

    def readinto(self, buffer: Any) -> int:
        view = memoryview(buffer).cast("B")
        n = min(len(view), self._size - self._pos)
        got = 0
        while got < n:
            i, off = divmod(self._pos + got, self._block)
            chunk = self._block_bytes(i)[off : off + n - got]
            if not chunk:
                break
            view[got : got + len(chunk)] = chunk
            got += len(chunk)
        self._pos += got
        return got


def parquet_frames(
    fobj: io.RawIOBase, ra_deg: float, dec_deg: float, band: int, box_deg: float = PARQUET_BOX_DEG
) -> list[tuple[str, int, float]]:
    """Distinct (scan_id, frame_num, mjd) of the detections inside a box around the position.

    Reads only the row groups whose ra/dec statistics overlap the box. The source table lists
    detections of both bands per frame set, so `band` does not filter rows; the L1b frame set
    holds both band images (Explanatory Supplement), and the caller asks for the band it needs.
    """
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(fobj)
    names = pf.schema_arrow.names
    cols = [names.index(c) for c in ("ra", "dec")]
    cosd = max(math.cos(math.radians(dec_deg)), 1e-6)
    ra_lo, ra_hi = ra_deg - box_deg / cosd, ra_deg + box_deg / cosd
    de_lo, de_hi = dec_deg - box_deg, dec_deg + box_deg
    groups: list[int] = []
    for g in range(pf.metadata.num_row_groups):
        rg = pf.metadata.row_group(g)
        sra, sde = rg.column(cols[0]).statistics, rg.column(cols[1]).statistics
        if sra is None or sde is None or not (sra.has_min_max and sde.has_min_max):
            groups.append(g)
            continue
        if sra.max < ra_lo or sra.min > ra_hi or sde.max < de_lo or sde.min > de_hi:
            continue
        groups.append(g)
    out: dict[tuple[str, int], float] = {}
    for g in groups:
        t = pf.read_row_group(g, columns=["scan_id", "frame_num", "mjd", "ra", "dec"])
        ra = np.asarray(t["ra"].to_numpy(zero_copy_only=False), dtype=np.float64)
        de = np.asarray(t["dec"].to_numpy(zero_copy_only=False), dtype=np.float64)
        sel = np.nonzero((ra >= ra_lo) & (ra <= ra_hi) & (de >= de_lo) & (de <= de_hi))[0]
        if sel.size == 0:
            continue
        scans = t["scan_id"].to_pylist()
        frames = t["frame_num"].to_pylist()
        mjds = t["mjd"].to_pylist()
        for i in sel:
            out.setdefault((str(scans[i]), int(frames[i])), float(mjds[i]))
    return sorted((s, f, m) for (s, f), m in out.items())


def _geometry_covers(
    header: fits.Header, ra_deg: float, dec_deg: float, radius_arcsec: float
) -> bool:
    """True when the cutout in `header` contains the circle of `radius_arcsec` around (ra, dec)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", AstropyWarning)
        w = WCS(header)
        x, y = w.all_world2pix(ra_deg, dec_deg, 0)
        scale = float(np.mean(np.abs(proj_plane_pixel_scales(w.celestial))) * 3600.0)
    if not (math.isfinite(float(x)) and math.isfinite(float(y))):
        return False
    r = radius_arcsec / scale
    nx, ny = int(header["NAXIS1"]), int(header["NAXIS2"])
    return bool(r - 0.5 <= float(x) <= nx - 0.5 - r and r - 0.5 <= float(y) <= ny - 0.5 - r)


class WiseClient(SourceBase):
    """Frame discovery and cutouts for WISE/NEOWISE L1b frames."""

    namespace = "wise"

    def __init__(
        self,
        settings: Settings | None = None,
        client: EgressClient | None = None,
        *,
        concurrency: int = IBE_CONCURRENCY,
        limiter: Limiter | None = None,
    ) -> None:
        # `limiter`: pass the shared IRSA limiter in production so these requests count against
        # the global IRSA bound; the local semaphore of `concurrency` applies in any case.
        super().__init__(
            settings, client, semaphore=asyncio.Semaphore(concurrency), limiter=limiter,
            max_attempts=IBE_ATTEMPTS, wait_initial_s=IBE_WAIT_INITIAL_S,
            wait_max_s=IBE_WAIT_MAX_S,
        )  # fmt: skip
        self.counts: dict[str, int] = {"cached": 0, "reused": 0, "downloaded": 0, "failed": 0}

    # ------------------------------------------------------------------ paths
    @property
    def cutouts_root(self) -> Path:
        return self.settings.data_dir / "wise" / "cutouts"

    def _plane_path(self, frame: WiseFrame, plane: Plane, geom: CutoutGeometry) -> Path:
        key = f"{frame.table}:{frame.frame_id}:w{frame.band}:{plane}:{geom.key()}"
        digest = hashlib.sha256(key.encode()).hexdigest()[:24]
        return self.cutouts_root / digest[:2] / f"{digest}.fits"

    def _index_path(self, frame: WiseFrame) -> Path:
        return self.cutouts_root / "index" / f"{frame.frame_id}-w{frame.band}.json"

    def _index(self, frame: WiseFrame) -> list[dict[str, float]]:
        try:
            data = json.loads(self._index_path(frame).read_text("utf-8"))
        except (OSError, ValueError):
            return []
        return [g for g in data if isinstance(g, dict)]

    def _note(self, frame: WiseFrame, geom: CutoutGeometry) -> None:
        geoms = self._index(frame)
        if asdict(geom) not in geoms:
            geoms.append(asdict(geom))
            atomic_write_bytes(self._index_path(frame), json.dumps(geoms).encode("utf-8"))

    def cutout_url(self, frame: WiseFrame, plane: Plane, geom: CutoutGeometry) -> str:
        return f"{frame.file_url(plane)}?{geom.query()}&gzip=false"

    # ------------------------------------------------------------------ discovery
    async def frames_tap(self, ra_deg: float, dec_deg: float, band: int) -> list[WiseFrame]:
        """Frames from the four IRSA TAP frame tables (raises SourceError when TAP fails)."""
        out: list[WiseFrame] = []
        for table in FRAME_TABLE_ORDER:
            adql = frame_adql(table, ra_deg, dec_deg, band)

            async def fetch(adql: str = adql) -> list[dict[str, str]]:
                return await self.tap_rows(TAP_URL, adql, attempts=TAP_ATTEMPTS)

            rows = await self.cached("tap:" + adql, fetch, ttl_s=DISCOVERY_TTL_S)
            out.extend(parse_tap_frames(table, rows, ra_deg, dec_deg, band))
        return sorted(out, key=lambda f: f.mjd_obs)

    async def _content_length(self, url: str) -> int | None:
        resp = await self.request("HEAD", url, timeout_s=60.0)
        if resp.status_code in (403, 404):
            return None
        if resp.status_code != 200:
            raise SourceError(f"Parquet HEAD HTTP {resp.status_code}")
        return int(resp.headers["content-length"])

    async def _partition_frames(
        self, year: str, k5: int, ra_deg: float, dec_deg: float, band: int
    ) -> list[list[Any]]:
        url = PARQUET_BASE + parquet_key(year, k5)
        size = await self._content_length(url)
        if size is None:
            return []
        loop = asyncio.get_running_loop()

        def fetch(start: int, end: int) -> bytes:
            coro = self.request("GET", url, headers={"Range": f"bytes={start}-{end}"},
                                timeout_s=120.0)  # fmt: skip
            resp = asyncio.run_coroutine_threadsafe(coro, loop).result()
            if resp.status_code not in (200, 206):
                raise SourceError(f"Parquet range HTTP {resp.status_code}")
            body = resp.content
            if resp.status_code == 200:
                body = body[start : end + 1]
            return body

        rf = RangeFile(size, fetch, PARQUET_READ_BLOCK)
        rows = await asyncio.to_thread(parquet_frames, rf, ra_deg, dec_deg, band)
        self.log.info("parquet_partition", year=year, k5=k5, frames=len(rows), requests=rf.requests)
        return [[s, f, m] for s, f, m in rows]

    async def frames_parquet(self, ra_deg: float, dec_deg: float, band: int) -> list[WiseFrame]:
        """NEOWISE-R frames from the Parquet source table (2013 December to 2024)."""
        k5 = healpix_k5(ra_deg, dec_deg)
        out: dict[str, WiseFrame] = {}
        for year in PARQUET_YEARS:
            key = f"parquet:{year}:{k5}:{ra_deg:.5f}:{dec_deg:.5f}:{PARQUET_BOX_DEG}"

            async def fetch(year: str = year) -> list[list[Any]]:
                return await self._partition_frames(year, k5, ra_deg, dec_deg, band)

            rows = await self.cached(key, fetch, ttl_s=DISCOVERY_TTL_S)
            for s, f, m in rows:
                fr = WiseFrame("neowiser_p1bm_frm", _sanitize_scan(str(s)), int(f), band, float(m))
                out.setdefault(fr.frame_id, fr)
        return sorted(out.values(), key=lambda f: f.mjd_obs)

    async def discover(self, ra_deg: float, dec_deg: float, band: int) -> FrameList:
        """TAP first; the Parquet source table when TAP fails. The source used is returned."""
        try:
            frames = await self.frames_tap(ra_deg, dec_deg, band)
            return FrameList(frames, "irsa_tap", ", ".join(FRAME_TABLE_ORDER))
        except SourceError as exc:  # includes OfflineMiss
            self.log.warning("wise_tap_failed", error=str(exc)[:200])
            tap_error = str(exc)[:200]
        frames = await self.frames_parquet(ra_deg, dec_deg, band)
        detail = (
            "NEOWISE-R single-exposure source table (Parquet, nasa-irsa-wise); "
            f"IRSA TAP failed: {tap_error}"
        )
        return FrameList(frames, "neowiser_parquet", detail)

    # ------------------------------------------------------------------ cutouts
    def register_local_cutout(self, path: Path, geom: CutoutGeometry, table: str) -> WiseFrame:
        """Add an intensity cutout from an earlier run to the cache (its frame read from header).

        The header must carry SCAN, FRNUM, BAND and MJD_OBS (L1b keywords). Only the intensity
        plane is registered; the other planes are fetched with the same geometry on demand.
        """
        raw = path.read_bytes()
        if not raw.startswith(b"SIMPLE"):
            raise SourceError(f"{path} is not a FITS file")
        hdr = fits.getheader(io.BytesIO(raw))
        frame = WiseFrame(table, _sanitize_scan(str(hdr["SCAN"])), int(hdr["FRNUM"]),
                          int(hdr["BAND"]), float(hdr["MJD_OBS"]))  # fmt: skip
        dest = self._plane_path(frame, "int", geom)
        if not dest.exists():
            atomic_write_bytes(dest, raw)
        self._note(frame, geom)
        return frame

    def _reusable(
        self, frame: WiseFrame, ra: float, dec: float, radius: float
    ) -> CutoutGeometry | None:
        for g in self._index(frame):
            geom = CutoutGeometry(float(g["ra_deg"]), float(g["dec_deg"]), float(g["size_arcsec"]))
            p = self._plane_path(frame, "int", geom)
            try:
                hdr = fits.getheader(p)
            except (OSError, ValueError):
                continue
            if _geometry_covers(hdr, ra, dec, radius):
                return geom
        return None

    async def _plane(self, frame: WiseFrame, plane: Plane, geom: CutoutGeometry) -> Path:
        path = self._plane_path(frame, plane, geom)
        if path.exists():
            return path
        if self.mode == DataMode.OFFLINE:
            raise OfflineMiss(f"WISE cutout {frame.frame_id} {plane} not cached")
        url = self.cutout_url(frame, plane, geom)
        resp = await self.request("GET", url, timeout_s=self.settings.cutout_timeout_s)
        if resp.status_code != 200 or not resp.content.startswith(b"SIMPLE"):
            raise SourceError(f"WISE cutout HTTP {resp.status_code} for {frame.frame_id} {plane}")
        atomic_write_bytes(path, resp.content)
        self.counts["downloaded"] += 1
        return path

    async def fetch_frame_set(
        self, frame: WiseFrame, ra_deg: float, dec_deg: float, size_arcsec: float,
        reuse_radius_arcsec: float,
    ) -> FrameSet:  # fmt: skip
        """The three planes of one frame around (ra, dec), from the cache when possible.

        A cached geometry is reused when its intensity cutout covers the circle of
        `reuse_radius_arcsec` around the position; otherwise the planes are requested with
        center (ra, dec) and side `size_arcsec`. The planes must share shape and CRPIX.
        """
        geom = self._reusable(frame, ra_deg, dec_deg, reuse_radius_arcsec)
        if geom is not None:
            self.counts["reused"] += 1
        else:
            geom = CutoutGeometry(round(ra_deg, 6), round(dec_deg, 6), round(size_arcsec))
        paths: dict[str, Path] = {}
        for plane in PLANES:
            paths[plane] = await self._plane(frame, plane, geom)
        self._note(frame, geom)
        heads = [fits.getheader(paths[p]) for p in PLANES]
        sig = {(h["NAXIS1"], h["NAXIS2"], h.get("CRPIX1"), h.get("CRPIX2")) for h in heads}
        if len(sig) != 1:
            raise SourceError(f"WISE planes of {frame.frame_id} differ in geometry: {sig}")
        urls: dict[str, str] = {p: self.cutout_url(frame, p, geom) for p in PLANES}
        return FrameSet(frame, geom, paths, urls)

    async def fetch_frame_sets(
        self, frames: Sequence[WiseFrame], ra_deg: float, dec_deg: float, size_arcsec: float,
        reuse_radius_arcsec: float,
    ) -> list[FrameSet | None]:  # fmt: skip
        """All frame sets, concurrently within the client bound; a failed frame gives None."""
        t0 = time.perf_counter()

        async def one(fr: WiseFrame) -> FrameSet | None:
            try:
                return await self.fetch_frame_set(
                    fr, ra_deg, dec_deg, size_arcsec, reuse_radius_arcsec
                )
            except OfflineMiss:
                raise
            except (SourceError, OSError, KeyError, ValueError) as exc:
                self.counts["failed"] += 1
                self.log.warning("wise_cutout_failed", frame=fr.frame_id, error=str(exc)[:200])
                return None

        out = await asyncio.gather(*(one(f) for f in frames))
        self.log.info("wise_cutouts", n=len(frames), seconds=round(time.perf_counter() - t0, 1),
                      **self.counts)  # fmt: skip
        return list(out)
