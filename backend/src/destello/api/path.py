"""F-27 predicted path and parallax ellipse of a source over a stored sequence.

Thin adapter over `pipeline.path` (pure, astropy): reads the manifest for the grid and the
observation times, converts sky positions to frame pixels with the same transform as the catalog
overlays. No network access.
"""

from __future__ import annotations

from typing import Any

import astropy.units as u
import numpy as np
from astropy.time import Time

from destello.api.deps import AppState
from destello.api.derived import grid_from_manifest, read_manifest, to_frame_pixels
from destello.api.errors import ApiError
from destello.models.targets import parse_epoch
from destello.pipeline.path import parallax_ellipse, predicted_track, sample_times
from destello.pipeline.propagate import Astrometry

#: Bumped when the response shape or the computation changes.
PATH_VERSION = "1"


def parse_ref_epoch(text: str) -> Time:
    """Catalog reference epoch: "J2016.0" (TDB Julian year) or "MJD57388.0" (UTC)."""
    try:
        return parse_epoch(text)
    except ValueError:
        raise ApiError(
            422, "INVALID_EPOCH", "Invalid epoch", "ref_epoch: use J2016.0 or MJD57388.0."
        ) from None


def _iso(value: Any) -> Time | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return Time(value.rstrip("Z"), format="isot", scale="utc")
    except ValueError:
        return None


def sequence_span(manifest: dict[str, Any]) -> tuple[Time, Time, list[tuple[int, Time]]]:
    """First and last observation time of the sequence, and the mid time of each epoch."""
    mids: list[tuple[int, Time]] = []
    edges: list[float] = []
    for ep in manifest.get("epochs", []):
        mid = ep.get("t_mid_mjd")
        if mid is None:
            continue
        t_mid = Time(float(mid), format="mjd", scale="utc")
        mids.append((int(ep["index"]), t_mid))
        edges.append(float(mid))
        for k in ("t_start", "t_end"):
            t = _iso(ep.get(k))
            if t is not None:
                edges.append(float(t.mjd))
    if not mids:
        raise ApiError(409, "NO_EPOCHS", "No epochs", "The sequence has no observation times yet.")
    return (
        Time(min(edges), format="mjd", scale="utc"),
        Time(max(edges), format="mjd", scale="utc"),
        mids,
    )


def _r(v: float, nd: int = 3) -> float:
    return round(float(v), nd)


def build_path(state: AppState, sid: str, astrometry: Astrometry, ref_epoch: str) -> dict[str, Any]:
    manifest = read_manifest(state, sid)
    grid = grid_from_manifest(manifest)
    t0, t1, mids = sequence_span(manifest)

    track = predicted_track(astrometry, sample_times(t0, t1))
    px, py = to_frame_pixels(grid, track.ra_deg, track.dec_deg)
    path = [
        {
            "t_mjd": _r(t, 4),
            "x": _r(x),
            "y": _r(y),
            "ra_deg": _r(ra, 7),
            "dec_deg": _r(dec, 7),
        }
        for t, x, y, ra, dec in zip(
            track.times.utc.mjd, px, py, track.ra_deg, track.dec_deg, strict=True
        )
    ]

    mid_times = Time([m.mjd for _, m in mids], format="mjd", scale="utc")
    marks = predicted_track(astrometry, mid_times)
    ex, ey = to_frame_pixels(grid, marks.ra_deg, marks.dec_deg)
    epochs = [
        {
            "index": idx,
            "t_mjd": _r(t.mjd, 5),
            "x": _r(x),
            "y": _r(y),
            "ra_deg": _r(ra, 7),
            "dec_deg": _r(dec, 7),
        }
        for (idx, t), x, y, ra, dec in zip(mids, ex, ey, marks.ra_deg, marks.dec_deg, strict=True)
    ]

    centre = Time(float(np.mean(mid_times.mjd)), format="mjd", scale="utc")
    ell = parallax_ellipse(astrometry, centre)
    ellipse: dict[str, Any] | None = None
    if ell is not None:
        lx, ly = to_frame_pixels(grid, ell.ra_deg, ell.dec_deg)
        cx, cy = to_frame_pixels(
            grid,
            np.array([ell.center_ra_deg], dtype=np.float64),
            np.array([ell.center_dec_deg], dtype=np.float64),
        )
        ellipse = {
            "center_t_mjd": _r(centre.mjd, 4),
            "center_x": _r(cx[0]),
            "center_y": _r(cy[0]),
            "semi_major_arcsec": _r(ell.semi_major.to_value(u.arcsec), 4),
            "semi_minor_arcsec": _r(ell.semi_minor.to_value(u.arcsec), 4),
            "points": [(_r(x, 4), _r(y, 4)) for x, y in zip(lx, ly, strict=True)],
        }

    return {
        "sequence_id": sid,
        "ref_epoch": ref_epoch,
        "pmra_masyr": float(astrometry.pmra_cosdec.to_value(u.mas / u.yr)),
        "pmdec_masyr": float(astrometry.pmdec.to_value(u.mas / u.yr)),
        "parallax_mas": float(astrometry.parallax.to_value(u.mas)),
        "observer": "geocentric",
        "t_start_mjd": _r(t0.mjd, 5),
        "t_end_mjd": _r(t1.mjd, 5),
        "pixel_scale_arcsec": grid.pixel_scale_arcsec,
        "path": path,
        "epochs": epochs,
        "ellipse": ellipse,
    }
