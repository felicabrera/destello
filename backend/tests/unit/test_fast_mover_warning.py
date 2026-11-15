"""FAST_MOVER_NEAR_EDGE manifest warning (docs/06 section 3.4)."""

from __future__ import annotations

from astropy.time import Time

from destello.models.targets import load_targets
from destello.worker.jobs import (
    FAST_MOVER_EDGE_FRACTION,
    _science_warnings,
    fast_mover_offset,
    preset_params,
)

TIMES = [Time("2025-05-01"), Time("2025-11-01"), Time("2026-05-01"), Time("2026-11-01")]


def _codes(fov: float, times: list[Time] = TIMES) -> set[str]:
    params = preset_params(load_targets()["wise0855"])
    params = type(params).from_dict({**params.to_dict(), "fov_arcmin": fov})
    return {w.code for w in _science_warnings(params, None, {}, times)}


def test_fast_mover_in_a_small_field_is_flagged() -> None:
    # About 8 arcsec/yr: sixteen years of epochs move it some 65 arcsec each side of the center,
    # beyond 80 percent of the 60 arcsec half field.
    assert "FAST_MOVER_NEAR_EDGE" in _codes(2.0, [Time("2018-01-01"), Time("2034-01-01")])
    assert "FAST_MOVER_NEAR_EDGE" not in _codes(2.0)


def test_large_field_keeps_the_mover_inside() -> None:
    assert "FAST_MOVER_NEAR_EDGE" not in _codes(30.0)


def test_static_position_has_no_offset() -> None:
    params = preset_params(load_targets()["rdra"])
    offset = fast_mover_offset(params, TIMES)
    assert offset is None or offset < FAST_MOVER_EDGE_FRACTION
