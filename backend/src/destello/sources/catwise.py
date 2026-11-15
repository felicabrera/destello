"""CatWISE2020 client (IRSA TAP table `catwise_2020`).

Columns verified live (IRSA TAP_SCHEMA): ra_pm, dec_pm ("at epoch MJD=57170 (2015.405) from psf
model incl. motion"), pmra and pmdec in arcsec/yr (apparent motion, i.e. mu_alpha* in the CatWISE
convention), their sigmas, w1mpro and w2mpro. ra, dec come from the stationary fit (no motion), a
weighted mean over the WISE epochs that only approximately corresponds to `meanobsmjd` and does not
pair exactly with the motion (about 1 arcsec off for WISE 0855). The reference position is therefore
(ra_pm, dec_pm) at MJD 57170, the position the motion fit refers to; (ra, dec) at meanobsmjd is the
fallback for a row without a motion fit.
"""

from __future__ import annotations

import astropy.units as u
from astropy.time import Time

from destello.models.catalog import CatalogSource
from destello.sources.base import SourceBase, opt_float

CATWISE_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"

_COLUMNS = (
    "source_name, ra, dec, ra_pm, dec_pm, pmra, pmdec, sigpmra, sigpmdec, par_pm, par_pmsig, "
    "w1mpro, w2mpro, meanobsmjd, pmcode"
)
#: Reference epoch of ra_pm, dec_pm (CatWISE2020 column descriptions: MJD 57170, 2015.405).
CATWISE_PM_EPOCH_MJD = 57170.0


def cone_adql(
    ra_deg: float,
    dec_deg: float,
    radius: u.Quantity,
    min_pm_arcsec_yr: float | None,
    limit: int,
) -> str:
    where = (
        f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_deg:.7f}, {dec_deg:.7f}, "
        f"{radius.to_value(u.deg):.6f}))"
    )
    if min_pm_arcsec_yr is not None:
        where += f" AND (pmra*pmra + pmdec*pmdec) > {float(min_pm_arcsec_yr) ** 2:.6f}"
    return f"SELECT TOP {int(limit)} {_COLUMNS} FROM catwise_2020 WHERE {where} ORDER BY w2mpro"


def parse_row(row: dict[str, str]) -> CatalogSource:
    """CatWISE row to CatalogSource (arcsec/yr converted to mas/yr).

    Position (ra_pm, dec_pm) at MJD 57170 when the motion fit is present, otherwise (ra, dec) at
    the source meanobsmjd."""
    ra_pm = opt_float(row.get("ra_pm"))
    dec_pm = opt_float(row.get("dec_pm"))
    if ra_pm is not None and dec_pm is not None:
        ra, dec, mjd = ra_pm, dec_pm, CATWISE_PM_EPOCH_MJD
    else:
        ra, dec, mjd = float(row["ra"]), float(row["dec"]), float(row["meanobsmjd"])
    pmra = opt_float(row.get("pmra"))
    pmdec = opt_float(row.get("pmdec"))
    sra = opt_float(row.get("sigpmra"))
    sde = opt_float(row.get("sigpmdec"))
    par = opt_float(row.get("par_pm"))
    return CatalogSource(
        catalog="catwise2020",
        source_id=row["source_name"],
        ra_deg=ra,
        dec_deg=dec,
        pmra_masyr=None if pmra is None else pmra * 1000.0,
        pmdec_masyr=None if pmdec is None else pmdec * 1000.0,
        # Parallax from CatWISE is unreliable for faint sources; it is carried but not trusted.
        parallax_mas=None if par is None else par * 1000.0,
        ref_epoch_jyear=float(Time(mjd, format="mjd", scale="utc").jyear),
        mag=opt_float(row.get("w2mpro")),
        mag_band="W2",
        pmra_err_masyr=None if sra is None else sra * 1000.0,
        pmdec_err_masyr=None if sde is None else sde * 1000.0,
        parallax_err_mas=None,
    )


class CatwiseClient(SourceBase):
    namespace = "catwise"

    async def cone(
        self,
        ra_deg: float,
        dec_deg: float,
        radius: u.Quantity,
        min_pm_arcsec_yr: float | None = None,
        limit: int = 2000,
    ) -> list[CatalogSource]:
        adql = cone_adql(ra_deg, dec_deg, radius, min_pm_arcsec_yr, limit)

        async def fetch() -> list[dict[str, str]]:
            return await self.tap_rows(CATWISE_TAP_URL, adql)

        rows = await self.cached("tap:" + adql, fetch)
        return [parse_row(r) for r in rows]
