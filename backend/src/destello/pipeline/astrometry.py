"""Centroids, local astrometric recalibration and proper motion fitting (docs/03 section 4.5)."""

from __future__ import annotations

from dataclasses import dataclass

import astropy.units as u
import numpy as np
import numpy.typing as npt
from astropy.time import Time
from scipy.optimize import least_squares

from destello.pipeline.propagate import parallax_factors

FloatArray = npt.NDArray[np.floating]

ARCSEC_PER_MAS = 1.0e-3


@dataclass(frozen=True)
class Centroid:
    """Centroid in pixels (0-based) with 1-sigma uncertainties (pixels)."""

    x: float
    y: float
    x_err: float
    y_err: float
    fwhm_pix: float
    n_pix: int
    amp: float = float("nan")  # fitted Gaussian peak above background (image units)
    amp_err: float = float("nan")
    chi2_red: float = float("nan")


def _gauss(p: FloatArray, xx: FloatArray, yy: FloatArray) -> FloatArray:
    amp, x0, y0, sx, sy, bkg = p
    model: FloatArray = amp * np.exp(-0.5 * (((xx - x0) / sx) ** 2 + ((yy - y0) / sy) ** 2)) + bkg
    return model


def measure_centroid(
    image: FloatArray,
    variance: FloatArray | None,
    exclude: npt.NDArray[np.bool_] | None,
    x0: float,
    y0: float,
    half_box: int = 4,
    min_pixels: int = 12,
    neighbors: list[tuple[float, float]] | None = None,
) -> Centroid | None:
    """Weighted 2D Gaussian centroid near (x0, y0). Pixels in `exclude` (flagged, saturated) and
    non-finite pixels are left out of the fit. Returns None when the fit is not constrained.

    `neighbors` are known contaminating sources at fixed pixel positions (for example catalog
    stars propagated to the epoch); each is modeled with the same Gaussian shape and its own
    free amplitude, so that the target centroid is not pulled toward them.

    The uncertainty comes from the fit covariance scaled by the reduced chi squared (>= 1).
    """
    ny, nx = image.shape
    if not (np.isfinite(x0) and np.isfinite(y0)):
        return None  # a position that does not project onto the image
    xi, yi = int(round(x0)), int(round(y0))
    xa, xb = max(xi - half_box, 0), min(xi + half_box + 1, nx)
    ya, yb = max(yi - half_box, 0), min(yi + half_box + 1, ny)
    if xb - xa < 5 or yb - ya < 5:
        return None
    sub = np.asarray(image[ya:yb, xa:xb], dtype=np.float64)
    yy, xx = np.mgrid[ya:yb, xa:xb].astype(np.float64)
    ok = np.isfinite(sub)
    if exclude is not None:
        ok &= ~exclude[ya:yb, xa:xb]
    if variance is not None:
        var = np.asarray(variance[ya:yb, xa:xb], dtype=np.float64)
        ok &= np.isfinite(var) & (var > 0)
        sig = np.sqrt(np.where(ok, var, 1.0))
    else:
        sig = np.full(sub.shape, max(float(np.nanstd(sub)), 1e-12))
    if int(ok.sum()) < min_pixels:
        return None
    bkg0 = float(np.median(sub[ok]))
    peak = float(np.max(sub[ok]) - bkg0)
    if peak <= 0:
        return None
    reach = half_box + 4.0
    nbs = [
        (float(a), float(b))
        for a, b in (neighbors or [])
        if abs(a - x0) <= reach and abs(b - y0) <= reach
    ]
    k = len(nbs)
    p0 = np.array([peak, float(x0), float(y0), 1.5, 1.5, bkg0] + [0.1 * peak] * k)
    lo = np.array([0.0, x0 - half_box, y0 - half_box, 0.5, 0.5, -np.inf] + [0.0] * k)
    hi = np.array([np.inf, x0 + half_box, y0 + half_box, 6.0, 6.0, np.inf] + [np.inf] * k)

    def resid(p: FloatArray) -> FloatArray:
        model = _gauss(p[:6], xx, yy)
        for j, (nx_, ny_) in enumerate(nbs):
            model = model + p[6 + j] * np.exp(
                -0.5 * (((xx - nx_) / p[3]) ** 2 + ((yy - ny_) / p[4]) ** 2)
            )
        return ((model - sub) / sig)[ok]

    try:
        sol = least_squares(resid, p0, bounds=(lo, hi), method="trf")
    except ValueError:
        return None
    if not sol.success:
        return None
    dof = max(int(ok.sum()) - 6 - k, 1)
    chi2_red = max(float(np.sum(sol.fun**2)) / dof, 1.0)
    try:
        cov = np.linalg.inv(sol.jac.T @ sol.jac) * chi2_red
    except np.linalg.LinAlgError:
        return None
    err = np.sqrt(np.clip(np.diag(cov), 0, None))
    fwhm = 2.3548 * float(np.sqrt(sol.x[3] * sol.x[4]))
    return Centroid(
        x=float(sol.x[1]),
        y=float(sol.x[2]),
        x_err=float(err[1]),
        y_err=float(err[2]),
        fwhm_pix=fwhm,
        n_pix=int(ok.sum()),
        amp=float(sol.x[0]),
        amp_err=float(err[0]),
        chi2_red=chi2_red,
    )


WING_SECTORS = 8  # azimuthal sectors that must each hold valid pixels around the start position
WING_MAX_NFEV = 5000  # wings far from the core are a power law: amplitude and alpha are degenerate


def measure_wing_centroid(
    image: FloatArray,
    variance: FloatArray,
    exclude: npt.NDArray[np.bool_],
    x0: float,
    y0: float,
    r_max_pix: float = 14.0,
    max_shift_pix: float = 3.0,
    min_pixels: int = 40,
    min_sector_pixels: int = 3,
) -> Centroid | None:
    """Centroid of a source whose core is masked (saturated), from the PSF wings.

    Fits a circular Moffat profile plus a constant background, amp * (1 + r^2 / alpha^2)^-beta
    + bkg, to the valid pixels within `r_max_pix` of (x0, y0); pixels in `exclude` and
    non-finite pixels are left out, so the masked core does not enter the fit and the center is
    constrained by the symmetry of the surrounding wings. A soft L1 loss limits the weight of
    unmodeled sources and PSF structure. The fit is accepted only when each of WING_SECTORS
    azimuthal sectors holds at least `min_sector_pixels` valid pixels (a one-sided wing does not
    constrain the center), when it converges, and when the center stays inside
    `max_shift_pix` of the start position (a center on the bound is rejected).

    The uncertainty comes from the fit covariance scaled by the reduced chi squared (>= 1); it
    does not include PSF asymmetry, so callers combining several exposures should use the
    empirical scatter as well. `fwhm_pix` is the Moffat FWHM, 2 alpha sqrt(2^(1/beta) - 1).
    """
    if not (np.isfinite(x0) and np.isfinite(y0)):
        return None
    ny, nx = image.shape
    yy, xx = np.mgrid[0:ny, 0:nx].astype(np.float64)
    rr = np.hypot(xx - x0, yy - y0)
    var = np.asarray(variance, dtype=np.float64)
    img = np.asarray(image, dtype=np.float64)
    ok = (rr <= r_max_pix) & ~exclude & np.isfinite(img) & np.isfinite(var) & (var > 0)
    n = int(ok.sum())
    if n < min_pixels:
        return None
    sector = (
        np.floor((np.arctan2(yy - y0, xx - x0) + np.pi) / (2 * np.pi) * WING_SECTORS).astype(int)
        % WING_SECTORS
    )
    counts = np.bincount(sector[ok], minlength=WING_SECTORS)
    if int(counts.min()) < min_sector_pixels:
        return None
    px, py, z, sig = xx[ok], yy[ok], img[ok], np.sqrt(var[ok])
    bkg0 = float(np.median(z))
    peak = float(np.max(z) - bkg0)
    if peak <= 0:
        return None

    def resid(p: FloatArray) -> FloatArray:
        amp, xc, yc, alpha, beta, bkg = p
        model = amp * (1.0 + ((px - xc) ** 2 + (py - yc) ** 2) / alpha**2) ** (-beta) + bkg
        out: FloatArray = (model - z) / sig
        return out

    p0 = np.array([peak * 10.0, x0, y0, 1.5, 1.5, 0.0])
    lo = np.array([0.0, x0 - max_shift_pix, y0 - max_shift_pix, 0.3, 0.6, -np.inf])
    hi = np.array([np.inf, x0 + max_shift_pix, y0 + max_shift_pix, 20.0, 6.0, np.inf])
    try:
        sol = least_squares(
            resid, p0, bounds=(lo, hi), method="trf", loss="soft_l1", f_scale=3.0,
            x_scale="jac", max_nfev=WING_MAX_NFEV,
        )  # fmt: skip
    except ValueError:
        return None
    if not sol.success:
        return None
    xc, yc = float(sol.x[1]), float(sol.x[2])
    edge = max_shift_pix - 0.05
    if abs(xc - x0) >= edge or abs(yc - y0) >= edge:
        return None
    dof = max(n - 6, 1)
    chi2_red = max(float(np.sum(resid(sol.x) ** 2)) / dof, 1.0)
    try:
        cov = np.linalg.inv(sol.jac.T @ sol.jac) * chi2_red
    except np.linalg.LinAlgError:
        return None
    err = np.sqrt(np.clip(np.diag(cov), 0, None))
    if not (np.isfinite(err[1]) and np.isfinite(err[2])):
        return None
    alpha, beta = float(sol.x[3]), float(sol.x[4])
    return Centroid(
        x=xc,
        y=yc,
        x_err=float(err[1]),
        y_err=float(err[2]),
        fwhm_pix=2.0 * alpha * float(np.sqrt(2.0 ** (1.0 / beta) - 1.0)),
        n_pix=n,
        amp=float(sol.x[0]),
        amp_err=float(err[0]),
        chi2_red=chi2_red,
    )


@dataclass(frozen=True)
class CombinedOffset:
    """Mean of per-exposure offsets after sigma clipping, with its uncertainty (same units)."""

    dx: float
    dy: float
    dx_err: float
    dy_err: float
    n_used: int
    n_total: int
    scatter_x: float
    scatter_y: float


def combine_offsets(
    dx: FloatArray, dy: FloatArray, ex: FloatArray, ey: FloatArray, clip: float = 3.0
) -> CombinedOffset | None:
    """Combine per-exposure offsets of one epoch.

    Offsets further than `clip` robust standard deviations (1.4826 MAD) from the median on either
    axis are rejected once. The mean of the remaining offsets is returned with the larger of the
    formal error of the mean (root sum of squares of `ex`, `ey` over n) and the standard error of
    the mean from the scatter, so that unmodeled per-exposure errors are not hidden by small
    formal errors. Returns None without at least two offsets after clipping.
    """
    dx, dy = np.asarray(dx, dtype=np.float64), np.asarray(dy, dtype=np.float64)
    ex, ey = np.asarray(ex, dtype=np.float64), np.asarray(ey, dtype=np.float64)
    n_total = int(dx.size)
    if n_total < 2:
        return None
    keep = np.ones(n_total, dtype=bool)
    for v in (dx, dy):
        med = float(np.median(v))
        mad = 1.4826 * float(np.median(np.abs(v - med)))
        if mad > 0:
            keep &= np.abs(v - med) <= clip * mad
    n = int(keep.sum())
    if n < 2:
        return None
    sx = float(np.std(dx[keep], ddof=1))
    sy = float(np.std(dy[keep], ddof=1))
    fx = float(np.sqrt(np.sum(ex[keep] ** 2))) / n
    fy = float(np.sqrt(np.sum(ey[keep] ** 2))) / n
    return CombinedOffset(
        dx=float(np.mean(dx[keep])),
        dy=float(np.mean(dy[keep])),
        dx_err=max(fx, sx / float(np.sqrt(n))),
        dy_err=max(fy, sy / float(np.sqrt(n))),
        n_used=n,
        n_total=n_total,
        scatter_x=sx,
        scatter_y=sy,
    )


@dataclass(frozen=True)
class Offset:
    """Median offset (measured minus predicted) of reference stars, in pixels."""

    dx: float
    dy: float
    scatter_x: float  # robust standard deviation of the individual offsets
    scatter_y: float
    n_stars: int


def fit_offset(predicted_xy: FloatArray, measured_xy: FloatArray, clip: float = 3.0) -> Offset:
    """Median offset between predicted (propagated Gaia) and measured star centroids.

    Both arrays have shape (N, 2). One round of clipping at `clip` robust sigmas removes
    mismatches. Returns n_stars = 0 and zero offsets for empty input.
    """
    pred = np.asarray(predicted_xy, dtype=np.float64).reshape(-1, 2)
    meas = np.asarray(measured_xy, dtype=np.float64).reshape(-1, 2)
    if pred.shape[0] == 0:
        return Offset(0.0, 0.0, float("nan"), float("nan"), 0)
    d = meas - pred
    keep = np.ones(d.shape[0], dtype=bool)
    for _ in range(2):
        med = np.median(d[keep], axis=0)
        mad = 1.4826 * np.median(np.abs(d[keep] - med), axis=0)
        thr = clip * np.maximum(mad, 0.05)
        keep = np.all(np.abs(d - med) <= thr, axis=1)
        if keep.sum() == 0:
            keep[:] = True
            break
    med = np.median(d[keep], axis=0)
    sc = (
        1.4826 * np.median(np.abs(d[keep] - med), axis=0)
        if keep.sum() > 1
        else np.array([np.nan] * 2)
    )
    return Offset(float(med[0]), float(med[1]), float(sc[0]), float(sc[1]), int(keep.sum()))


@dataclass(frozen=True)
class MotionFit:
    """Result of the weighted least squares motion fit."""

    pmra_cosdec_masyr: float
    pmdec_masyr: float
    pmra_err_masyr: float
    pmdec_err_masyr: float
    parallax_mas: float
    parallax_err_mas: float | None
    parallax_fixed: bool
    chi2_red: float | None
    dof: int
    n_epochs: int
    ref_epoch: Time
    ra0_deg: float  # fitted position at ref_epoch
    dec0_deg: float
    residuals_arcsec: FloatArray  # shape (N, 2): (d_alpha*, d_delta) per epoch


def fit_motion(
    times: Time,
    ra: u.Quantity,
    dec: u.Quantity,
    err_ra_arcsec: FloatArray,
    err_dec_arcsec: FloatArray,
    parallax_mas: float = 0.0,
    fit_parallax: bool = False,
    min_epochs_for_parallax: int = 4,
) -> MotionFit:
    """Weighted least squares fit of position, proper motion and optionally parallax.

    alpha*(t) = alpha*_0 + mu_alpha* (t - t0) + varpi P_alpha(t)
    delta(t)  = delta_0  + mu_delta  (t - t0) + varpi P_delta(t)

    `ra`/`dec` are measured positions per epoch (ICRS), `err_*_arcsec` their uncertainties.
    Parallax is fixed to `parallax_mas` unless `fit_parallax` is true and at least
    `min_epochs_for_parallax` epochs are available. t0 is the mean observation time. The returned
    uncertainties are scaled by sqrt(chi2_red) when chi2_red > 1 and dof > 0.
    """
    n = len(times)
    ra_deg = ra.to_value(u.deg)
    dec_deg = dec.to_value(u.deg)
    ra_ref = float(np.mean(ra_deg))
    dec_ref = float(np.mean(dec_deg))
    cosd = np.cos(np.radians(dec_ref))
    x = (ra_deg - ra_ref) * cosd * 3600.0
    y = (dec_deg - dec_ref) * 3600.0
    t_years = times.tdb.jyear
    t0 = float(np.mean(t_years))
    dt = t_years - t0
    pa, pd = parallax_factors(ra_ref * u.deg, dec_ref * u.deg, times)
    do_plx = fit_parallax and n >= min_epochs_for_parallax
    plx_arcsec = parallax_mas * ARCSEC_PER_MAS

    obs = np.concatenate([x, y])
    sig = np.concatenate([np.asarray(err_ra_arcsec, float), np.asarray(err_dec_arcsec, float)])
    zeros, ones = np.zeros(n), np.ones(n)
    cols = [
        np.concatenate([ones, zeros]),
        np.concatenate([zeros, ones]),
        np.concatenate([dt, zeros]),
        np.concatenate([zeros, dt]),
    ]
    if do_plx:
        cols.append(np.concatenate([pa, pd]))
    else:
        obs = obs - plx_arcsec * np.concatenate([pa, pd])
    design = np.column_stack(cols)
    w = 1.0 / sig
    sol, *_ = np.linalg.lstsq(design * w[:, None], obs * w, rcond=None)
    cov = np.linalg.inv((design * w[:, None]).T @ (design * w[:, None]))
    resid = obs - design @ sol
    dof = 2 * n - design.shape[1]
    chi2 = float(np.sum((resid * w) ** 2))
    chi2_red = chi2 / dof if dof > 0 else None
    infl = float(np.sqrt(chi2_red)) if (chi2_red is not None and chi2_red > 1.0) else 1.0
    err = np.sqrt(np.diag(cov)) * infl
    plx_fit = float(sol[4]) / ARCSEC_PER_MAS if do_plx else parallax_mas
    plx_err = float(err[4]) / ARCSEC_PER_MAS if do_plx else None
    ref_epoch = Time(t0, format="jyear", scale="tdb")
    ra0 = ra_ref + float(sol[0]) / 3600.0 / cosd
    dec0 = dec_ref + float(sol[1]) / 3600.0
    return MotionFit(
        pmra_cosdec_masyr=float(sol[2]) / ARCSEC_PER_MAS,
        pmdec_masyr=float(sol[3]) / ARCSEC_PER_MAS,
        pmra_err_masyr=float(err[2]) / ARCSEC_PER_MAS,
        pmdec_err_masyr=float(err[3]) / ARCSEC_PER_MAS,
        parallax_mas=plx_fit,
        parallax_err_mas=plx_err,
        parallax_fixed=not do_plx,
        chi2_red=chi2_red,
        dof=dof,
        n_epochs=n,
        ref_epoch=ref_epoch,
        ra0_deg=ra0,
        dec0_deg=dec0,
        residuals_arcsec=np.column_stack([resid[:n], resid[n:]]),
    )


def agreement_sigma(
    fit: MotionFit,
    ref_pmra_masyr: float,
    ref_pmdec_masyr: float,
    ref_pmra_err_masyr: float = 0.0,
    ref_pmdec_err_masyr: float = 0.0,
) -> float:
    """Largest per-axis difference between fitted and reference proper motion in combined sigma."""
    s_ra = float(np.hypot(fit.pmra_err_masyr, ref_pmra_err_masyr))
    s_de = float(np.hypot(fit.pmdec_err_masyr, ref_pmdec_err_masyr))
    d_ra = abs(fit.pmra_cosdec_masyr - ref_pmra_masyr) / s_ra if s_ra > 0 else float("inf")
    d_de = abs(fit.pmdec_masyr - ref_pmdec_masyr) / s_de if s_de > 0 else float("inf")
    return float(max(d_ra, d_de))


@dataclass(frozen=True)
class Recalibration:
    """Local astrometric recalibration of one image against propagated reference stars.

    Model (pixels): measured = c + R(theta) (predicted - c) + (dx, dy), with c the reference
    point (usually the image center) and theta small. All quantities in pixels and radians.
    """

    dx: float
    dy: float
    theta_rad: float
    dx_err: float
    dy_err: float
    theta_err_rad: float
    scatter_pix: float  # robust per-axis standard deviation of the residuals after the fit
    excess_pix: float  # part of the scatter not explained by the formal centroid errors
    n_stars: int  # stars kept after clipping
    n_input: int
    rotation_fitted: bool
    center: tuple[float, float]
    residuals: FloatArray  # (n_input, 2) measured minus model, pixels
    kept: npt.NDArray[np.bool_]  # (n_input,) stars kept after clipping

    def correct(self, x: float, y: float) -> tuple[float, float]:
        """Map a measured pixel position into the frame of the predictions (inverse model)."""
        cx, cy = self.center
        ux, uy = x - self.dx - cx, y - self.dy - cy
        c, s = np.cos(-self.theta_rad), np.sin(-self.theta_rad)
        return float(cx + c * ux - s * uy), float(cy + s * ux + c * uy)

    def apply(self, x: float, y: float) -> tuple[float, float]:
        """Map a predicted pixel position into the measured frame (forward model)."""
        cx, cy = self.center
        c, s = np.cos(self.theta_rad), np.sin(self.theta_rad)
        ux, uy = x - cx, y - cy
        return float(cx + c * ux - s * uy + self.dx), float(cy + s * ux + c * uy + self.dy)


def _robust_std(v: FloatArray) -> float:
    v = np.asarray(v, dtype=np.float64)
    if v.size < 2:
        return float("nan")
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def fit_recalibration(
    predicted_xy: FloatArray,
    measured_xy: FloatArray,
    measured_err: FloatArray | None,
    center: tuple[float, float],
    *,
    fit_rotation: bool = False,
    min_stars_rotation: int = 8,
    clip: float = 3.0,
    floor_pix: float = 0.05,
) -> Recalibration:
    """Fit an offset (and optionally a small rotation) between predicted and measured stars.

    `predicted_xy` are reference catalog positions propagated to the image epoch and converted
    to pixels; `measured_xy` the centroids, shape (N, 2). Stars are weighted equally (the
    residuals of real data are dominated by systematics, not by the formal centroid errors) and
    outliers are clipped iteratively at `clip` robust sigmas (minimum `floor_pix`). Rotation is
    fitted only when requested and at least `min_stars_rotation` stars are available.
    The parameter uncertainties are the residual scatter divided by sqrt(N) (offset) and the
    least squares equivalent for the rotation.
    """
    pred = np.asarray(predicted_xy, dtype=np.float64).reshape(-1, 2)
    meas = np.asarray(measured_xy, dtype=np.float64).reshape(-1, 2)
    n_in = pred.shape[0]
    cx, cy = float(center[0]), float(center[1])
    if n_in == 0:
        return Recalibration(
            0.0, 0.0, 0.0, float("nan"), float("nan"), float("nan"), float("nan"),
            float("nan"), 0, 0, False, (cx, cy), np.zeros((0, 2)), np.zeros(0, dtype=bool),
        )  # fmt: skip
    d = meas - pred
    rx, ry = pred[:, 0] - cx, pred[:, 1] - cy
    do_rot = fit_rotation and n_in >= min_stars_rotation
    keep = np.ones(n_in, dtype=bool)
    params: FloatArray = np.zeros(3, dtype=np.float64)

    def solve(mask: npt.NDArray[np.bool_]) -> FloatArray:
        if not do_rot:
            med = np.median(d[mask], axis=0)
            return np.array([med[0], med[1], 0.0])
        k = int(mask.sum())
        a = np.zeros((2 * k, 3))
        a[:k, 0] = 1.0
        a[k:, 1] = 1.0
        a[:k, 2] = -ry[mask]
        a[k:, 2] = rx[mask]
        b = np.concatenate([d[mask, 0], d[mask, 1]])
        sol, *_ = np.linalg.lstsq(a, b, rcond=None)
        return np.asarray(sol, dtype=np.float64)

    def model(p: FloatArray) -> FloatArray:
        return np.column_stack([p[0] - p[2] * ry, p[1] + p[2] * rx])

    for _ in range(5):
        params = solve(keep)
        res: FloatArray = np.asarray(d - model(params), dtype=np.float64)
        sx = _robust_std(res[keep, 0])
        sy = _robust_std(res[keep, 1])
        sx = max(sx if np.isfinite(sx) else floor_pix, floor_pix)
        sy = max(sy if np.isfinite(sy) else floor_pix, floor_pix)
        new_keep = (np.abs(res[:, 0] - np.median(res[keep, 0])) <= clip * sx) & (
            np.abs(res[:, 1] - np.median(res[keep, 1])) <= clip * sy
        )
        if new_keep.sum() < max(2, min(3, n_in)):
            break
        if np.array_equal(new_keep, keep):
            break
        keep = new_keep
    params = solve(keep)
    res = np.asarray(d - model(params), dtype=np.float64)
    k = int(keep.sum())
    axis_scatter = [
        s for s in (_robust_std(res[keep, 0]), _robust_std(res[keep, 1])) if np.isfinite(s)
    ]
    scatter = float(np.mean(axis_scatter)) if axis_scatter else float("nan")
    if k >= 2 and not np.isfinite(scatter):
        scatter = float(np.std(res[keep]))
    excess = float("nan")
    if np.isfinite(scatter):
        if measured_err is not None:
            err = np.asarray(measured_err, dtype=np.float64).reshape(-1, 2)[keep]
            formal = float(np.median(err**2)) if err.size else 0.0
            excess = float(np.sqrt(max(scatter**2 - formal, 0.0)))
        else:
            excess = scatter
    off_err = scatter / np.sqrt(k) if (k > 0 and np.isfinite(scatter)) else float("nan")
    th_err = float("nan")
    if do_rot and k > 0 and np.isfinite(scatter):
        r2 = float(np.sum(rx[keep] ** 2 + ry[keep] ** 2))
        th_err = scatter / np.sqrt(r2) if r2 > 0 else float("nan")
    return Recalibration(
        dx=float(params[0]),
        dy=float(params[1]),
        theta_rad=float(params[2]),
        dx_err=float(off_err),
        dy_err=float(off_err),
        theta_err_rad=th_err,
        scatter_pix=scatter,
        excess_pix=excess,
        n_stars=k,
        n_input=n_in,
        rotation_fitted=do_rot,
        center=(cx, cy),
        residuals=res,
        kept=keep,
    )


def well_spread_epochs(times: Time, min_epochs: int = 4, min_span_years: float = 1.0) -> bool:
    """True when there are enough epochs over a long enough baseline to fit parallax."""
    if len(times) < min_epochs:
        return False
    t = np.sort(np.asarray(times.tdb.jyear, dtype=np.float64))
    return bool(t[-1] - t[0] >= min_span_years)


def well_spread_for_parallax(
    times: Time,
    ra: u.Quantity,
    dec: u.Quantity,
    min_epochs: int = 6,
    min_span_years: float = 2.0,
    min_factor_range: float = 1.0,
) -> bool:
    """Rule of docs/11 V-15 for fitting the parallax over a long, multi-mission baseline.

    True with at least `min_epochs` epochs over at least `min_span_years`, whose parallax factors
    (in units of the parallax, geocentric observer) span at least `min_factor_range` on at least
    one axis. The rule was fixed before any long-baseline measurement.
    """
    if len(times) < min_epochs:
        return False
    t = np.asarray(times.tdb.jyear, dtype=np.float64)
    if float(t.max() - t.min()) < min_span_years:
        return False
    ra_m = float(np.mean(ra.to_value(u.deg))) * u.deg
    dec_m = float(np.mean(dec.to_value(u.deg))) * u.deg
    pa, pd = parallax_factors(ra_m, dec_m, times)
    return bool(max(float(np.ptp(pa)), float(np.ptp(pd))) >= min_factor_range)
