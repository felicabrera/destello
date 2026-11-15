"""NASA/IPAC IRSA client: TAP discovery, SIA2, cutouts and solid angle pixel maps.

Findings from the live spike are recorded in backend/data-notes.md. In short: a cutout costs
10 to 20 s and about 5 MB (the PSF cube is about 96 percent of it and cannot be excluded server
side; IBE cutouts only take center and size), IRSA answers 503 "Server busy" under load, and the
extension names are IMAGE, FLAGS, VARIANCE, ZODI, PSF (EPSF in newer files) and WCS-WAVE. Cutouts
are requested with gzip=true (about 15 percent fewer bytes, about 17 percent faster) and cached
without the PSF extension (about 25x smaller).
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re
import time
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
import structlog
from astropy.io import fits

from destello.core.cache import atomic_write_bytes
from destello.core.config import SAPM_PATHS, DataMode
from destello.core.ids import cutout_key
from destello.pipeline.query import (
    IRSA_BASE,
    SIA_POINT_RADIUS_DEG,
    ImageRecord,
    cutout_url,
    discovery_adql,
    latest_versions,
    parse_rows,
    sia_rows_as_tap,
)
from destello.sources.base import OfflineMiss, SourceBase, SourceError

log = structlog.get_logger(__name__)

# Discovery skips TAP for TAP_SKIP_S seconds after a failure that took longer than TAP_SLOW_S.
TAP_SKIP_S = 600.0
TAP_SLOW_S = 60.0

TAP_URL = IRSA_BASE + "TAP/sync"
SIA_URL = IRSA_BASE + "SIA"
AVAILABILITY_URL = IRSA_BASE + "TAP/availability"
RESOLVE_URL = "https://irsa.ipac.caltech.edu/irsaviewer/sticky/CmdSrv"
RESOLVE_TTL_S = 3600  # fallback answers are short lived so a richer SIMBAD answer replaces them
DISCOVERY_TTL_S = 6 * 3600  # docs/04 section 6: SIA2 result lifetime

# Extensions retained in cached cutouts. PSF is dropped to save space (see module docstring).
KEEP_EXTENSIONS = ("IMAGE", "FLAGS", "VARIANCE", "ZODI", "WCS-WAVE")
# Primary header keyword that records which service produced a cached cutout ("irsa" or "s3").
SOURCE_KEYWORD = "DSTLSRC"
# The only bucket the S3 cutout source may read (docs/10 section 3.3).
S3_BUCKET = "nasa-irsa-spherex"
S3_KEY_RE = re.compile(r"^(?:qr|dr)[0-9]+(?:_deep)?/level2/[A-Za-z0-9_./-]+\.fits$")
_CLOUD_ACCESS_RE = re.compile(r'\{"aws":\s*\{[^{}]*\}\s*\}')


@dataclass(frozen=True)
class ReleaseInfo:
    collection: str
    n_planes: int
    latest_pub_date: str | None
    t_max_mjd: float | None


@dataclass(frozen=True)
class ResolvedName:
    """A position returned by the IRSA name resolver (ICRS, J2000, degrees)."""

    name: str
    ra_deg: float
    dec_deg: float
    resolver: str  # upstream service that answered, for example "ned" or "simbad"


class _Unresolved(Exception):
    """The resolver answered but does not know the name (never cached)."""


def parse_resolve_body(text: str) -> ResolvedName | None:
    """Parse the CmdResolveName JSON body. None when unresolved or not an EQ_J2000 position.

    Success: [{"data": "ra;dec;EQ_J2000;name;resolver;type", "success": "true"}].
    Failure: [{"success": "false", "error": "..."}].
    """
    try:
        body = json.loads(text)
    except ValueError as exc:
        raise SourceError("IRSA resolver returned invalid JSON") from exc
    if not isinstance(body, list) or not body or not isinstance(body[0], dict):
        raise SourceError("IRSA resolver returned an unexpected body")
    item = body[0]
    if str(item.get("success")).lower() != "true":
        return None
    parts = str(item.get("data", "")).split(";")
    if len(parts) < 5 or parts[2].strip() != "EQ_J2000":
        return None
    try:
        ra = float(parts[0])
        dec = float(parts[1])
    except ValueError:
        return None
    if not (0.0 <= ra < 360.0 and -90.0 <= dec <= 90.0):
        return None
    return ResolvedName(
        name=parts[3].strip(), ra_deg=ra, dec_deg=dec, resolver=parts[4].strip().lower()
    )


class IrsaClient(SourceBase):
    namespace = "irsa"
    # Monotonic time before which discovery goes straight to SIA2 (set when TAP fails).
    _tap_skip_until: float = 0.0

    # ------------------------------------------------------------------ name resolution
    async def resolve_name(self, name: str) -> ResolvedName | None:
        """Fallback name resolution through the IRSA viewer service (NED, then SIMBAD).

        The name travels only as a query parameter value. Returns None when the service does not
        know the name or answers in a frame other than EQ_J2000. Successful answers are cached.
        """

        async def fetch() -> dict[str, Any]:
            response = await self.request(
                "GET",
                RESOLVE_URL,
                params={"cmd": "CmdResolveName", "resolver": "nedthensimbad", "objName": name},
                timeout_s=8.0,
            )
            if response.status_code != 200:
                raise SourceError(f"IRSA resolver HTTP {response.status_code}")
            found = parse_resolve_body(response.text)
            if found is None:
                raise _Unresolved
            return asdict(found)

        try:
            row = await self.cached("resolve:" + name.lower(), fetch, ttl_s=RESOLVE_TTL_S)
        except _Unresolved:
            return None
        return ResolvedName(**row)

    # ------------------------------------------------------------------ discovery
    async def query_images(
        self,
        ra_deg: float,
        dec_deg: float,
        collections: Sequence[str],
        detectors: Iterable[int] | None = None,
    ) -> list[ImageRecord]:
        """All detector images in the given collections whose footprint contains the position."""
        adql = discovery_adql(ra_deg, dec_deg, collections, detectors)

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(TAP_URL, adql, maxrec=20000, attempts=2)

        asked = time.monotonic()
        try:
            if asked < self._tap_skip_until:
                raise SourceError("IRSA TAP failed recently; not asked again yet")
            rows = await self.cached("tap:" + adql, fetch, ttl_s=DISCOVERY_TTL_S)
        except OfflineMiss:
            raise
        except SourceError as exc:
            # IRSA TAP can be down while SIA2 answers (2026-11-14): same images, other service.
            # A TAP that hung (queries queued until the timeout) is not asked again for a while, so
            # a batch does not wait on every query. A quick refusal (503) is asked again next time.
            if time.monotonic() - asked > TAP_SLOW_S:
                IrsaClient._tap_skip_until = time.monotonic() + TAP_SKIP_S  # process wide
            log.warning("tap_discovery_failed_using_sia", error=str(exc))
            wanted = None if detectors is None else {int(d) for d in detectors}

            async def fetch_sia() -> list[dict[str, str]]:
                found: list[dict[str, str]] = []
                for collection in collections:
                    found += sia_rows_as_tap(
                        await self.sia2_query(
                            ra_deg, dec_deg, SIA_POINT_RADIUS_DEG * u.deg, collection
                        )
                    )
                return found

            key = f"sia:{ra_deg:.7f}:{dec_deg:.7f}:{','.join(collections)}"
            rows = await self.cached(key, fetch_sia, ttl_s=DISCOVERY_TTL_S)
            if wanted is not None:
                rows = [r for r in rows if int(r["productid"][1:]) in wanted]
        # One image per exposure and detector: the newest processing when releases overlap.
        return latest_versions(parse_rows(rows))

    async def list_releases(self) -> list[ReleaseInfo]:
        """Science collections with plane counts and the latest publication date."""
        adql = (
            "SELECT o.collection, COUNT(*) AS n, MAX(p.ipac_pub_date) AS latest, "
            "MAX(p.time_bounds_upper) AS t_max FROM spherex.observation o "
            "JOIN spherex.plane p ON p.obsid = o.obsid GROUP BY o.collection"
        )

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(TAP_URL, adql)

        rows = await self.cached("releases", fetch, ttl_s=6 * 3600)
        out: list[ReleaseInfo] = []
        for r in rows:
            out.append(
                ReleaseInfo(
                    collection=r["collection"],
                    n_planes=int(float(r["n"])),
                    latest_pub_date=r.get("latest") or None,
                    t_max_mjd=float(r["t_max"]) if r.get("t_max") else None,
                )
            )
        return sorted(out, key=lambda x: x.collection)

    async def sia2_query(
        self, ra_deg: float, dec_deg: float, radius: u.Quantity, collection: str
    ) -> list[dict[str, str]]:
        """Optional SIA2 cone search (CSV). Rows hold access_url, t_min, t_max, em_min, obs_id."""
        if not collection.replace("_", "").isalnum():
            raise ValueError("Invalid collection")
        params = {
            "COLLECTION": collection,
            "POS": f"circle {ra_deg:.6f} {dec_deg:.6f} {radius.to_value(u.deg):.5f}",
            "RESPONSEFORMAT": "csv",
        }
        response = await self.request("GET", SIA_URL, params=params)
        if response.status_code != 200:
            raise SourceError(f"SIA2 HTTP {response.status_code}")
        return list(csv.DictReader(io.StringIO(response.text)))

    async def cloud_keys(self, ra_deg: float, dec_deg: float, collection: str) -> list[str]:
        """S3 object keys of the images in `collection` that contain the position.

        Keys come only from the `cloud_access` field of IRSA SIA2 results; each entry is checked
        for the expected bucket and key shape. Cached like discovery results.
        """
        if not collection.replace("_", "").isalnum():
            raise ValueError("Invalid collection")
        params = {
            "COLLECTION": collection,
            "POS": f"circle {ra_deg:.6f} {dec_deg:.6f} 0.0005",
            "RESPONSEFORMAT": "csv",
            "MAXREC": "20000",
        }

        async def fetch() -> list[str]:
            response = await self.request("GET", SIA_URL, params=params, timeout_s=120.0)
            if response.status_code != 200:
                raise SourceError(f"SIA2 HTTP {response.status_code}")
            return parse_cloud_access(response.text)

        key = f"sia2-cloud:{collection}:{ra_deg:.5f}:{dec_deg:.5f}"
        return await self.cached(key, fetch, ttl_s=DISCOVERY_TTL_S)

    async def health(self) -> str:
        """ "ok", "degraded" or "down" from the TAP availability endpoint (single quick try)."""
        if self.mode == DataMode.OFFLINE:
            return "down"
        try:
            response = await self.client.get(AVAILABILITY_URL, timeout_s=5.0)
        except Exception:
            return "down"
        if response.status_code != 200:
            return "degraded"
        return "ok" if "available>true" in response.text.replace(" ", "") else "degraded"

    # ------------------------------------------------------------------ cutouts
    def cutout_path(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        key = cutout_key(record.obs_id, ra_deg, dec_deg, float(size.to_value(u.arcmin)))
        return self.settings.cutouts_dir / key[:2] / f"{key}.fits"

    async def download_cutout(
        self, record: ImageRecord, ra_deg: float, dec_deg: float, size: u.Quantity
    ) -> Path:
        """Return the path of the cached cutout, downloading it first when needed.

        The file is content addressed by (obs_id, rounded center, size). Concurrency is bounded
        by the shared semaphore (max 8) and the request has a 120 s timeout with retries.
        """
        path = self.cutout_path(record, ra_deg, dec_deg, size)
        if path.exists():
            return path
        if self.mode == DataMode.OFFLINE:
            raise OfflineMiss(f"Cutout for {record.obs_id} not cached")
        # gzip=true: IBE compresses the response (httpx decodes it transparently).
        url = cutout_url(record.uri, ra_deg, dec_deg, size) + "&gzip=true"
        response = await self.request("GET", url, timeout_s=self.settings.cutout_timeout_s)
        if response.status_code != 200 or not response.content.startswith(b"SIMPLE"):
            raise SourceError(f"Cutout HTTP {response.status_code} for {record.obs_id}")
        data = await asyncio.to_thread(_strip_cutout, response.content)
        atomic_write_bytes(path, data)
        return path

    # ------------------------------------------------------------------ calibration
    def sapm_path(self, collection: str, detector: int) -> Path:
        release = collection.replace("_deep", "")
        return self.settings.data_dir / "calibration" / f"sapm_{release}_D{detector}.fits"

    async def solid_angle_map(self, collection: str, detector: int) -> np.ndarray[Any, Any]:
        """Per-detector solid angle pixel map (arcsec^2, 2040 x 2040) for a release.

        Downloaded once per (release, detector) and cached on disk (about 17 MB each).
        """
        release = collection.replace("_deep", "")
        template = SAPM_PATHS.get(release)
        if template is None:
            raise SourceError(f"No solid angle map known for {collection}")
        path = self.sapm_path(collection, detector)
        if not path.exists():
            if self.mode == DataMode.OFFLINE:
                raise OfflineMiss(f"Solid angle map {path.name} not cached")
            url = IRSA_BASE + template.format(d=detector)
            response = await self.request("GET", url, timeout_s=300.0)
            if response.status_code != 200 or not response.content.startswith(b"SIMPLE"):
                raise SourceError(f"Solid angle map HTTP {response.status_code}")
            atomic_write_bytes(path, response.content)
        return await asyncio.to_thread(_read_sapm, path)


def _read_sapm(path: Path) -> np.ndarray[Any, Any]:
    with fits.open(path) as hdul:
        data = np.asarray(hdul["IMAGE"].data, dtype=np.float32)
    return data


def parse_cloud_access(text: str) -> list[str]:
    """Extract validated S3 keys from the `cloud_access` JSON of an SIA2 CSV response.

    The JSON is embedded unquoted in the CSV (with doubled quotes), so it is located with a
    pattern and parsed with json. Entries for any other bucket or with an unexpected key shape
    are ignored.
    """
    keys: list[str] = []
    for blob in _CLOUD_ACCESS_RE.findall(text.replace('""', '"')):
        try:
            aws = json.loads(blob)["aws"]
        except (ValueError, KeyError, TypeError):
            continue
        key = str(aws.get("key", ""))
        if aws.get("bucket_name") != S3_BUCKET or ".." in key or not S3_KEY_RE.match(key):
            continue
        keys.append(key)
    return sorted(set(keys))


def _strip_cutout(raw: bytes) -> bytes:
    """Re-serialise a cutout keeping only KEEP_EXTENSIONS (drops the 4.9 MB PSF cube)."""
    with fits.open(io.BytesIO(raw)) as hdul:
        keep = [hdul[0]] + [h for h in hdul[1:] if h.name in KEEP_EXTENSIONS]
        out = fits.HDUList([h.copy() for h in keep])
        out[0].header[SOURCE_KEYWORD] = ("irsa", "Cutout service that produced this file")
        buf = io.BytesIO()
        out.writeto(buf)
    return buf.getvalue()
