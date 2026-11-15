"""Cutout paths from a build sidecar stay inside the data directory."""

from __future__ import annotations

from pathlib import Path

import pytest

from destello.api.science import ScienceError, exposure_path


def test_relative_path_resolves_under_the_data_dir(tmp_path: Path) -> None:
    p = exposure_path(tmp_path, {"path": "cutouts/ab/x.fits"})
    assert p == Path(tmp_path).resolve() / "cutouts" / "ab" / "x.fits"


@pytest.mark.parametrize(
    "rel", ["../outside.fits", "cutouts/../../outside.fits", "/etc/passwd", ".", "cutouts/.."]
)
def test_paths_that_leave_the_data_dir_are_rejected(tmp_path: Path, rel: str) -> None:
    with pytest.raises(ScienceError):
        exposure_path(tmp_path, {"path": rel})
