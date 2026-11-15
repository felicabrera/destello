"""Hunt (F-35): anonymous citizen science loop under /api/v1/hunt.

POST /hunt/next        next field for a session (body carries the random session token)
POST /hunt/votes       submit a vote; the gold answer is returned only after it, for gold fields
GET  /hunt/counters    public counters
GET  /hunt/candidates  fields where volunteers agree (volunteer consensus, unconfirmed)

The session token travels in the body, never in the URL, so it stays out of access logs. The
hashed client address is used only for the Redis rate limit counters.
"""

from __future__ import annotations

import asyncio
from typing import Annotated, Any, Literal

import astropy.units as u
import numpy as np
from astropy.coordinates import Angle
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field

from destello.api import hunt as hu
from destello.api.deps import AppState, client_hash, get_state
from destello.api.errors import ApiError
from destello.api.routes.reports import verify_turnstile
from destello.core import ratelimit
from destello.models.hunt_bank import load_bank
from destello.pipeline import hunt as consensus

router = APIRouter(tags=["hunt"])

# Votes are quick: up to 40 per ten minutes without any check, then Turnstile is required for the
# rest of the window; the hard limit applies to everything (docs/10 section 3.3).
VOTE_FREE_LIMIT = ratelimit.Limit("hunt_votes_free", 40, 600)
VOTE_HARD_LIMIT = ratelimit.Limit("hunt_votes", 200, 3600)
NEXT_LIMIT = ratelimit.Limit("hunt_next", 120, 600)

Label = Literal["mover", "brightness_change", "artifact", "nothing", "not_sure"]


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session: str = Field(pattern=r"^[A-Za-z0-9_-]{16,64}$")


class MarkIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ra_deg: float = Field(ge=0.0, lt=360.0, allow_inf_nan=False)
    dec_deg: float = Field(ge=-90.0, le=90.0, allow_inf_nan=False)


class VoteIn(SessionIn):
    field_id: str = Field(pattern=r"^[0-9a-f]{16}$")
    vote_token: str = Field(pattern=r"^[0-9]{9,12}\.[0-9a-f]{64}$")
    label: Label
    mark: MarkIn | None = None
    turnstile_token: str | None = Field(default=None, max_length=2048)


def _too_many(res: ratelimit.LimitResult, what: str) -> ApiError:
    return ApiError(
        429,
        "RATE_LIMITED",
        "Too many requests",
        f"{what} rate limit exceeded.",
        headers=res.headers(),
    )


async def _hit(
    state: AppState, request: Request, limit: ratelimit.Limit
) -> ratelimit.LimitResult | None:
    try:
        return await ratelimit.hit(state.redis, limit, client_hash(request))
    except Exception:  # Redis outage: fail open, like the other routes
        return None


async def _enforce(state: AppState, request: Request, limit: ratelimit.Limit, what: str) -> None:
    res = await _hit(state, request, limit)
    if res is not None and not res.allowed:
        raise _too_many(res, what)


def mark_in_field(
    mark_ra_deg: float, mark_dec_deg: float, ra_deg: float, dec_deg: float, fov_arcmin: float
) -> bool:
    """True when a mark lies inside the square field of width `fov_arcmin` centred on the field.

    Offsets are taken on the tangent plane at the centre (east offset scaled by cos(dec)); each
    axis must be within half the width.
    """
    ra = Angle(mark_ra_deg * u.deg)
    dra = (ra - Angle(ra_deg * u.deg)).wrap_at(180 * u.deg)
    ddec = Angle(mark_dec_deg * u.deg) - Angle(dec_deg * u.deg)
    east = (dra * np.cos(dec_deg * u.deg)).to(u.arcmin)
    north = ddec.to(u.arcmin)
    half = (fov_arcmin / 2.0) * u.arcmin
    return bool(abs(east) <= half and abs(north) <= half)


@router.post("/hunt/next")
async def next_field(
    body: SessionIn, request: Request, state: Annotated[AppState, Depends(get_state)]
) -> dict[str, Any]:
    await _enforce(state, request, NEXT_LIMIT, "Field")
    bank = load_bank()
    ready = hu.ready_fields(state.settings, bank)
    engine = state.get_reports_engine()
    fields = bank.by_id()
    fid, n = await asyncio.to_thread(
        hu.serve_field, engine, hu.hunt_secret(state.settings), body.session, fields, ready
    )
    seen = await asyncio.to_thread(hu.session_state, engine, body.session)
    remaining = len([i for i in ready if i not in seen])
    if fid is None:
        return {"field": None, "remaining": 0, "reviewed": len(seen)}
    return {
        "field": hu.public_field(state.settings, bank, fields[fid], ready[fid], body.session, n),
        "remaining": remaining,
        "reviewed": len(seen),
    }


@router.post("/hunt/votes", status_code=201)
async def submit_vote(
    body: VoteIn, request: Request, state: Annotated[AppState, Depends(get_state)]
) -> dict[str, Any]:
    bank = load_bank()
    ready = hu.ready_fields(state.settings, bank)
    internal = hu.resolve_public_id(state.settings, bank, body.session, body.field_id)
    field = bank.by_id().get(internal) if internal else None
    entry = ready.get(internal) if internal else None
    if field is None or entry is None:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown field.")
    n_votes = await asyncio.to_thread(
        hu.session_vote_count, state.get_reports_engine(), body.session
    )
    try:
        hu.check_vote_token(state.settings, body.vote_token, body.session, field.id, n_votes)
    except hu.VoteTokenError as e:
        raise ApiError(
            403,
            e.code,
            "Vote not allowed",
            "The vote token is expired; request a field again."
            if e.code == "VOTE_TOKEN_EXPIRED"
            else "The vote token does not match this session and field.",
        ) from None
    if body.mark is not None and not mark_in_field(
        body.mark.ra_deg,
        body.mark.dec_deg,
        float(entry["ra_deg"]),
        float(entry["dec_deg"]),
        bank.fov_arcmin,
    ):
        raise ApiError(422, "VALIDATION_ERROR", "Invalid request", "mark: outside the field.")
    await _enforce(state, request, VOTE_HARD_LIMIT, "Vote")
    free = await _hit(state, request, VOTE_FREE_LIMIT)
    if free is not None and not free.allowed:  # a burst: ask for Turnstile before storing
        await verify_turnstile(state, body.turnstile_token)
    country = hu.country_code(
        request.headers.get("cf-ipcountry"), state.settings.env == "production"
    )
    mark = (body.mark.ra_deg, body.mark.dec_deg) if body.mark else None
    try:
        await asyncio.to_thread(
            hu.insert_vote,
            state.get_reports_engine(),
            body.session,
            field,
            body.label,
            mark,
            country,
            n_votes,
            hu.vote_client_key(
                state.settings,
                ratelimit.pick_client_ip(
                    request.client.host if request.client else None,
                    request.headers.get("x-forwarded-for"),
                ),
                field.id,
            ),
        )
    except hu.VoteTokenError:
        raise ApiError(
            403,
            "VOTE_TOKEN_INVALID",
            "Vote not allowed",
            "The vote token does not match this session and field.",
        ) from None
    except hu.DuplicateVote:
        raise ApiError(
            409, "ALREADY_VOTED", "Already voted", "This session already voted on the field."
        ) from None
    return {"accepted": True, "gold": hu.gold_feedback(field, body.label)}


@router.get("/hunt/counters")
async def get_counters(state: Annotated[AppState, Depends(get_state)]) -> dict[str, Any]:
    ids = {f.id for f in load_bank().fields}
    return await asyncio.to_thread(hu.counters, state.get_reports_engine(), ids)


@router.get("/hunt/candidates")
async def get_candidates(state: Annotated[AppState, Depends(get_state)]) -> dict[str, Any]:
    bank = load_bank()
    ready = hu.ready_fields(state.settings, bank)
    items = await asyncio.to_thread(
        hu.candidates, state.settings, state.get_reports_engine(), bank, ready
    )
    return {"status": consensus.CONSENSUS_STATUS, "candidates": items}
