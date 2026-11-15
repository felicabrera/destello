"""Request and response schemas of the public API (docs/06). Request bodies forbid extra fields."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

# Bounds from docs/10 section 3.1.
FOV_MIN_ARCMIN = 2.0
FOV_MAX_ARCMIN = 30.0
KNOWN_RELEASES = (
    "all",
    "spherex_dr1",
    "spherex_qr3",
    "spherex_dr1_deep",
    "spherex_qr3_deep",
)


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------ health, releases
class HealthResponse(_Out):
    status: str
    version: str
    pipeline_version: str
    irsa: Literal["ok", "degraded", "down"]


class ReleaseOut(_Out):
    collection: str
    label: str
    doi: str
    data_as_of: str


class ReleasesOut(_Out):
    default: str
    releases: list[ReleaseOut]


# ------------------------------------------------------------------ targets
class TargetAstrometryOut(_Out):
    source: str
    ref_epoch: str
    ra_deg: float
    dec_deg: float
    pmra_masyr: float
    pmdec_masyr: float
    parallax_mas: float


class DefaultViewOut(_Out):
    fov_arcmin: float
    detectors: list[int]
    det: str | int = "all"
    mode: str = "blink"
    panel: str | None = None


class TargetResultOut(_Out):
    kind: Literal["motion", "variability"]
    value: float
    err: float | None = None
    unit: str
    reference_value: float | None = None
    reference_source: str | None = None
    agreement_sigma: float | None = None
    significance_sigma: float | None = None


class TargetOut(_Out):
    id: str
    names: dict[str, str]
    ra_deg: float
    dec_deg: float
    astrometry: TargetAstrometryOut
    default_view: DefaultViewOut
    notes: dict[str, str]
    sequence_id: str | None = None
    result: TargetResultOut | None = None
    # True when the validation run tried every measurement of this target and none was possible
    # (for example a saturated star), so the interface can say so instead of "pending".
    not_measurable: bool = False
    kind: dict[str, str] | None = None
    headline: dict[str, str] | None = None
    look: dict[str, str] | None = None
    caption: dict[str, str] | None = None
    limit: dict[str, str] | None = None
    label: dict[str, float] | None = None


class PropagatedOut(_Out):
    epoch: str
    ra_deg: float
    dec_deg: float


class ResolveOut(_Out):
    query: str
    main_id: str
    ra_deg: float
    dec_deg: float
    ref_epoch: str | None
    pmra_masyr: float | None
    pmdec_masyr: float | None
    parallax_mas: float | None
    propagated: PropagatedOut | None = None
    # Service that answered: "simbad" or "irsa:<upstream>" (fallback, no proper motion). Optional.
    resolver: str | None = None


# ------------------------------------------------------------------ sequences
class TrackIn(_In):
    pmra_masyr: float = Field(ge=-100000, le=100000)
    pmdec_masyr: float = Field(ge=-100000, le=100000)
    parallax_mas: float = Field(default=0.0, ge=0, le=1000)
    ref_epoch: str = Field(
        default="J2016.0", pattern=r"^(J[0-9]{4}(\.[0-9]+)?|MJD[0-9]{4,6}(\.[0-9]+)?)$"
    )


class SequenceCreate(_In):
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    fov_arcmin: float = Field(ge=FOV_MIN_ARCMIN, le=FOV_MAX_ARCMIN)
    detectors: list[int] = Field(
        default_factory=lambda: [1, 2, 3, 4, 5, 6], min_length=1, max_length=6
    )
    release: str | None = Field(default=None, max_length=32)
    track: TrackIn | None = None
    # Detector to build and publish first (the one on screen). Changes only the build order, not
    # the result, so it is not part of the sequence id; ignored when the build already exists.
    priority_detector: int | None = Field(default=None, ge=1, le=6)
    # Also build the short revisits between survey passes as low coverage epochs. They are
    # shown and labelled but excluded from measurements. Part of the sequence id.
    include_partial: bool = False


class EstimateOut(_Out):
    images: int
    megabytes: int
    seconds: int


class SequenceReady(_Out):
    sequence_id: str
    status: Literal["ready"] = "ready"
    manifest_url: str
    # True when IRSA has published data since this manifest was built: it is served as it is and
    # a rebuild has been queued, so a later request returns the newer images.
    refreshing: bool = False


class SequenceQueued(_Out):
    sequence_id: str
    status: Literal["queued", "running"] = "queued"
    events_url: str
    estimate: EstimateOut | None = None


class SequenceStatusOut(_Out):
    sequence_id: str
    status: Literal["queued", "running", "ready", "failed"]
    manifest_url: str | None = None
    position: int | None = None
    events_url: str | None = None
    # Progressive build (status running): detectors already viewable and their partial manifest.
    detectors_ready: list[int] | None = None
    partial_manifest_url: str | None = None


# ------------------------------------------------------------------ derived products
class OverlaySourceOut(_Out):
    id: str
    x: float
    y: float
    mag: float | None = None
    pmra_masyr: float | None = None
    pmdec_masyr: float | None = None


class OverlayEpochOut(_Out):
    index: int
    sources: list[OverlaySourceOut]


class OverlayOut(_Out):
    catalog: Literal["gaia_dr3", "catwise2020"]
    archive: str | None = None  # archive copy that served the catalog (MAST, ESA, IRSA)
    epochs: list[OverlayEpochOut]


class PathPointOut(_Out):
    """One sample of the predicted path, in frame pixel EDGE coordinates (as overlays) and ICRS."""

    t_mjd: float
    x: float
    y: float
    ra_deg: float
    dec_deg: float


class PathEpochOut(PathPointOut):
    index: int


class PathEllipseOut(_Out):
    """Yearly parallax loop around the barycentric position at `center_t_mjd` (frame pixels)."""

    center_t_mjd: float
    center_x: float
    center_y: float
    semi_major_arcsec: float
    semi_minor_arcsec: float
    points: list[tuple[float, float]]


class PathOut(_Out):
    """F-27 predicted path of a source with known motion over the sequence span (docs/06)."""

    sequence_id: str
    ref_epoch: str
    pmra_masyr: float
    pmdec_masyr: float
    parallax_mas: float
    observer: Literal["geocentric"] = "geocentric"
    t_start_mjd: float
    t_end_mjd: float
    pixel_scale_arcsec: float
    path: list[PathPointOut]
    epochs: list[PathEpochOut]
    ellipse: PathEllipseOut | None = None


class DifferenceRegistrationOut(_Out):
    """Residual shift of epoch b relative to epoch a in grid pixels along the FITS axes of the
    coadd (x = NAXIS1, y = NAXIS2), measured on field stars (median of centroid in a minus
    centroid in b). b was resampled by (+dx, +dy) before the subtraction only if `applied`."""

    dx_pix: float
    dy_pix: float
    dx_err_pix: float | None
    dy_err_pix: float | None
    n_stars: int
    applied: bool


class DifferenceOut(_Out):
    url: str
    scale: float
    n_stars_used: int
    registration: DifferenceRegistrationOut | None = None
    method_version: str | None = None


class CandidatePointOut(_Out):
    ra_deg: float
    dec_deg: float
    x: float
    y: float


class CandidateMatchOut(_Out):
    catalog: str
    source_id: str
    sep_arcsec: float
    mag: float | None = None
    mag_band: str | None = None
    pm_total_masyr: float | None = None


class CandidateOut(_Out):
    id: str
    kind: Literal["moved", "brighter_in_a", "brighter_in_b"]
    status: Literal["unmatched", "unchecked", "target", "known_source", "not_measurable"]
    snr: float
    snr_local: float | None = None
    detectors: list[int]
    snr_by_detector: list[float]
    ra_deg: float
    dec_deg: float
    x: float
    y: float
    a: CandidatePointOut | None = None
    b: CandidatePointOut | None = None
    separation_arcsec: float | None = None
    match: CandidateMatchOut | None = None


class CandidateDetectorOut(_Out):
    detector: int
    usable: bool
    n_features: int
    n_extended: int
    residual_fraction: float | None = None
    registration_applied: bool
    n_stars_used: int


class CandidatesOut(_Out):
    """F-29: significant differences between two epochs. Never a discovery claim."""

    sequence_id: str
    epoch_a: int
    epoch_b: int
    threshold_sigma: float
    pair_max_arcsec: float
    match_radius_arcsec: float
    min_detectors_unpaired: int
    target_radius_arcsec: float
    target_wing_radius_arcsec: float
    method_version: str
    detectors: list[CandidateDetectorOut]
    catalogs: dict[str, Literal["ok", "unavailable"]]
    counts: dict[str, int]
    truncated: bool
    candidates: list[CandidateOut]


class MotionPointOut(_Out):
    epoch: int
    ra_deg: float
    dec_deg: float
    x: float
    y: float


class MotionMatchOut(_Out):
    catalog: str
    source_id: str
    sep_arcsec: float
    mag: float | None = None
    mag_band: str | None = None
    pmra_masyr: float | None = None
    pmdec_masyr: float | None = None
    pm_total_masyr: float | None = None
    agreement_sigma: float | None = None
    parallax_mas: float | None = None
    parallax_err_mas: float | None = None
    parallax_agreement_sigma: float | None = None


class MotionSourceOut(_Out):
    id: str
    status: Literal["unmatched", "unchecked", "target", "known_source"]
    snr: float
    detectors: list[int]
    snr_by_detector: list[float]
    pmra_masyr: float
    pmdec_masyr: float
    pmra_err_masyr: float
    pmdec_err_masyr: float
    pm_total_masyr: float
    # Fitted with the motion when the epochs allow it (4 or more over at least one year); null
    # otherwise. distance_pc only when the parallax is significant (MIN_PARALLAX_SIGMA).
    parallax_mas: float | None = None
    parallax_err_mas: float | None = None
    parallax_sigma: float | None = None
    distance_pc: float | None = None
    distance_err_pc: float | None = None
    ref_epoch_jyear: float
    ra_deg: float
    dec_deg: float
    x: float
    y: float
    track: list[MotionPointOut]
    match: MotionMatchOut | None = None


class MotionDetectorOut(_Out):
    detector: int
    usable: bool
    n_epochs: int
    n_trials: int
    step_arcsec_yr: float | None = None
    n_peaks: int
    n_fitted: int
    n_moving: int
    residual_fraction: float | None = None


class MotionSearchOut(_Out):
    """F-32: sources that move consistently across every measurable epoch. Never a discovery
    claim."""

    sequence_id: str
    method_version: str
    epochs: list[int]
    baseline_years: float
    ref_epoch_jyear: float
    mu_max_arcsec_yr: float
    step_arcsec_yr: float | None = None
    threshold_sigma: float
    epoch_min_sigma: float
    min_motion_sigma: float
    min_detectors: int
    parallax_fitted: bool = False
    min_parallax_sigma: float | None = None
    match_radius_arcsec: float
    target_radius_arcsec: float
    detectors: list[MotionDetectorOut]
    catalogs: dict[str, Literal["ok", "unavailable"]]
    counts: dict[str, int]
    truncated: bool
    sources: list[MotionSourceOut]
