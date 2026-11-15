"""Development fallback for /frames and /manifests (production: Caddy serves them, docs/06 s.4).

Only files named by the content-addressed pattern are served, read only, from fixed directories.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path as FsPath
from typing import Annotated

from fastapi import APIRouter, Depends, Path
from fastapi.responses import FileResponse

from destello.api.deps import FILE_NAME_RE, AppState, get_state
from destello.api.errors import ApiError

router = APIRouter(tags=["static"], include_in_schema=False)
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}
# A manifest keeps its name when its sequence is rebuilt, so it is cached briefly and revalidated
# (FileResponse sets ETag and Last-Modified).
REVALIDATED = {"Cache-Control": "public, max-age=60"}
_TYPES = {
    ".webp": "image/webp",
    ".png": "image/png",
    ".json": "application/json",
    ".fits": "application/fits",
}


def _serve(directory: FsPath, name: str, headers: dict[str, str] = IMMUTABLE) -> FileResponse:
    if not FILE_NAME_RE.match(name):
        raise ApiError(404, "NOT_FOUND", "Not found", "Not found.")
    root = directory.resolve()
    target = (root / name).resolve()
    if target.parent != root or not target.is_file():
        raise ApiError(404, "NOT_FOUND", "Not found", "Not found.")
    media = _TYPES.get(target.suffix) or mimetypes.guess_type(name)[0] or "application/octet-stream"
    return FileResponse(target, media_type=media, headers=headers)


@router.get("/frames/{name}")
async def frame(
    name: Annotated[str, Path(max_length=64)], state: Annotated[AppState, Depends(get_state)]
) -> FileResponse:
    return _serve(state.settings.frames_dir, name)


@router.get("/manifests/{name}")
async def manifest(
    name: Annotated[str, Path(max_length=64)], state: Annotated[AppState, Depends(get_state)]
) -> FileResponse:
    return _serve(state.settings.manifests_dir, name, REVALIDATED)
