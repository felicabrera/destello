"""SQLite storage for candidate reports (F-22): engine setup and online backup.

The database holds only reports. It runs in WAL mode so the API can read while it writes, with a
busy timeout so the backup job and the API never fail on a short lock (docs/04, docs/09).
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlmodel import SQLModel, create_engine

SQLITE_PREFIX = "sqlite:///"
BUSY_TIMEOUT_MS = 5000


def sqlite_path(db_url: str) -> Path | None:
    """File path of a `sqlite:///` URL (four slashes for an absolute path); None otherwise."""
    if not db_url.startswith(SQLITE_PREFIX):
        return None
    rest = db_url[len(SQLITE_PREFIX) :]
    if not rest or rest == ":memory:":
        return None
    return Path(rest)


def _set_pragmas(dbapi_conn: Any, _record: Any) -> None:
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.close()


def make_engine(db_url: str) -> Engine:
    """Create the engine, the parent directory and the tables (idempotent)."""
    path = sqlite_path(db_url)
    if path is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        db_url,
        connect_args={"check_same_thread": False, "timeout": BUSY_TIMEOUT_MS / 1000.0},
    )
    if db_url.startswith("sqlite"):
        event.listen(engine, "connect", _set_pragmas)
    import destello.models.hunt  # noqa: F401  (registers the Hunt tables)
    import destello.models.reports  # noqa: F401  (registers the table on the metadata)

    SQLModel.metadata.create_all(engine)
    _add_missing_columns(engine)
    return engine


def _add_missing_columns(engine: Engine) -> None:
    """Add columns that tables created by an earlier version lack (SQLite, no migration tool).

    `create_all` never alters an existing table. Each entry is (table, column, SQL type); the column
    is added as nullable, so old rows keep NULL."""
    wanted = (("hunt_votes", "client_hash", "VARCHAR(64)"),)
    with engine.begin() as conn:
        for table, column, sql_type in wanted:
            cols = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if cols and column not in cols:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {sql_type}")


def backup_sqlite(src: Path, dest_dir: Path, keep: int, now: datetime | None = None) -> Path:
    """Online backup of `src` (consistent while the API writes) into a dated file in `dest_dir`.

    Keeps the newest `keep` backups and removes older ones. Returns the new backup path."""
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"reports-{stamp}.sqlite"
    tmp = dest.with_suffix(".sqlite.part")
    source = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True, timeout=10.0)
    try:
        target = sqlite3.connect(tmp)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    tmp.replace(dest)
    backups = sorted(dest_dir.glob("reports-*.sqlite"))
    for old in backups[: max(len(backups) - keep, 0)]:
        old.unlink(missing_ok=True)
    return dest
