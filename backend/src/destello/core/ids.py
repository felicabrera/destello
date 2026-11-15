"""Deterministic identifiers (docs/04 section 6).

All identifiers are truncated SHA-256 digests of a canonical JSON document, so that they are
stable across key order and float noise but change with the release or the pipeline version.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping
from typing import Any

# Coordinates are rounded to 1e-5 degrees (36 mas) before hashing.
_COORD_SCALE = 100_000


def _canonical(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _digest(obj: Any, length: int = 16) -> str:
    return hashlib.sha256(_canonical(obj).encode("ascii")).hexdigest()[:length]


def _coord(value: float) -> int:
    """Quantise a coordinate in degrees to integer units of 1e-5 degrees."""
    q = int(round(value * _COORD_SCALE))
    return 0 if q == 0 else q  # avoids a distinct hash for negative zero


def sequence_id(
    ra_deg: float,
    dec_deg: float,
    fov_arcmin: float,
    detectors: Iterable[int],
    release: str,
    pipeline_version: str,
    mode_params: Mapping[str, Any] | None = None,
) -> str:
    """Return the 16 hex character sequence identifier.

    The hash covers the rounded center, field of view, sorted detectors, mode parameters,
    release and pipeline version.
    """
    doc = {
        "ra": _coord(ra_deg % 360.0),
        "dec": _coord(dec_deg),
        "fov": round(float(fov_arcmin), 3),
        "det": sorted({int(d) for d in detectors}),
        "mode": dict(mode_params) if mode_params else {},
        "release": release,
        "pipeline": pipeline_version,
    }
    return _digest(doc, 16)


def cutout_key(obs_id: str, ra_deg: float, dec_deg: float, size_arcmin: float) -> str:
    """Return the cache key of a cutout: hash of (obs_id, rounded center, size)."""
    doc = {
        "obs": obs_id,
        "ra": _coord(ra_deg % 360.0),
        "dec": _coord(dec_deg),
        "size": round(float(size_arcmin), 3),
    }
    return _digest(doc, 24)


def cutout_center_key(obs_id: str, ra_deg: float, dec_deg: float) -> str:
    """Key of the size index of one image and center (cutouts of any size share it)."""
    doc = {"obs": obs_id, "ra": _coord(ra_deg % 360.0), "dec": _coord(dec_deg)}
    return _digest(doc, 24)


def frame_key(
    seq_id: str,
    epoch: int,
    detector: str,
    kind: str,
    stretch: Mapping[str, float] | None = None,
) -> str:
    """Return the file stem of a rendered frame (docs/04 section 6)."""
    doc = {
        "seq": seq_id,
        "epoch": int(epoch),
        "det": str(detector),
        "kind": kind,
        "stretch": {k: round(float(v), 6) for k, v in (stretch or {}).items()},
    }
    return _digest(doc, 16)
