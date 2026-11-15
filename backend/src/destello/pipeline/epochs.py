"""Epoch grouping by observation time (docs/03 section 4.1 step 3)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from astropy.time import Time

from destello.core.config import EPOCH_GAP_DAYS


@dataclass(frozen=True)
class Epoch:
    """A group of exposures separated from the next group by more than the gap threshold."""

    index: int  # 0-based, chronological
    members: tuple[int, ...]  # indices into the input array
    t_start: Time
    t_end: Time
    t_mid: Time  # mean of member mid-times


def group_epochs(times: Time, gap_days: float = EPOCH_GAP_DAYS) -> list[Epoch]:
    """Cluster exposure mid-times into epochs.

    The input need not be sorted. A new epoch starts when the gap to the previous exposure is
    strictly greater than `gap_days`; a gap exactly equal to the threshold stays in the same
    epoch. Returns epochs in chronological order; member indices refer to the input order.
    """
    mjd: npt.NDArray[np.float64] = np.atleast_1d(np.asarray(times.utc.mjd, dtype=np.float64))
    if mjd.size == 0:
        return []
    order = np.argsort(mjd, kind="stable")
    sorted_mjd = mjd[order]
    breaks = np.nonzero(np.diff(sorted_mjd) > gap_days)[0] + 1
    groups = np.split(np.arange(mjd.size), breaks)
    epochs: list[Epoch] = []
    for i, g in enumerate(groups):
        members = tuple(int(k) for k in order[g])
        vals = mjd[list(members)]
        epochs.append(
            Epoch(
                index=i,
                members=members,
                t_start=Time(float(vals.min()), format="mjd", scale="utc"),
                t_end=Time(float(vals.max()), format="mjd", scale="utc"),
                t_mid=Time(float(vals.mean()), format="mjd", scale="utc"),
            )
        )
    return epochs
