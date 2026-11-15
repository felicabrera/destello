"""Catalog record shared by the source clients, the worker and the API."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import astropy.units as u
from astropy.time import Time

from destello.pipeline.propagate import Astrometry


@dataclass(frozen=True)
class CatalogSource:
    """One catalog entry with astrometry at its own reference epoch (ICRS)."""

    catalog: str  # "gaia_dr3" | "catwise2020" | "simbad"
    source_id: str
    ra_deg: float
    dec_deg: float
    pmra_masyr: float | None  # mu_alpha* (includes cos dec)
    pmdec_masyr: float | None
    parallax_mas: float | None
    ref_epoch_jyear: float  # e.g. 2016.0 for Gaia DR3
    mag: float | None
    mag_band: str | None = None
    rv_kms: float | None = None
    pmra_err_masyr: float | None = None
    pmdec_err_masyr: float | None = None
    parallax_err_mas: float | None = None
    ruwe: float | None = None
    archive: str | None = None  # archive copy that served the row: "MAST" | "ESA" | "IRSA"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def ref_epoch(self) -> Time:
        return Time(self.ref_epoch_jyear, format="jyear", scale="tdb")

    def astrometry(self) -> Astrometry:
        """Astrometry for propagation; missing motion or parallax become zero."""
        return Astrometry(
            ra=self.ra_deg * u.deg,
            dec=self.dec_deg * u.deg,
            pmra_cosdec=(self.pmra_masyr or 0.0) * u.mas / u.yr,
            pmdec=(self.pmdec_masyr or 0.0) * u.mas / u.yr,
            parallax=(self.parallax_mas or 0.0) * u.mas,
            ref_epoch=self.ref_epoch,
            rv=None if self.rv_kms is None else self.rv_kms * u.km / u.s,
        )
