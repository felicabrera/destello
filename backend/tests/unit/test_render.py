from typing import Any

import numpy as np

from destello.pipeline.render import (
    apply_diverging,
    apply_stretch,
    compute_stretch,
    diverging_limit,
    to_webp,
)


def frames() -> list[Any]:
    rng = np.random.default_rng(0)
    out = []
    for gain in (1.0, 1.5, 2.0):
        f = rng.normal(0.2, 0.05, (64, 64)) * gain
        f[30:33, 30:33] += 20 * gain
        f[0:3, 0:3] = np.nan
        out.append(f)
    return out


def test_one_stretch_shared_by_all_epochs() -> None:
    fr = frames()
    st = compute_stretch(fr)
    assert st.method == "asinh" and st.vmax > st.vmin
    # the same limits applied to each epoch: a brighter epoch renders brighter at the same pixel
    outs = [apply_stretch(f, st) for f in fr]
    assert outs[0][31, 31] <= outs[1][31, 31] <= outs[2][31, 31]


def test_monotonic_and_nan_handling() -> None:
    st = compute_stretch(frames())
    x = np.linspace(st.vmin - 1, st.vmax + 1, 500)
    y = apply_stretch(x, st)
    assert np.all(np.diff(y.astype(int)) >= 0)
    z = apply_stretch(np.array([np.nan, st.vmin, st.vmax]), st)
    assert z[0] == 0 and z[1] == 0 and z[2] == 255


def test_stretch_ignores_masked_pixels() -> None:
    fr = frames()
    fr[0][10:20, 10:20] = np.nan
    st = compute_stretch(fr)
    assert np.isfinite(st.vmin) and st.vmax > st.vmin


def test_diverging_symmetric_and_webp_valid() -> None:
    d = np.random.default_rng(2).normal(0, 1, (50, 50))
    lim = diverging_limit(d)
    out = apply_diverging(np.array([[-lim, 0.0, lim]]), lim)
    assert out[0, 1] == 128 and out[0, 0] == 1 and out[0, 2] == 255
    data = to_webp(apply_stretch(frames()[0], compute_stretch(frames())))
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP"
