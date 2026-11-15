"""Moving-target (F-33) products stored by the mover build: the forced photometry spectrum and
the ephemeris check, plus a listing of the moving-target sequences for the preset."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, Depends

from destello.api.deps import AppState, get_state
from destello.api.errors import ApiError
from destello.api.routes.sequences import check_seq_id

router = APIRouter(tags=["movers"])

# Kind label shown on the preset card (docs/16 copy rules: EN and ES entries).
MOVER_KIND = {"en": "Moving target", "es": "Objeto en movimiento"}


def _read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _stored(state: AppState, sid: str, name: str) -> dict[str, Any]:
    check_seq_id(sid)
    doc = _read_json(state.settings.data_dir / "movers" / sid / name)
    if not isinstance(doc, dict):
        raise ApiError(
            404, "NOT_FOUND", "Not found", "No moving-target product is stored for this sequence."
        )
    return doc


@router.get("/movers/{sid}/spectrum")
async def mover_spectrum(
    sid: str, state: Annotated[AppState, Depends(get_state)]
) -> dict[str, Any]:
    """Forced photometry points per exposure (Jy) and the band tests, as stored by the build."""
    return _stored(state, sid, "spectrum.json")


@router.get("/movers/{sid}/ephemeris-check")
async def mover_ephemeris_check(
    sid: str, state: Annotated[AppState, Depends(get_state)]
) -> dict[str, Any]:
    """Offset of the measured coma centroid from the topocentric Horizons position."""
    return _stored(state, sid, "ephemeris_check.json")


@router.get("/movers/{sid}/neossat")
async def mover_neossat(sid: str, state: Annotated[AppState, Depends(get_state)]) -> dict[str, Any]:
    """Nearest NEOSSat frame (Canadian Space Agency) per SPHEREx exposure, within the stated
    window. A different telescope, band and time; never SPHEREx data."""
    return _stored(state, sid, "neossat.json")


@router.get("/movers")
async def list_movers(state: Annotated[AppState, Depends(get_state)]) -> list[dict[str, Any]]:
    """Built moving-target sequences, one entry per designation (campaigns grouped), newest
    campaign first. Read from the manifests; nothing is derived or invented."""
    groups: dict[str, dict[str, Any]] = {}
    mdir = state.settings.manifests_dir
    for path in sorted(mdir.glob("*.json")) if mdir.is_dir() else []:
        m = _read_json(path)
        mt = m.get("moving_target") if isinstance(m, dict) else None
        sid = m.get("sequence_id") if isinstance(m, dict) else None
        if not isinstance(mt, dict) or not isinstance(sid, str):
            continue
        if not (state.settings.data_dir / "movers" / sid / "spectrum.json").is_file():
            continue
        designation = str(mt.get("designation", ""))
        g = groups.setdefault(
            designation,
            {
                "designation": designation,
                "name": mt.get("name"),
                "kind": MOVER_KIND,
                "horizons_record": mt.get("horizons_record"),
                "sequences": [],
            },
        )
        g["sequences"].append(
            {
                "sequence_id": sid,
                "solution": mt.get("solution"),
                "campaigns": mt.get("campaigns", []),
                "spectrum_url": mt.get("spectrum_url"),
                "ephemeris_check_url": mt.get("ephemeris_check_url"),
            }
        )
    for g in groups.values():
        g["sequences"].sort(
            key=lambda s: str(s["campaigns"][0].get("t_start", "")) if s["campaigns"] else "",
            reverse=True,
        )
    return list(groups.values())
