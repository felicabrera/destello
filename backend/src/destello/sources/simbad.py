"""CDS SIMBAD name resolution through the SIMBAD TAP service.

Note: in the development environment CDS hosts were unreachable, so this client is covered by
recorded-response tests only (backend/data-notes.md). SIMBAD positions are ICRS at epoch J2000.0.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import astropy.units as u

from destello.models.catalog import CatalogSource
from destello.sources.base import SourceBase, SourceError, opt_float

SIMBAD_TAP_URL = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync"
RESOLVER_TTL_S = 7 * 86400  # docs/04 section 6
CONE_TTL_S = 7 * 86400
SIMBAD_EPOCH_JYEAR = 2000.0  # SIMBAD coordinates are ICRS at epoch J2000.0


@dataclass(frozen=True)
class SimbadObject:
    query: str
    main_id: str
    ra_deg: float
    dec_deg: float
    ref_epoch: str  # always "J2000.0" for SIMBAD coordinates
    pmra_masyr: float | None
    pmdec_masyr: float | None
    parallax_mas: float | None
    rv_kms: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def sanitize_name(name: str) -> str:
    """Validate a user supplied object name (max 100 printable characters) and escape quotes."""
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 100 or not cleaned.isprintable():
        raise ValueError("Invalid object name")
    return cleaned.replace("'", "''")


def resolve_adql(name: str) -> str:
    safe = sanitize_name(name)
    return (
        "SELECT TOP 1 main_id, ra, dec, pmra, pmdec, plx_value, rvz_radvel "
        "FROM basic JOIN ident ON oidref = oid "
        f"WHERE id = '{safe}'"
    )


def cone_adql(
    ra_deg: float, dec_deg: float, radius: u.Quantity, min_pm_masyr: float | None, limit: int
) -> str:
    """Objects with coordinates inside a cone, nearest first. Only numbers are interpolated."""
    ra = float(ra_deg) % 360.0
    dec = max(min(float(dec_deg), 90.0), -90.0)
    r = float(radius.to_value(u.deg))
    where = (
        "ra IS NOT NULL AND dec IS NOT NULL AND "
        f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra:.7f}, {dec:.7f}, {r:.6f}))"
    )
    if min_pm_masyr is not None:
        where += f" AND (pmra*pmra + pmdec*pmdec) > {float(min_pm_masyr) ** 2:.3f}"
    return (
        f"SELECT TOP {int(limit)} main_id, ra, dec, pmra, pmdec, plx_value, rvz_radvel, otype, "
        f"DISTANCE(POINT('ICRS', ra, dec), POINT('ICRS', {ra:.7f}, {dec:.7f})) AS dist "
        f"FROM basic WHERE {where} ORDER BY dist"
    )


def parse_cone_row(row: dict[str, str]) -> CatalogSource:
    """SIMBAD row to CatalogSource at J2000.0. There is no magnitude; `mag_band` carries the
    SIMBAD object type (for example `BD*` or `PM*`)."""
    return CatalogSource(
        catalog="simbad",
        source_id=row.get("main_id", "").strip(),
        ra_deg=float(row["ra"]),
        dec_deg=float(row["dec"]),
        pmra_masyr=opt_float(row.get("pmra")),
        pmdec_masyr=opt_float(row.get("pmdec")),
        parallax_mas=opt_float(row.get("plx_value")),
        ref_epoch_jyear=SIMBAD_EPOCH_JYEAR,
        mag=None,
        mag_band=(row.get("otype") or "").strip() or None,
        rv_kms=opt_float(row.get("rvz_radvel")),
    )


class SimbadClient(SourceBase):
    namespace = "simbad"

    async def resolve(self, name: str) -> SimbadObject | None:
        """Resolve an identifier; returns None when SIMBAD does not know it."""
        adql = resolve_adql(name)

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(SIMBAD_TAP_URL, adql)

        rows = await self.cached("tap:" + adql, fetch, ttl_s=RESOLVER_TTL_S)
        if not rows:
            return None
        r = rows[0]
        try:
            ra = float(r["ra"])
            dec = float(r["dec"])
        except (KeyError, ValueError) as exc:
            raise SourceError("SIMBAD returned no coordinates") from exc
        return SimbadObject(
            query=name,
            main_id=r.get("main_id", name),
            ra_deg=ra,
            dec_deg=dec,
            ref_epoch="J2000.0",
            pmra_masyr=opt_float(r.get("pmra")),
            pmdec_masyr=opt_float(r.get("pmdec")),
            parallax_mas=opt_float(r.get("plx_value")),
            rv_kms=opt_float(r.get("rvz_radvel")),
        )

    async def cone(
        self,
        ra_deg: float,
        dec_deg: float,
        radius: u.Quantity,
        min_pm_masyr: float | None = None,
        limit: int = 200,
    ) -> list[CatalogSource]:
        """SIMBAD objects in a cone (J2000.0 positions). `mag_band` carries the object type."""
        adql = cone_adql(ra_deg, dec_deg, radius, min_pm_masyr, limit)

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(SIMBAD_TAP_URL, adql)

        rows = await self.cached("tap:" + adql, fetch, ttl_s=CONE_TTL_S)
        out: list[CatalogSource] = []
        for r in rows:
            try:
                out.append(parse_cone_row(r))
            except (KeyError, ValueError):
                continue
        return out
