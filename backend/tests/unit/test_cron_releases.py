"""check_releases: Redis cache and preset warm-up on a release change (docs/09 section 9)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import fakeredis.aioredis
import pytest

from destello.sources.irsa import ReleaseInfo
from destello.worker import cron


class FakeIrsa:
    def __init__(self, n_planes: int) -> None:
        self.n_planes = n_planes

    async def list_releases(self) -> list[ReleaseInfo]:
        return [
            ReleaseInfo(
                collection="spherex_qr3",
                n_planes=self.n_planes,
                latest_pub_date="2026-11-05",
                t_max_mjd=61000.0,
            )
        ]


class QueueRedis(fakeredis.aioredis.FakeRedis):  # type: ignore[misc]
    """FakeRedis that records arq enqueue_job calls."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.enqueued: list[tuple[str, str | None]] = []
        self.kwargs: list[dict[str, Any]] = []

    async def enqueue_job(
        self, name: str, *_: Any, _job_id: str | None = None, **kwargs: Any
    ) -> None:
        self.enqueued.append((name, _job_id))
        self.kwargs.append(kwargs)


def test_change_enqueues_warm_presets_once(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cron, "IrsaClient", FakeIrsa)
    redis = QueueRedis()

    async def run(n: int) -> list[dict[str, Any]]:
        return await cron.check_releases({"irsa": FakeIrsa(n), "redis": redis})

    async def scenario() -> None:
        await run(10)  # first run: records the signature, nothing to compare with
        assert redis.enqueued == []
        await run(10)  # unchanged
        assert redis.enqueued == []
        await run(11)  # new images published
        assert [name for name, _ in redis.enqueued] == ["warm_presets"]
        # The sequence id does not change with the data: only a forced build reads the new images.
        assert redis.kwargs == [{"force": True}]
        cached = json.loads(await redis.get(cron.RELEASES_KEY))
        assert cached[0]["n_planes"] == 11

    asyncio.run(scenario())


def test_signature_ignores_order_and_mjd() -> None:
    a = [
        {"collection": "b", "n_planes": 1, "latest_pub_date": "x", "t_max_mjd": 1.0},
        {"collection": "a", "n_planes": 2, "latest_pub_date": "y", "t_max_mjd": 2.0},
    ]
    b = [dict(a[1], t_max_mjd=3.0), a[0]]
    assert cron.release_signature(a) == cron.release_signature(b)
    assert cron.release_signature(a) != cron.release_signature([dict(a[0], n_planes=5), a[1]])
