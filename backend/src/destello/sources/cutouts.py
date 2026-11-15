"""Pluggable cutout source.

The build job only needs "give me the cached cutout file for this image, center and size". Two
implementations exist:
- `IrsaClient` (IRSA IBE cutout service on premises; always returns every extension including the
  PSF cube, about 96 percent of each response; global limit 8 concurrent requests);
- `S3CutoutSource` (AWS open data copy, bucket nasa-irsa-spherex; range reads of only the needed
  extensions and rows; global limit DESTELLO_S3_CONCURRENCY, default 16).
`CutoutRouter` first reuses the cache: an exact cutout, or a crop of a cached larger cutout of the
same image and center (field of view changes download nothing; the crop uses the same box rule and
a raw data copy, so it equals a fresh S3 cutout byte for byte, and keeps the parent's DSTLSRC).
Otherwise it tries S3 and falls back to IRSA per image on any S3 error.

Contract for any implementation:
- returns the path of a FITS file under the cutouts cache that holds at least the extensions
  IMAGE, FLAGS, VARIANCE, ZODI and WCS-WAVE with the IRSA headers (WCS, MJD-*, MSK*, BUNIT), and
  the primary keyword DSTLSRC naming the service that produced it;
- the file is content addressed by (obs_id, rounded center, size) through `cutout_path`;
- raises SourceError (or a subclass) on failure; never fabricates data;
- bounds its own outbound concurrency (core.limiter).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Protocol, runtime_checkable

import astropy.units as u

from destello.core.cache import atomic_write_bytes
from destello.core.ids import cutout_center_key
from destello.core.logging import get_logger
from destello.pipeline.query import ImageRecord
from destello.sources.base import OfflineMiss
from destello.sources.s3 import crop_cutout


@runtime_checkable
class CutoutSource(Protocol):
    def cutout_path(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path: ...

    async def download_cutout(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path: ...


class CutoutRouter:
    """Primary source with an automatic per image fallback (S3 first, then IRSA)."""

    def __init__(self, fallback: CutoutSource, primary: CutoutSource | None = None) -> None:
        self.fallback = fallback
        self.primary = primary
        self.counts: dict[str, int] = {"cached": 0, "cropped": 0, "primary": 0, "fallback": 0}
        self.log = get_logger(source="cutouts")

    def cutout_path(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        return self.fallback.cutout_path(record, ra_deg, dec_deg, size)

    def _sizes_dir(self, path: Path, record: ImageRecord, ra_deg: float, dec_deg: float) -> Path:
        # Cutouts live in <cutouts_dir>/<xx>/<key>.fits; the size index sits next to that tree.
        return path.parent.parent / "sizes" / cutout_center_key(record.obs_id, ra_deg, dec_deg)

    def _note_size(
        self, path: Path, record: ImageRecord, ra: float, dec: float, size_arcmin: float
    ) -> None:
        """Record that a cutout of this size exists for this image and center (empty marker)."""
        try:
            d = self._sizes_dir(path, record, ra, dec)
            d.mkdir(parents=True, exist_ok=True)
            (d / f"{size_arcmin:.3f}").touch(exist_ok=True)
        except OSError:
            pass  # the index only speeds up later builds

    async def _from_larger(
        self, path: Path, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path | None:
        """Cut the cutout from a cached larger one with the same image and center (no download).

        Pixel values equal a fresh cutout (raw byte copy with the same box rule); the file keeps
        the DSTLSRC of the service that produced the larger cutout, so provenance stays exact.
        """
        want = float(size.to_value(u.arcmin))
        d = self._sizes_dir(path, record, ra_deg, dec_deg)
        try:
            sizes = sorted(float(p.name) for p in d.iterdir() if float(p.name) > want + 1e-6)
        except (OSError, ValueError):
            return None
        for s in sizes:
            src = self.cutout_path(record, ra_deg, dec_deg, s * u.arcmin)
            try:
                raw = await asyncio.to_thread(src.read_bytes)
            except OSError:
                continue  # evicted since it was indexed
            size_deg = float(size.to_value(u.deg))
            try:
                data = await asyncio.to_thread(crop_cutout, raw, ra_deg, dec_deg, size_deg)
            except Exception as exc:  # a malformed cached file: fall through to a download
                self.log.warning("cutout_crop_failed", obs_id=record.obs_id, error=str(exc)[:200])
                continue
            if data is None:
                continue
            atomic_write_bytes(path, data)
            return path
        return None

    async def download_cutout(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        path = self.cutout_path(record, ra_deg, dec_deg, size)
        size_arcmin = float(size.to_value(u.arcmin))
        if path.exists():
            self.counts["cached"] += 1
            self._note_size(path, record, ra_deg, dec_deg, size_arcmin)
            return path
        if await self._from_larger(path, record, ra_deg, dec_deg, size) is not None:
            self.counts["cropped"] += 1
            self._note_size(path, record, ra_deg, dec_deg, size_arcmin)
            return path
        if self.primary is not None:
            try:
                out = await self.primary.download_cutout(record, ra_deg, dec_deg, size)
                self.counts["primary"] += 1
                self._note_size(out, record, ra_deg, dec_deg, size_arcmin)
                return out
            except OfflineMiss:
                raise
            except Exception as exc:  # any S3 problem (HTTP, egress, parse) falls back to IRSA
                self.log.warning("cutout_fallback", obs_id=record.obs_id, error=str(exc)[:200])
        out = await self.fallback.download_cutout(record, ra_deg, dec_deg, size)
        self.counts["fallback"] += 1
        self._note_size(out, record, ra_deg, dec_deg, size_arcmin)
        return out
