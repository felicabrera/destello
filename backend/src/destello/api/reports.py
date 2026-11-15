"""Candidate reports (F-22): input validation, the public document, storage and the text export.

Reports are stored in SQLite (WAL). The public document never contains the contact address or
anything that identifies the visitor; the contact lives in its own column and is never served.
Destello does not review reports or send them anywhere.
"""

from __future__ import annotations

import json
import re
import secrets
import string
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from destello.api.report_checks import Mark
from destello.models.reports import ReportRow

REPORT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10}$")
REPORT_ID_ALPHABET = string.ascii_letters + string.digits
REPORT_SCHEMA_VERSION = 1
NOTES_MAX = 2000
CONTACT_MAX = 254
# Deliberately simple: one @, a dot in the domain, no spaces or angle brackets (docs/10).
EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9.-]{1,185}\.[A-Za-z]{2,24}$")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

NEXT_STEPS = [
    {
        "id": "backyard_worlds",
        "name": "Backyard Worlds: Planet 9",
        "url": "https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9",
        "text": "Citizen science project that searches WISE images for brown dwarfs and nearby "
        "moving objects. Its forum is the place to discuss a candidate with experienced "
        "volunteers.",
    },
    {
        "id": "minor_planet_center",
        "name": "Minor Planet Center",
        "url": "https://www.minorplanetcenter.net/",
        "text": "Clearing house for asteroid and comet astrometry. Submissions need measured "
        "positions in the MPC format; Destello does not submit for you.",
    },
]
DISCLAIMER = (
    "This is an unconfirmed candidate marked by a visitor. Automated checks only compare the marks "
    "with published catalogs; they do not confirm or reject an object. Destello does not review "
    "reports or send them anywhere."
)


def clean_notes(notes: str | None) -> str:
    """Plain text notes: line endings normalized, control characters removed, trimmed."""
    if not notes:
        return ""
    text = notes.replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL_RE.sub("", text).strip()


def clean_contact(contact: str | None) -> str | None:
    """Optional email address; None when empty. Raises ValueError when it is not an address."""
    if contact is None:
        return None
    c = contact.strip()
    if not c:
        return None
    if len(c) > CONTACT_MAX or not EMAIL_RE.match(c):
        raise ValueError("contact must be an email address")
    return c


def new_report_id() -> str:
    return "".join(secrets.choice(REPORT_ID_ALPHABET) for _ in range(10))


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_document(
    report_id: str,
    created_at: str,
    manifest: dict[str, Any],
    marks: list[Mark],
    checks: dict[str, Any],
    notes: str,
    detector: int | str | None,
) -> dict[str, Any]:
    """The public report document served by GET /reports/{id} and the .json download."""
    request = manifest.get("request") or {}
    prov = manifest.get("provenance") or {}
    grid = manifest.get("grid") or {}
    sid = str(manifest.get("sequence_id", ""))
    return {
        "schema_version": REPORT_SCHEMA_VERSION,
        "report_id": report_id,
        "url": f"/r/{report_id}",
        "created_at": created_at,
        "status": "unconfirmed",
        "sequence": {
            "sequence_id": sid,
            "manifest_url": f"/manifests/{sid}.json",
            "pipeline_version": manifest.get("pipeline_version"),
            "manifest_created_at": manifest.get("created_at"),
            "center_deg": grid.get("crval_deg"),
            "fov_arcmin": request.get("fov_arcmin"),
            "target_id": request.get("target_id"),
            "n_epochs": len(manifest.get("epochs") or []),
            "collections": prov.get("collections", []),
            "dois": prov.get("dois", []),
        },
        "detector": detector,
        "marks": [m.to_dict() for m in marks],
        "checks": checks,
        "notes": notes,
        "disclaimer": DISCLAIMER,
        "next_steps": NEXT_STEPS,
    }


# ------------------------------------------------------------------ storage (sync, run in a thread)
def insert_report(
    engine: Engine,
    manifest: dict[str, Any],
    marks: list[Mark],
    checks: dict[str, Any],
    notes: str,
    contact: str | None,
    detector: int | str | None,
) -> dict[str, Any]:
    """Store a new report under a fresh random id (retried on the unlikely collision)."""
    created = utc_now()
    for _ in range(5):
        rid = new_report_id()
        doc = build_document(rid, created, manifest, marks, checks, notes, detector)
        row = ReportRow(
            id=rid,
            created_at=created,
            sequence_id=str(manifest.get("sequence_id", ""))[:16],
            public_json=json.dumps(doc, separators=(",", ":"), ensure_ascii=False),
            contact=contact,
        )
        try:
            with Session(engine) as s:
                s.add(row)
                s.commit()
        except IntegrityError:
            continue
        return doc
    raise RuntimeError("could not allocate a report id")


def get_report(engine: Engine, report_id: str) -> dict[str, Any] | None:
    with Session(engine) as s:
        row = s.get(ReportRow, report_id)
        if row is None or row.deleted:
            return None
        doc: dict[str, Any] = json.loads(row.public_json)
        return doc


# ------------------------------------------------------------------ text export
def _fmt(v: Any, nd: int = 2, unit: str = "") -> str:
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.{nd}f}{unit}"
    return f"{v}{unit}"


_STATUS_TEXT = {
    "match": "known source at every mark",
    "partial": "known source at some marks",
    "no_match": "no match",
    "unavailable": "could not be checked",
}
_CATALOG_TEXT = {
    "gaia_dr3": "Gaia DR3",
    "catwise2020": "CatWISE2020",
    "simbad": "SIMBAD",
    "sbident": "JPL SBIdent",
}
_VERDICT_TEXT = {
    "match": "A cataloged source matches the marks. The candidate is most likely a known object.",
    "partial": "A cataloged source matches some of the marks. Compare the marks with the "
    "catalog positions before going further.",
    "incomplete": "At least one check could not run. Run the checks again later.",
    "no_match": "No catalog match. That is not proof of a new object: it may be an image "
    "artifact, a source these catalogs miss, or an unlisted asteroid.",
}


def render_text(doc: dict[str, Any], public_url: str) -> str:
    """Plain text version of a report (the .txt download). English, ASCII friendly."""
    base = public_url.rstrip("/")
    seq = doc.get("sequence") or {}
    checks = doc.get("checks") or {}
    summary = checks.get("summary") or {}
    motion = checks.get("motion") or {}
    lines: list[str] = [
        f"Destello candidate report {doc['report_id']}",
        "Status: unconfirmed",
        f"Created: {doc.get('created_at')}",
        f"Permanent link: {base}{doc.get('url')}",
        "",
        doc.get("disclaimer", DISCLAIMER),
        "",
        "SEQUENCE",
        f"  Sequence id: {seq.get('sequence_id')}",
        f"  Manifest: {base}{seq.get('manifest_url')}",
        f"  Data: {', '.join(seq.get('collections') or [])}",
        f"  DOI: {', '.join(seq.get('dois') or [])}",
        f"  Detector marked: {_fmt(doc.get('detector'))}",
        "",
        "MARKS (ICRS)",
    ]
    for m in doc.get("marks") or []:
        lines.append(
            f"  {m['index'] + 1}. epoch E{m['epoch'] + 1}  RA {m['ra_deg']:.6f}  "
            f"Dec {m['dec_deg']:+.6f}  mid {m['t_mid']}  MJD {m['t_mid_mjd']:.4f}"
        )
    lines += [
        "",
        f"ESTIMATED MOTION (from {motion.get('n_marks')} marks, parallax not fitted)",
        f"  Total: {_fmt(motion.get('total_arcsec_yr'), 2, ' arcsec/yr')} "
        f"+/- {_fmt(motion.get('sigma_arcsec_yr'), 2)}",
        f"  mu_alpha*: {_fmt(motion.get('pmra_cosdec_arcsec_yr'), 2)}  "
        f"mu_delta: {_fmt(motion.get('pmdec_arcsec_yr'), 2)} arcsec/yr",
        f"  Position angle: {_fmt(motion.get('position_angle_deg'), 1, ' deg')}  "
        f"Baseline: {_fmt(motion.get('baseline_days'), 1, ' days')}",
    ]
    if motion.get("rms_residual_arcsec") is not None:
        lines.append(f"  Residual RMS: {motion['rms_residual_arcsec']:.2f} arcsec")
    lines += [
        "",
        "AUTOMATED CHECKS",
        "  Catalog positions were propagated with proper motion (and parallax when available) to "
        "the mid time of each marked frame.",
    ]
    for key in ("gaia_dr3", "catwise2020", "simbad", "sbident"):
        s = summary.get(key) or {}
        status = _STATUS_TEXT.get(str(s.get("status")), str(s.get("status")))
        radius = s.get("radius_arcsec") or s.get("half_width_arcsec")
        line = f"  {_CATALOG_TEXT[key]}: {status}"
        if s.get("archive"):
            line = f"  {_CATALOG_TEXT[key]} (copy: {s['archive']}): {status}"
        if radius is not None:
            line += f" (search {radius:g} arcsec)"
        near = s.get("nearest")
        if near and key != "sbident":
            line += f"; nearest {near.get('source_id')} at {_fmt(near.get('sep_arcsec'))} arcsec"
        lines.append(line)
        for hit in (checks.get(key) or [])[:5]:
            if key == "sbident":
                lines.append(
                    f"      {hit.get('name')}  mark {hit.get('mark', 0) + 1}  "
                    f"{_fmt(hit.get('sep_arcsec'), 1)} arcsec  V {_fmt(hit.get('vmag'), 1)}"
                )
            else:
                seps = ", ".join(f"{h['sep_arcsec']:.1f}" for h in hit.get("marks", []))
                lines.append(f"      {hit.get('source_id')}  separations {seps} arcsec")
    lines += [
        "  SBIdent assumes a geocentric observer; SPHEREx is in low Earth orbit, so matches for "
        "very near objects are approximate.",
        "",
        f"Result: {_VERDICT_TEXT.get(str(checks.get('verdict')), '')}",
        "",
        "NOTES FROM THE REPORTER (shown as written)",
    ]
    notes = str(doc.get("notes") or "").strip()
    lines += [f"  {ln}" for ln in notes.split("\n")] if notes else ["  (none)"]
    lines += ["", "HOW TO TAKE IT FURTHER"]
    for step in doc.get("next_steps") or NEXT_STEPS:
        lines.append(f"  {step['name']}: {step['url']}")
        lines.append(f"    {step['text']}")
    lines.append("")
    return "\n".join(lines)
