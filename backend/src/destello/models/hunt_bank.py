"""Hunt field bank (F-35): the versioned field definitions and the build status file.

`data/hunt_fields.yaml` lists the fields. Gold answers (`answer`, `kind`, `reason`, and the catalog
astrometry of gold stars) are server side data: nothing in `public_field` exposes them. The bank
status file (`<data_dir>/hunt/bank_status.json`) is written by scripts/build_hunt_bank.py and says
which fields have a built sequence; only those fields are served to volunteers.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field

from destello.core.config import Settings

BANK_PATH = Path(__file__).resolve().parent.parent / "data" / "hunt_fields.yaml"
STATUS_FILE = "bank_status.json"
LABELS = ("mover", "brightness_change", "artifact", "nothing", "not_sure")
FieldKind = Literal["gold", "ecliptic", "random"]


class GoldAstrometry(BaseModel):
    """Gaia DR3 astrometry of a gold star at its reference epoch (J2016.0)."""

    model_config = ConfigDict(extra="forbid")

    source: str
    ref_epoch: str
    ra_deg: float
    dec_deg: float
    pmra_masyr: float
    pmdec_masyr: float
    parallax_mas: float
    g_mag: float
    ruwe: float | None = None
    verified: bool = True


class HuntField(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z]{3,4}-[0-9]{2}$")
    kind: FieldKind
    reason: str
    ra_deg: float | None = None  # centre for non-gold fields; gold fields derive it
    dec_deg: float | None = None
    ecl_lon_deg: float | None = None
    ecl_lat_deg: float | None = None
    gal_lat_deg: float | None = None
    answer: str | None = None  # gold only, one of LABELS
    astrometry: GoldAstrometry | None = None  # gold only


class HuntBank(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int
    seed: int
    fov_arcmin: float
    detectors: list[int]
    fields: list[HuntField]

    def by_id(self) -> dict[str, HuntField]:
        return {f.id: f for f in self.fields}


@lru_cache
def load_bank(path: Path | None = None) -> HuntBank:
    raw = yaml.safe_load((path or BANK_PATH).read_text(encoding="utf-8"))
    bank = HuntBank.model_validate(raw)
    for f in bank.fields:
        if f.kind == "gold":
            if f.answer not in LABELS or f.astrometry is None:
                raise ValueError(f"gold field {f.id} needs an answer and astrometry")
        elif f.ra_deg is None or f.dec_deg is None:
            raise ValueError(f"field {f.id} needs a centre")
    return bank


def status_path(settings: Settings) -> Path:
    return settings.data_dir / "hunt" / STATUS_FILE


def read_status(settings: Settings) -> dict[str, dict[str, Any]]:
    """Per field build status ({} when the bank has not been built)."""
    p = status_path(settings)
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    fields = data.get("fields") if isinstance(data, dict) else None
    return fields if isinstance(fields, dict) else {}
