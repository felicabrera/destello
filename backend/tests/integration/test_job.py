"""End to end build_sequence on recorded real cutouts (no network): fixtures from Barnard's Star."""

from __future__ import annotations

import csv
import json
import shutil
from pathlib import Path
from typing import Any

import astropy.units as u
import fakeredis.aioredis
import numpy as np
import pytest
from PIL import Image

from destello.core.config import Settings
from destello.models.manifest import Manifest
from destello.models.targets import load_targets
from destello.pipeline.calibrate import DEFAULT_MASK_FLAGS
from destello.pipeline.query import ImageRecord, parse_rows
from destello.sources.base import SourceError
from destello.worker import jobs
from destello.worker.jobs import SequenceParams, build_sequence, params_sequence_id, preset_params

FIX = Path(__file__).resolve().parent.parent / "fixtures"


class FakeIrsa:
    """Stands in for IrsaClient: discovery from a recorded TAP response, cutouts from fixtures."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        with open(FIX / "barnard_records.csv", newline="") as fh:
            self.records = parse_rows(list(csv.DictReader(fh)))

    async def query_images(
        self, ra: float, dec: float, collections: list[str], detectors: Any = None
    ) -> list[ImageRecord]:
        # The recorded response dates from Quick Release 2, which IRSA has since republished as
        # Data Release 1: the fake serves those records when the successor collection is asked for.
        dets = set(detectors) if detectors is not None else None
        return [
            r
            for r in self.records
            if r.collection.replace("_qr2", "_dr1") in collections
            and (dets is None or r.detector in dets)
        ]

    async def download_cutout(
        self, rec: ImageRecord, ra: float, dec: float, size: u.Quantity
    ) -> Path:
        src = FIX / "cutouts" / f"{rec.observation_id}_D{rec.detector}.fits"
        if not src.exists():
            raise SourceError("no fixture")
        dst = self.settings.cutouts_dir / src.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, dst)
        return dst

    async def solid_angle_map(self, collection: str, detector: int) -> Any:
        raise SourceError("solid angle map not available in tests")

    def sapm_path(self, collection: str, detector: int) -> Path:
        return Path("none")

    async def aclose(self) -> None:
        return None


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path, pipeline_version="test")


async def test_build_sequence_end_to_end(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs, "MIN_EPOCH_IMAGES", 1)
    target = load_targets()["barnard"]
    base = preset_params(target)
    params = SequenceParams(**{**base.__dict__, "detectors": (2, 6)})
    seq_id = params_sequence_id(params, settings)
    redis = fakeredis.aioredis.FakeRedis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(f"destello:seq:{seq_id}")
    ctx = {"settings": settings, "redis": redis, "irsa": FakeIrsa(settings)}

    assert await build_sequence(ctx, params.to_dict()) == seq_id

    events: list[dict[str, Any]] = []
    misses = 0
    while misses < 5:
        msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=0.1)
        if msg is None:
            misses += 1
            continue
        misses = 0
        events.append(json.loads(msg["data"]))
    names = [e["event"] for e in events]
    assert names[0] == "status" and names[-1] == "completed"
    epoch_events = [e for e in events if e["event"] == "epoch_ready"]
    assert [e["data"]["epoch"] for e in epoch_events] == list(range(len(epoch_events)))
    assert len(epoch_events) >= 2
    state = json.loads(await redis.get(f"destello:seq:{seq_id}:state"))
    assert state["status"] == "ready"

    mpath = settings.manifests_dir / f"{seq_id}.json"
    manifest = Manifest.model_validate_json(mpath.read_text())
    assert manifest.sequence_id == seq_id and manifest.pipeline_version == "test"
    assert manifest.grid.naxis == (116, 116)  # 6 arcmin at 3.1 arcsec per pixel
    assert manifest.epochs == sorted(manifest.epochs, key=lambda e: e.t_mid_mjd)
    for det in ("2", "6"):  # one shared stretch per detector for all epochs
        assert det in manifest.stretch
    for epoch in manifest.epochs:
        for frame in epoch.frames:
            assert frame.obs_ids and frame.collections and frame.dois and frame.t_start
            assert (settings.data_dir / frame.url.lstrip("/")).exists()
            # Flag mask on the frame grid: alpha marks exactly the pixels in flagged_fraction.
            assert frame.flags_url is not None and frame.flags_url.endswith(".png")
            with Image.open(settings.data_dir / frame.flags_url.lstrip("/")) as im:
                assert im.mode == "RGBA" and im.size == manifest.grid.naxis
                alpha = np.asarray(im)[..., 3]
            assert float(np.mean(alpha == 255)) == pytest.approx(frame.flagged_fraction, abs=1e-4)
            assert frame.mask_flags is not None
            assert frame.mask_flags == sorted(frame.mask_flags)
            assert set(frame.mask_flags) <= set(DEFAULT_MASK_FLAGS)
            if frame.kind == "coadd":
                assert frame.wavelength_um is not None
                assert frame.fits_url is not None
    assert any(f.mask_flags for ep in manifest.epochs for f in ep.frames)
    assert (settings.manifests_dir / f"{seq_id}.photometry.json").exists()
    phot = json.loads((settings.manifests_dir / f"{seq_id}.photometry.json").read_text())
    assert phot["unit"] == "Jy" and phot["points"]
    # coadd epoch photometry follows the spectrum rejection rule: a reason means no flux
    assert phot["epoch_photometry"]
    for entry in phot["epoch_photometry"]:
        assert "reason" in entry
        assert (entry["reason"] is None) == (entry["flux"] is not None)
    codes = {w.code for w in manifest.warnings}
    assert "QUICK_RELEASE_CALIBRATION" in codes
    # Saturation is stated as measured: the code is present exactly when the photometry found a
    # saturated core, and the registry risk flag alone no longer produces a warning.
    measured = any(e["reason"] == "saturated_core" for e in phot["epoch_photometry"])
    assert ("SATURATED_CORE" in codes) == measured
    assert "SATURATION_RISK" not in codes

    # every detector_ready is kept for streams that connect later, and no partial is left over
    ready_key = f"destello:seq:{seq_id}:detectors_ready"
    assert await redis.llen(ready_key) == 2
    assert names.count("detector_ready") == 2
    assert not jobs.partial_manifest_path(settings, seq_id).exists()

    # idempotent: a second run reuses the manifest and only republishes `completed`
    before = mpath.stat().st_mtime_ns
    assert await build_sequence(ctx, params.to_dict()) == seq_id
    assert mpath.stat().st_mtime_ns == before
    assert await redis.llen(ready_key) == 0  # the replay list belongs to one run


async def test_progressive_build_publishes_the_priority_detector_first(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs, "MIN_EPOCH_IMAGES", 1)
    base = preset_params(load_targets()["barnard"])
    params = SequenceParams(**{**base.__dict__, "detectors": (2, 6), "priority_detector": 2})
    seq_id = params_sequence_id(params, settings)
    partial = jobs.partial_manifest_path(settings, seq_id)
    published: list[tuple[str, dict[str, Any]]] = []
    snapshots: list[dict[str, Any]] = []

    async def publish(event: str, data: dict[str, Any]) -> None:
        published.append((event, data))
        if event == "detector_ready":  # the partial manifest is written before the event
            snapshots.append(json.loads(partial.read_text()))

    fake: Any = FakeIrsa(settings)
    assert await jobs.run_build(params, settings, publish, fake) == seq_id

    names = [e for e, _ in published]
    ready = [d for e, d in published if e == "detector_ready"]
    assert [d["detector"] for d in ready] == [2, 6]
    assert max(i for i, n in enumerate(names) if n == "detector_ready") < names.index("epoch_ready")
    assert names[-1] == "completed"
    first = ready[0]
    assert first["detectors_ready"] == [2] and first["detectors_pending"] == [6]
    assert first["manifest_url"] == f"/api/v1/sequences/{seq_id}/manifest"
    assert ready[1]["detectors_ready"] == [2, 6] and ready[1]["detectors_pending"] == []

    snap = dict(snapshots[0])
    assert snap.pop("build") == {
        "status": "partial",
        "priority_detector": 2,
        "detectors_ready": [2],
        "detectors_pending": [6],
    }
    part = Manifest.model_validate(snap)
    assert set(part.stretch) == {"2"} and part.photometry_url is None
    assert part.provenance.services == jobs.SERVICES
    assert all(f.detector == 2 for ep in part.epochs for f in ep.frames)
    assert not partial.exists()  # removed once the final manifest is written

    final = Manifest.model_validate_json((settings.manifests_dir / f"{seq_id}.json").read_text())
    # Frames published early are final: same names and stretch as in the complete manifest.
    final_d2 = {ep.index: f for ep in final.epochs for f in ep.frames if f.detector == 2}
    assert {f["epoch"]: f["url"] for f in first["frames"]} == {
        i: f.url for i, f in final_d2.items()
    }
    assert first["stretch"] == final.stretch["2"].model_dump(mode="json")
    for f in final_d2.values():
        assert f.cutout_sources and set(f.cutout_sources.values()) == {"irsa"}
        assert set(f.cutout_sources) == set(f.obs_ids)
    assert final.provenance.services == jobs.SERVICES


async def test_a_failed_build_removes_the_partial_manifest(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(jobs, "MIN_EPOCH_IMAGES", 1)

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("broadband failed")

    monkeypatch.setattr(jobs, "broadband_coadd", broken)
    base = preset_params(load_targets()["barnard"])
    params = SequenceParams(**{**base.__dict__, "detectors": (2, 6)})
    seq_id = params_sequence_id(params, settings)
    published: list[tuple[str, dict[str, Any]]] = []

    async def publish(event: str, data: dict[str, Any]) -> None:
        published.append((event, data))

    fake: Any = FakeIrsa(settings)
    with pytest.raises(RuntimeError):
        await jobs.run_build(params, settings, publish, fake)
    names = [e for e, _ in published]
    assert names.count("detector_ready") == 2  # detectors were published before the failure
    assert names[-1] == "failed" and published[-1][1]["code"] == "BUILD_FAILED"
    assert not jobs.partial_manifest_path(settings, seq_id).exists()
    assert not (settings.manifests_dir / f"{seq_id}.json").exists()


async def test_failed_event_when_nothing_covers(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeIrsa(settings)
    fake.records = []
    published: list[tuple[str, dict[str, Any]]] = []

    async def publish(event: str, data: dict[str, Any]) -> None:
        published.append((event, data))

    params = preset_params(load_targets()["barnard"])
    with pytest.raises(SourceError):
        await jobs.run_build(params, settings, publish, fake)  # type: ignore[arg-type]
    assert published[-1][0] == "failed"
