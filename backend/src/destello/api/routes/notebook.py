"""Notebook export: a Jupyter notebook generated from the stored manifest (F-36)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response
from pydantic import ValidationError

from destello.api.deps import AppState, client_hash, get_state
from destello.api.derived import read_manifest
from destello.api.errors import ApiError
from destello.api.routes.sequences import check_seq_id
from destello.core import ratelimit
from destello.models.manifest import Manifest
from destello.pipeline.notebook import NOTEBOOK_MEDIA_TYPE, NotebookError, notebook_json

router = APIRouter(tags=["sequences"])


@router.get(
    "/sequences/{sid}/notebook",
    response_class=Response,
    responses={200: {"content": {NOTEBOOK_MEDIA_TYPE: {}}, "description": "Jupyter notebook"}},
)
async def get_notebook(
    request: Request,
    sid: Annotated[str, Path(max_length=16)],
    state: Annotated[AppState, Depends(get_state)],
) -> Response:
    """A Jupyter notebook (nbformat 4) that reproduces the sequence from its manifest with
    astroquery and astropy. It is generated from the stored manifest only; the notebook, not this
    server, downloads the data when it is run."""
    check_seq_id(sid)
    doc = read_manifest(state, sid)
    try:
        res = await ratelimit.hit(state.redis, ratelimit.COMPUTE_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            "Compute rate limit exceeded.",
            headers=res.headers(),
        )
    try:
        manifest = Manifest.model_validate(doc)
        body = notebook_json(manifest, state.settings.public_url)
    except (ValidationError, NotebookError):
        raise ApiError(
            422, "NOTEBOOK_UNAVAILABLE", "Notebook unavailable", "The manifest cannot be exported."
        ) from None
    return Response(
        body,
        media_type=NOTEBOOK_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="destello-{sid}.ipynb"',
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        },
    )
