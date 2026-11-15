"""Preset measurement prewarm: requests mirror the Explorer defaults and failures are isolated."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from destello.api import prewarm
from destello.core.config import Settings
from destello.models.targets import load_targets


def _state(tmp_path: Path, presets: dict[str, Any]) -> Any:
    (tmp_path / prewarm.PINS_FILE).write_text(json.dumps({"presets": presets}), encoding="utf-8")
    return SimpleNamespace(settings=Settings(data_dir=tmp_path))


def test_requests_use_the_registry_position_and_default_detector(tmp_path: Path) -> None:
    state = _state(
        tmp_path,
        {
            "barnard": {"sequence_id": "a" * 16},
            "rdra": {"sequence_id": "b" * 16},
            "unknown": {"sequence_id": "c" * 16},  # not in the registry: ignored
            "rwaur": {},  # no sequence yet: ignored
        },
    )
    reqs = {tid: (sid, req) for tid, sid, req in prewarm.preset_requests(state)}
    assert set(reqs) == {"barnard", "rdra"}
    targets = load_targets()
    for tid, (sid, req) in reqs.items():
        assert sid == {"barnard": "a" * 16, "rdra": "b" * 16}[tid]
        assert req.ra_deg == targets[tid].astrometry.ra_deg
        assert req.dec_deg == targets[tid].astrometry.dec_deg
        det = targets[tid].default_view.det
        assert req.detector == (det if isinstance(det, int) else None)
        # The server applies its own astrometry to a preset: no motion is sent, as in the Explorer.
        assert req.pmra_masyr is None and req.pmdec_masyr is None and req.ref_epoch is None
        assert req.reference == "literature" and req.fit_parallax is False


def test_no_pins_file_means_nothing_to_do(tmp_path: Path) -> None:
    state = SimpleNamespace(settings=Settings(data_dir=tmp_path))
    assert prewarm.preset_requests(state) == []
    assert asyncio.run(prewarm.prewarm_once(state)) == {"done": 0, "failed": 0}


def test_a_failed_measurement_does_not_stop_the_others(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state = _state(
        tmp_path, {"barnard": {"sequence_id": "a" * 16}, "rdra": {"sequence_id": "b" * 16}}
    )
    calls: list[tuple[str, str]] = []

    async def spectrum(_state: Any, sid: str, ra: float, dec: float) -> dict[str, Any]:
        calls.append(("spectrum", sid))
        if sid == "a" * 16:
            raise RuntimeError("catalog did not answer")
        return {}

    async def astrometry(_state: Any, sid: str, req: Any) -> dict[str, Any]:
        calls.append(("astrometry", sid))
        return {}

    monkeypatch.setattr(prewarm, "spectrum_doc", spectrum)
    monkeypatch.setattr(prewarm, "astrometry_doc", astrometry)
    out = asyncio.run(prewarm.prewarm_once(state))
    assert out == {"done": 3, "failed": 1}
    assert calls == [
        ("spectrum", "a" * 16),
        ("astrometry", "a" * 16),
        ("spectrum", "b" * 16),
        ("astrometry", "b" * 16),
    ]


def test_saturated_core_warning_states_what_was_measured() -> None:
    from destello.worker.jobs import saturated_core_warning

    phot = [
        {"epoch": 0, "detector": 5, "reason": "saturated_core"},
        {"epoch": 0, "detector": 6, "reason": None},
        {"epoch": 1, "detector": 5, "reason": "saturated_core"},
        {"epoch": 1, "detector": 2, "reason": "low_coverage"},
    ]
    w = saturated_core_warning(phot)
    assert w is not None and w.code == "SATURATED_CORE"
    assert "saturated in 2 of 4 coadds (detectors D5)" in w.detail
    assert saturated_core_warning([{"epoch": 0, "detector": 1, "reason": None}]) is None
    assert saturated_core_warning([]) is None
