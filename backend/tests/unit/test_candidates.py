"""F-29 candidate detection on synthetic arrays (test data only; the product never simulates)."""

from typing import Any

import numpy as np

from destello.pipeline import candidates as cd
from destello.pipeline.difference import difference

SIGMA = 0.3


def star_field(n: int = 140, n_stars: int = 25, seed: int = 3) -> tuple[Any, Any, Any]:
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:n, 0:n]
    img = np.zeros((n, n))
    pos: list[tuple[float, float]] = []
    while len(pos) < n_stars:
        x, y = rng.uniform(15, n - 15, 2)
        if all(np.hypot(x - a, y - b) > 14 for a, b in pos):
            pos.append((x, y))
            img += rng.uniform(20, 120) * blob(xx, yy, x, y, 1.0)
    return img, xx, yy


def blob(xx: Any, yy: Any, x: float, y: float, flux: float) -> Any:
    return flux * np.exp(-0.5 * ((xx - x) ** 2 + (yy - y) ** 2) / 1.6**2)


def pair(extra_a: Any = 0.0, extra_b: Any = 0.0, seed: int = 9) -> tuple[Any, Any, Any]:
    stars, _, _ = star_field()
    rng = np.random.default_rng(seed)
    a = 1.07 * stars + extra_a + rng.normal(0, SIGMA, stars.shape)
    b = stars + extra_b + rng.normal(0, SIGMA, stars.shape)
    return a, b, np.full(stars.shape, SIGMA**2)


def features(a: Any, b: Any, var: Any) -> tuple[cd.Significance, list[cd.Feature]]:
    res = difference(a, b, var_a=var, var_b=var)
    sig = cd.significance_map(res, a, var, var)
    return sig, cd.detect_features(sig)


def empty_spot(stars: Any, xx: Any, yy: Any, last: bool = False) -> Any:
    """A pixel far from every star (the first or the last such pixel), away from the border."""
    from scipy.ndimage import maximum_filter

    near = maximum_filter(stars, size=19)
    ok = (near < 0.01) & (xx > 20) & (xx < 120) & (yy > 20) & (yy < 120)
    ys, xs = np.nonzero(ok)
    assert len(xs) > 0
    i = -1 if last else 0
    return float(xs[i]), float(ys[i])


def test_static_field_gives_no_features() -> None:
    a, b, var = pair()
    sig, found = features(a, b, var)
    assert sig.usable and found == []


def test_mover_is_one_dipole_with_lobes_at_both_positions() -> None:
    stars, xx, yy = star_field()
    x, y = empty_spot(stars, xx, yy)
    a, b, var = pair(blob(xx, yy, x + 3, y, 40), blob(xx, yy, x, y, 40))
    _, found = features(a, b, var)
    moved = [f for f in found if f.kind == "moved"]
    assert len(moved) == 1 and len(found) == 1
    f = moved[0]
    assert abs(f.x_a - (x + 3)) <= 1.5 and abs(f.x_b - x) <= 1.5
    assert abs(f.y_a - y) <= 1 and abs(f.y_b - y) <= 1
    assert f.snr > cd.DETECTION_SIGMA and not f.near_blank


def test_unpaired_lobes_keep_their_sign() -> None:
    stars, xx, yy = star_field()
    xa, ya = empty_spot(stars, xx, yy)
    xb, yb = empty_spot(stars, xx, yy, last=True)
    assert np.hypot(xa - xb, ya - yb) > 10
    a, b, var = pair(blob(xx, yy, xa, ya, 40), blob(xx, yy, xb, yb, 40))
    _, found = features(a, b, var)
    kinds = {f.kind: f for f in found}
    assert set(kinds) == {"brighter_in_a", "brighter_in_b"} and len(found) == 2
    assert (kinds["brighter_in_a"].x, kinds["brighter_in_a"].y) == (xa, ya)
    assert (kinds["brighter_in_b"].x, kinds["brighter_in_b"].y) == (xb, yb)


def test_feature_next_to_missing_data_is_flagged() -> None:
    stars, xx, yy = star_field()
    x, y = empty_spot(stars, xx, yy)
    a, b, var = pair(blob(xx, yy, x, y, 40))
    a[int(y) + 1, int(x) + 1] = np.nan
    _, found = features(a, b, var)
    assert [f.near_blank for f in found if f.kind == "brighter_in_a"] == [True]


def test_too_few_pixels_is_not_usable() -> None:
    a, b, var = pair()
    a[:, 5:] = np.nan
    a[10:, :] = np.nan  # 50 pixels left
    sig, found = features(a, b, var)
    assert not sig.usable and found == []


def test_significance_is_never_inflated() -> None:
    """Variances stated ten times too large must not be rescaled up to unit width."""
    a, b, var = pair()
    res = difference(a, b, var_a=var * 100, var_b=var * 100)
    sig = cd.significance_map(res, a, var * 100, var * 100)
    z = sig.z[np.isfinite(sig.z)]
    assert float(np.median(np.abs(z))) * 1.4826 < 0.3


def feat(kind: str, x: float, y: float, snr: float, near_blank: bool = False) -> cd.Feature:
    return cd.Feature(kind, x, y, x, y, x, y, snr, snr, near_blank)


def test_merge_groups_same_kind_across_detectors() -> None:
    merged = cd.merge_detectors(
        {
            1: [feat("brighter_in_a", 50, 50, 8.0), feat("brighter_in_b", 51, 50, 7.0)],
            2: [feat("brighter_in_a", 51, 51, 12.0, near_blank=True)],
            3: [feat("brighter_in_a", 90, 20, 30.0)],
        }
    )
    assert [(c.feature.kind, c.detectors) for c in merged] == [
        ("brighter_in_a", (1, 2)),
        ("brighter_in_a", (3,)),
        ("brighter_in_b", (1,)),
    ]
    first = merged[0]
    # positions of the most significant member; not near blank because detector 1 is clean
    assert (first.feature.x, first.feature.y) == (51, 51) and first.snr_by_detector == (8.0, 12.0)
    assert first.feature.near_blank is False


def test_merge_keeps_two_features_of_one_detector_apart() -> None:
    merged = cd.merge_detectors(
        {4: [feat("brighter_in_a", 50, 50, 9.0), feat("brighter_in_a", 51, 50, 8.0)]}
    )
    assert [c.detectors for c in merged] == [(4,), (4,)]


def test_local_peaks_ignore_nan_and_threshold() -> None:
    z = np.zeros((9, 9))
    z[4, 4], z[2, 7], z[7, 1] = 9.0, 4.0, np.nan
    assert cd.local_peaks(z, 5.0) == [(4.0, 4.0)]
    assert (
        cd.blank_neighbors(~np.isfinite(z))[6, 2] and not cd.blank_neighbors(~np.isfinite(z))[4, 4]
    )


def test_smooth_halo_change_is_not_compact_but_a_point_source_is() -> None:
    stars, xx, yy = star_field()
    x, y = empty_spot(stars, xx, yy)
    halo = 6.0 * np.exp(-0.5 * ((xx - 70) ** 2 + (yy - 70) ** 2) / 25.0**2)  # broad, only in A
    a, b, var = pair(halo + blob(xx, yy, x, y, 40))
    sig, found = features(a, b, var)
    point = [f for f in found if (f.x, f.y) == (x, y)]
    assert len(point) == 1 and point[0].snr_local > cd.DETECTION_SIGMA
    smooth = [f for f in found if (f.x, f.y) != (x, y) and f.kind == "brighter_in_a"]
    assert smooth and all(f.snr > cd.DETECTION_SIGMA for f in smooth)
    assert all(not f.snr_local >= cd.DETECTION_SIGMA for f in smooth)


def test_local_snr_without_surrounding_data_is_nan() -> None:
    a, b, var = pair()
    res = difference(a, b, var_a=var, var_b=var)
    sig = cd.significance_map(res, a, var, var)
    sig.diff[40:60, 40:60] = np.nan
    sig.diff[50, 50] = 9.0
    assert np.isnan(cd.local_snr(sig, 50, 50))
