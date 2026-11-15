"""JPL Horizons client: small-body lookup and observer ephemerides at given times (F-33).

API: https://ssd.jpl.nasa.gov/api/horizons.api (documentation at
ssd-api.jpl.nasa.gov/doc/horizons.html, read 2026-11-14). The host and path are fixed here. A
designation typed by a user is never placed in a host or a path: it is validated against strict
patterns (`normalize_designation`), turned into a Horizons small-body command (always terminated by
";", which restricts the search to the small-body database) and sent only as the encoded value of
the COMMAND query parameter.

Ephemerides are requested for the geocentre (CENTER 500@399), quantities 1 (astrometric ICRF RA and
Dec, light-time corrected), 3 (rates), 9 (magnitude: T-mag for comets, APmag for asteroids), 20
(delta, deldot) and 36 (formal 3 sigma RA and Dec uncertainty). Astrometric positions are the ones
to compare with a WCS fitted on stars. The spacecraft (topocentric) correction is applied by the
caller (`pipeline.movers.topocentric`), because Horizons cannot take an observer position in an
inertial frame. Every answer carries the orbit solution id (for example "JPL#55") for provenance.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
from astropy.time import Time

from destello.sources.base import SourceBase, SourceError

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
LOOKUP_TTL_S = 86400.0
EPHEMERIS_TTL_S = 7 * 86400.0  # orbit solutions are refined; a week old answer is refetched
TLIST_CHUNK = 40  # times per request (keeps the query string short)
QUANTITIES = "1,3,9,20,36"

# Accepted designation forms (case sensitive where the MPC form is).
_NUMBERED = re.compile(r"^\(?(\d{1,7})\)?$")  # 1, (1), 433
_RECORD = re.compile(r"^(9\d{7})$")  # a Horizons comet record number, for example 90004937
_PERIODIC = re.compile(r"^(\d{1,4})([PI])(?:-[A-Z]{1,2})?(?:/[A-Za-z][A-Za-z0-9 \-]{0,30})?$")
_PROVISIONAL = re.compile(
    r"^(?:([CPDXAI])/)?(\d{4} [A-Z]{1,2}\d{0,4}(?:-[A-Z])?)(?: \([A-Za-z][A-Za-z0-9 \-]{0,30}\))?$"
)
_NAME = re.compile(r"^[A-Za-z][A-Za-z\- ]{1,29}$")
_SOLUTION_RE = re.compile(r"Target body name:.*\{source:\s*([^}]+?)\s*\}")
_TARGET_RE = re.compile(r"Target body name:\s*(.+?)\s{2,}")
_REC_RE = re.compile(r"Rec #:\s*(\d+)")
_SOLN_DATE_RE = re.compile(r"Soln\.date:\s*(\S+)")
_LOOKUP_NAME_RE = re.compile(r"JPL/HORIZONS\s+(.+?)\s{2,}")


class HorizonsError(SourceError):
    code = "HORIZONS_ERROR"


class DesignationError(ValueError):
    """The text is not an accepted small-body designation (never sent upstream)."""


class HorizonsNotFound(HorizonsError):
    code = "SMALL_BODY_NOT_FOUND"


class HorizonsAmbiguous(HorizonsError):
    """Several small bodies match; `candidates` lists them for the user to choose."""

    code = "SMALL_BODY_AMBIGUOUS"

    def __init__(self, message: str, candidates: list[dict[str, str]]) -> None:
        super().__init__(message)
        self.candidates = candidates


def normalize_designation(text: str) -> str:
    """Horizons small-body command for a designation, or DesignationError.

    "3I/ATLAS" -> "3I;", "C/2025 N1" -> "C/2025 N1;", "Ceres" -> "Ceres;", "1" -> "1;",
    "90004937" -> "90004937;" (a Horizons record number). The output only contains letters,
    digits, spaces, "/", "-" and the terminating ";", so it cannot break the quoting of the
    COMMAND value.
    """
    s = " ".join(str(text).split())
    if not s or len(s) > 48:
        raise DesignationError("Designation is empty or too long")
    m = _RECORD.match(s) or _NUMBERED.match(s)
    if m:
        return f"{int(m.group(1))};"
    m = _PERIODIC.match(s)
    if m:
        return f"{int(m.group(1))}{m.group(2)};"
    m = _PROVISIONAL.match(s)
    if m:
        prefix = f"{m.group(1)}/" if m.group(1) else ""
        return f"{prefix}{m.group(2)};"
    if _NAME.match(s):
        return f"{s};"
    raise DesignationError("Not a recognised small-body designation")


@dataclass(frozen=True)
class HorizonsTarget:
    record_id: int
    name: str  # as Horizons writes it, for example "ATLAS (C/2025 N1)"
    solution_date: str | None


@dataclass(frozen=True)
class EphemerisRow:
    """One ephemeris row. Times are UTC; angles in degrees; rates in arcsec per hour."""

    jd_utc: float
    ra_deg: float  # astrometric ICRF, geocentric
    dec_deg: float
    delta_au: float
    deldot_km_s: float | None
    ra_rate_arcsec_h: float | None  # dRA*cosD
    dec_rate_arcsec_h: float | None
    mag: float | None
    mag_kind: str | None  # "T-mag" (comet total) or "APmag" (asteroid)
    ra_3sigma_arcsec: float | None
    dec_3sigma_arcsec: float | None

    @property
    def time(self) -> Time:
        return Time(self.jd_utc, format="jd", scale="utc")


@dataclass(frozen=True)
class Ephemeris:
    record_id: int
    target_name: str
    solution: str  # orbit solution id, for example "JPL#55"
    center: str  # "500@399" (geocentre)
    rows: list[EphemerisRow] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Ephemeris:
        return cls(
            record_id=int(d["record_id"]),
            target_name=str(d["target_name"]),
            solution=str(d["solution"]),
            center=str(d["center"]),
            rows=[EphemerisRow(**r) for r in d["rows"]],
        )


def _num(v: str | None) -> float | None:
    if v is None:
        return None
    v = v.strip()
    if not v or v.lower() in {"n.a.", "n.a"}:
        return None
    try:
        out = float(v)
    except ValueError:
        return None
    return out if math.isfinite(out) else None


def parse_match_table(result: str) -> list[dict[str, str]]:
    """Rows of a Horizons "Matching small-bodies" table, split at the dashed column rulers."""
    lines = result.split("Matching small-bodies:", 1)[1].splitlines()
    ruler = next((i for i, ln in enumerate(lines) if ln.strip().startswith("---")), None)
    if ruler is None:
        return []
    spans = [(m.start(), m.end()) for m in re.finditer(r"-+", lines[ruler])]
    keys = ["record", "epoch_year", "designation", "name"]
    out: list[dict[str, str]] = []
    for line in lines[ruler + 1 :]:
        if not line.strip() or not line.strip()[0].isdigit():
            break
        cells = []
        for k, (a, _b) in enumerate(spans):
            end = spans[k + 1][0] if k + 1 < len(spans) else len(line)
            cells.append(line[a:end].strip())
        out.append(dict(zip(keys, cells, strict=False)))
    return out


def parse_lookup(result: str) -> HorizonsTarget:
    """Parse a Horizons OBJ_DATA answer: the single matched body, or raise.

    A list of matches raises HorizonsAmbiguous with the candidates; "No matches found" raises
    HorizonsNotFound.
    """
    if "No matches found" in result:
        raise HorizonsNotFound("No small body matches this designation")
    if "Matching small-bodies" in result:
        raise HorizonsAmbiguous(
            "Several small bodies match this designation", parse_match_table(result)
        )
    rec = _REC_RE.search(result)
    name = _LOOKUP_NAME_RE.search(result)
    if rec is None or name is None:
        raise HorizonsError("Unexpected Horizons lookup answer")
    soln = _SOLN_DATE_RE.search(result)
    return HorizonsTarget(int(rec.group(1)), name.group(1).strip(), soln.group(1) if soln else None)


def parse_ephemeris(result: str, record_id: int, center: str = "500@399") -> Ephemeris:
    """Parse a CSV observer table (CAL_FORMAT=JD, ANG_FORMAT=DEG) into an Ephemeris."""
    if "$$SOE" not in result or "$$EOE" not in result:
        raise HorizonsError("Horizons answer has no ephemeris table")
    head, rest = result.split("$$SOE", 1)
    body = rest.split("$$EOE", 1)[0]
    sol = _SOLUTION_RE.search(head)
    tname = _TARGET_RE.search(head)
    header_lines = [ln for ln in head.splitlines() if "R.A." in ln and "DEC" in ln]
    if not header_lines:
        raise HorizonsError("Horizons table header not found")
    cols = [c.strip() for c in header_lines[-1].split(",")]

    def idx(*names: str) -> int | None:
        for n in names:
            for i, c in enumerate(cols):
                if c.startswith(n):
                    return i
        return None

    i_jd = idx("Date_________JDUT", "Date_________JD")
    i_ra = idx("R.A.___(ICRF)")
    i_dec = idx("DEC____(ICRF)")
    i_delta = idx("delta")
    if i_jd is None or i_ra is None or i_dec is None or i_delta is None:
        raise HorizonsError("Horizons table lacks time, RA, Dec or delta (check QUANTITIES)")
    i_ddot = idx("deldot")
    i_rar = idx("dRA*cosD")
    i_der = idx("d(DEC)/dt")
    i_mag = idx("T-mag", "APmag")
    mag_kind = cols[i_mag] if i_mag is not None else None
    i_s_ra = idx("RA_3sigma")
    i_s_dec = idx("DEC_3sigma")
    rows: list[EphemerisRow] = []
    for line in body.strip().splitlines():
        v = [x.strip() for x in line.split(",")]
        if len(v) < len(cols) - 1:
            continue

        def g(i: int | None, v: list[str] = v) -> float | None:
            return _num(v[i]) if i is not None and i < len(v) else None

        jd, ra, dec, delta = g(i_jd), g(i_ra), g(i_dec), g(i_delta)
        if jd is None or ra is None or dec is None or delta is None:
            continue
        rows.append(
            EphemerisRow(
                jd_utc=jd,
                ra_deg=ra % 360.0,
                dec_deg=dec,
                delta_au=delta,
                deldot_km_s=g(i_ddot),
                ra_rate_arcsec_h=g(i_rar),
                dec_rate_arcsec_h=g(i_der),
                mag=g(i_mag),
                mag_kind=mag_kind,
                ra_3sigma_arcsec=g(i_s_ra),
                dec_3sigma_arcsec=g(i_s_dec),
            )
        )
    return Ephemeris(
        record_id=record_id,
        target_name=tname.group(1).strip() if tname else "",
        solution=sol.group(1).strip() if sol else "unknown",
        center=center,
        rows=rows,
    )


def _result_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        raise HorizonsError("Horizons answered with an unexpected body")
    if payload.get("error"):
        raise HorizonsError(f"Horizons error: {str(payload['error'])[:200]}")
    result = payload.get("result")
    if not isinstance(result, str):
        raise HorizonsError("Horizons answer has no result text")
    return result


class HorizonsClient(SourceBase):
    """Async Horizons client with the shared retry, concurrency, egress and cache machinery."""

    namespace = "horizons"

    async def _query(self, params: dict[str, str]) -> str:
        response = await self.request("GET", HORIZONS_URL, params={"format": "json", **params})
        if response.status_code != 200:
            raise HorizonsError(f"Horizons HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as exc:
            raise HorizonsError("Horizons answered with invalid JSON") from exc
        return _result_text(payload)

    async def lookup(self, designation: str) -> HorizonsTarget:
        """Resolve a designation to one Horizons small-body record (DesignationError,
        HorizonsNotFound or HorizonsAmbiguous otherwise)."""
        command = normalize_designation(designation)

        async def fetch() -> str:
            return await self._query(
                {"COMMAND": f"'{command}'", "OBJ_DATA": "YES", "MAKE_EPHEM": "NO"}
            )

        text = await self.cached("lookup:" + command, fetch, ttl_s=LOOKUP_TTL_S)
        return parse_lookup(text)

    async def ephemeris(self, record_id: int, times: Sequence[Time]) -> Ephemeris:
        """Geocentric astrometric ephemeris of a record at the given times (UTC).

        Rows are returned in the order of `times`; a time without a row raises HorizonsError.
        """
        if not 0 < int(record_id) < 10**9:
            raise DesignationError("Invalid Horizons record")
        rec = int(record_id)
        jds = [float(np.round(t.utc.jd, 9)) for t in times]
        if not jds:
            return Ephemeris(rec, "", "unknown", "500@399", [])
        found: dict[float, EphemerisRow] = {}
        meta: Ephemeris | None = None
        uniq = sorted(set(jds))
        for k in range(0, len(uniq), TLIST_CHUNK):
            chunk = uniq[k : k + TLIST_CHUNK]
            tlist = " ".join(f"{jd:.9f}" for jd in chunk)
            params = {
                "COMMAND": f"'{rec};'",
                "OBJ_DATA": "NO",
                "MAKE_EPHEM": "YES",
                "EPHEM_TYPE": "OBSERVER",
                "CENTER": "'500@399'",
                "TLIST": f"'{tlist}'",
                "TLIST_TYPE": "JD",
                "TIME_TYPE": "UT",
                "QUANTITIES": f"'{QUANTITIES}'",
                "ANG_FORMAT": "DEG",
                "CSV_FORMAT": "YES",
                "CAL_FORMAT": "JD",
                "EXTRA_PREC": "YES",
            }

            async def fetch(params: dict[str, str] = params) -> str:
                return await self._query(params)

            text = await self.cached(f"ephem:{rec}:{tlist}", fetch, ttl_s=EPHEMERIS_TTL_S)
            eph = parse_ephemeris(text, rec)
            meta = meta or eph
            for row in eph.rows:
                found[round(row.jd_utc, 6)] = row
        rows: list[EphemerisRow] = []
        for jd in jds:
            hit = found.get(round(jd, 6))
            if hit is None:
                raise HorizonsError(f"Horizons returned no row for JD {jd:.6f}")
            rows.append(hit)
        assert meta is not None
        return Ephemeris(rec, meta.target_name, meta.solution, meta.center, rows)

    async def ephemeris_range(
        self, record_id: int, start: Time, stop: Time, step_hours: float
    ) -> Ephemeris:
        """Ephemeris sampled every `step_hours` from `start` to `stop` (inclusive)."""
        if not 0 < step_hours <= 48:
            raise ValueError("step_hours must be in (0, 48]")
        n = int(math.floor((stop.utc.jd - start.utc.jd) * 24.0 / step_hours)) + 1
        if n <= 0 or n > 5000:
            raise ValueError("Ephemeris range must hold 1 to 5000 samples")
        jd0 = start.utc.jd
        times = [Time(jd0 + i * step_hours / 24.0, format="jd", scale="utc") for i in range(n)]
        return await self.ephemeris(record_id, times)
