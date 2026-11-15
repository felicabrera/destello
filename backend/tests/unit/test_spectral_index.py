"""Methane 3.3 um index (pipeline/spectral_index.py)."""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from destello.pipeline.spectral_index import BAND_UM, epoch_index, methane_index


def _points(
    flux_of: Any, epoch: int = 0, err: float = 0.01, step: float = 0.02, flagged: bool = False
) -> list[dict[str, Any]]:
    out = []
    for wl in np.arange(2.80, 4.20, step):
        out.append(
            {
                "epoch": epoch,
                "wavelength_um": float(wl),
                "flux": float(flux_of(wl)),
                "flux_err": err,
                "flagged": flagged,
            }
        )
    return out


def test_power_law_gives_one() -> None:
    pts = _points(lambda wl: 2.0 * (wl / 3.0) ** -2.0)
    r = epoch_index(pts)
    assert r is not None
    assert r["index"] == pytest.approx(1.0, abs=1e-3)


def test_band_absorption_lowers_index() -> None:
    lo, hi = BAND_UM

    def f(wl: float) -> float:
        return 1.0 * (0.4 if lo <= wl <= hi else 1.0)

    r = methane_index(_points(f))
    assert r["index"] == pytest.approx(0.4, abs=0.01)
    assert r["depth_sigma"] > 10


def test_flagged_points_ignored_and_none_when_empty() -> None:
    r = methane_index(_points(lambda wl: 1.0, flagged=True))
    assert r["index"] is None
    assert r["epochs"] == []


def test_low_signal_window_rejected() -> None:
    assert epoch_index(_points(lambda wl: 0.01, err=0.5)) is None


def test_epochs_combined_and_scatter_inflates_error() -> None:
    a = _points(lambda wl: 1.0, epoch=0, err=0.001)
    lo, hi = BAND_UM
    b = _points(lambda wl: 0.8 if lo <= wl <= hi else 1.0, epoch=1, err=0.001)
    r = methane_index(a + b)
    assert len(r["epochs"]) == 2
    assert 0.8 < r["index"] < 1.0
    # The two epochs disagree far beyond their formal errors, so the error is scaled up.
    assert r["index_err"] > 0.05
