from typing import Any

import numpy as np
from astropy.time import Time

from destello.pipeline.epochs import group_epochs


def T(vals: Any) -> Time:
    return Time(np.array(vals, dtype=float), format="mjd", scale="utc")


def test_single_epoch() -> None:
    eps = group_epochs(T([60000, 60001, 60005]))
    assert len(eps) == 1 and eps[0].members == (0, 1, 2)


def test_two_epochs_six_months_apart() -> None:
    eps = group_epochs(T(list(range(60000, 60010)) + list(range(60182, 60192))))
    assert [len(e.members) for e in eps] == [10, 10]
    assert eps[0].t_mid.mjd < eps[1].t_mid.mjd and eps[1].index == 1


def test_unsorted_input_keeps_input_indices() -> None:
    eps = group_epochs(T([60200, 60000, 60201, 60001]))
    assert eps[0].members == (1, 3) and eps[1].members == (0, 2)


def test_gap_exactly_at_threshold_stays_together() -> None:
    assert len(group_epochs(T([60000, 60020]), gap_days=20)) == 1
    assert len(group_epochs(T([60000, 60020.0001]), gap_days=20)) == 2


def test_deep_field_dense_sampling() -> None:
    eps = group_epochs(T(np.arange(60000, 60400, 0.5)))
    assert len(eps) == 1


def test_empty() -> None:
    assert group_epochs(T([])) == []
