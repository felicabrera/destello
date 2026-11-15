"""Report table (F-22). The public document and the private contact are stored apart.

`public_json` is exactly what `GET /reports/{id}` serves. `contact` is never serialized into it
and never returned by the API (docs/10 section 3.8).
"""

from __future__ import annotations

from sqlmodel import Field, SQLModel


class ReportRow(SQLModel, table=True):
    __tablename__ = "reports"

    id: str = Field(primary_key=True, min_length=10, max_length=10)
    created_at: str
    sequence_id: str = Field(index=True, max_length=16)
    public_json: str
    contact: str | None = Field(default=None, max_length=254)
    deleted: bool = False
