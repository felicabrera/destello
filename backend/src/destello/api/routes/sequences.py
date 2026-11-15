"""Sequence creation, status, estimate and the SSE event stream (docs/06 section 3.3)."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import time
import uuid
from collections.abc import AsyncIterator
from typing import Annotated, Any, Literal

from astropy.time import Time
from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from destello.api.deps import (
    SEQ_ID_RE,
    AppState,
    client_hash,
    get_state,
    redis_get_json,
    redis_set_json,
)
from destello.api.errors import ApiError
from destello.core import ratelimit
from destello.core.config import CUTOUT_MARGIN_ARCMIN, EPOCH_GAP_DAYS, GRID_PIXEL_SCALE_ARCSEC
from destello.core.logging import get_logger
from destello.models.schemas import (
    KNOWN_RELEASES,
    EstimateOut,
    SequenceCreate,
    SequenceQueued,
    SequenceReady,
    SequenceStatusOut,
)
from destello.pipeline.epochs import group_epochs
from destello.sources.base import OfflineMiss, SourceError
from destello.worker.cron import RELEASES_CHANGED_AT_KEY
from destello.worker.jobs import (
    MAX_IMAGES_PER_EPOCH_DETECTOR,
    SequenceParams,
    collections_for_release,
    manifest_api_url,
    manifest_path,
    params_sequence_id,
    partial_manifest_path,
    plan_epochs,
)

router = APIRouter(tags=["sequences"])
log = get_logger(component="sequences")

QUEUE_KEY = "arq:queue"
MAX_QUEUE_DEPTH = 50
MAX_IMAGES = 600
PROCESS_S_PER_IMAGE = 0.1  # rough: reproject and coadd of one image on a 116 px grid
REFERENCE_NPIX = 116.0 * 116.0
# Download cost per image by cutout source. IRSA cutouts carry the PSF cube, so their size barely
# depends on the field: measured on a full build of 369 images at 6 arcmin (progressive
# builds, 2026-11), 3.98 MB and 1.18 wall seconds per image with the shared IRSA limiter (8).
# S3 range reads fetch whole detector rows of four extensions, so their size grows with the cutout
# side: 0.326 MB per arcmin of cutout, measured at 7 arcmin (2.28 MB, 369 images) and 11 arcmin
# (3.58 MB, 427 images); download time is 0.26 s per MB with the S3 limiter (16), fitted to both
# builds on the same link (it scales with the server bandwidth).
MB_PER_IMAGE_IRSA = 3.98
DOWNLOAD_S_PER_IMAGE_IRSA = 1.18
S3_MB_PER_CUTOUT_ARCMIN = 0.326
S3_S_PER_MB = 0.26
SECONDS_OVERHEAD = 20
SSE_MAX_STREAMS = 3
SSE_TIMEOUT_S = 1800.0
SSE_HEARTBEAT_S = 15.0
ESTIMATE_TTL_S = 3600


def check_seq_id(sid: str) -> str:
    if not SEQ_ID_RE.match(sid):
        raise ApiError(
            422, "INVALID_SEQUENCE_ID", "Invalid identifier", "sequence_id must be 16 hex digits."
        )
    return sid


def load_pins(state: AppState) -> dict[str, Any]:
    try:
        doc = json.loads((state.settings.data_dir / "pins.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    presets = doc.get("presets", {}) if isinstance(doc, dict) else {}
    return presets if isinstance(presets, dict) else {}


def canonical_params(body: SequenceCreate, state: AppState) -> SequenceParams:
    """Canonical request. A request that equals a preset pin (same rounded center, field of view,
    detectors and release) takes the preset's target id, so that it reuses the preset sequence."""
    # Default "all": union of every science collection (backend/data-notes.md).
    release = body.release or state.settings.default_release
    if release not in KNOWN_RELEASES:
        raise ApiError(
            422, "INVALID_RELEASE", "Invalid release", f"release must be one of {KNOWN_RELEASES}."
        )
    detectors = sorted(set(body.detectors))
    if any(d < 1 or d > 6 for d in detectors):
        raise ApiError(
            422, "INVALID_DETECTORS", "Invalid detectors", "detectors must be integers 1 to 6."
        )
    track = None
    if body.track is not None:
        track = body.track.model_dump()
    priority = body.priority_detector if body.priority_detector in detectors else None
    params = SequenceParams(
        ra_deg=round(body.ra_deg, 5),
        dec_deg=round(body.dec_deg, 5),
        fov_arcmin=float(body.fov_arcmin),
        detectors=tuple(detectors),
        release=release,
        track=track,
        priority_detector=priority,
        include_partial=body.include_partial,
    )
    if track is None:
        for pin in load_pins(state).values():
            p = pin.get("params", {}) if isinstance(pin, dict) else {}
            try:
                pinned = SequenceParams.from_dict(p)
            except (KeyError, TypeError, ValueError):
                continue
            if (
                pinned.ra_deg == params.ra_deg
                and pinned.dec_deg == params.dec_deg
                and pinned.fov_arcmin == params.fov_arcmin
                and pinned.detectors == params.detectors
                and pinned.release == params.release
            ):
                return dataclasses.replace(
                    pinned,
                    priority_detector=priority
                    if priority is not None
                    else pinned.priority_detector,
                    include_partial=body.include_partial,
                )
    return params


async def queue_depth(redis: Any) -> int:
    try:
        return int(await redis.zcard(QUEUE_KEY))
    except Exception:
        return 0


async def sequence_state(state: AppState, sid: str) -> dict[str, Any] | None:
    """Current status of a sequence, or None when it is unknown."""
    redis = state.redis
    if manifest_path(state.settings, sid).exists():
        return {"status": "ready", "manifest_url": f"/manifests/{sid}.json"}
    st = await redis_get_json(redis, f"destello:seq:{sid}:state")
    status = st.get("status") if isinstance(st, dict) else None
    if status not in ("queued", "running", "failed"):
        status = None
        try:
            if (
                await redis.exists(f"arq:job:{sid}")
                or await redis.zscore(QUEUE_KEY, sid) is not None
            ):
                status = "queued"
        except Exception:
            status = None
    if status is None:
        return None
    out: dict[str, Any] = {"status": status}
    if status == "queued":
        try:
            rank = await redis.zrank(QUEUE_KEY, sid)
        except Exception:
            rank = None
        out["position"] = (int(rank) + 1) if rank is not None else 1
    return out


def usage_summary(recs: list[Any], include_partial: bool = False) -> dict[str, int]:
    """Images the worker would actually use: the epochs planned as in worker.jobs (short
    revisits dropped, or kept on their usable detectors with `include_partial`), each
    (epoch, detector) group capped. FoV independent (cached)."""
    if not recs:
        return {"used": 0, "epochs": 0, "detectors": 0}
    epochs = group_epochs(
        Time([r.t_mid.mjd for r in recs], format="mjd", scale="utc"), EPOCH_GAP_DAYS
    )
    kept, low = plan_epochs(epochs, [r.detector for r in recs], include_partial=include_partial)
    used = 0
    dets: set[int] = set()
    for i, e in enumerate(kept):
        members = [k for d in low[i].values() for k in d] if i in low else e.members
        per: dict[int, int] = {}
        for k in members:
            per[recs[k].detector] = per.get(recs[k].detector, 0) + 1
        dets |= set(per)
        used += sum(min(c, MAX_IMAGES_PER_EPOCH_DETECTOR) for c in per.values())
    return {"used": used, "epochs": len(kept), "detectors": len(dets)}


def estimate_numbers(
    summary: dict[str, int], fov_arcmin: float, cutout_source: str = "s3"
) -> EstimateOut:
    """Estimate from the usage summary and the field of view.

    Download: one cutout per image, with the measured cost of the configured cutout source
    (range requests on the AWS open data copy, or IRSA cutouts).
    Processing grows with the grid area (reproject and coadd);
    the output size is one FITS (4 bytes) plus one WebP (about 1 byte) per pixel for every frame
    (detectors plus the broadband frame, per epoch). The per image processing constant is rough."""
    images = min(summary["used"], MAX_IMAGES)
    npix = (fov_arcmin * 60.0 / GRID_PIXEL_SCALE_ARCSEC) ** 2
    frames = summary["epochs"] * (summary["detectors"] + 1)
    if cutout_source == "s3":
        mb_per_image = S3_MB_PER_CUTOUT_ARCMIN * (fov_arcmin + CUTOUT_MARGIN_ARCMIN)
        s_per_image = S3_S_PER_MB * mb_per_image
    else:
        mb_per_image = MB_PER_IMAGE_IRSA
        s_per_image = DOWNLOAD_S_PER_IMAGE_IRSA
    megabytes = images * mb_per_image + frames * npix * 5.0 / 1e6
    seconds = (
        SECONDS_OVERHEAD
        + images * s_per_image
        + images * PROCESS_S_PER_IMAGE * npix / REFERENCE_NPIX
    )
    return EstimateOut(images=images, megabytes=round(megabytes), seconds=round(seconds))


async def estimate_for(
    state: AppState,
    ra: float,
    dec: float,
    release: str,
    detectors: tuple[int, ...] = (1, 2, 3, 4, 5, 6),
    fov_arcmin: float = 6.0,
    include_partial: bool = False,
) -> EstimateOut:
    """Images, download size and time from the IRSA footprint query (cached one hour) and the
    field of view. Raises 422 NO_COVERAGE when no image covers the position and 503 when IRSA
    is unreachable and nothing is cached."""
    key = (
        f"destello:estimate:v2:{release}:{round(ra, 4)}:{round(dec, 4)}:"
        f"{''.join(map(str, detectors))}{':partial' if include_partial else ''}"
    )
    cached = await redis_get_json(state.redis, key)
    if isinstance(cached, dict) and "used" in cached:
        summary = {k: int(cached[k]) for k in ("used", "epochs", "detectors")}
    else:
        try:
            # Same arguments as the worker: the discovery result is cached and reused by the build.
            recs = await state.get_irsa().query_images(
                ra, dec, collections_for_release(release), detectors
            )
        except OfflineMiss as exc:
            raise ApiError(
                503, "OFFLINE_CACHE_MISS", "Not available offline", str(exc)[:200]
            ) from None
        except (SourceError, OSError) as exc:
            log.warning("estimate_failed", error=str(exc)[:200])
            raise ApiError(
                503,
                "IRSA_UNAVAILABLE",
                "IRSA unavailable",
                "NASA IRSA could not be reached.",
                headers={"Retry-After": "300"},
            ) from None
        if not recs:
            raise ApiError(
                422, "NO_COVERAGE", "No coverage", "No SPHEREx images cover this position."
            )
        summary = usage_summary(list(recs), include_partial)
        await redis_set_json(state.redis, key, summary, ESTIMATE_TTL_S)
    return estimate_numbers(summary, fov_arcmin, state.settings.cutout_source)


def _accepted(
    sid: str, estimate: EstimateOut | None, status: Literal["queued", "running"] = "queued"
) -> JSONResponse:
    body = SequenceQueued(
        status=status,
        sequence_id=sid,
        events_url=f"/api/v1/sequences/{sid}/events",
        estimate=estimate,
    )
    return JSONResponse(body.model_dump(mode="json"), status_code=202)


@router.post(
    "/sequences",
    response_model=SequenceReady | SequenceQueued,
    responses={200: {"model": SequenceReady}, 202: {"model": SequenceQueued}},
)
async def create_sequence(
    body: SequenceCreate,
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
) -> Response:
    """Return the ready manifest (200) or enqueue a build, deduplicated by sequence id (202)."""
    params = canonical_params(body, state)
    sid = params_sequence_id(params, state.settings)
    if manifest_path(state.settings, sid).exists():
        refreshing = await _refresh_if_stale(state, sid, params)
        ready = SequenceReady(
            sequence_id=sid, manifest_url=f"/manifests/{sid}.json", refreshing=refreshing
        )
        return JSONResponse(ready.model_dump(mode="json"), status_code=200)

    current = await sequence_state(state, sid)
    is_preset = params.target_id is not None
    if current is not None and current["status"] in ("queued", "running"):
        est = await _estimate_or_none(state, params)
        return _accepted(sid, est, current["status"])

    # A new build: per client limit, coverage and queue depth checks.
    try:
        res = await ratelimit.hit(state.redis, ratelimit.BUILD_LIMIT, client_hash(request))
    except Exception:
        res = None
    if res is not None:
        request.state.ratelimit = res.headers()
        if not res.allowed:
            raise ApiError(
                429,
                "RATE_LIMITED",
                "Too many builds",
                "Build limit reached (6 new builds per 10 minutes). Retry later.",
                headers=res.headers(),
            )
    estimate = await estimate_for(
        state,
        params.ra_deg,
        params.dec_deg,
        params.release,
        params.detectors,
        params.fov_arcmin,
        params.include_partial,
    )
    if not is_preset and await queue_depth(state.redis) >= MAX_QUEUE_DEPTH:
        raise ApiError(
            503,
            "QUEUE_FULL",
            "Queue full",
            "The build queue is full. Retry later.",
            headers={"Retry-After": "120"},
        )
    await _enqueue(state, sid, params, was_failed=bool(current and current["status"] == "failed"))
    return _accepted(sid, estimate)


async def _estimate_or_none(state: AppState, params: SequenceParams) -> EstimateOut | None:
    try:
        return await estimate_for(
            state,
            params.ra_deg,
            params.dec_deg,
            params.release,
            params.detectors,
            params.fov_arcmin,
            params.include_partial,
        )
    except ApiError:
        return None


REFRESH_GUARD_S = 3600


async def _refresh_if_stale(state: AppState, sid: str, params: SequenceParams) -> bool:
    """Rebuild a ready sequence in the background when IRSA has published data since it was built.

    The existing manifest keeps being served (it is real data, only not the newest); the forced
    build replaces it when it finishes. Presets are rebuilt by the release cron itself. At most
    one refresh per sequence is queued per hour, so a failing archive is not hammered. Returns
    True when the manifest is older than the data and a rebuild is queued (now or within the
    last hour); any Redis or queue problem leaves the sequence as it is.
    """
    if params.target_id is not None or state.queue is None:
        return False
    try:
        raw = await state.redis.get(RELEASES_CHANGED_AT_KEY)
        if raw is None:
            return False
        changed_at = float(raw.decode() if isinstance(raw, bytes) else raw)
        if manifest_path(state.settings, sid).stat().st_mtime >= changed_at:
            return False
        if not await state.redis.set(
            f"destello:seq:{sid}:refresh", "1", nx=True, ex=REFRESH_GUARD_S
        ):
            return True  # stale, and its rebuild was queued within the last hour
        await state.redis.delete(f"arq:result:{sid}")
        await state.queue.enqueue_job("build_sequence", params.to_dict(), force=True, _job_id=sid)
    except Exception as exc:
        log.warning("refresh_failed", sequence_id=sid, error=str(exc)[:200])
        return False
    log.info("refresh_queued", sequence_id=sid)
    return True


async def _enqueue(state: AppState, sid: str, params: SequenceParams, *, was_failed: bool) -> None:
    redis = state.redis
    if was_failed:
        await redis.delete(
            f"arq:result:{sid}",
            f"destello:seq:{sid}:state",
            f"destello:seq:{sid}:last",
            f"destello:seq:{sid}:detectors_ready",
        )
    try:
        job = await state.queue.enqueue_job("build_sequence", params.to_dict(), _job_id=sid)
        if job is None:  # a finished result of this id is still retained by arq: drop it, retry
            await redis.delete(f"arq:result:{sid}")
            job = await state.queue.enqueue_job("build_sequence", params.to_dict(), _job_id=sid)
    except Exception as exc:
        log.error("enqueue_failed", error=str(exc)[:200])
        raise ApiError(
            503,
            "QUEUE_UNAVAILABLE",
            "Queue unavailable",
            "The build queue is not reachable. Retry later.",
            headers={"Retry-After": "60"},
        ) from None
    await redis_set_json(redis, f"destello:seq:{sid}:state", {"status": "queued"}, 86400)


@router.get("/sequences/estimate", response_model=EstimateOut)
async def estimate(
    state: Annotated[AppState, Depends(get_state)],
    ra_deg: Annotated[float, Query(ge=0, lt=360)],
    dec_deg: Annotated[float, Query(ge=-90, le=90)],
    fov_arcmin: Annotated[float, Query(ge=2, le=30)],
    release: Annotated[str | None, Query(max_length=32)] = None,
    include_partial: Annotated[bool, Query()] = False,
) -> EstimateOut:
    """Estimated images, download size and build time for a position (not a quote)."""
    rel = release or state.settings.default_release
    if rel not in KNOWN_RELEASES:
        raise ApiError(422, "INVALID_RELEASE", "Invalid release", "Unknown release.")
    return await estimate_for(
        state,
        round(ra_deg, 5),
        round(dec_deg, 5),
        rel,
        fov_arcmin=fov_arcmin,
        include_partial=include_partial,
    )


@router.get("/sequences/{sid}", response_model=SequenceStatusOut, response_model_exclude_none=True)
async def get_sequence(
    sid: Annotated[str, Path(max_length=16)], state: Annotated[AppState, Depends(get_state)]
) -> SequenceStatusOut:
    check_seq_id(sid)
    st = await sequence_state(state, sid)
    if st is None:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.")
    build = read_partial_build(state, sid) if st["status"] == "running" else None
    return SequenceStatusOut(
        sequence_id=sid,
        status=st["status"],
        manifest_url=st.get("manifest_url"),
        position=st.get("position"),
        events_url=None if st["status"] == "ready" else f"/api/v1/sequences/{sid}/events",
        detectors_ready=build["detectors_ready"] if build else None,
        partial_manifest_url=manifest_api_url(sid) if build else None,
    )


def _read_json(path: Any) -> dict[str, Any] | None:
    try:
        doc = json.loads(path.read_bytes())
    except (OSError, ValueError):
        return None
    return doc if isinstance(doc, dict) else None


def read_partial_build(state: AppState, sid: str) -> dict[str, Any] | None:
    """The `build` block of the partial manifest of a running build, if one was written."""
    doc = _read_json(partial_manifest_path(state.settings, sid))
    build = doc.get("build") if doc else None
    if not isinstance(build, dict) or not isinstance(build.get("detectors_ready"), list):
        return None
    return build


@router.get("/sequences/{sid}/manifest")
async def get_manifest(
    sid: Annotated[str, Path(max_length=16)], state: Annotated[AppState, Depends(get_state)]
) -> Response:
    """The final manifest, or while the build runs the partial manifest of the detectors that are
    already viewable. Both carry a `build` block; the partial one is never cached."""
    check_seq_id(sid)
    for _ in range(2):  # the partial file is removed right after the final one is written
        final = _read_json(manifest_path(state.settings, sid))
        if final is not None:
            dets = sorted(int(k) for k in final.get("stretch", {}) if str(k).isdigit())
            final["build"] = {
                "status": "complete",
                "priority_detector": None,
                "detectors_ready": dets,
                "detectors_pending": [],
            }
            return JSONResponse(final, headers={"Cache-Control": "no-cache"})
        partial = _read_json(partial_manifest_path(state.settings, sid))
        if partial is not None:
            return JSONResponse(partial, headers={"Cache-Control": "no-store"})
    raise ApiError(404, "NOT_FOUND", "Not found", "No manifest is available yet.")


# ------------------------------------------------------------------ SSE
SLOT_TTL_S = 45.0  # a stream that stops refreshing frees its slot after this long


async def slot_acquire(redis: Any, chash: str, token: str) -> bool:
    """Take one of the client's stream slots (sorted set member with an expiry score).

    The count is exact: expired members are purged first, and a member is removed on release.
    A leaked slot (crashed worker, dropped connection) heals itself within SLOT_TTL_S."""
    key = f"destello:sse:{chash}"
    now = time.time()
    await redis.zremrangebyscore(key, 0, now)
    await redis.zadd(key, {token: now + SLOT_TTL_S})
    await redis.expire(key, int(SLOT_TTL_S) * 2)
    if int(await redis.zcard(key)) > SSE_MAX_STREAMS:
        await redis.zrem(key, token)
        return False
    return True


async def slot_refresh(redis: Any, chash: str, token: str) -> None:
    with contextlib.suppress(Exception):
        await redis.zadd(f"destello:sse:{chash}", {token: time.time() + SLOT_TTL_S}, xx=True)


async def slot_release(redis: Any, chash: str, token: str) -> None:
    with contextlib.suppress(Exception):
        await asyncio.shield(redis.zrem(f"destello:sse:{chash}", token))


def sse(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


def enrich_epoch_ready(data: dict[str, Any]) -> dict[str, Any]:
    """Add epoch level times and the image count, derived from the frame objects of the event."""
    frames = [f for f in data.get("frames", []) if isinstance(f, dict)]
    coadds = [f for f in frames if f.get("kind") == "coadd"]
    out = dict(data)
    if frames:
        out["t_start"] = (
            min(str(f["t_start"]) for f in frames if "t_start" in f)
            if any("t_start" in f for f in frames)
            else None
        )
        out["t_end"] = (
            max(str(f["t_end"]) for f in frames if "t_end" in f)
            if any("t_end" in f for f in frames)
            else None
        )
        out["n_images"] = sum(int(f.get("n_images", 0)) for f in coadds)
        out = {k: v for k, v in out.items() if v is not None}
    return out


async def replay_detectors_ready(redis: Any, sid: str) -> list[str]:
    """SSE chunks of the detector_ready events already published by the running build."""
    try:
        raw = await redis.lrange(f"destello:seq:{sid}:detectors_ready", 0, -1)
    except Exception:
        return []
    out: list[str] = []
    for item in raw or []:
        try:
            doc = json.loads(item)
            if doc.get("event") == "detector_ready" and isinstance(doc.get("data"), dict):
                out.append(sse("detector_ready", doc["data"]))
        except (ValueError, TypeError, AttributeError):
            continue
    return out


async def event_stream(
    state: AppState, sid: str, chash: str, token: str, pubsub: Any, first: list[str]
) -> AsyncIterator[str]:
    redis = state.redis
    try:
        yield "retry: 3000\n\n"
        for chunk in first:
            yield chunk
        started = time.monotonic()
        last_sent = started
        last_check = started
        last_refresh = started
        while time.monotonic() - started < SSE_TIMEOUT_S:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            now = time.monotonic()
            if msg is not None and msg.get("type") == "message":
                try:
                    doc = json.loads(msg["data"])
                    event, data = str(doc["event"]), dict(doc["data"])
                except (ValueError, KeyError, TypeError):
                    continue
                if event == "epoch_ready":
                    data = enrich_epoch_ready(data)
                if event == "completed":
                    yield sse("status", {"status": "ready"})
                yield sse(event, data)
                last_sent = now
                if event in ("completed", "failed"):
                    return
                continue
            if now - last_check >= 3.0:  # the manifest is written last: it marks completion
                last_check = now
                if manifest_path(state.settings, sid).exists():
                    yield sse("status", {"status": "ready"})
                    yield sse("completed", {"manifest_url": f"/manifests/{sid}.json"})
                    return
            if now - last_sent >= SSE_HEARTBEAT_S:
                yield ": heartbeat\n\n"
                last_sent = now
            if now - last_refresh >= SLOT_TTL_S / 3:
                last_refresh = now
                await slot_refresh(redis, chash, token)
    finally:
        with contextlib.suppress(Exception):
            await pubsub.unsubscribe()
            await pubsub.aclose()
        await slot_release(redis, chash, token)


@router.get("/sequences/{sid}/events")
async def events(
    sid: Annotated[str, Path(max_length=16)],
    request: Request,
    state: Annotated[AppState, Depends(get_state)],
) -> Response:
    """Server-Sent Events relayed from Redis pub/sub, with a 15 second heartbeat, at most three
    open streams per client and a server side timeout."""
    check_seq_id(sid)
    st = await sequence_state(state, sid)
    if st is None:
        raise ApiError(404, "NOT_FOUND", "Not found", "Unknown sequence.")
    headers = {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    if st["status"] == "ready":
        body = sse("status", {"status": "ready"}) + sse(
            "completed", {"manifest_url": st["manifest_url"]}
        )
        return Response(body, media_type="text/event-stream", headers=headers)

    chash = client_hash(request)
    token = uuid.uuid4().hex
    try:
        got = await slot_acquire(state.redis, chash, token)
    except Exception:
        got = True  # Redis hiccup: do not block the stream
    if not got:
        raise ApiError(
            429,
            "TOO_MANY_STREAMS",
            "Too many streams",
            f"At most {SSE_MAX_STREAMS} event streams per client.",
            headers={"Retry-After": "10"},
        )
    pubsub = state.redis.pubsub()
    try:
        await pubsub.subscribe(f"destello:seq:{sid}")
    except Exception:
        await slot_release(state.redis, chash, token)
        raise ApiError(
            503, "QUEUE_UNAVAILABLE", "Event stream unavailable", "Retry later."
        ) from None
    first: list[str] = []
    if st["status"] == "failed":
        last = await redis_get_json(state.redis, f"destello:seq:{sid}:last")
        data = (
            last["data"]
            if isinstance(last, dict) and last.get("event") == "failed"
            else {"code": "BUILD_FAILED", "retry_after_s": 300}
        )
        first.append(sse("status", {"status": "failed"}))
        first.append(sse("failed", data))
        await pubsub.unsubscribe()
        await pubsub.aclose()
        await slot_release(state.redis, chash, token)
        return Response(
            "retry: 3000\n\n" + "".join(first), media_type="text/event-stream", headers=headers
        )
    status: dict[str, Any] = {"status": st["status"]}
    if "position" in st:
        status["position"] = st["position"]
    first.append(sse("status", status))
    # Replay the detectors already published by this run (subscribed first, so an event published
    # meanwhile can arrive twice; clients deduplicate detector_ready by detector).
    first.extend(await replay_detectors_ready(state.redis, sid))
    last = await redis_get_json(state.redis, f"destello:seq:{sid}:last")
    if isinstance(last, dict) and last.get("event") == "progress":
        first.append(sse("progress", dict(last["data"])))
    return StreamingResponse(
        event_stream(state, sid, chash, token, pubsub, first),
        media_type="text/event-stream",
        headers=headers,
        background=BackgroundTask(slot_release, state.redis, chash, token),
    )
