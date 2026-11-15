"""Application settings read from environment variables (prefix DESTELLO_).

Every scientific constant that is not target specific lives here with its source.
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Pixel scale of the common display grid. Native SPHEREx pixels are about 6.15 arcsec; the grid
# oversamples by a factor of two (docs/03 section 4.1 step 6).
GRID_PIXEL_SCALE_ARCSEC = 3.1
# Default gap (days) that separates two survey epochs (docs/03 section 4.1 step 3).
EPOCH_GAP_DAYS = 20.0
# Extra margin added to cutouts, in arcmin, on top of the field of view and twice the motion.
CUTOUT_MARGIN_ARCMIN = 1.0

# Collections that hold SPHEREx Level 2 science images (verified by TAP, see backend/data-notes.md).
# Data Release 1 (November 2026) holds the reprocessed Quick Release 2 images, 2025-04-24 to
# 2026-05-14, and IRSA removed spherex_qr2 from TAP when it was published; Quick Release 3
# continues from 2026-05-14 and IRSA documents both as one uniformly processed set.
SCIENCE_COLLECTIONS = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
# Collections that IRSA no longer lists. Kept so that stored manifests and cached cutouts built
# from them keep their DOI and solid angle map; never queried.
RETIRED_COLLECTIONS = ("spherex_qr2", "spherex_qr2_deep")
# Release DOIs: IRSA SPHEREx overview pages (DR1: /data/SPHEREx/docs/overview_dr1.html, spectral
# images) and docs/03 section 2.1.
RELEASE_DOIS: dict[str, str] = {
    "spherex_dr1": "10.26131/IRSA678",
    "spherex_dr1_deep": "10.26131/IRSA678",
    "spherex_qr2": "10.26131/IRSA652",
    "spherex_qr2_deep": "10.26131/IRSA652",
    "spherex_qr3": "10.26131/IRSA662",
    "spherex_qr3_deep": "10.26131/IRSA662",
}
# Solid angle pixel maps (arcsec^2, 2040 x 2040) per release, see backend/data-notes.md.
SAPM_PATHS: dict[str, str] = {
    "spherex_dr1": (
        "ibe/data/spherex/dr1/solid_angle_pixel_map/cal-sapm-v3-2026-191/{d}/"
        "solid_angle_pixel_map_D{d}_spx_cal-sapm-v3-2026-191.fits"
    ),
    "spherex_qr2": (
        "ibe/data/spherex/qr2/solid_angle_pixel_map/cal-sapm-v2-2025-164/{d}/"
        "solid_angle_pixel_map_D{d}_spx_cal-sapm-v2-2025-164.fits"
    ),
    "spherex_qr3": (
        "ibe/data/spherex/qr3/solid_angle_pixel_map/cal-sapm-v3-2026-191/{d}/"
        "solid_angle_pixel_map_D{d}_spx_cal-sapm-v3-2026-191.fits"
    ),
}


def uses_quick_release(collections: Iterable[str]) -> bool:
    """True when any collection is a Quick Release, whose calibration IRSA calls preliminary."""
    return any("_qr" in c for c in collections)


DEFAULT_EGRESS_ALLOWLIST = (
    "irsa.ipac.caltech.edu,gea.esac.esa.int,mast.stsci.edu,simbad.cds.unistra.fr,cds.unistra.fr,"
    "vizier.cds.unistra.fr,alasky.cds.unistra.fr,vizier.idia.ac.za,"
    "ssd-api.jpl.nasa.gov,ssd.jpl.nasa.gov,"
    "nasa-irsa-spherex.s3.us-east-1.amazonaws.com,nasa-irsa-wise.s3.us-west-2.amazonaws.com,"
    "ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca,ws-cadc.canfar.net,"
    "challenges.cloudflare.com"
)


class DataMode(StrEnum):
    """Where remote data may come from."""

    OFFLINE = "offline"  # cache only, never touch the network
    ONLINE = "online"  # always query the network (results are still written to the cache)
    HYBRID = "hybrid"  # cache first, network on a miss


class Settings(BaseSettings):
    """Runtime configuration (see deploy/env.example)."""

    model_config = SettingsConfigDict(env_prefix="DESTELLO_", env_file=".env", extra="ignore")

    env: str = "development"
    public_url: str = "http://localhost:8080"
    version: str = "0.3.0"
    default_release: str = "all"  # every science collection, newest version of each image
    pipeline_version: str = "0.3.0"
    data_dir: Path = Path("./data")
    data_quota_gb: float = 120.0
    redis_url: str = "redis://localhost:6379/0"
    db_url: str = "sqlite:///./data/db/destello.sqlite"
    irsa_concurrency: int = Field(default=8, ge=1, le=8)
    http_timeout_s: float = 30.0
    cutout_timeout_s: float = 120.0
    # Cutout source: "s3" reads the AWS open data copy with range requests and falls back to the
    # IRSA cutout service per image; "irsa" uses the IRSA cutout service only (docs/04 section 4).
    cutout_source: Literal["s3", "irsa"] = "s3"
    # Global bound on concurrent requests to the S3 bucket (Redis backed, all processes).
    s3_concurrency: int = Field(default=16, ge=1, le=32)
    egress_allowlist: str = DEFAULT_EGRESS_ALLOWLIST
    turnstile_secret: str = ""
    turnstile_disabled: bool = False
    ip_hash_salt: str = ""
    # Secret for Hunt opaque field ids, vote tokens and gold placement. Empty uses a random value
    # per process (development and tests only; ids and tokens then change on restart).
    hunt_secret: str = ""
    data_mode: DataMode = DataMode.HYBRID
    # Daily online backup of the report database (F-22, docs/09 section 9). Empty means
    # <data_dir>/backups/reports; point it at a second disk or a mounted storage box in production.
    reports_backup_dir: str = ""
    reports_backup_keep: int = Field(default=14, ge=1, le=365)
    # The API measures the spectrum and the astrometry of the pinned presets in the background, so
    # the first visitor of a preset finds them cached (an uncached measurement takes tens of
    # seconds). Off by default (tests, scripts); the compose files turn it on.
    prewarm_measurements: bool = False

    @property
    def egress_hosts(self) -> frozenset[str]:
        """Allowlisted outbound hostnames, lower case."""
        return frozenset(h.strip().lower() for h in self.egress_allowlist.split(",") if h.strip())

    @property
    def cutouts_dir(self) -> Path:
        return self.data_dir / "cutouts"

    @property
    def frames_dir(self) -> Path:
        return self.data_dir / "frames"

    @property
    def manifests_dir(self) -> Path:
        return self.data_dir / "manifests"

    @property
    def cache_dir(self) -> Path:
        return self.data_dir / "cache"

    @property
    def backups_dir(self) -> Path:
        if self.reports_backup_dir.strip():
            return Path(self.reports_backup_dir.strip())
        return self.data_dir / "backups" / "reports"


@lru_cache
def get_settings() -> Settings:
    """Return the process wide settings instance."""
    return Settings()
