"""Gaia DR3 client (cone searches through TAP sync).

Three archive copies serve the same release (Gaia DR3, reference epoch J2016.0), tried in this
order: MAST (STScI, `mast.stsci.edu`, table `dbo.gaia_source`), the ESA Gaia archive
(`gea.esac.esa.int`, table `gaiadr3.gaia_source`) and the NASA/IPAC IRSA copy
(`irsa.ipac.caltech.edu`, table `gaia_dr3_source`). Same columns and values, so results share one
cache entry. Each result records the copy that answered (`CatalogSource.archive`). The data owner
stays ESA/Gaia/DPAC.

astroquery.mast Catalogs does not serve DR3 (version 3 is not accepted; it falls back to DR2), so
MAST is queried through its documented VO TAP service, which answers with a VOTable.
"""

from __future__ import annotations

import asyncio
import io
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import astropy.units as u
from astropy.io.votable import parse_single_table

from destello.core.logging import get_logger
from destello.models.catalog import CatalogSource
from destello.sources.base import SourceBase, SourceError, opt_float

MAST_TAP_URL = "https://mast.stsci.edu/vo-tap/api/v0.1/gaiadr3/sync"
GAIA_TAP_URL = "https://gea.esac.esa.int/tap-server/tap/sync"
IRSA_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
_ESA_TABLE = "gaiadr3.gaia_source"
_IRSA_TABLE = "gaia_dr3_source"
_MAST_TABLE = "dbo.gaia_source"
MAST, ESA, IRSA = "MAST", "ESA", "IRSA"  # names of the copies, recorded as provenance
EARLY_ATTEMPTS = 2  # retry budget of a copy that has a fallback behind it
HEDGE_S = 8.0  # the IRSA copy answers a report check cone in about 6 s (measured 2026-11-11)
SKIP_S = 600.0
_skip_until: dict[str, float] = {}  # process wide: clients are created per request
GAIA_DR3_EPOCH_JYEAR = 2016.0  # Gaia DR3 reference epoch, J2016.0

_COLUMNS = (
    "source_id, ra, dec, pmra, pmdec, parallax, parallax_error, pmra_error, pmdec_error, "
    "phot_g_mean_mag, ref_epoch, radial_velocity, ruwe"
)


def cone_adql(
    ra_deg: float, dec_deg: float, radius: u.Quantity, max_g: float | None, limit: int
) -> str:
    where = (
        f"1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', {ra_deg:.7f}, {dec_deg:.7f}, "
        f"{radius.to_value(u.deg):.6f}))"
    )
    if max_g is not None:
        where += f" AND phot_g_mean_mag < {float(max_g):.3f}"
    return (
        f"SELECT TOP {int(limit)} {_COLUMNS} FROM {_ESA_TABLE} WHERE {where} "
        "ORDER BY phot_g_mean_mag"
    )


def parse_row(row: dict[str, str], archive: str | None = None) -> CatalogSource:
    """Gaia row to CatalogSource. The reference epoch is read from the row (J2016.0)."""
    return CatalogSource(
        catalog="gaia_dr3",
        source_id=row["source_id"],
        ra_deg=float(row["ra"]),
        dec_deg=float(row["dec"]),
        pmra_masyr=opt_float(row.get("pmra")),
        pmdec_masyr=opt_float(row.get("pmdec")),
        parallax_mas=opt_float(row.get("parallax")),
        ref_epoch_jyear=opt_float(row.get("ref_epoch")) or GAIA_DR3_EPOCH_JYEAR,
        mag=opt_float(row.get("phot_g_mean_mag")),
        mag_band="G",
        rv_kms=opt_float(row.get("radial_velocity")),
        pmra_err_masyr=opt_float(row.get("pmra_error")),
        pmdec_err_masyr=opt_float(row.get("pmdec_error")),
        parallax_err_mas=opt_float(row.get("parallax_error")),
        ruwe=opt_float(row.get("ruwe")),
        archive=archive,
    )


def reset_skips() -> None:
    """Forget which copies were recently slow or failing (used by tests)."""
    _skip_until.clear()


def votable_rows(text: bytes) -> list[dict[str, str]]:
    """Rows of a TAP VOTable answer as strings, null cells as empty strings (CSV conventions)."""
    body = text.decode("utf-8", "replace")
    if 'name="QUERY_STATUS" value="ERROR"' in body or "<TABLE" not in body:
        raise SourceError("TAP query failed: " + " ".join(body[-300:].split()))
    table = parse_single_table(io.BytesIO(text), verify="ignore").to_table()
    rows: list[dict[str, str]] = []
    for rec in table:
        row: dict[str, str] = {}
        for name in table.colnames:
            value = rec[name]
            masked = bool(getattr(value, "mask", False)) or value is None
            if not masked and isinstance(value, float) and value != value:
                masked = True
            row[name] = "" if masked else str(value)
        rows.append(row)
    return rows


@dataclass(frozen=True)
class _Copy:
    name: str
    table: str
    fetch: Callable[[GaiaClient, str, int | None], Awaitable[list[dict[str, str]]]]


async def _fetch_mast(client: GaiaClient, adql: str, attempts: int | None) -> list[dict[str, str]]:
    response = await client.request(
        "POST",
        MAST_TAP_URL,
        data={"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "votable", "QUERY": adql},
        timeout_s=max(client.settings.http_timeout_s, 120.0),
        attempts=attempts,
    )
    if response.status_code != 200:
        raise SourceError(f"TAP {MAST_TAP_URL} returned HTTP {response.status_code}")
    return votable_rows(response.content)


async def _fetch_esa(client: GaiaClient, adql: str, attempts: int | None) -> list[dict[str, str]]:
    return await client.tap_rows(GAIA_TAP_URL, adql, attempts=attempts)


async def _fetch_irsa(client: GaiaClient, adql: str, attempts: int | None) -> list[dict[str, str]]:
    return await client.tap_rows(IRSA_TAP_URL, adql, attempts=attempts)


_COPIES = (
    _Copy(MAST, _MAST_TABLE, _fetch_mast),
    _Copy(ESA, _ESA_TABLE, _fetch_esa),
    _Copy(IRSA, _IRSA_TABLE, _fetch_irsa),
)


class GaiaClient(SourceBase):
    namespace = "gaia"

    async def _rows(self, adql: str) -> tuple[str, list[dict[str, str]]]:
        """Run on MAST, then ESA, then IRSA; return the name of the copy that answered and rows.

        `adql` is written against the ESA table name; each copy gets its own table name. A copy
        that has a fallback behind it gets a short retry budget. The request is hedged: if a copy
        has not answered after HEDGE_S seconds, the next one starts too and the first successful
        answer wins. A copy that failed or lost a race is skipped by the next queries of this
        process for SKIP_S seconds.
        """
        log = get_logger(source="gaia")
        now = time.monotonic()
        queue = [c for c in _COPIES if now >= _skip_until.get(c.name, 0.0)] or [_COPIES[-1]]
        pending: dict[asyncio.Future[list[dict[str, str]]], _Copy] = {}
        last: BaseException | None = None

        def launch() -> None:
            copy = queue.pop(0)
            attempts = EARLY_ATTEMPTS if queue else None
            query = adql.replace(_ESA_TABLE, copy.table)
            pending[asyncio.ensure_future(copy.fetch(self, query, attempts))] = copy

        launch()
        try:
            while pending:
                done, _ = await asyncio.wait(
                    pending,
                    timeout=HEDGE_S if queue else None,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in done:
                    copy = pending.pop(task)
                    exc = task.exception()
                    if exc is None:
                        return copy.name, task.result()
                    last = exc
                    _skip_until[copy.name] = time.monotonic() + SKIP_S
                    log.warning("gaia_copy_failed", copy=copy.name, error=str(exc)[:200])
                if not queue:
                    continue
                if not done:
                    for copy in pending.values():
                        _skip_until[copy.name] = time.monotonic() + SKIP_S
                    log.warning(
                        "gaia_hedge", after_s=HEDGE_S, slow=[c.name for c in pending.values()]
                    )
                launch()
            assert last is not None
            raise last
        finally:
            for task in pending:
                task.cancel()

    async def _query(self, adql: str) -> list[CatalogSource]:
        async def fetch() -> dict[str, Any]:
            copy, rows = await self._rows(adql)
            return {"archive": copy, "rows": rows}

        entry = await self.cached("tap:" + adql, fetch)
        if isinstance(entry, list):  # entries written before the copy was recorded
            return [parse_row(r) for r in entry]
        return [parse_row(r, entry["archive"]) for r in entry["rows"]]

    async def cone(
        self,
        ra_deg: float,
        dec_deg: float,
        radius: u.Quantity,
        max_g: float | None = 20.0,
        limit: int = 2000,
    ) -> list[CatalogSource]:
        """Gaia DR3 sources inside a cone, brightest first. Positions are at J2016.0."""
        return await self._query(cone_adql(ra_deg, dec_deg, radius, max_g, limit))

    async def by_source_id(self, source_id: int) -> CatalogSource | None:
        """One Gaia DR3 source by identifier (an integer, validated before interpolation)."""
        sid = int(source_id)
        rows = await self._query(f"SELECT {_COLUMNS} FROM {_ESA_TABLE} WHERE source_id = {sid}")
        return rows[0] if rows else None
