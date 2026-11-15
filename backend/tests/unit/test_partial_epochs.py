"""F-31 low coverage epochs: planning, sequence identifier and the measurement view."""

from __future__ import annotations

from pathlib import Path

from astropy.time import Time

from destello.api.science import SequenceFiles, low_coverage_epochs, measurable
from destello.core.config import Settings
from destello.pipeline.epochs import group_epochs
from destello.worker.jobs import (
    MIN_EPOCH_IMAGES,
    MIN_PARTIAL_DETECTOR_IMAGES,
    SequenceParams,
    params_sequence_id,
    plan_epochs,
)


def survey() -> tuple[list[float], list[int]]:
    """A pass of 24 images, a revisit 40 days later (5 on D1, 2 on D4), a second pass."""
    mjd = [60900.0 + 0.1 * i for i in range(24)]
    det = [1 + i % 6 for i in range(24)]
    mjd += [60945.0 + 0.1 * i for i in range(7)]
    det += [1, 1, 1, 1, 1, 4, 4]
    mjd += [61100.0 + 0.1 * i for i in range(24)]
    det += [1 + i % 6 for i in range(24)]
    return mjd, det


def test_partial_revisits_are_dropped_by_default() -> None:
    mjd, det = survey()
    epochs = group_epochs(Time(mjd, format="mjd", scale="utc"))
    kept, low = plan_epochs(epochs, det, include_partial=False)
    assert [len(e.members) for e in kept] == [24, 24]
    assert low == {}


def test_partial_revisit_is_kept_in_time_order_on_the_detectors_with_enough_images() -> None:
    mjd, det = survey()
    epochs = group_epochs(Time(mjd, format="mjd", scale="utc"))
    assert len(epochs[1].members) < MIN_EPOCH_IMAGES
    kept, low = plan_epochs(epochs, det, include_partial=True)
    assert [len(e.members) for e in kept] == [24, 7, 24]
    assert list(low) == [1]
    # D4 has 2 images, fewer than the minimum of a low coverage coadd: only D1 is built
    assert MIN_PARTIAL_DETECTOR_IMAGES == 3
    assert low[1] == {1: {24, 25, 26, 27, 28}}


def test_a_revisit_without_a_usable_detector_is_dropped() -> None:
    mjd = [60900.0 + 0.1 * i for i in range(24)] + [60945.0, 60945.1, 60945.2, 60945.3]
    det = [1 + i % 6 for i in range(24)] + [1, 1, 4, 4]
    epochs = group_epochs(Time(mjd, format="mjd", scale="utc"))
    kept, low = plan_epochs(epochs, det, include_partial=True)
    assert len(kept) == 1 and low == {}


def test_include_partial_changes_the_identifier_only_when_set() -> None:
    settings = Settings(pipeline_version="test")
    base = SequenceParams(ra_deg=10.0, dec_deg=-5.0, fov_arcmin=12.0)
    off = SequenceParams(ra_deg=10.0, dec_deg=-5.0, fov_arcmin=12.0, include_partial=False)
    on = SequenceParams(ra_deg=10.0, dec_deg=-5.0, fov_arcmin=12.0, include_partial=True)
    assert "partial" not in base.mode_params()
    assert params_sequence_id(base, settings) == params_sequence_id(off, settings)
    assert params_sequence_id(base, settings) != params_sequence_id(on, settings)
    assert SequenceParams.from_dict(on.to_dict()) == on
    old_sidecar = {k: v for k, v in base.to_dict().items() if k != "include_partial"}
    assert SequenceParams.from_dict(old_sidecar) == base


def test_measurements_do_not_see_low_coverage_epochs(tmp_path: Path) -> None:
    manifest = {
        "epochs": [
            {"index": 0, "frames": []},
            {"index": 1, "frames": [], "coverage": "low"},
            {"index": 2, "frames": [], "coverage": "full"},
        ]
    }
    sidecar = {"exposures": [{"epoch": 0, "obs_id": "a"}, {"epoch": 1, "obs_id": "b"}]}
    seq = SequenceFiles(sid="s", data_dir=tmp_path, manifest=manifest, sidecar=sidecar)
    assert low_coverage_epochs(manifest) == {1}
    view = measurable(seq)
    assert [e["index"] for e in view.manifest["epochs"]] == [0, 2]
    assert [e["obs_id"] for e in view.sidecar["exposures"]] == ["a"]
    assert len(seq.manifest["epochs"]) == 3  # the stored documents are not modified
    plain = SequenceFiles(
        sid="s", data_dir=tmp_path, manifest={"epochs": [{"index": 0}]}, sidecar={}
    )
    assert measurable(plain) is plain


def test_estimate_counts_the_low_coverage_images_only_when_asked() -> None:
    from types import SimpleNamespace

    from destello.api.routes.sequences import usage_summary

    mjd, det = survey()
    recs = [
        SimpleNamespace(t_mid=Time(m, format="mjd", scale="utc"), detector=d)
        for m, d in zip(mjd, det, strict=True)
    ]
    assert usage_summary(recs) == {"used": 48, "epochs": 2, "detectors": 6}
    assert usage_summary(recs, include_partial=True) == {"used": 53, "epochs": 3, "detectors": 6}
