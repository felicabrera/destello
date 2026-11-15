"""Hunt consensus (F-35): volunteer weights and field consensus."""

from __future__ import annotations

import pytest

from destello.pipeline import hunt as h


def test_weight_prior_and_extremes() -> None:
    assert h.volunteer_weight(0, 0) == 0.5
    assert h.volunteer_weight(10, 10) == pytest.approx(12 / 14)
    assert h.volunteer_weight(0, 10) == pytest.approx(2 / 14)
    assert h.volunteer_weight(3, 4) == pytest.approx(5 / 8)
    with pytest.raises(ValueError):
        h.volunteer_weight(3, 2)


def votes(labels: list[str]) -> list[h.Vote]:
    return [h.Vote(f"s{i}", lab) for i, lab in enumerate(labels)]


def test_candidate_needs_votes_share_and_label() -> None:
    four = h.field_consensus(votes(["mover"] * 4), {})
    assert not four.is_candidate  # fewer than MIN_VOTES
    five = h.field_consensus(votes(["mover"] * 5), {})
    assert five.is_candidate and five.top_label == "mover" and five.top_share == 1.0
    split = h.field_consensus(votes(["mover"] * 3 + ["nothing"] * 2), {})
    assert not split.is_candidate and split.top_share == pytest.approx(0.6)
    edge = h.field_consensus(votes(["mover"] * 7 + ["nothing"] * 3), {})
    assert edge.is_candidate and edge.top_share == pytest.approx(0.7)
    quiet = h.field_consensus(votes(["nothing"] * 9), {})
    assert not quiet.is_candidate  # agreement on a non candidate label


def test_weights_change_the_outcome() -> None:
    v = votes(["mover"] * 3 + ["nothing"] * 3)
    even = h.field_consensus(v, {})
    assert even.top_share == pytest.approx(0.5)
    w = {f"s{i}": h.volunteer_weight(10, 10) for i in range(3)}  # the movers are reliable
    w.update({f"s{i}": h.volunteer_weight(0, 10) for i in range(3, 6)})
    weighted = h.field_consensus(v, w)
    assert weighted.top_label == "mover" and weighted.top_share == pytest.approx(0.8571, abs=1e-3)
    assert weighted.is_candidate


def test_total_weight_floor() -> None:
    bad = {f"s{i}": h.volunteer_weight(0, 20) for i in range(5)}  # weight 2/24 each
    c = h.field_consensus(votes(["mover"] * 5), bad)
    assert c.n_votes == 5 and not c.is_candidate


def test_one_vote_per_session() -> None:
    v = [h.Vote("a", "mover")] * 10
    assert h.field_consensus(v, {}).n_votes == 1


def test_mark_mean_and_ra_wrap() -> None:
    v = [
        h.Vote("a", "mover", 359.999, 10.0),
        h.Vote("b", "mover", 0.001, 10.0),
        h.Vote("c", "nothing", 180.0, -10.0),
    ]
    c = h.field_consensus(v, {})
    assert c.n_marks == 2
    assert c.mark_ra_deg is not None
    assert min(c.mark_ra_deg, 360 - c.mark_ra_deg) < 1e-6
    assert c.mark_dec_deg == pytest.approx(10.0, abs=1e-6)
    assert c.mark_rms_arcsec == pytest.approx(3.545, abs=0.01)
    single = h.field_consensus([h.Vote("a", "mover", 1.0, 1.0)], {})
    assert single.mark_ra_deg is None
