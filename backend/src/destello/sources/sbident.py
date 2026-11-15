"""JPL SBIdent client: known asteroids and comets in a field at a given time.

SBIdent assumes an Earth based or geocentric observer (MPC code 500). SPHEREx is in low Earth
orbit, so matches for very near objects are approximate (docs/00-context.md, scientific pitfalls).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

import astropy.units as u
from astropy.time import Time

from destello.sources.base import SourceBase, SourceError

SBIDENT_URL = "https://ssd-api.jpl.nasa.gov/sb_ident.api"


@dataclass(frozen=True)
class SmallBody:
    name: str
    ra_hms: str
    dec_dms: str
    vmag: float | None
    ra_rate_arcsec_h: float | None
    dec_rate_arcsec_h: float | None
    approximate: bool = True  # geocentric observer approximation
    sep_arcsec: float | None = None  # distance from the field center

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _fmt_ra(ra_deg: float) -> str:
    hours = (ra_deg % 360.0) / 15.0
    h = int(hours)
    m = int((hours - h) * 60)
    s = int(round(((hours - h) * 60 - m) * 60))
    if s == 60:
        s, m = 0, m + 1
    if m == 60:
        m, h = 0, (h + 1) % 24
    return f"{h:02d}-{m:02d}-{s:02d}"


def _fmt_dec(dec_deg: float) -> str:
    sign = "-" if dec_deg < 0 else "+"
    a = abs(dec_deg)
    d = int(a)
    m = int((a - d) * 60)
    s = int(round(((a - d) * 60 - m) * 60))
    if s == 60:
        s, m = 0, m + 1
    if m == 60:
        m, d = 0, d + 1
    return f"{sign}{d:02d}-{m:02d}-{s:02d}"


# Column positions of the SBIdent answer when the field names cannot be read (API v1.1 layout).
_DEFAULT_COLUMNS = {"vmag": 6, "ra_rate": 7, "dec_rate": 8, "sep": 5}


def _columns(fields: list[Any] | None) -> dict[str, int]:
    """Locate columns by field name, falling back to the documented positions."""
    cols = dict(_DEFAULT_COLUMNS)
    if not fields:
        return cols
    names = [str(f).lower() for f in fields]
    for i, name in enumerate(names):
        if "norm" in name and "dist" in name:
            cols["sep"] = i
        elif "visual" in name:
            cols["vmag"] = i
        elif name.startswith("ra rate"):
            cols["ra_rate"] = i
        elif name.startswith("dec rate"):
            cols["dec_rate"] = i
    return cols


def _cell(row: list[Any], i: int) -> float | None:
    return _num(row[i]) if len(row) > i else None


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class SBIdentClient(SourceBase):
    namespace = "sbident"

    async def identify(
        self,
        ra_deg: float,
        dec_deg: float,
        obs_time: Time,
        half_width: u.Quantity,
        vmag_limit: float = 22.0,
    ) -> list[SmallBody]:
        """Small bodies inside a square field around the position at `obs_time` (geocentric)."""
        hw = max(float(half_width.to_value(u.deg)), 1.0 / 3600.0)
        params = {
            "obs-time": obs_time.utc.strftime("%Y-%m-%d_%H:%M:%S"),
            "mpc-code": "500",
            "two-pass": "true",
            "fov-ra-center": _fmt_ra(ra_deg),
            "fov-dec-center": _fmt_dec(dec_deg),
            "fov-ra-hwidth": f"{hw:.5f}",
            "fov-dec-hwidth": f"{hw:.5f}",
            "vmag-lim": f"{vmag_limit:.1f}",
        }
        key = "&".join(f"{k}={v}" for k, v in sorted(params.items()))

        async def fetch() -> dict[str, Any]:
            response = await self.request("GET", SBIDENT_URL, params=params)
            if response.status_code != 200:
                raise SourceError(f"SBIdent HTTP {response.status_code}")
            payload: dict[str, Any] = response.json()
            return payload

        payload = await self.cached(key, fetch, ttl_s=86400.0)
        # With two-pass, the first pass is only a coarse candidate list (bodies whose uncertain
        # positions may reach the field, often thousands of arcseconds away); the second pass
        # (full numerical propagation) is the answer, and an empty second pass means no body in
        # the field. The first pass is used only when the service did not run a second pass.
        if "n_second_pass" in payload or "data_second_pass" in payload:
            rows = payload.get("data_second_pass") or []
            cols = _columns(payload.get("fields_second"))
        else:
            rows = payload.get("data_first_pass") or []
            cols = _columns(payload.get("fields_first"))
        # Keep only bodies inside the requested square (corner distance), whatever the pass.
        max_sep = hw * 3600.0 * math.sqrt(2.0) + 1.0
        bodies = [
            SmallBody(
                name=str(r[0]),
                ra_hms=str(r[1]),
                dec_dms=str(r[2]),
                vmag=_cell(r, cols["vmag"]),
                ra_rate_arcsec_h=_cell(r, cols["ra_rate"]),
                dec_rate_arcsec_h=_cell(r, cols["dec_rate"]),
                sep_arcsec=_cell(r, cols["sep"]),
            )
            for r in rows
            if r
        ]
        return [b for b in bodies if b.sep_arcsec is None or b.sep_arcsec <= max_sep]
