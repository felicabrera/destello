"""Background measurement of the pinned presets (spectrum and astrometry).

An uncached measurement reads every exposure of a sequence and takes tens of seconds. The five
presets are what most visitors open first, so the API computes their default measurements ahead
of time, with the same code path and the same cache keys as the public endpoints. Nothing here is
reachable from a request: positions come from the target registry and sequence ids from pins.json.
"""

from __future__ import annotations

import asyncio
import json

from destello.api.deps import AppState
from destello.api.routes.astrometry import AstrometryRequest, astrometry_doc
from destello.api.routes.spectrum import spectrum_doc
from destello.core.logging import get_logger
from destello.models.targets import load_targets

PINS_FILE = "pins.json"
LOCK_KEY = "destello:prewarm:lock"
LOCK_TTL_S = 1800
INTERVAL_S = 6 * 3600
START_DELAY_S = 20.0


def preset_requests(state: AppState) -> list[tuple[str, str, AstrometryRequest]]:
    """(preset id, sequence id, default request) for every pinned preset, as the Explorer sends
    them: the registry position alone (the server applies its own astrometry) and the default
    detector of the preset."""
    path = state.settings.data_dir / PINS_FILE
    try:
        presets = json.loads(path.read_text(encoding="utf-8")).get("presets", {})
    except (OSError, ValueError):
        return []
    targets = load_targets()
    out: list[tuple[str, str, AstrometryRequest]] = []
    for tid, pin in presets.items():
        target = targets.get(tid)
        if target is None or "sequence_id" not in pin:
            continue
        det = target.default_view.det
        out.append(
            (
                tid,
                str(pin["sequence_id"]),
                AstrometryRequest(
                    ra_deg=target.astrometry.ra_deg,
                    dec_deg=target.astrometry.dec_deg,
                    detector=det if isinstance(det, int) else None,
                ),
            )
        )
    return out


async def prewarm_once(state: AppState) -> dict[str, int]:
    """Measure what is not cached yet, one preset at a time. A failure (a target that cannot be
    measured, a catalog that does not answer) is logged and never stops the others."""
    log = get_logger(component="prewarm")
    done = failed = 0
    for tid, sid, req in preset_requests(state):
        for kind in ("spectrum", "astrometry"):
            try:
                if kind == "spectrum":
                    await spectrum_doc(state, sid, req.ra_deg, req.dec_deg)
                else:
                    await astrometry_doc(state, sid, req)
                done += 1
            except Exception as exc:
                failed += 1
                log.info("prewarm_skipped", target=tid, kind=kind, error=str(exc)[:200])
    log.info("prewarm_done", measured_or_cached=done, failed=failed)
    return {"done": done, "failed": failed}


async def prewarm_loop(state: AppState) -> None:
    """Run prewarm_once shortly after startup and then every INTERVAL_S. A Redis lock keeps
    several API processes from measuring the same presets at once; without Redis the pass is
    skipped."""
    await asyncio.sleep(START_DELAY_S)
    while True:
        try:
            if await state.redis.set(LOCK_KEY, "1", nx=True, ex=LOCK_TTL_S):
                try:
                    await prewarm_once(state)
                finally:
                    await state.redis.delete(LOCK_KEY)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            get_logger(component="prewarm").warning("prewarm_failed", error=str(exc)[:200])
        await asyncio.sleep(INTERVAL_S)
