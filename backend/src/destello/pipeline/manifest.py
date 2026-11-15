"""Manifest assembly helpers: turn pipeline results into the typed manifest (docs/06 3.4)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Literal

from astropy.time import Time

from destello.core.config import RELEASE_DOIS
from destello.models.manifest import (
    Manifest,
    ManifestEpoch,
    ManifestFrame,
    ManifestGrid,
    ManifestProvenance,
    ManifestRequest,
    ManifestStretch,
    ManifestWarning,
)
from destello.pipeline.render import Stretch
from destello.pipeline.reproject import GridSpec


def iso_utc(t: Time) -> str:
    """ISO 8601 UTC string with a trailing Z and second resolution."""
    return str(t.utc.strftime("%Y-%m-%dT%H:%M:%SZ"))


def dois_for(collections: Sequence[str]) -> list[str]:
    """Sorted unique DOIs for the given collections (unknown collections are skipped)."""
    return sorted({RELEASE_DOIS[c] for c in collections if c in RELEASE_DOIS})


def make_frame(
    *,
    detector: int | str,
    kind: str,
    url: str,
    fits_url: str | None,
    wavelength_um: tuple[float, float] | None,
    n_images: int,
    flagged_fraction: float,
    obs_ids: Sequence[str],
    collections: Sequence[str],
    t_start: Time,
    t_end: Time,
    t_mid: Time,
    normalization: str | None = None,
    cutout_sources: Mapping[str, str] | None = None,
    flags_url: str | None = None,
    mask_flags: Sequence[str] | None = None,
) -> ManifestFrame:
    """Build a manifest frame that carries full traceability for one rendered image."""
    cols = sorted(set(collections))
    sources: dict[str, Literal["s3", "irsa"]] | None = None
    if cutout_sources is not None:
        sources = {k: "s3" if cutout_sources[k] == "s3" else "irsa" for k in sorted(cutout_sources)}
    return ManifestFrame(
        detector=detector,
        kind=kind,
        url=url,
        fits_url=fits_url,
        wavelength_um=wavelength_um,
        n_images=n_images,
        flagged_fraction=round(float(flagged_fraction), 4),
        obs_ids=sorted(obs_ids),
        collections=cols,
        dois=dois_for(cols),
        t_start=iso_utc(t_start),
        t_end=iso_utc(t_end),
        t_mid_mjd=round(float(t_mid.utc.mjd), 5),
        normalization=normalization,
        cutout_sources=sources,
        flags_url=flags_url,
        mask_flags=sorted(set(mask_flags)) if mask_flags is not None else None,
    )


def make_epoch(
    index: int,
    t_start: Time,
    t_end: Time,
    t_mid: Time,
    n_images: int,
    frames: list[ManifestFrame],
    coverage: Literal["full", "low"] = "full",
) -> ManifestEpoch:
    return ManifestEpoch(
        index=index,
        t_start=iso_utc(t_start),
        t_end=iso_utc(t_end),
        t_mid_mjd=round(float(t_mid.utc.mjd), 5),
        n_images=n_images,
        frames=frames,
        coverage=coverage,
    )


def build_manifest(
    *,
    sequence_id: str,
    pipeline_version: str,
    request: ManifestRequest,
    grid: GridSpec,
    epochs: list[ManifestEpoch],
    stretches: dict[str, Stretch],
    photometry_url: str | None,
    collections: Sequence[str],
    services: Sequence[str],
    warnings: Sequence[ManifestWarning] = (),
    data_release_dates: Sequence[str] = (),
    solid_angle_maps: Sequence[str] = (),
    created_at: datetime | None = None,
) -> Manifest:
    """Assemble and validate the manifest."""
    created = (created_at or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ")
    cols = sorted(set(collections))
    return Manifest(
        sequence_id=sequence_id,
        pipeline_version=pipeline_version,
        created_at=created,
        request=request,
        grid=ManifestGrid(
            crval_deg=(grid.ra_deg, grid.dec_deg),
            pixel_scale_arcsec=grid.pixel_scale_arcsec,
            naxis=(grid.nx, grid.ny),
        ),
        epochs=epochs,
        stretch={
            k: ManifestStretch(vmin=s.vmin, vmax=s.vmax, softening=s.softening, unit=s.unit)
            for k, s in stretches.items()
        },
        photometry_url=photometry_url,
        provenance=ManifestProvenance(
            collections=cols,
            dois=dois_for(cols),
            services=list(services),
            data_release_dates=sorted(set(data_release_dates)),
            solid_angle_maps=sorted(set(solid_angle_maps)),
        ),
        warnings=list(warnings),
    )
