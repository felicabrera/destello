"""Small file backed cache used by sources and the worker (atomic writes, content addressed)."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write bytes to path atomically (write to a temp file in the same directory, then rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def sha256_hex(data: bytes, length: int = 16) -> str:
    return hashlib.sha256(data).hexdigest()[:length]


class JsonCache:
    """Cache of JSON documents under <root>/<namespace>/<key>.json."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def _path(self, namespace: str, key: str) -> Path:
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in key)[:120]
        digest = hashlib.sha256(key.encode()).hexdigest()[:10]
        return self.root / namespace / f"{safe}-{digest}.json"

    def get(self, namespace: str, key: str) -> Any | None:
        path = self._path(namespace, key)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None

    def put(self, namespace: str, key: str, value: Any) -> None:
        atomic_write_bytes(
            self._path(namespace, key), json.dumps(value, sort_keys=True).encode("utf-8")
        )
