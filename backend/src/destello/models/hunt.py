"""Hunt tables (F-35). Anonymous by design.

A vote holds a random client session token, the field, the label, an optional mark, the time and a
salted hash of the client address. The hash is stored only so that consensus can count at most two
sessions per address and field (docs/06 section 3.5.2); the address itself, the country and the
user agent are never stored. The country is only a counter (one row per code). `hunt_served` keeps
which field /next gave a session at each vote count, for seven days.
"""

from __future__ import annotations

from sqlalchemy import UniqueConstraint
from sqlmodel import Field, SQLModel


class HuntVoteRow(SQLModel, table=True):
    __tablename__ = "hunt_votes"
    __table_args__ = (UniqueConstraint("session", "field_id", name="uq_hunt_session_field"),)

    id: int | None = Field(default=None, primary_key=True)
    session: str = Field(index=True, max_length=64)
    field_id: str = Field(index=True, max_length=16)
    label: str = Field(max_length=24)
    mark_ra_deg: float | None = None
    mark_dec_deg: float | None = None
    gold_correct: bool | None = None  # set for gold fields only
    created_at: str
    client_hash: str | None = Field(default=None, max_length=64)  # salted hash; NULL on old rows


class HuntServedRow(SQLModel, table=True):
    """The field /next served to a session when it had `n` votes. One row per (session, n)."""

    __tablename__ = "hunt_served"
    __table_args__ = (UniqueConstraint("session", "n", name="uq_hunt_served_session_n"),)

    id: int | None = Field(default=None, primary_key=True)
    session: str = Field(index=True, max_length=64)
    n: int
    field_id: str = Field(max_length=16)
    issued_at: str = Field(index=True)  # UTC, same format as vote times


class HuntCountryRow(SQLModel, table=True):
    """Votes per country code (ISO 3166 alpha-2 or "unknown"): a counter, nothing else."""

    __tablename__ = "hunt_countries"

    code: str = Field(primary_key=True, max_length=7)
    votes: int = 0
