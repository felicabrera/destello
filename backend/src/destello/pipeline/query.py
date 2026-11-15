"""Discovery helpers: ADQL construction, row parsing and cutout geometry. Pure, no network.

Table and column names were verified against the live IRSA TAP service (backend/data-notes.md):
`spherex.plane` (one row per detector image), `spherex.artifact` (file URI) and
`spherex.observation` (collection and observation id).
"""

from __future__ import annotations

import math
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import astropy.units as u
from astropy.time import Time

IRSA_BASE = "https://irsa.ipac.caltech.edu/"

_COLLECTION_RE = re.compile(r"^[a-z0-9_]+$")
_FILE_STEM_RE = re.compile(r"([^/]+?)(?:\.fits(?:\.gz)?)?$")


@dataclass(frozen=True)
class ImageRecord:
    """One SPHEREx Level 2 detector image covering the requested position."""

    obs_id: str  # file stem, unique per detector image, e.g. level2_2025W33_2C_0321_1D6_spx_...
    observation_id: str  # e.g. 2025W33_2C_0321_1
    plane_id: str
    detector: int  # 1..6
    collection: str
    uri: str  # relative IRSA path, e.g. ibe/data/spherex/qr2/level2/...fits
    t_start: Time
    t_end: Time
    wave_min: u.Quantity  # nominal detector band lower edge (micron)
    wave_max: u.Quantity
    exposure_s: float
    content_length: int

    @property
    def t_mid(self) -> Time:
        return Time(0.5 * (self.t_start.mjd + self.t_end.mjd), format="mjd", scale="utc")


def discovery_adql(
    ra_deg: float,
    dec_deg: float,
    collections: Sequence[str],
    detectors: Iterable[int] | None = None,
) -> str:
    """Build the ADQL that lists all detector images whose footprint contains the position.

    Collections and detectors are validated (never interpolated from raw user text).
    """
    for c in collections:
        if not _COLLECTION_RE.match(c):
            raise ValueError(f"Invalid collection name: {c!r}")
    coll = ", ".join(f"'{c}'" for c in collections)
    det_clause = ""
    if detectors is not None:
        det = sorted({int(d) for d in detectors})
        if any(d < 1 or d > 6 for d in det):
            raise ValueError("Detectors must be in 1..6")
        det_clause = " AND p.productid IN (" + ", ".join(f"'D{d}'" for d in det) + ")"
    return (
        "SELECT p.planeid, p.obsid, p.productid, p.energy_bounds_lower, p.energy_bounds_upper, "
        "p.time_bounds_lower, p.time_bounds_upper, p.time_exposure, a.uri, a.contentlength, "
        "o.collection, o.observationid "
        "FROM spherex.plane p "
        "JOIN spherex.artifact a ON a.planeid = p.planeid "
        "JOIN spherex.observation o ON o.obsid = p.obsid "
        f"WHERE 1 = CONTAINS(POINT('ICRS', {float(ra_deg):.7f}, {float(dec_deg):.7f}), p.poly) "
        f"AND o.collection IN ({coll}) AND a.producttype = 'science'{det_clause} "
        "ORDER BY p.time_bounds_lower"
    )


def parse_rows(rows: Iterable[Mapping[str, Any]]) -> list[ImageRecord]:
    """Convert TAP result rows (dict per row, string or numeric values) to ImageRecord objects."""
    records: list[ImageRecord] = []
    for row in rows:
        uri = str(row["uri"])
        match = _FILE_STEM_RE.search(uri)
        obs_id = match.group(1) if match else uri
        productid = str(row["productid"]).upper()
        if not productid.startswith("D") or not productid[1:].isdigit():
            continue
        records.append(
            ImageRecord(
                obs_id=obs_id,
                observation_id=str(row["observationid"]),
                plane_id=str(row["planeid"]),
                detector=int(productid[1:]),
                collection=str(row["collection"]),
                uri=uri,
                t_start=Time(float(row["time_bounds_lower"]), format="mjd", scale="utc"),
                t_end=Time(float(row["time_bounds_upper"]), format="mjd", scale="utc"),
                wave_min=float(row["energy_bounds_lower"]) * u.m.to(u.um) * u.um,
                wave_max=float(row["energy_bounds_upper"]) * u.m.to(u.um) * u.um,
                exposure_s=float(row["time_exposure"]),
                content_length=int(float(row["contentlength"] or 0)),
            )
        )
    records.sort(key=lambda r: (r.t_start.mjd, r.detector, r.obs_id))
    return records


SIA_POINT_RADIUS_DEG = 1e-4  # 0.36 arcsec: far below one 6.2 arcsec pixel


def sia_rows_as_tap(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, str]]:
    """Map SIA2 (ObsCore) rows of IRSA to the column names of the TAP discovery query.

    Used when TAP does not answer: a SIA2 search with a circle of SIA_POINT_RADIUS_DEG lists the
    images whose footprint intersects the circle, which equals containment of the position up to
    that radius. Times are MJD (UTC), wavelengths metres, sizes kB, as in ObsCore. SIA2 gives no
    plane identifier, so the file stem stands in for it.
    """
    out: list[dict[str, str]] = []
    for row in rows:
        url = str(row.get("access_url") or "")
        band = str(row.get("energy_bandpassname") or "")
        if str(row.get("dataproduct_subtype") or "") != "science" or "/ibe/data/" not in url:
            continue
        if not band.startswith("SPHEREx-D"):
            continue
        uri = "ibe/data/" + url.split("/ibe/data/", 1)[1]
        match = _FILE_STEM_RE.search(uri)
        stem = match.group(1) if match else uri
        out.append(
            {
                "planeid": stem,
                "obsid": stem,
                "productid": band.removeprefix("SPHEREx-"),
                "energy_bounds_lower": str(row["em_min"]),
                "energy_bounds_upper": str(row["em_max"]),
                "time_bounds_lower": str(row["t_min"]),
                "time_bounds_upper": str(row["t_max"]),
                "time_exposure": str(row["t_exptime"]),
                "uri": uri,
                "contentlength": str(int(float(row.get("access_estsize") or 0) * 1024)),
                "collection": str(row["obs_collection"]),
                "observationid": str(row["obs_id"]),
            }
        )
    return out


_PROCESSING_RE = re.compile(r"-v(\d+)-(\d{4})-(\d{3})")
_COLLECTION_NUM_RE = re.compile(r"(\d+)")


def processing_rank(record: ImageRecord) -> tuple[int, int, int, int, str]:
    """Sort key that grows with newer processing of the same exposure: pipeline version, then
    processing date (year, day of year) from the file name, then the release number of the
    collection. The file name is the last tie breaker so the choice is deterministic."""
    m = _PROCESSING_RE.search(record.obs_id)
    version, year, doy = (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)
    c = _COLLECTION_NUM_RE.search(record.collection)
    return (version, year, doy, int(c.group(1)) if c else 0, record.obs_id)


def latest_versions(records: Iterable[ImageRecord]) -> list[ImageRecord]:
    """Keep one image per exposure and detector: the most recently processed one.

    A later release can republish an exposure that an earlier release already holds, reprocessed
    with a newer pipeline. Coadding both would count the same photons twice and mix calibrations,
    so only the newest processing is kept. Order of the input is preserved.
    """
    items = list(records)
    best: dict[tuple[str, int], ImageRecord] = {}
    for r in items:
        key = (r.observation_id, r.detector)
        held = best.get(key)
        if held is None or processing_rank(r) > processing_rank(held):
            best[key] = r
    keep = {id(r) for r in best.values()}
    return [r for r in items if id(r) in keep]


def cutout_url(uri: str, ra_deg: float, dec_deg: float, size: u.Quantity) -> str:
    """Return the IRSA cutout URL for a relative image URI (docs/03 section 2.2).

    The `size` is the side of the square cutout (any angular unit); IRSA expects degrees.
    """
    if ".." in uri or uri.startswith("/") or "?" in uri or not uri.startswith("ibe/data/spherex/"):
        raise ValueError(f"Unexpected IRSA URI: {uri!r}")
    size_deg = float(size.to_value(u.deg))
    return f"{IRSA_BASE}{uri}?center={ra_deg:.6f},{dec_deg:.6f}d&size={size_deg:.5f}"


def cutout_size(
    fov: u.Quantity,
    total_motion: u.Quantity,
    margin: u.Quantity = 1.0 * u.arcmin,
) -> u.Quantity:
    """Cutout side = field of view + 2 x motion over the whole survey span + margin (docs/00)."""
    size = fov + 2.0 * total_motion + margin
    return size.to(u.arcmin)


def max_detector_index(n: int) -> int:
    """Return the number of grid pixels for a field of view (helper for size estimates)."""
    return int(math.ceil(n))
