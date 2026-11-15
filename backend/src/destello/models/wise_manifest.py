"""Manifest of a WISE/NEOWISE companion sequence (F-40), served next to a SPHEREx manifest.

A companion sequence holds per-visit coadds of one WISE band on exactly the grid of one SPHEREx
sequence (`spherex_sequence_id`), so the two can be shown on one timeline. Every frame names its
mission, mission phase and band: WISE and SPHEREx frames never share a stretch, and the viewer
must never present them as one instrument. Epoch `index` fields are 0-based.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from destello.models.manifest import ManifestGrid, ManifestStretch, ManifestWarning

WISE_SCHEMA_VERSION = 1


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WiseInputFrame(_Model):
    """One L1b frame that entered a coadd (or was offered to it)."""

    frame_id: str  # scan_id + 3 digit frame number, the archive frame set id
    scan_id: str
    frame_num: int
    mjd_obs: float
    t_obs: str  # ISO 8601 UTC
    table: str  # IRSA frame table (also when listed from the Parquet source table)
    phase: Literal["WISE", "NEOWISE"]
    data_release: str
    cutout_url: str  # IBE cutout of the intensity plane (msk and unc use the same box)
    qual_frame: int | None = None  # None when the frame list came from the Parquet table
    clipped_samples: int | None = None


class WiseCoaddFrame(_Model):
    mission: Literal["WISE"] = "WISE"
    phase: Literal["WISE", "NEOWISE"]
    band: Literal["W1", "W2"]
    kind: Literal["coadd"] = "coadd"
    url: str  # WebP, stretched with stretch[band]
    fits_url: str  # coadd in DN at MAGZP 22.5 (not scaled), with VARIANCE extension
    flags_url: str  # PNG, alpha where no frame has a valid pixel
    wavelength_um: tuple[float, float]  # half-peak band window (Wright et al. 2010 RSR)
    n_images: int
    flagged_fraction: float
    flux_scale: float  # factor applied before the shared stretch (field stars, reference epoch)
    flux_scale_stars: int  # field stars behind flux_scale (0: not measured, scale 1)
    t_start: str
    t_end: str
    t_mid_mjd: float
    data_releases: list[str]
    dois: list[str]
    inputs: list[WiseInputFrame]


class WiseEpoch(_Model):
    index: int
    t_start: str
    t_end: str
    t_mid_mjd: float
    phase: Literal["WISE", "NEOWISE"]
    n_images: int
    frames: list[WiseCoaddFrame]


class WiseProvenance(_Model):
    frame_list_source: Literal["irsa_tap", "neowiser_parquet"]
    frame_list_detail: str
    services: list[str]
    data_releases: list[str]
    dois: list[str]
    mask_tables: list[str]  # Explanatory Supplement tables whose bit definitions were applied
    response_curves: str


class WiseManifest(_Model):
    schema_version: int = WISE_SCHEMA_VERSION
    kind: Literal["wise_companion"] = "wise_companion"
    sequence_id: str
    spherex_sequence_id: str
    pipeline_version: str
    coadd_method_version: str
    created_at: str
    mission: Literal["WISE"] = "WISE"
    band: Literal["W1", "W2"]
    target_id: str | None = None
    grid: ManifestGrid  # identical to the SPHEREx manifest grid
    reference_epoch: int  # epoch whose flux scale is 1
    epochs: list[WiseEpoch]
    # Keyed "WISE:W2": one stretch per mission and band, shared by all its epochs.
    stretch: dict[str, ManifestStretch]
    provenance: WiseProvenance
    warnings: list[ManifestWarning] = Field(default_factory=list)
