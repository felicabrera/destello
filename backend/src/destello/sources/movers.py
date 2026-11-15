"""Exposure discovery along an ephemeris and S3 access without IRSA (F-33).

Two discovery paths, recorded in the manifest provenance (`discovery_path`):

- "tap": IRSA TAP with one CONTAINS(POINT) per ephemeris sample and a time window around it
  (`pipeline.movers.moving_discovery_adql`). IRSA rejects several CONTAINS joined with OR.
- "s3_header_scan": when IRSA does not answer, the AWS open data copy is scanned: the Level 2
  folders of the survey weeks that overlap the time window are listed (anonymous ListObjectsV2 on
  the allowlisted bucket host), the IMAGE header of detector 2 of every exposure is read with one
  range request (pass 1: keep exposures whose D2 field center lies within 8 degrees of the
  ephemeris at their mid time; D1 to D3 sit side by side and D4 to D6 see the same fields through
  the dichroic), then the headers of all six detectors of the kept exposures (pass 2: keep the
  images whose full WCS, with SIP, puts the ephemeris position on the 2040 x 2040 array). Header
  summaries are cached on disk; the scan is bounded by the S3 concurrency setting.

Object keys used by `ListedKeyS3Source` come from the bucket listing itself and must match the
Level 2 key pattern; they are never user supplied. This replaces the SIA2 `cloud_access` check of
`S3CutoutSource.resolve_key` for moving targets only (docs/10 section 3.3 names cloud_access as
the only key source; the listing is the same bucket's own index, see the F-33 report).
"""

from __future__ import annotations

import asyncio
import math
import re
import warnings
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import astropy.units as u
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS, FITSFixedWarning

from destello.core.cache import atomic_write_bytes
from destello.core.config import SAPM_PATHS, DataMode, Settings
from destello.core.egress import EgressClient
from destello.core.limiter import LocalLimiter
from destello.pipeline.movers import angular_sep_arcsec, moving_discovery_adql
from destello.pipeline.query import ImageRecord, latest_versions, parse_rows
from destello.sources.base import OfflineMiss, SourceBase, SourceError
from destello.sources.irsa import S3_KEY_RE, TAP_URL, IrsaClient
from destello.sources.s3 import (
    HEAD_WINDOW,
    S3_BASE,
    URI_PREFIX,
    S3CutoutSource,
    S3Unavailable,
    find_hdu,
    object_key,
)

DISCOVERY_PATH_TAP = "tap"
DISCOVERY_PATH_S3 = "s3_header_scan"
LISTING_TTL_S = 86400.0
PASS1_RADIUS_DEG = 8.0
_RELEASE_COLLECTION = {"dr1": "spherex_dr1", "qr3": "spherex_qr3"}
_NAME_RE = re.compile(r"level2_(\d{4}W\d{2}_\d[A-Z])_(\d{4})_(\d)D(\d)_spx_")
_WEEK_RE = re.compile(r"/(\d{4})W(\d{2})_[0-9A-Z]+/$")
_KEY_TAG = re.compile(r"<Key>([^<]+)</Key>")
_PREFIX_TAG = re.compile(r"<Prefix>([^<]+)</Prefix>")
_TOKEN_TAG = re.compile(r"<NextContinuationToken>([^<]+)</NextContinuationToken>")
_WCS_KEYS = re.compile(
    r"^(NAXIS[12]?|CTYPE[12]|CRVAL[12]|CRPIX[12]|CDELT[12]|CUNIT[12]|PC[12]_[12]|CD[12]_[12]|"
    r"RADESYS|EQUINOX|LONPOLE|LATPOLE|(A|B|AP|BP)_(ORDER|DMAX|\d+_\d+))$"
)
_HEADER_CARDS = (
    "MJD-AVG", "MJD-BEG", "MJD-END", "XPOSURE", "DETECTOR", "OBSID", "TIMESYS",
    "X_SC", "Y_SC", "Z_SC", "CRVAL1", "CRVAL2",
)  # fmt: skip


@dataclass(frozen=True)
class MoverImage:
    """A detector image that contains the ephemeris position (one per obs_id)."""

    record: ImageRecord
    key: str | None  # S3 key when found by the header scan
    sc_km: tuple[float, float, float] | None  # spacecraft geocentric position at mid exposure


@dataclass(frozen=True)
class DiscoveryResult:
    images: list[MoverImage]
    path: str  # DISCOVERY_PATH_TAP or DISCOVERY_PATH_S3
    detail: str


def iso_weeks(start: Time, stop: Time, margin_days: float = 7.0) -> set[tuple[int, int]]:
    """(ISO year, ISO week) pairs that overlap [start - margin, stop + margin]."""
    d0 = (start - margin_days * u.day).to_datetime().date()
    d1 = (stop + margin_days * u.day).to_datetime().date()
    out: set[tuple[int, int]] = set()
    d = d0
    while d <= d1:
        y, w, _ = d.isocalendar()
        out.add((int(y), int(w)))
        d += timedelta(days=1)
    return out


def record_from_key(key: str, header: dict[str, Any]) -> ImageRecord:
    """An ImageRecord for a bucket key and its header summary (no IRSA metadata needed)."""
    if not S3_KEY_RE.match(key) or ".." in key:
        raise S3Unavailable("Unexpected S3 key")
    release = key.split("/", 1)[0]
    collection = _RELEASE_COLLECTION.get(release.replace("_deep", ""), "")
    if not collection:
        raise S3Unavailable(f"Unknown release folder {release!r}")
    if release.endswith("_deep"):
        collection += "_deep"
    stem = key.rsplit("/", 1)[-1].removesuffix(".fits")
    m = _NAME_RE.search(stem)
    obs = str(header.get("OBSID") or (f"{m.group(1)}_{m.group(2)}_{m.group(3)}" if m else stem))
    nan = float("nan") * u.um
    return ImageRecord(
        obs_id=stem,
        observation_id=obs,
        plane_id="",
        detector=int(header["DETECTOR"]),
        collection=collection,
        uri=URI_PREFIX + key,
        t_start=Time(float(header["MJD-BEG"]), format="mjd", scale="utc"),
        t_end=Time(float(header["MJD-END"]), format="mjd", scale="utc"),
        wave_min=nan,
        wave_max=nan,
        exposure_s=float(header.get("XPOSURE") or 0.0),
        content_length=0,
    )


def summarize_header(h: fits.Header, *, with_wcs: bool) -> dict[str, Any]:
    """The cards needed for discovery (and the celestial WCS cards when `with_wcs`)."""
    out: dict[str, Any] = {k: h[k] for k in _HEADER_CARDS if k in h}
    if with_wcs:
        out["wcs"] = {k: h[k] for k in h if isinstance(k, str) and _WCS_KEYS.match(k)}
    return out


def on_array(summary: dict[str, Any], ra_deg: float, dec_deg: float) -> tuple[bool, float, float]:
    """Whether (ra, dec) falls on the array with the full header WCS (TAN-SIP), and (x, y)."""
    h = fits.Header()
    for k, v in summary["wcs"].items():
        h[k] = v
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", FITSFixedWarning)
        w = WCS(h)
    x, y = (float(v) for v in w.all_world2pix([[ra_deg, dec_deg]], 0, quiet=True)[0])
    nx, ny = int(summary["wcs"].get("NAXIS1", 2040)), int(summary["wcs"].get("NAXIS2", 2040))
    ok = math.isfinite(x) and math.isfinite(y)
    return ok and -0.5 <= x <= nx - 0.5 and -0.5 <= y <= ny - 0.5, x, y


Track = Callable[[float], tuple[float, float]]  # MJD (UTC) -> geocentric (ra, dec) in degrees


class MoverS3Scan(SourceBase):
    """Header scan of the SPHEREx bucket (the fallback discovery path)."""

    namespace = "s3scan"

    def __init__(self, settings: Settings | None = None, client: EgressClient | None = None):
        super().__init__(settings, client, max_attempts=4, wait_initial_s=0.5, wait_max_s=8.0)
        self.limiter = LocalLimiter(max(self.settings.s3_concurrency, 1))

    async def _list(self, prefix: str, delimiter: str | None) -> tuple[list[str], list[str]]:
        if not re.fullmatch(r"(?:dr|qr)\d+(?:_deep)?/level2/[A-Za-z0-9_./-]*", prefix):
            raise S3Unavailable("Unexpected listing prefix")

        async def fetch() -> dict[str, list[str]]:
            keys: list[str] = []
            prefixes: list[str] = []
            token: str | None = None
            for _ in range(200):
                params = {"list-type": "2", "prefix": prefix}
                if delimiter:
                    params["delimiter"] = delimiter
                if token:
                    params["continuation-token"] = token
                r = await self.request("GET", S3_BASE, params=params)
                if r.status_code != 200:
                    raise S3Unavailable(f"S3 listing HTTP {r.status_code}")
                text = r.text
                keys += _KEY_TAG.findall(text)
                prefixes += [p for p in _PREFIX_TAG.findall(text) if p != prefix]
                m = _TOKEN_TAG.search(text)
                if not m:
                    return {"keys": keys, "prefixes": prefixes}
                token = m.group(1).replace("&amp;", "&")
            raise S3Unavailable("S3 listing did not end")

        got = await self.cached(f"list:{prefix}:{delimiter}", fetch, ttl_s=LISTING_TTL_S)
        return got["keys"], got["prefixes"]

    async def keys_for_window(self, start: Time, stop: Time, releases: Sequence[str]) -> list[str]:
        weeks = iso_weeks(start, stop)
        keys: list[str] = []
        for rel in releases:
            _, folders = await self._list(f"{rel}/level2/", "/")
            for f in folders:
                m = _WEEK_RE.search(f)
                if m and (int(m.group(1)), int(m.group(2))) in weeks:
                    _, procs = await self._list(f, "/")
                    for p in procs:
                        k, _ = await self._list(p, None)
                        keys += [x for x in k if x.endswith(".fits") and S3_KEY_RE.match(x)]
        return sorted(set(keys))

    async def header(self, key: str, *, with_wcs: bool) -> dict[str, Any] | None:
        """Header summary of the IMAGE extension of one file (one range request, cached)."""

        async def fetch() -> dict[str, Any]:
            r = await self.request(
                "GET", S3_BASE + key, headers={"Range": f"bytes=0-{HEAD_WINDOW - 1}"}
            )
            if r.status_code not in (200, 206):
                raise S3Unavailable(f"S3 HTTP {r.status_code}")
            hdu = find_hdu(r.content, 0, "IMAGE")
            if hdu is None:
                raise S3Unavailable("IMAGE header not in the first blocks")
            return summarize_header(hdu.header, with_wcs=True)

        try:
            full = await self.cached(f"hdr:{key}", fetch)
        except SourceError:
            return None
        return full if with_wcs else {k: v for k, v in full.items() if k != "wcs"}

    async def discover(
        self, track: Track, start: Time, stop: Time, releases: Sequence[str] = ("dr1", "qr3")
    ) -> list[MoverImage]:
        keys = await self.keys_for_window(start, stop, releases)
        groups: dict[tuple[str, str, str], dict[int, str]] = {}
        for k in keys:
            m = _NAME_RE.search(k)
            if m:
                groups.setdefault((m.group(1), m.group(2), m.group(3)), {})[int(m.group(4))] = k
        t0, t1 = float(start.utc.mjd), float(stop.utc.mjd)
        # Pass 1: the D2 field center near the track (any processing folder holds the same field).
        d2 = [(g, v[2]) for g, v in sorted(groups.items()) if 2 in v]
        heads = await asyncio.gather(*(self.header(k, with_wcs=True) for _, k in d2))
        cand: list[tuple[str, str, str]] = []
        for (g, _), h in zip(d2, heads, strict=True):
            if h is None or "MJD-AVG" not in h:
                continue
            t = float(h["MJD-AVG"])
            if not t0 <= t <= t1:
                continue
            ra, dec = track(t)
            if angular_sep_arcsec(ra, dec, float(h["CRVAL1"]), float(h["CRVAL2"])) < (
                PASS1_RADIUS_DEG * 3600.0
            ):
                cand.append(g)
        # Pass 2: every file of the candidate exposures, all processing versions.
        cset = set(cand)
        todo = [
            k
            for k in keys
            if (m := _NAME_RE.search(k)) and (m.group(1), m.group(2), m.group(3)) in cset
        ]
        heads2 = await asyncio.gather(*(self.header(k, with_wcs=True) for k in todo))
        recs: list[ImageRecord] = []
        meta: dict[str, tuple[str, tuple[float, float, float] | None]] = {}
        for k, h in zip(todo, heads2, strict=True):
            if h is None or "wcs" not in h:
                continue
            t = float(h["MJD-AVG"])
            ra, dec = track(t)
            inside, _, _ = on_array(h, ra, dec)
            if not inside:
                continue
            rec = record_from_key(k, h)
            sc = None
            if all(c in h for c in ("X_SC", "Y_SC", "Z_SC")):
                sc = (float(h["X_SC"]), float(h["Y_SC"]), float(h["Z_SC"]))
            recs.append(rec)
            meta[rec.obs_id] = (k, sc)
        out = [MoverImage(r, meta[r.obs_id][0], meta[r.obs_id][1]) for r in latest_versions(recs)]
        out.sort(key=lambda m: (m.record.t_mid.mjd, m.record.detector))
        return out


async def discover_tap(
    irsa: IrsaClient,
    samples: Sequence[tuple[float, float, float]],
    half_window_days: float,
    collections: list[str],
    track: Track,
) -> list[MoverImage]:
    """TAP path: one query per (mjd, ra, dec) sample. Raises SourceError when IRSA fails."""
    rows: list[dict[str, str]] = []
    for t, ra, dec in samples:
        adql = moving_discovery_adql(
            ra, dec, t - half_window_days, t + half_window_days, collections
        )

        async def fetch(adql: str = adql) -> list[dict[str, str]]:
            return await irsa.tap_rows(TAP_URL, adql, maxrec=20000, attempts=2)

        rows += await irsa.cached("tap:" + adql, fetch, ttl_s=6 * 3600)
    recs = latest_versions({r.obs_id: r for r in parse_rows(rows)}.values())
    return [
        MoverImage(r, None, None) for r in sorted(recs, key=lambda r: (r.t_mid.mjd, r.detector))
    ]


class ListedKeyS3Source(S3CutoutSource):
    """S3 cutouts for keys that came from the bucket listing (no SIA2 cloud_access lookup)."""

    def __init__(self, settings: Settings, *, irsa: IrsaClient, keys: Sequence[str]) -> None:
        super().__init__(settings, irsa=irsa)
        self._listed = frozenset(k for k in keys if S3_KEY_RE.match(k) and ".." not in k)

    async def resolve_key(self, record: ImageRecord, ra_deg: float, dec_deg: float) -> str:
        key = object_key(record)
        if key not in self._listed:
            raise S3Unavailable(f"{record.obs_id} was not found in the bucket listing")
        return key

    async def solid_angle_map(self, collection: str, detector: int) -> np.ndarray[Any, Any]:
        """The DR1/QR3 solid angle pixel map from the bucket (same file as on IRSA), cached at
        the IrsaClient path so either source reuses it."""
        release = collection.replace("_deep", "")
        template = SAPM_PATHS.get(release)
        if template is None:
            raise SourceError(f"No solid angle map known for {collection}")
        path: Path = self.irsa.sapm_path(collection, detector)
        if not path.exists():
            if self.mode == DataMode.OFFLINE:
                raise OfflineMiss(f"Solid angle map {path.name} not cached")
            key = template.format(d=int(detector)).removeprefix(URI_PREFIX)
            r = await self.request("GET", S3_BASE + key, timeout_s=300.0)
            if r.status_code != 200 or not r.content.startswith(b"SIMPLE"):
                raise SourceError(f"Solid angle map HTTP {r.status_code}")
            atomic_write_bytes(path, r.content)
        with fits.open(path) as hdul:
            return np.asarray(hdul["IMAGE"].data, dtype=np.float32)
