"""Build order, provenance services, cloud_access parsing and the global concurrency limiter."""

from __future__ import annotations

import asyncio
from typing import Any

import fakeredis.aioredis
import pytest
from astropy.io import fits

from destello.core import limiter as limiter_mod
from destello.core.config import Settings
from destello.core.limiter import LocalLimiter, RedisLimiter, irsa_limiter, s3_limiter
from destello.sources.irsa import parse_cloud_access
from destello.sources.s3 import Box, cutout_header
from destello.worker import jobs
from destello.worker.jobs import (
    SERVICE_IBE,
    SERVICE_S3,
    SERVICE_SAPM,
    SERVICE_SIA,
    SERVICE_TAP,
    SERVICES,
    SequenceParams,
    _Group,
    detector_priority,
    params_sequence_id,
    services_for,
)

KEY = (
    "qr2/level2/2025W33_2C/l2b-v20-2025-266/6/level2_2025W33_2C_0321_1D6_spx_l2b-v20-2025-266.fits"
)


def groups(spec: dict[int, list[int]]) -> list[_Group]:
    """spec: detector -> images per epoch (0 means no images in that epoch). Only the number of
    records matters to the ordering, so placeholders stand in for image records."""
    out: list[_Group] = []
    for det, per_epoch in spec.items():
        for epoch, n in enumerate(per_epoch):
            if n:
                records: list[Any] = [object()] * n
                out.append(_Group(epoch=epoch, detector=det, records=records))
    return out


# ------------------------------------------------------------------ build order
def test_detector_priority_ranks_by_epochs_then_size_then_number() -> None:
    g = groups({6: [10, 10], 2: [5, 5], 3: [2, 0], 1: [4, 4], 5: [4, 4]})
    # Two epochs first (a usable blink), fewest images next, then the higher detector number.
    assert detector_priority(g) == [5, 1, 2, 6, 3]


def test_detector_priority_puts_the_requested_detector_first() -> None:
    g = groups({6: [10, 10], 2: [5, 5], 3: [2, 0]})
    assert detector_priority(g, 3) == [3, 2, 6]
    assert detector_priority(g, 6) == [6, 2, 3]
    assert detector_priority(g, 4) == [2, 6, 3]  # no images on D4: ignored
    assert detector_priority([], 2) == []


def test_priority_detector_does_not_change_the_sequence_id() -> None:
    settings = Settings(pipeline_version="test")
    base = SequenceParams(10.0, 20.0, 6.0, (2, 6), "all")
    prio = SequenceParams(10.0, 20.0, 6.0, (2, 6), "all", priority_detector=6)
    assert params_sequence_id(base, settings) == params_sequence_id(prio, settings)
    assert SequenceParams.from_dict(prio.to_dict()) == prio
    assert SequenceParams.from_dict(base.to_dict()).priority_detector is None
    legacy = {k: v for k, v in base.to_dict().items() if k != "priority_detector"}
    assert SequenceParams.from_dict(legacy) == base  # jobs enqueued before the field existed


def test_services_follow_the_cutout_sources() -> None:
    assert services_for(["irsa", "irsa"]) == [SERVICE_TAP, SERVICE_IBE, SERVICE_SAPM]
    assert services_for([]) == SERVICES
    assert services_for(["s3"]) == [SERVICE_TAP, SERVICE_SIA, SERVICE_S3, SERVICE_SAPM]
    assert services_for(["s3", "irsa"]) == [
        SERVICE_TAP,
        SERVICE_IBE,
        SERVICE_SIA,
        SERVICE_S3,
        SERVICE_SAPM,
    ]


def test_partial_manifest_is_not_under_the_static_manifests_route(tmp_path: Any) -> None:
    settings = Settings(data_dir=tmp_path)
    path = jobs.partial_manifest_path(settings, "0123456789abcdef")
    assert path.parent == settings.data_dir / "builds"
    assert settings.manifests_dir not in path.parents
    assert jobs.manifest_api_url("0123456789abcdef") == (
        "/api/v1/sequences/0123456789abcdef/manifest"
    )


# ------------------------------------------------------------------ cloud_access
def cloud(bucket: str, key: str) -> str:
    blob = f'{{"aws": {{"bucket_name": "{bucket}", "key": "{key}", "region": "us-east-1"}}}}'
    return '"' + blob.replace('"', '""') + '"'


def test_parse_cloud_access_keeps_only_valid_keys_of_the_spherex_bucket() -> None:
    other = KEY.replace("0321", "0322")
    csv_text = (
        "obs_id,access_url,cloud_access\n"
        f"a,https://irsa.ipac.caltech.edu/x.fits,{cloud('nasa-irsa-spherex', KEY)}\n"
        f"b,https://irsa.ipac.caltech.edu/y.fits,{cloud('nasa-irsa-spherex', KEY)}\n"
        f"c,https://irsa.ipac.caltech.edu/z.fits,{cloud('evil-bucket', other)}\n"
        f"d,x,{cloud('nasa-irsa-spherex', 'qr2/level2/../../secret.fits')}\n"
        f"e,x,{cloud('nasa-irsa-spherex', 'qr2/other/file.fits')}\n"
        f"f,x,{cloud('nasa-irsa-spherex', 'qr2/level2/file.txt')}\n"
        'g,x,"{""aws"": not json}"\n'
        "h,x,\n"
    )
    assert parse_cloud_access(csv_text) == [KEY]
    assert parse_cloud_access("") == []


def test_parse_cloud_access_accepts_data_release_keys() -> None:
    # Layout listed in the bucket for Data Release 1 (same as the Quick Releases).
    dr1 = (
        "dr1/level2/2025W33_2C/l2b-v27-2026-228/1/"
        "level2_2025W33_2C_0001_1D1_spx_l2b-v27-2026-228.fits"
    )
    csv_text = (
        "obs_id,access_url,cloud_access\n"
        f"a,https://irsa.ipac.caltech.edu/x.fits,{cloud('nasa-irsa-spherex', dr1)}\n"
        f"b,x,{cloud('nasa-irsa-spherex', 'xr1/level2/file.fits')}\n"
    )
    assert parse_cloud_access(csv_text) == [dr1]


# ------------------------------------------------------------------ cutout header
def test_cutout_header_shifts_every_crpix_and_sets_the_size() -> None:
    h = fits.Header()
    h["NAXIS"] = 2
    h["NAXIS1"] = 2040
    h["NAXIS2"] = 2040
    h["CRPIX1"] = 1020.5
    h["CRPIX2"] = 1021.0
    h["CRPIX1A"] = 1.0
    h["CRPIX2A"] = 1.0
    h["CRPIX1W"] = 10.0
    h["CRPIX2W"] = 20.0
    h["CRVAL1"] = 269.0
    h["CHECKSUM"] = "x"
    out = cutout_header(h, Box(x0=900, y0=950, nx=68, ny=67))
    assert (out["NAXIS1"], out["NAXIS2"]) == (68, 67)
    assert (out["CRPIX1"], out["CRPIX2"]) == (120.5, 71.0)
    assert (out["CRPIX1A"], out["CRPIX2A"]) == (-899.0, -949.0)
    assert (out["CRPIX1W"], out["CRPIX2W"]) == (-890.0, -930.0)
    assert out["CRVAL1"] == 269.0 and "CHECKSUM" not in out
    assert h["CRPIX1"] == 1020.5  # the input header is not modified


# ------------------------------------------------------------------ limiter
@pytest.fixture
def fast_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(limiter_mod, "POLL_MIN_S", 0.001)
    monkeypatch.setattr(limiter_mod, "POLL_MAX_S", 0.003)


async def peak_concurrency(limiters: list[Any], tasks_each: int) -> int:
    active = 0
    peak = 0

    async def use(lim: Any) -> None:
        nonlocal active, peak
        async with lim.slot():
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.005)
            active -= 1

    await asyncio.gather(*(use(lim) for lim in limiters for _ in range(tasks_each)))
    return peak


@pytest.mark.usefixtures("fast_poll")
async def test_redis_limiter_bounds_concurrency_across_processes() -> None:
    redis = fakeredis.aioredis.FakeRedis()
    # Two limiters on one key stand for two processes (API and worker): each has a local
    # semaphore of 3, so only the shared Redis lease set can keep the total at 3.
    a = RedisLimiter(redis, "destello:egress:test", 3)
    b = RedisLimiter(redis, "destello:egress:test", 3)
    peak = await peak_concurrency([a, b], 12)
    assert 1 <= peak <= 3
    assert await a.in_use() == 0  # every lease was released


@pytest.mark.usefixtures("fast_poll")
async def test_redis_limiter_falls_back_to_the_local_bound_when_redis_fails() -> None:
    class Down:
        def pipeline(self, transaction: bool = True) -> Any:
            raise ConnectionError("redis down")

    lim = RedisLimiter(Down(), "destello:egress:test", 2)
    assert 1 <= await peak_concurrency([lim], 8) <= 2


def test_limiter_factories() -> None:
    assert isinstance(irsa_limiter(None, 8), LocalLimiter)
    assert isinstance(s3_limiter(None, 16), LocalLimiter)
    redis = fakeredis.aioredis.FakeRedis()
    irsa = irsa_limiter(redis, 8)
    s3 = s3_limiter(redis, 16)
    assert isinstance(irsa, RedisLimiter) and isinstance(s3, RedisLimiter)
    assert irsa.key != s3.key and (irsa.limit, s3.limit) == (8, 16)
