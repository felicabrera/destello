"""CADC client: NEOSSat frames (Canadian Space Agency) at the Canadian Astronomy Data Centre (F-33).

Two services, both public and read only:

* CAOM TAP at ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync lists the calibrated ("cor") planes of
  the NEOSSAT collection in a time window, with their footprint polygon, time bounds and exposure.
* The file service at ws-cadc.canfar.net/minoc/files serves the FITS file of a plane.

The ADQL text is built here from numbers only. A file address is built from an observation id that
must be digits only; no user text reaches a host, a path or a query. NEOSSat is a different
telescope, band and time from SPHEREx: nothing from this module is ever shown as SPHEREx data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np
from astropy.time import Time

from destello.sources.base import SourceBase, SourceError, opt_float

CADC_TAP_URL = "https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync"
CADC_FILES_URL = "https://ws-cadc.canfar.net/minoc/files/cadc:NEOSSAT"
NEOSSAT_CREDIT = "NEOSSat, Canadian Space Agency; Canadian Astronomy Data Centre"
SERVICE_CADC_TAP = (
    "CADC CAOM TAP (ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync), collection NEOSSAT"
)
SERVICE_CADC_FILES = "CADC file service (ws-cadc.canfar.net/minoc/files/cadc:NEOSSAT)"
PLANES_TTL_S = 86400.0
MAX_PLANES = 5000
SLICE_DAYS = 0.5
_OBS_ID = re.compile(r"^[0-9]{10,16}$")
_COLUMNS = (
    "o.observationID, o.target_name, p.time_bounds_lower, p.time_bounds_upper, "
    "p.time_exposure, p.position_bounds"
)


class CadcError(SourceError):
    code = "CADC_ERROR"


@dataclass(frozen=True)
class NeossatPlane:
    """One calibrated NEOSSat plane. Times are MJD (UTC); the polygon is in degrees (RA, Dec)."""

    observation_id: str
    target_name: str
    t_start_mjd: float
    t_end_mjd: float
    exposure_s: float | None
    polygon_deg: tuple[tuple[float, float], ...]

    @property
    def t_mid_mjd(self) -> float:
        return 0.5 * (self.t_start_mjd + self.t_end_mjd)

    @property
    def file_name(self) -> str:
        return f"NEOS_SCI_{self.observation_id}_cor.fits"

    @property
    def access_url(self) -> str:
        return f"{CADC_FILES_URL}/{self.file_name}"


def parse_polygon(text: str) -> tuple[tuple[float, float], ...]:
    """Parse a CAOM `polygon ra dec ra dec ...` string into (ra, dec) pairs; empty when unusable."""
    nums: list[float] = []
    for tok in text.replace("(", " ").replace(")", " ").replace(",", " ").split():
        try:
            nums.append(float(tok))
        except ValueError:
            continue
    if len(nums) < 6 or len(nums) % 2:
        return ()
    arr = np.array(nums).reshape(-1, 2)
    return tuple((float(a), float(b)) for a, b in arr)


def plane_from_row(row: dict[str, str]) -> NeossatPlane | None:
    obs = (row.get("observationID") or "").strip()
    lo = opt_float(row.get("time_bounds_lower"))
    hi = opt_float(row.get("time_bounds_upper"))
    poly = parse_polygon(row.get("position_bounds") or "")
    if not _OBS_ID.match(obs) or lo is None or hi is None or not poly:
        return None
    return NeossatPlane(
        observation_id=obs,
        target_name=(row.get("target_name") or "").strip(),
        t_start_mjd=lo,
        t_end_mjd=hi,
        exposure_s=opt_float(row.get("time_exposure")),
        polygon_deg=poly,
    )


class CadcClient(SourceBase):
    namespace = "cadc"

    async def cor_planes(self, start: Time, stop: Time) -> list[NeossatPlane]:
        """Calibrated planes of the NEOSSAT collection observed between `start` and `stop`.

        Dark frames are left out here; whether a footprint contains a target is decided by the
        caller (`pipeline.neossat`), whatever the target name says.
        """
        lo, hi = float(start.utc.mjd), float(stop.utc.mjd)
        if not hi > lo:
            raise ValueError("stop must be after start")
        # The service answers small result sets in seconds but stalls (minutes) on a few hundred
        # rows, so the window is read in short slices, each cached. A plane belongs to the slice
        # of its start time, so no plane is read twice.
        rows: list[dict[str, str]] = []
        edges = [lo]
        while edges[-1] < hi:
            edges.append(min(edges[-1] + SLICE_DAYS, hi))
        for a, b in zip(edges[:-1], edges[1:], strict=True):
            last = b >= hi
            adql = (
                f"SELECT {_COLUMNS} FROM caom2.Observation o "
                "JOIN caom2.Plane p ON p.obsID = o.obsID "
                "WHERE o.collection = 'NEOSSAT' AND p.productID = 'cor' "
                "AND o.target_name <> 'DARK' "
                f"AND p.time_bounds_lower >= {a:.6f} AND p.time_bounds_lower "
                f"{'<=' if last else '<'} {b:.6f} AND p.time_bounds_upper <= {hi:.6f}"
            )

            async def fetch(q: str = adql) -> list[dict[str, str]]:
                return await self.tap_rows(CADC_TAP_URL, q, maxrec=MAX_PLANES + 1)

            rows += await self.cached(
                f"planes2|{a:.6f}|{b:.6f}|{hi:.6f}", fetch, ttl_s=PLANES_TTL_S
            )
        if len(rows) > MAX_PLANES:
            raise CadcError(f"More than {MAX_PLANES} NEOSSat planes in the window")
        unique = {p.observation_id: p for r in rows if (p := plane_from_row(r)) is not None}
        return sorted(unique.values(), key=lambda p: p.t_mid_mjd)

    async def fetch_file(self, plane: NeossatPlane) -> bytes:
        """The FITS file of a plane (a few megabytes). The address comes from a validated id."""
        if not _OBS_ID.match(plane.observation_id):
            raise CadcError("Invalid NEOSSat observation id")
        response = await self.request("GET", plane.access_url, timeout_s=300.0)
        if response.status_code != 200:
            raise CadcError(f"CADC file service returned HTTP {response.status_code}")
        return response.content
