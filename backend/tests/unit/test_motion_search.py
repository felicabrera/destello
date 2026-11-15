"""F-32 motion search on synthetic arrays (test data only; the product never simulates)."""

from typing import Any

import numpy as np
import pytest

from destello.pipeline import motion_search as ms

N = 120
SIGMA = 0.3
TIMES = (2025.70, 2026.25, 2026.80)  # three survey passes, 1.1 yr baseline


def blob(x: float, y: float, flux: float) -> Any:
    yy, xx = np.mgrid[0:N, 0:N]
    return flux * np.exp(-0.5 * ((xx - x) ** 2 + (yy - y) ** 2) / 1.6**2)


def field(seed: int = 3, n_stars: int = 25) -> list[tuple[float, float, float]]:
    rng = np.random.default_rng(seed)
    pos: list[tuple[float, float, float]] = []
    while len(pos) < n_stars:
        x, y = rng.uniform(15, N - 15, 2)
        if all(np.hypot(x - a, y - b) > 14 for a, b, _ in pos):
            pos.append((float(x), float(y), float(rng.uniform(20, 120))))
    return pos


def epochs(
    mover: tuple[float, float, float, float, float] | None = None,
    times: tuple[float, ...] = TIMES,
    gains: tuple[float, ...] = (1.0, 1.15, 0.9),
) -> list[ms.EpochImage]:
    """Static stars plus an optional mover (x, y at the mean time, vx, vy in px/yr, flux)."""
    stars = field()
    t_mean = float(np.mean(times))
    out = []
    for i, t in enumerate(times):
        rng = np.random.default_rng(100 + i)
        img = rng.normal(0.0, SIGMA, (N, N))
        for x, y, f in stars:
            img += gains[i] * blob(x, y, f)
        if mover is not None:
            mx, my, vx, vy, f = mover
            img += gains[i] * blob(mx + vx * (t - t_mean), my + vy * (t - t_mean), f)
        out.append(ms.EpochImage(i, t, img, np.full((N, N), SIGMA**2)))
    return out


def test_trial_motions_skip_static_and_duplicate_shifts() -> None:
    dt = [-0.55, 0.0, 0.55]
    trials = ms.trial_motions(dt, v_max_pix=4.0, step_pix=1.0 / 1.1)
    shifts = [s for _, _, s in trials]
    assert len(shifts) == len(set(shifts))
    assert all(any(p != (0, 0) for p in s) for s in shifts)
    assert all(np.hypot(vx, vy) <= 4.0 + 1e-9 for vx, vy, _ in trials)
    # the slowest motion that moves the outer epochs by one pixel is present
    assert any(s == ((-1, 0), (0, 0), (1, 0)) for s in shifts)


def test_shifted_reads_from_the_offset_and_pads_with_nan() -> None:
    img = np.arange(16, dtype=float).reshape(4, 4)
    out = ms._shifted(img, 1, 0)
    assert out[0, 0] == img[0, 1] and np.isnan(out[0, 3])
    out = ms._shifted(img, 0, -2)
    assert np.isnan(out[1, 0]) and out[2, 0] == img[0, 0]


def test_static_field_gives_no_peaks() -> None:
    res = ms.search_detector(epochs(), v_max_pix_per_year=4.0)
    assert res.usable and res.n_trials > 0
    assert res.peaks == ()


def clear_spot(min_sep: float = 12.0) -> tuple[float, float]:
    """A position at least `min_sep` pixels from every field star."""
    stars = field()
    for y in range(20, N - 20, 2):
        for x in range(20, N - 20, 2):
            if all(np.hypot(x - a, y - b) >= min_sep for a, b, _ in stars):
                return float(x), float(y)
    raise AssertionError("no clear spot")


def test_injected_mover_is_found_and_tracked_on_every_epoch() -> None:
    x0, y0 = clear_spot()
    mover = (x0, y0, 3.0, -1.5, 15.0)
    res = ms.search_detector(epochs(mover), v_max_pix_per_year=4.0)
    assert res.usable and len(res.peaks) >= 1
    best = res.peaks[0]
    p = best.peak
    assert np.hypot(p.x - x0, p.y - y0) <= 1.5
    assert p.snr > ms.DETECTION_SIGMA and min(p.epoch_snr) >= ms.EPOCH_MIN_SIGMA
    assert best.complete
    t_mean = float(np.mean(TIMES))
    for c, t in zip(best.centroids, TIMES, strict=True):
        assert c is not None
        assert abs(c.x - (x0 + 3.0 * (t - t_mean))) < 0.3
        assert abs(c.y - (y0 - 1.5 * (t - t_mean))) < 0.3


def test_a_centroid_captured_by_a_static_star_is_dropped_not_used() -> None:
    # The mover passes 4 to 5 pixels from a bright field star.
    x0, y0, _ = max(field(), key=lambda s: s[2])
    mover = (x0 - 4.5, y0 + 1.0, 3.0, 0.0, 15.0)
    res = ms.search_detector(epochs(mover), v_max_pix_per_year=4.0)
    t_mean = float(np.mean(TIMES))
    for tp in res.peaks:
        for c, t in zip(tp.centroids, TIMES, strict=True):
            if c is None:
                continue
            true_x = mover[0] + 3.0 * (t - t_mean)
            on_star = np.hypot(c.x - x0, c.y - y0) < 1.0
            assert not on_star or abs(true_x - x0) < 1.0


def test_motion_beyond_the_search_bound_is_not_reported_as_slow() -> None:
    mover = (60.0, 45.0, 12.0, 0.0, 15.0)
    res = ms.search_detector(epochs(mover), v_max_pix_per_year=4.0)
    for tp in res.peaks:
        assert np.hypot(tp.peak.x - 60.0, tp.peak.y - 45.0) > 1.5 or not tp.complete


@pytest.mark.parametrize("times", [(2025.7, 2026.25), (2025.70, 2025.80, 2025.90)])
def test_too_few_epochs_or_short_baseline_is_not_usable(times: tuple[float, ...]) -> None:
    res = ms.search_detector(epochs(times=times, gains=(1.0,) * len(times)), 4.0)
    assert not res.usable and res.peaks == () and res.n_trials == 0
