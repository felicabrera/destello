"""2MASS All-Sky Point Source Catalog client (IRSA TAP table `fp_psc`).

Used only by the flux cross-check of the validation (docs/11, V-08): J, H and Ks magnitudes of
field stars with their total uncertainties and quality flags. Positions are J2000 ICRS at the
2MASS observation date (`jdate`, 1997 to 2001).
"""

from __future__ import annotations

from dataclasses import dataclass

import astropy.units as u

from destello.sources.base import SourceBase, opt_float

TWOMASS_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"

_COLUMNS = (
    "designation, ra, dec, j_m, j_msigcom, h_m, h_msigcom, k_m, k_msigcom, ph_qual, rd_flg, "
    "bl_flg, cc_flg, gal_contam, mp_flg, jdate"
)


@dataclass(frozen=True)
class TwoMassSource:
    designation: str
    ra_deg: float
    dec_deg: float
    j_m: float | None
    j_err: float | None
    h_m: float | None
    h_err: float | None
    k_m: float | None
    k_err: float | None
    ph_qual: str
    rd_flg: str
    bl_flg: str
    cc_flg: str
    gal_contam: int
    mp_flg: int
    jdate: float


def cone_adql(ra_deg: float, dec_deg: float, radius: u.Quantity, max_k: float, limit: int) -> str:
    where = (
        f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_deg:.7f}, {dec_deg:.7f}, "
        f"{radius.to_value(u.deg):.6f})) AND k_m < {float(max_k):.2f}"
    )
    return f"SELECT TOP {int(limit)} {_COLUMNS} FROM fp_psc WHERE {where} ORDER BY k_m"


def parse_row(row: dict[str, str]) -> TwoMassSource:
    return TwoMassSource(
        designation=row["designation"],
        ra_deg=float(row["ra"]),
        dec_deg=float(row["dec"]),
        j_m=opt_float(row.get("j_m")),
        j_err=opt_float(row.get("j_msigcom")),
        h_m=opt_float(row.get("h_m")),
        h_err=opt_float(row.get("h_msigcom")),
        k_m=opt_float(row.get("k_m")),
        k_err=opt_float(row.get("k_msigcom")),
        ph_qual=str(row.get("ph_qual") or ""),
        rd_flg=str(row.get("rd_flg") or ""),
        bl_flg=str(row.get("bl_flg") or ""),
        cc_flg=str(row.get("cc_flg") or ""),
        gal_contam=int(float(row.get("gal_contam") or 0)),
        mp_flg=int(float(row.get("mp_flg") or 0)),
        jdate=float(row.get("jdate") or 0.0),
    )


class TwoMassClient(SourceBase):
    namespace = "twomass"

    async def cone(
        self, ra_deg: float, dec_deg: float, radius: u.Quantity, max_k: float = 14.0,
        limit: int = 2000,
    ) -> list[TwoMassSource]:  # fmt: skip
        adql = cone_adql(ra_deg, dec_deg, radius, max_k, limit)

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(TWOMASS_TAP_URL, adql)

        rows = await self.cached("tap:" + adql, fetch)
        return [parse_row(r) for r in rows]
