"""Hunt consensus (F-35): weighted votes with volunteer weights from gold-field accuracy.

Pure functions: no I/O. Every statistical choice is a module constant below.

Volunteer weight. Each volunteer (anonymous session) answers some gold fields, whose answer is
known. With `c` correct answers out of `n` and a Beta(PRIOR_A, PRIOR_B) = Beta(2, 2) prior on the
probability of answering a gold field correctly, the weight is the posterior mean

    w = (PRIOR_A + c) / (PRIOR_A + PRIOR_B + n)

so a volunteer without gold answers would weigh 0.5, one who is always right tends to 1 and one who
is always wrong tends to 0. A gold answer is correct when the label equals the stored answer. The
weight is a plain accuracy estimate: it does not model per label confusion, and a volunteer is
not penalized for answers on non gold fields.

Minimum. A session counts toward consensus only after it answered at least MIN_GOLD_ANSWERS (2)
current gold fields; without that, five sessions without gold answers would reach the weight
threshold alone. The caller passes weights for eligible sessions only.

Field consensus. For one field with one vote per session, let `W` be the sum of the weights of
the voters and `S_L` the sum of the weights of the voters who chose label `L`. The weighted share
of `L` is `S_L / W`. A field is a candidate ("volunteer consensus, unconfirmed") when all hold:

* at least MIN_VOTES votes (5);
* total weight `W` at least MIN_WEIGHT (2.5, the weight of five volunteers without gold answers);
* the label with the largest share is one of CANDIDATE_LABELS (mover, brightness_change);
* that share is at least THRESHOLD (0.7).

The threshold is a fixed choice, not a calibrated false positive rate: no correction is made for
looking at many fields, and agreement of volunteers is not a detection. Candidates are always
reviewed elsewhere (F-22 checks) and never called discoveries.

Mark. For the consensus label, the weighted mean direction of the voters' optional marks (unit
vectors, so RA wrapping is harmless) and the weighted rms angular distance of the marks from it.
It is reported only with at least MIN_MARKS marks.
"""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

PRIOR_A = 2.0
PRIOR_B = 2.0
MIN_VOTES = 5
MIN_GOLD_ANSWERS = 2  # a session counts toward consensus after this many current gold answers
MIN_WEIGHT = 2.5
THRESHOLD = 0.7
MIN_MARKS = 2
CANDIDATE_LABELS = ("mover", "brightness_change")
CONSENSUS_STATUS = "volunteer_consensus_unconfirmed"  # shown as "volunteer consensus, unconfirmed"


@dataclass(frozen=True)
class Vote:
    session: str
    label: str
    ra_deg: float | None = None
    dec_deg: float | None = None


@dataclass(frozen=True)
class FieldConsensus:
    n_votes: int
    total_weight: float
    shares: dict[str, float]  # weighted share per label (sums to 1 when total_weight > 0)
    top_label: str | None
    top_share: float
    is_candidate: bool
    mark_ra_deg: float | None
    mark_dec_deg: float | None
    mark_rms_arcsec: float | None
    n_marks: int


def volunteer_weight(n_correct: int, n_answered: int) -> float:
    """Posterior mean accuracy under the Beta(2, 2) prior (0.5 with no gold answers)."""
    if n_answered < 0 or not 0 <= n_correct <= n_answered:
        raise ValueError("need 0 <= n_correct <= n_answered")
    return (PRIOR_A + n_correct) / (PRIOR_A + PRIOR_B + n_answered)


def _mean_mark(
    marks: Iterable[tuple[float, float, float]],
) -> tuple[float, float, float] | None:
    """Weighted mean direction (ra, dec in degrees) and weighted rms distance (arcsec)."""
    pts = list(marks)
    sw = sum(w for _, _, w in pts)
    if len(pts) < MIN_MARKS or sw <= 0:
        return None
    vx = vy = vz = 0.0
    for ra, dec, w in pts:
        r, d = math.radians(ra), math.radians(dec)
        vx += w * math.cos(d) * math.cos(r)
        vy += w * math.cos(d) * math.sin(r)
        vz += w * math.sin(d)
    norm = math.sqrt(vx * vx + vy * vy + vz * vz)
    if norm == 0:
        return None
    mx, my, mz = vx / norm, vy / norm, vz / norm
    acc = 0.0
    for ra, dec, w in pts:
        r, d = math.radians(ra), math.radians(dec)
        dot = mx * math.cos(d) * math.cos(r) + my * math.cos(d) * math.sin(r) + mz * math.sin(d)
        acc += w * math.acos(max(-1.0, min(1.0, dot))) ** 2
    rms = math.degrees(math.sqrt(acc / sw)) * 3600.0
    return (
        math.degrees(math.atan2(my, mx)) % 360.0,
        math.degrees(math.asin(max(-1.0, min(1.0, mz)))),
        rms,
    )


def field_consensus(votes: Iterable[Vote], weights: Mapping[str, float]) -> FieldConsensus:
    """Consensus of one field. `weights` maps session to weight (default 0.5 when missing).

    Only the first vote of a session counts."""
    seen: set[str] = set()
    by_label: dict[str, float] = defaultdict(float)
    kept: list[tuple[Vote, float]] = []
    for v in votes:
        if v.session in seen:
            continue
        seen.add(v.session)
        w = weights.get(v.session, volunteer_weight(0, 0))
        by_label[v.label] += w
        kept.append((v, w))
    total = sum(by_label.values())
    n = len(kept)
    shares = {k: (s / total if total > 0 else 0.0) for k, s in by_label.items()}
    top = max(shares, key=lambda k: (shares[k], k)) if shares else None
    top_share = shares[top] if top else 0.0
    is_cand = (
        n >= MIN_VOTES
        and total >= MIN_WEIGHT
        and top in CANDIDATE_LABELS
        and top_share >= THRESHOLD
    )
    mark = None
    n_marks = 0
    if top is not None:
        pts = [
            (v.ra_deg, v.dec_deg, w)
            for v, w in kept
            if v.label == top and v.ra_deg is not None and v.dec_deg is not None
        ]
        n_marks = len(pts)
        mark = _mean_mark(pts)
    return FieldConsensus(
        n_votes=n,
        total_weight=total,
        shares=shares,
        top_label=top,
        top_share=top_share,
        is_candidate=is_cand,
        mark_ra_deg=mark[0] if mark else None,
        mark_dec_deg=mark[1] if mark else None,
        mark_rms_arcsec=mark[2] if mark else None,
        n_marks=n_marks,
    )
