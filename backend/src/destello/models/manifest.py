"""Manifest schema (docs/06 section 3.4), served at /manifests/<sequence_id>.json.

Epoch `index` fields are 0-based. Images are oriented north up, east left. Detector is the
integer 1..6 for per-detector coadds and the string "all" for the broadband image.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ManifestRequest(_Model):
    ra_deg: float
    dec_deg: float
    fov_arcmin: float
    detectors: list[int]
    release: str
    target_id: str | None = None


class ManifestGrid(_Model):
    projection: Literal["TAN"] = "TAN"
    crval_deg: tuple[float, float]
    pixel_scale_arcsec: float
    naxis: tuple[int, int]  # (nx, ny)
    orientation: Literal["north_up_east_left"] = "north_up_east_left"


class ManifestEphemerisPoint(_Model):
    """Predicted position of a moving target at the mid time of one exposure (F-33)."""

    ra_deg: float  # topocentric (from the spacecraft), astrometric ICRF
    dec_deg: float
    geocentric_ra_deg: float  # JPL Horizons, observer 500@399
    geocentric_dec_deg: float
    parallax_shift_arcsec: float | None  # topocentric minus geocentric; None without X_SC
    delta_au: float
    ra_3sigma_arcsec: float | None
    dec_3sigma_arcsec: float | None
    solution: str  # Horizons orbit solution id, for example "JPL#55"


class ManifestFrame(_Model):
    detector: int | Literal["all"]
    # "exposure": one single exposure on a grid centered on a moving target; "stack": the
    # inverse-variance mean of the exposures of one detector and campaign on that co-moving grid
    # (the target is sharp, stars trail). Both only in moving-target manifests (F-33).
    kind: Literal["coadd", "broadband", "exposure", "stack"]
    url: str
    fits_url: str | None = None
    wavelength_um: tuple[float, float] | None = None
    n_images: int
    flagged_fraction: float
    obs_ids: list[str]
    collections: list[str]
    dois: list[str]
    t_start: str  # ISO 8601 UTC
    t_end: str
    t_mid_mjd: float
    normalization: str | None = None  # broadband only: how each detector was normalised
    # Service that produced each input cutout (obs_id -> "s3" or "irsa"); absent in manifests
    # built before the S3 source existed (all of those cutouts came from IRSA).
    cutout_sources: dict[str, Literal["s3", "irsa"]] | None = None
    # PNG on the frame grid whose alpha channel marks the pixels counted in flagged_fraction, and
    # the masking flag names (read from the FLAGS headers) set in the frame's inputs inside the
    # field. Both absent in manifests built before the mask overlay existed.
    flags_url: str | None = None
    mask_flags: list[str] | None = None
    # Moving-target frames only (F-33). The grid of such a frame is the manifest grid shape and
    # scale centered on `center_deg` (the predicted target position), not on grid.crval_deg.
    center_deg: tuple[float, float] | None = None
    target_wavelength_um: float | None = None  # spectral WCS (key W, SIP off) at the target
    ephemeris: ManifestEphemerisPoint | None = None
    campaign: int | None = None


class ManifestEpoch(_Model):
    index: int
    t_start: str
    t_end: str
    t_mid_mjd: float
    n_images: int
    frames: list[ManifestFrame]
    # "low": a short revisit (fewer images than a survey pass, on some detectors only),
    # built on request. It is shown but never used in measurements (docs/03 section 4.1).
    coverage: Literal["full", "low"] = "full"


class ManifestStretch(_Model):
    method: Literal["asinh"] = "asinh"
    vmin: float
    vmax: float
    softening: float
    unit: str


class ManifestProvenance(_Model):
    collections: list[str]
    dois: list[str]
    services: list[str]
    data_release_dates: list[str] = Field(default_factory=list)
    solid_angle_maps: list[str] = Field(default_factory=list)


class ManifestWarning(_Model):
    code: str
    detail: str


class ManifestCampaign(_Model):
    index: int
    t_start: str
    t_end: str
    t_mid_mjd: float
    n_images: int
    parallax_bound_arcsec: float | None  # largest r_sc / delta over its exposures


class ManifestMovingTarget(_Model):
    """Moving-target sequence (F-33): epochs are single exposures on co-moving grids."""

    designation: str  # as requested
    name: str  # Horizons target name
    horizons_record: int
    solution: str
    ephemeris_service: str
    discovery_path: Literal["tap", "s3_header_scan"]
    discovery_detail: str
    method_version: str
    aperture_arcsec: float
    annulus_arcsec: tuple[float, float]
    campaigns: list[ManifestCampaign]
    stacks: list[ManifestFrame]
    spectrum_url: str | None = None
    ephemeris_check_url: str | None = None


class Manifest(_Model):
    schema_version: int = SCHEMA_VERSION
    sequence_id: str
    pipeline_version: str
    created_at: str
    request: ManifestRequest
    grid: ManifestGrid
    epochs: list[ManifestEpoch]
    stretch: dict[str, ManifestStretch]
    photometry_url: str | None = None
    provenance: ManifestProvenance
    warnings: list[ManifestWarning] = Field(default_factory=list)
    moving_target: ManifestMovingTarget | None = None
