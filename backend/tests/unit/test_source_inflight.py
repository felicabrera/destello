"""Concurrent identical source requests share one fetch."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from destello.core.config import DataMode, Settings
from destello.sources.base import SourceBase, SourceError


def _source(tmp_path: Path) -> SourceBase:
    return SourceBase(Settings(data_dir=tmp_path, data_mode=DataMode.ONLINE))


def test_concurrent_callers_share_one_fetch(tmp_path: Path) -> None:
    calls = 0

    async def scenario() -> list[int]:
        nonlocal calls
        src = _source(tmp_path)
        gate = asyncio.Event()

        async def fetch() -> int:
            nonlocal calls
            calls += 1
            await gate.wait()
            return 7

        tasks = [asyncio.ensure_future(src.cached("k", fetch)) for _ in range(5)]
        await asyncio.sleep(0)
        gate.set()
        out = await asyncio.gather(*tasks)
        assert src._inflight == {}
        await src.aclose()
        return out

    assert asyncio.run(scenario()) == [7] * 5
    assert calls == 1


def test_a_cancelled_caller_does_not_cancel_the_shared_fetch(tmp_path: Path) -> None:
    async def scenario() -> int:
        src = _source(tmp_path)
        gate = asyncio.Event()

        async def fetch() -> int:
            await gate.wait()
            return 3

        first = asyncio.ensure_future(src.cached("k", fetch))
        second = asyncio.ensure_future(src.cached("k", fetch))
        await asyncio.sleep(0)
        first.cancel()
        gate.set()
        value = await second
        await src.aclose()
        return value

    assert asyncio.run(scenario()) == 3


def test_a_failure_reaches_every_caller_and_is_not_remembered(tmp_path: Path) -> None:
    async def scenario() -> None:
        src = _source(tmp_path)
        n = 0

        async def fetch() -> int:
            nonlocal n
            n += 1
            if n == 1:
                await asyncio.sleep(0)
                raise SourceError("archive down")
            return 5

        results = await asyncio.gather(
            src.cached("k", fetch), src.cached("k", fetch), return_exceptions=True
        )
        assert all(isinstance(r, SourceError) for r in results) and n == 1
        assert await src.cached("k", fetch) == 5  # the next request fetches again
        await src.aclose()

    asyncio.run(scenario())


def test_different_keys_do_not_share(tmp_path: Path) -> None:
    async def scenario() -> list[str]:
        src = _source(tmp_path)

        def make(v: str):  # type: ignore[no-untyped-def]
            async def fetch() -> str:
                return v

            return fetch

        out = await asyncio.gather(src.cached("a", make("a")), src.cached("b", make("b")))
        await src.aclose()
        return out

    assert asyncio.run(scenario()) == ["a", "b"]


@pytest.mark.parametrize("mode", [DataMode.HYBRID])
def test_cached_value_skips_the_fetch(tmp_path: Path, mode: DataMode) -> None:
    async def scenario() -> tuple[int, int]:
        src = SourceBase(Settings(data_dir=tmp_path, data_mode=mode))
        n = 0

        async def fetch() -> int:
            nonlocal n
            n += 1
            return 9

        a = await src.cached("k", fetch)
        b = await src.cached("k", fetch)
        await src.aclose()
        return a + b, n

    assert asyncio.run(scenario()) == (18, 1)
