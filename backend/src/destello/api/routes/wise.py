"""WISE/NEOWISE companion of a SPHEREx sequence (F-40): manifest and long-baseline astrometry.

Both documents are stored files written by the build (`worker/wise_build.py`) and by
`scripts/export_longbaseline.py`. The routes read them; nothing is measured on request.
"""

from __future__ import annotations

import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Response
from fastapi.responses import JSONResponse

from destello.api.deps import AppState, get_state
from destello.api.routes.sequences import check_seq_id
from destello.worker.wise_build import wise_manifest_path, wise_sequence_id

router = APIRouter(tags=["wise"])

Band = Literal["W1", "W2"]


def longbaseline_path(state: AppState, wise_sid: str) -> Any:
    return state.settings.data_dir / "builds" / f"{wise_sid}.longbaseline.json"


def _read(path: Any) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def public_astrometry(doc: dict[str, Any]) -> dict[str, Any]:
    """The stored fit without the per-row recalibration star lists (large, not shown)."""
    out = dict(doc)
    for key in ("rows", "residuals"):
        if isinstance(out.get(key), list):
            out[key] = [
                {k: v for k, v in r.items() if k != "recalibration"} if isinstance(r, dict) else r
                for r in out[key]
            ]
    return out


def _none() -> Response:
    """No companion is the normal case for most sequences: 204, so that browsers log no error."""
    return Response(status_code=204, headers={"Cache-Control": "no-cache"})


@router.get("/sequences/{sid}/wise")
async def get_wise_manifest(
    sid: Annotated[str, Path(max_length=16)],
    state: Annotated[AppState, Depends(get_state)],
    band: Annotated[Band, Query()] = "W2",
) -> Response:
    """The WiseManifest of the companion of SPHEREx sequence `sid`, or 204."""
    check_seq_id(sid)
    wsid = wise_sequence_id(sid, band, state.settings)
    doc = _read(wise_manifest_path(state.settings, wsid))
    if doc is None or doc.get("kind") != "wise_companion" or doc.get("spherex_sequence_id") != sid:
        return _none()
    return JSONResponse(doc, headers={"Cache-Control": "no-cache"})


@router.get("/sequences/{sid}/wise/astrometry")
async def get_wise_astrometry(
    sid: Annotated[str, Path(max_length=16)],
    state: Annotated[AppState, Depends(get_state)],
    band: Annotated[Band, Query()] = "W2",
) -> Response:
    """The stored long-baseline proper motion fit (WISE/NEOWISE plus SPHEREx), or 204."""
    check_seq_id(sid)
    wsid = wise_sequence_id(sid, band, state.settings)
    doc = _read(longbaseline_path(state, wsid))
    if doc is None:
        return _none()
    return JSONResponse(public_astrometry(doc), headers={"Cache-Control": "no-cache"})
