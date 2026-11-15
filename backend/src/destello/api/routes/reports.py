"""Candidate reports (F-22, docs/06 section 3.6).

POST /reports/check runs the automated checks without storing anything (the preview the report
flow shows before notes). POST /reports verifies Turnstile, runs (or reuses) the checks and stores
the report. GET /reports/{id}, {id}.json and {id}.txt serve the public document. Nothing here
fetches a URL supplied by a visitor: the only outbound calls go to fixed, allowlisted archive and
Turnstile endpoints.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from destello.api import report_checks as rc
from destello.api import reports as rp
from destello.api.deps import AppState, client_hash, get_state, redis_get_json, redis_set_json
from destello.api.derived import read_manifest
from destello.api.errors import ApiError
from destello.core import ratelimit
from destello.sources.base import SourceError

router = APIRouter(tags=["reports"])

REPORT_LIMIT = ratelimit.Limit("reports", 10, 3600)  # docs/06 section 2
CHECK_LIMIT = ratelimit.Limit("report_checks", 30, 3600)


class MarkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    epoch: int = Field(ge=0, le=999)
    ra_deg: float = Field(ge=0.0, lt=360.0, allow_inf_nan=False)
    dec_deg: float = Field(ge=-90.0, le=90.0, allow_inf_nan=False)


class CheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sequence_id: str = Field(pattern=r"^[0-9a-f]{16}$")
    marks: list[MarkIn] = Field(min_length=rc.MIN_MARKS, max_length=rc.MAX_MARKS)
    # Detector whose frames were on screen; selects the frame (and its mid time) of each mark.
    detector: Annotated[int, Field(ge=1, le=6)] | Literal["all"] | None = None


class ReportIn(CheckIn):
    # Raw length bound; the cleaned text is held to NOTES_MAX characters below.
    notes: str = Field(default="", max_length=rp.NOTES_MAX * 2)
    contact: str | None = Field(default=None, max_length=rp.CONTACT_MAX)
    turnstile_token: str | None = Field(default=None, max_length=2048)


async def _limit(state: AppState, request: Request, limit: ratelimit.Limit, what: str) -> None:
    try:
        res = await ratelimit.hit(state.redis, limit, client_hash(request))
    except Exception:
        res = None
    if res is not None and not res.allowed:
        raise ApiError(
            429,
            "RATE_LIMITED",
            "Too many requests",
            f"{what} rate limit exceeded ({limit.limit} per hour).",
            headers=res.headers(),
        )


def turnstile_required(state: AppState) -> bool:
    s = state.settings
    return not s.turnstile_disabled or s.env == "production"


async def verify_turnstile(state: AppState, token: str | None) -> None:
    if not turnstile_required(state):
        return
    if not state.settings.turnstile_secret:
        raise ApiError(
            503,
            "REPORTS_UNAVAILABLE",
            "Reports unavailable",
            "Report submission is not configured on this server.",
        )
    if not token:
        raise ApiError(403, "TURNSTILE_FAILED", "Verification failed", "Verification required.")
    try:
        # In production the token must come from the public host name of this deployment.
        host = (
            urlsplit(state.settings.public_url).hostname
            if state.settings.env == "production"
            else None
        )
        ok = await state.get_turnstile().verify(token, state.settings.turnstile_secret, host)
    except SourceError:
        raise ApiError(
            503,
            "TURNSTILE_UNAVAILABLE",
            "Verification unavailable",
            "The verification service did not answer. Retry in a moment.",
            headers={"Retry-After": "30"},
        ) from None
    if not ok:
        raise ApiError(
            403, "TURNSTILE_FAILED", "Verification failed", "Verification did not succeed."
        )


async def checks_for(
    state: AppState, manifest: dict[str, Any], marks: list[rc.Mark]
) -> dict[str, Any]:
    """Checks for these marks, from the short-lived cache when the preview already ran them.

    A result with a check that could not run is not cached, so a retry queries again."""
    key = rc.checks_cache_key(str(manifest.get("sequence_id")), marks)
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict) and cached.get("version") == rc.CHECKS_VERSION:
        return cached
    checks = await rc.run_checks(state, manifest, marks)
    if rc.complete(checks):
        await redis_set_json(state.redis, key, checks, rc.CACHE_TTL_S)
    return checks


def _marks(manifest: dict[str, Any], body: CheckIn) -> list[rc.Mark]:
    return rc.resolve_marks(manifest, [m.model_dump() for m in body.marks], body.detector)


@router.post("/reports/check")
async def check_report(
    body: CheckIn, request: Request, state: Annotated[AppState, Depends(get_state)]
) -> dict[str, Any]:
    manifest = read_manifest(state, body.sequence_id)
    marks = _marks(manifest, body)  # validated before any outbound request or rate limit hit
    await _limit(state, request, CHECK_LIMIT, "Report check")
    checks = await checks_for(state, manifest, marks)
    return {
        "sequence_id": body.sequence_id,
        "marks": [m.to_dict() for m in marks],
        "checks": checks,
    }


@router.post("/reports", status_code=201)
async def create_report(
    body: ReportIn, request: Request, state: Annotated[AppState, Depends(get_state)]
) -> JSONResponse:
    notes = rp.clean_notes(body.notes)
    if len(notes) > rp.NOTES_MAX:
        raise ApiError(
            422,
            "VALIDATION_ERROR",
            "Invalid request",
            f"notes: at most {rp.NOTES_MAX} characters.",
        )
    try:
        contact = rp.clean_contact(body.contact)
    except ValueError:
        raise ApiError(
            422, "VALIDATION_ERROR", "Invalid request", "contact: must be an email address."
        ) from None
    manifest = read_manifest(state, body.sequence_id)
    marks = _marks(manifest, body)
    await _limit(state, request, REPORT_LIMIT, "Report")
    await verify_turnstile(state, body.turnstile_token)
    checks = await checks_for(state, manifest, marks)
    engine = state.get_reports_engine()
    doc = await asyncio.to_thread(
        rp.insert_report, engine, manifest, marks, checks, notes, contact, body.detector
    )
    return JSONResponse(
        {"report_id": doc["report_id"], "url": doc["url"], "checks": checks},
        status_code=201,
        headers={"Location": f"/api/v1/reports/{doc['report_id']}"},
    )


@router.get("/reports/{name}", response_model=None)
async def get_report(
    name: Annotated[str, Path(max_length=15)],
    state: Annotated[AppState, Depends(get_state)],
) -> Response | dict[str, Any]:
    report_id, _, ext = name.partition(".")
    if not rp.REPORT_ID_RE.match(report_id) or ext not in ("", "json", "txt"):
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown report.")
    engine = state.get_reports_engine()
    doc = await asyncio.to_thread(rp.get_report, engine, report_id)
    if doc is None:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown report.")
    headers = {"Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff"}
    if ext == "txt":
        return Response(
            rp.render_text(doc, state.settings.public_url),
            media_type="text/plain; charset=utf-8",
            headers={
                **headers,
                "Content-Disposition": f'attachment; filename="destello-report-{report_id}.txt"',
            },
        )
    if ext == "json":
        return JSONResponse(
            doc,
            headers={
                **headers,
                "Content-Disposition": f'attachment; filename="destello-report-{report_id}.json"',
            },
        )
    return JSONResponse(doc, headers=headers)
