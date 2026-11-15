"""When releases overlap, only the newest processing of an exposure is used."""

from __future__ import annotations

import astropy.units as u
from astropy.time import Time

from destello.pipeline.query import ImageRecord, latest_versions, processing_rank


def _rec(
    observation: str, det: int, collection: str, suffix: str, t: float = 61000.0
) -> ImageRecord:
    return ImageRecord(
        obs_id=f"level2_{observation}D{det}_spx_l2b-{suffix}",
        observation_id=observation,
        plane_id=f"{observation}-{det}-{collection}-{suffix}",
        detector=det,
        collection=collection,
        uri=f"ibe/data/spherex/x/level2_{observation}D{det}_spx_l2b-{suffix}.fits",
        t_start=Time(t, format="mjd", scale="utc"),
        t_end=Time(t + 0.001, format="mjd", scale="utc"),
        wave_min=0.75 * u.um,
        wave_max=1.1 * u.um,
        exposure_s=113.0,
        content_length=1,
    )


def test_newer_pipeline_version_replaces_the_older_one() -> None:
    old = _rec("2026W11_1A_0430_2", 1, "spherex_qr2", "v24-2026-094")
    new = _rec("2026W11_1A_0430_2", 1, "spherex_qr3", "v27-2026-290")
    other = _rec("2026W11_1A_0431_2", 1, "spherex_qr2", "v24-2026-094", 61000.1)
    assert latest_versions([old, other, new]) == [other, new]
    assert latest_versions([new, other, old]) == [new, other]


def test_same_version_prefers_later_processing_date_then_later_release() -> None:
    a = _rec("2026W11_1A_0430_2", 3, "spherex_qr2", "v24-2026-094")
    b = _rec("2026W11_1A_0430_2", 3, "spherex_qr2", "v24-2026-120")
    assert latest_versions([a, b]) == [b]
    c = _rec("2026W11_1A_0430_2", 3, "spherex_qr3", "v24-2026-120")
    assert latest_versions([b, c]) == [c]
    assert processing_rank(c) > processing_rank(b) > processing_rank(a)


def test_detectors_and_distinct_exposures_are_never_merged() -> None:
    recs = [
        _rec("2026W11_1A_0430_2", 1, "spherex_qr2", "v24-2026-094"),
        _rec("2026W11_1A_0430_2", 2, "spherex_qr2", "v24-2026-094"),
        _rec("2026W11_1A_0999_2", 1, "spherex_qr3", "v27-2026-290"),
    ]
    assert latest_versions(recs) == recs
    assert latest_versions([]) == []


def test_names_without_a_processing_tag_still_resolve_deterministically() -> None:
    a = _rec("2026W11_1A_0430_2", 1, "spherex_qr2", "x")
    b = _rec("2026W11_1A_0430_2", 1, "spherex_qr3", "x")
    assert latest_versions([a, b]) == [b] and latest_versions([b, a]) == [b]
