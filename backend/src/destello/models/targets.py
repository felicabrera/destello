"""Target registry loader (data/targets.yaml and data/presets_copy.yaml)."""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path
from typing import Any

import astropy.units as u
import yaml
from astropy.time import Time
from pydantic import BaseModel, ConfigDict, Field

from destello.pipeline.propagate import Astrometry

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_MJD_RE = re.compile(r"^MJD\s*([0-9.]+)$")
_JYEAR_RE = re.compile(r"^J([0-9.]+)$")


class _M(BaseModel):
    model_config = ConfigDict(extra="allow")


class TargetAstrometry(_M):
    source: str
    ref_epoch: str
    ra_deg: float
    dec_deg: float
    pmra_masyr: float = 0.0
    pmdec_masyr: float = 0.0
    parallax_mas: float = 0.0
    pmra_err_masyr: float | None = None
    pmdec_err_masyr: float | None = None
    parallax_err_mas: float | None = None
    rv_kms: float | None = None
    ruwe: float | None = None
    parallax_verified: bool = True


class ReferenceMotion(_M):
    pmra_masyr: float
    pmdec_masyr: float
    pmra_err_masyr: float = 0.0
    pmdec_err_masyr: float = 0.0
    source: str
    verified: bool = False


class DefaultView(_M):
    fov_arcmin: float
    detectors: list[int]
    det: str | int = "all"
    mode: str = "blink"
    panel: str | None = None


class Target(_M):
    id: str
    names: dict[str, str]
    aliases: list[str] = Field(default_factory=list)
    simbad: str
    astrometry: TargetAstrometry
    reference_motion: ReferenceMotion | None = None
    default_view: DefaultView
    validation: dict[str, bool] = Field(default_factory=dict)
    notes: dict[str, str] = Field(default_factory=dict)
    copy_: dict[str, Any] = Field(default_factory=dict, alias="copy")

    def ref_epoch(self) -> Time:
        return parse_epoch(self.astrometry.ref_epoch)

    def to_astrometry(self) -> Astrometry:
        a = self.astrometry
        return Astrometry(
            ra=a.ra_deg * u.deg,
            dec=a.dec_deg * u.deg,
            pmra_cosdec=a.pmra_masyr * u.mas / u.yr,
            pmdec=a.pmdec_masyr * u.mas / u.yr,
            parallax=a.parallax_mas * u.mas,
            ref_epoch=self.ref_epoch(),
            rv=None if a.rv_kms is None else a.rv_kms * u.km / u.s,
        )

    def total_motion_masyr(self) -> float:
        a = self.astrometry
        return float((a.pmra_masyr**2 + a.pmdec_masyr**2) ** 0.5)


def parse_epoch(text: str) -> Time:
    """Parse "J2016.0" (TDB Julian year) or "MJD57338.5" (UTC) into a Time."""
    s = text.strip()
    m = _JYEAR_RE.match(s)
    if m:
        return Time(float(m.group(1)), format="jyear", scale="tdb")
    m = _MJD_RE.match(s)
    if m:
        return Time(float(m.group(1)), format="mjd", scale="utc")
    raise ValueError(f"Unrecognised epoch: {text!r}")


@lru_cache
def load_targets(path: Path | None = None) -> dict[str, Target]:
    """Load the preset registry keyed by id, merging the localized preset copy."""
    raw = yaml.safe_load((path or DATA_DIR / "targets.yaml").read_text(encoding="utf-8"))
    copy = yaml.safe_load((DATA_DIR / "presets_copy.yaml").read_text(encoding="utf-8")) or {}
    out: dict[str, Target] = {}
    for item in raw:
        item = dict(item)
        item["copy"] = copy.get(item["id"], {})
        t = Target.model_validate(item)
        out[t.id] = t
    return out


def find_target(name: str) -> Target | None:
    """Look a preset up by id or alias (case and accent insensitive)."""

    def norm(s: str) -> str:
        import unicodedata

        s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
        return re.sub(r"[^a-z0-9]+", "", s.lower())

    key = norm(name)
    for t in load_targets().values():
        if key == norm(t.id) or key in {norm(a) for a in t.aliases} | {
            norm(n) for n in t.names.values()
        }:
            return t
    return None
