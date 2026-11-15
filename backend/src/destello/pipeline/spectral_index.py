"""Methane 3.3 um band index from single-exposure spectrum points (docs/03 section 4.8).

Pure functions: input is the list of spectrum points of `compute_spectrum` (wavelength in um, flux
density and error in Jy, flags), output is a plain dict. No network, no files.

The index is the flux density in the band window divided by the continuum interpolated across it
from a blue and a red window, linearly in log flux against log wavelength. A power law in F_nu
(for example the Rayleigh-Jeans tail of a stellar photosphere) gives exactly 1; methane absorption
in T and Y dwarfs makes it smaller than 1. The windows are fixed here, before any measurement.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

METHANE_INDEX_VERSION = "1"
BLUE_UM = (2.90, 3.10)
BAND_UM = (3.20, 3.45)
RED_UM = (3.85, 4.10)
MIN_POINTS = 2  # unflagged points per window and epoch
MIN_WINDOW_SNR = 3.0  # each window mean must be measured at this significance


def window_stats(points: list[dict[str, Any]], lo: float, hi: float) -> dict[str, Any]:
    """Points, mean wavelength, mean flux, error and S/N of the usable points in [lo, hi] um.

    Same selection and estimator as `_window`; fields other than `n_points` are None when fewer
    than MIN_POINTS points are present.
    """
    sel = [
        p
        for p in points
        if p.get("flux") is not None
        and p.get("flux_err") is not None
        and not p.get("flagged")
        and p.get("wavelength_um") is not None
        and lo <= float(p["wavelength_um"]) <= hi
    ]
    out: dict[str, Any] = {
        "n_points": len(sel),
        "wavelength_um": None,
        "mean_jy": None,
        "err_jy": None,
        "snr": None,
    }
    if len(sel) < MIN_POINTS:
        return out
    f = np.array([float(p["flux"]) for p in sel])
    e = np.array([float(p["flux_err"]) for p in sel])
    formal = float(np.sqrt(np.sum(e**2)) / len(f))
    sem = float(np.std(f, ddof=1) / np.sqrt(len(f)))
    err = max(formal, sem)
    mean = float(np.mean(f))
    out.update(
        wavelength_um=float(np.mean([float(p["wavelength_um"]) for p in sel])),
        mean_jy=mean,
        err_jy=err,
        snr=mean / err if err > 0 else None,
    )
    return out


def _window(
    points: list[dict[str, Any]], lo: float, hi: float
) -> tuple[float, float, float] | None:
    """(mean wavelength, mean flux, error) of the unflagged points in [lo, hi] um.

    The mean is unweighted, as in the per-epoch photometry (each exposure samples a different
    wavelength); the error is the larger of the propagated formal error and the standard error.
    """
    st = window_stats(points, lo, hi)
    if st["n_points"] < MIN_POINTS:
        return None
    mean, err = st["mean_jy"], st["err_jy"]
    if not (mean > 0 and err > 0 and mean / err >= MIN_WINDOW_SNR):
        return None
    return st["wavelength_um"], mean, err


def epoch_index(points: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Index of one epoch, or None when a window has too few points or too little signal."""
    blue = _window(points, *BLUE_UM)
    band = _window(points, *BAND_UM)
    red = _window(points, *RED_UM)
    if blue is None or band is None or red is None:
        return None
    (lb, fb, eb), (lc, fc, ec), (lr, fr, er) = blue, band, red
    w = math.log(lc / lb) / math.log(lr / lb)
    cont = math.exp((1.0 - w) * math.log(fb) + w * math.log(fr))
    index = fc / cont
    sig_ln = math.sqrt((ec / fc) ** 2 + ((1.0 - w) * eb / fb) ** 2 + (w * er / fr) ** 2)
    return {
        "index": index,
        "index_err": index * sig_ln,
        "band_flux": fc,
        "continuum_flux": cont,
        "wavelength_um": {"blue": lb, "band": lc, "red": lr},
    }


def methane_index(points: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-epoch indices and their inverse-variance mean in log (each epoch is one survey pass,
    so a variable source is compared within one pass). `index` is None when no epoch qualifies."""
    by_epoch: dict[int, list[dict[str, Any]]] = {}
    for p in points:
        by_epoch.setdefault(int(p["epoch"]), []).append(p)
    epochs: list[dict[str, Any]] = []
    for ep in sorted(by_epoch):
        r = epoch_index(by_epoch[ep])
        if r is not None:
            epochs.append({"epoch": ep, **r})
    out: dict[str, Any] = {
        "version": METHANE_INDEX_VERSION,
        "windows_um": {"blue": list(BLUE_UM), "band": list(BAND_UM), "red": list(RED_UM)},
        "index": None,
        "index_err": None,
        "depth_sigma": None,
        "epochs": [
            {
                "epoch": e["epoch"],
                "index": round(e["index"], 4),
                "index_err": round(e["index_err"], 4),
            }
            for e in epochs
        ],
    }
    if not epochs:
        return out
    ln = np.array([math.log(e["index"]) for e in epochs])
    s = np.array([e["index_err"] / e["index"] for e in epochs])
    wts = 1.0 / s**2
    m = float(np.sum(wts * ln) / np.sum(wts))
    sm = float(1.0 / math.sqrt(float(np.sum(wts))))
    if len(epochs) > 1:
        chi2 = float(np.sum(wts * (ln - m) ** 2)) / (len(epochs) - 1)
        sm *= max(1.0, math.sqrt(chi2))
    index = math.exp(m)
    err = index * sm
    out["index"] = round(index, 4)
    out["index_err"] = round(err, 4)
    # Depth below a featureless continuum (index 1), in standard errors.
    out["depth_sigma"] = round((1.0 - index) / err, 2)
    return out
