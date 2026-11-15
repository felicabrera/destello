"""Hunt (F-35): field selection, vote storage, counters and candidates.

Anonymous by design: the only visitor identifier is a random session token chosen by the browser.
A vote also stores a salted hash of the client address (never the address), used only to cap how
many sessions of one address count toward consensus. Gold answers and field kinds never leave this
module except through `gold_feedback`, which is called after a vote is stored. What identifies a
field (sequence id, centre, observation ids, dates) leaves it only through `provenance`, after the
session voted on that field.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import random
import re
import secrets
import time
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, col, func, select

from destello.core.config import Settings
from destello.models.hunt import HuntCountryRow, HuntServedRow, HuntVoteRow
from destello.models.hunt_bank import HuntBank, HuntField, read_status
from destello.pipeline import hunt as consensus

SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
UNKNOWN_COUNTRY = "unknown"
NON_COUNTRY = frozenset({"XX", "T1"})  # Cloudflare: unknown, Tor
GOLD_EVERY = 5  # one gold field in every block of five
MIN_EPOCHS = 2  # a blink needs at least two epochs
TOKEN_TTL_S = 2 * 3600  # a vote token is valid for two hours after /next issued it
PUBLIC_ID_LEN = 16  # hex characters of the opaque field id
MAX_SESSIONS_PER_CLIENT = 2  # sessions of one hashed address that count per field in consensus
SERVED_KEEP_DAYS = 7  # hunt_served rows older than this are removed
TOKEN_RE = re.compile(r"^[0-9]{9,12}\.[0-9a-f]{64}$")

_FALLBACK_SECRET = secrets.token_hex(32)  # per process; only for development and tests


class VoteTokenError(Exception):
    """The vote token is malformed, does not match the session and field, or has expired."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class DuplicateVote(Exception):
    """The session already voted on the field."""


def utc_now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def country_code(header: str | None, production: bool) -> str:
    """Country counter key: the CF-IPCountry value in production, "unknown" otherwise."""
    if not production or header is None:
        return UNKNOWN_COUNTRY
    code = header.strip().upper()
    if COUNTRY_RE.match(code) and code not in NON_COUNTRY:
        return code
    return UNKNOWN_COUNTRY


# ------------------------------------------------------------------ opaque ids and tokens
def hunt_secret(settings: Settings) -> bytes:
    """Server secret for opaque ids, vote tokens and the gold placement.

    DESTELLO_HUNT_SECRET in production. Without it a random per-process value is used, so ids and
    tokens change on restart (acceptable for development and tests only)."""
    return (settings.hunt_secret or _FALLBACK_SECRET).encode()


def _mac(secret: bytes, *parts: str) -> str:
    return hmac.new(secret, "|".join(parts).encode(), hashlib.sha256).hexdigest()


def vote_client_key(settings: Settings, ip: str, field_id: str) -> str:
    """Value stored with a vote for the per-address consensus cap.

    Keyed with the Hunt secret and bound to the field, so two votes of one address on different
    fields do not share a value and the stored column cannot be used to follow a visitor across
    fields. IPv6 addresses are reduced to their /64 first: one subscriber usually owns the whole
    prefix, so single addresses inside it must not count as separate clients."""
    try:
        addr = ipaddress.ip_address(ip)
        if isinstance(addr, ipaddress.IPv6Address):
            if addr.ipv4_mapped is not None:  # the same client must not count twice by notation
                ip = str(addr.ipv4_mapped)
            else:
                ip = str(ipaddress.ip_network(f"{addr}/64", strict=False).network_address)
        else:
            ip = str(addr)
    except ValueError:
        pass
    return _mac(hunt_secret(settings), "client", field_id, ip)[:32]


CANDIDATE_SCOPE = "candidates"  # public listing: not a valid session token, so no collision


def public_id(settings: Settings, session: str, internal_id: str) -> str:
    """Opaque field id exposed by the API, different for every session.

    HMAC-SHA256 over the session and the internal id, 16 hex characters. A gold field learned in
    one session therefore cannot be recognized in another."""
    return _mac(hunt_secret(settings), "id", session, internal_id)[:PUBLIC_ID_LEN]


def resolve_public_id(settings: Settings, bank: HuntBank, session: str, pub: str) -> str | None:
    """Internal id of the opaque field id of this session, or None."""
    for f in bank.fields:
        if hmac.compare_digest(public_id(settings, session, f.id), pub):
            return f.id
    return None


def issue_vote_token(
    settings: Settings, session: str, internal_id: str, n_votes: int, now: float | None = None
) -> str:
    """Stateless token: issue time and HMAC over session, internal field id, the session's vote
    count `n_votes` and the issue time. It is valid only while the session still has that count."""
    issued = str(int(time.time() if now is None else now))
    mac = _mac(hunt_secret(settings), "vote", session, internal_id, str(n_votes), issued)
    return f"{issued}.{mac}"


def check_vote_token(
    settings: Settings,
    token: str,
    session: str,
    internal_id: str,
    n_votes: int,
    now: float | None = None,
) -> None:
    """Raise VoteTokenError (VOTE_TOKEN_INVALID or VOTE_TOKEN_EXPIRED) unless the token is good."""
    if not TOKEN_RE.match(token):
        raise VoteTokenError("VOTE_TOKEN_INVALID")
    issued, mac = token.split(".")
    want = _mac(hunt_secret(settings), "vote", session, internal_id, str(n_votes), issued)
    if not hmac.compare_digest(mac, want):
        raise VoteTokenError("VOTE_TOKEN_INVALID")
    age = (time.time() if now is None else now) - int(issued)
    if age < -60 or age > TOKEN_TTL_S:
        raise VoteTokenError("VOTE_TOKEN_EXPIRED")


def selection_rng(secret: bytes, session: str, n_votes: int) -> random.Random:
    """Random generator seeded from the session and its vote count: /next is repeatable."""
    return random.Random(int(_mac(secret, "pick", session, str(n_votes)), 16))


def gold_slot(secret: bytes, session: str, block: int) -> int:
    """Position (0 to GOLD_EVERY - 1) of the gold field in block `block` of a session.

    Deterministic from the session and the secret: stable for one session, not a fixed rhythm.
    The very first field of a session is never gold."""
    n = int(_mac(secret, "gold", session, str(block))[:8], 16)
    return 1 + n % (GOLD_EVERY - 1) if block == 0 else n % GOLD_EVERY


# ------------------------------------------------------------------ bank
def ready_fields(settings: Settings, bank: HuntBank) -> dict[str, dict[str, Any]]:
    """Fields with a built sequence, keyed by id: the status entry (sequence, centre, epochs)."""
    status = read_status(settings)
    out: dict[str, dict[str, Any]] = {}
    for f in bank.fields:
        e = status.get(f.id)
        if (
            isinstance(e, dict)
            and e.get("status") == "ready"
            and e.get("sequence_id")
            and int(e.get("epochs") or 0) >= MIN_EPOCHS
            and e.get("ra_deg") is not None
            and e.get("dec_deg") is not None
        ):
            out[f.id] = e
    return out


def public_field(
    settings: Settings,
    bank: HuntBank,
    field: HuntField,
    entry: dict[str, Any],
    session: str,
    n_votes: int,
) -> dict[str, Any]:
    """What a volunteer may see before voting. No kind, reason, answer or catalog astrometry.

    The field id is opaque and `vote_token` authorizes one vote of this session on this field."""
    return {
        "field_id": public_id(settings, session, field.id),
        "vote_token": issue_vote_token(settings, session, field.id, n_votes),
        "sequence_id": entry["sequence_id"],
        "epochs": int(entry["epochs"]),
        "center_deg": {"ra": float(entry["ra_deg"]), "dec": float(entry["dec_deg"])},
        "fov_arcmin": bank.fov_arcmin,
        "manifest_url": f"/manifests/{entry['sequence_id']}.json",
    }


def choose_next(
    rng: random.Random,
    secret: bytes,
    session: str,
    fields: dict[str, HuntField],
    ready: dict[str, dict[str, Any]],
    seen: set[str],
    votes: dict[str, int] | None = None,
) -> str | None:
    """Next field id for a session that has already voted on `seen`. Never returns a seen field.

    One gold field comes in every block of GOLD_EVERY fields, at a position chosen from the session
    and the server secret (see `gold_slot`). Among the unseen fields of the wanted kind (the other
    kind when it is exhausted) the ones with the fewest total votes `votes` are kept, and the pick
    among them uses the HMAC seeded `rng`. The caller stores the pick (`serve_field`), so asking
    again cannot produce another field for the same vote count."""
    unseen = [i for i in ready if i not in seen and i in fields]
    if not unseen:
        return None
    gold = [i for i in unseen if fields[i].kind == "gold"]
    other = [i for i in unseen if fields[i].kind != "gold"]
    n = len(seen)
    want_gold = n % GOLD_EVERY == gold_slot(secret, session, n // GOLD_EVERY)
    pool = (gold or other) if want_gold else (other or gold)
    counts = votes or {}
    low = min(counts.get(i, 0) for i in pool)
    return rng.choice(sorted(i for i in pool if counts.get(i, 0) == low))


def gold_feedback(field: HuntField, label: str) -> dict[str, Any] | None:
    """The gold answer, only for gold fields and only after the vote was stored."""
    if field.kind != "gold":
        return None
    return {"answer": field.answer, "correct": label == field.answer}


# ------------------------------------------------------------------ storage (sync, run in a thread)
def session_state(engine: Engine, session: str) -> set[str]:
    """Fields the session has voted on."""
    with Session(engine) as s:
        return set(s.exec(select(HuntVoteRow.field_id).where(HuntVoteRow.session == session)))


def session_vote_count(engine: Engine, session: str) -> int:
    with Session(engine) as s:
        return int(
            s.exec(
                select(func.count()).select_from(HuntVoteRow).where(HuntVoteRow.session == session)
            ).one()
        )


def field_vote_counts(engine: Engine) -> dict[str, int]:
    """Total votes per field (all sessions)."""
    with Session(engine) as s:
        rows = s.exec(select(HuntVoteRow.field_id, func.count()).group_by(HuntVoteRow.field_id))
        return {fid: int(n) for fid, n in rows}


def _served_row(s: Session, session: str, n: int) -> HuntServedRow | None:
    return s.exec(
        select(HuntServedRow).where(HuntServedRow.session == session, HuntServedRow.n == n)
    ).first()


def served_field(engine: Engine, session: str, n: int) -> str | None:
    """Internal id of the field served to `session` at vote count `n`, or None."""
    with Session(engine) as s:
        row = _served_row(s, session, n)
        return row.field_id if row else None


def serve_field(
    engine: Engine,
    secret: bytes,
    session: str,
    fields: dict[str, HuntField],
    ready: dict[str, dict[str, Any]],
) -> tuple[str | None, int]:
    """The field of `session` at its current vote count, and that count.

    The first call chooses (`choose_next`, fewest total votes first) and stores the choice in
    hunt_served under the unique key (session, n); later calls return the stored field, so asking
    many times and keeping the best never changes the field. Two concurrent first calls agree: the
    loser of the unique key reads the winner's row. A stored field that is no longer built (or was
    already voted) is replaced. Rows older than SERVED_KEEP_DAYS are removed on write."""
    seen = session_state(engine, session)
    n = len(seen)
    with Session(engine) as s:
        row = _served_row(s, session, n)
        if row is not None:
            if row.field_id in ready and row.field_id not in seen and row.field_id in fields:
                return row.field_id, n
            s.delete(row)
            s.commit()
    counts = field_vote_counts(engine)
    fid = choose_next(
        selection_rng(secret, session, n), secret, session, fields, ready, seen, counts
    )
    if fid is None:
        return None, n
    now = datetime.now(UTC)
    with Session(engine) as s:
        try:
            s.add(
                HuntServedRow(
                    session=session,
                    n=n,
                    field_id=fid,
                    issued_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"),
                )
            )
            cutoff = (now - timedelta(days=SERVED_KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            s.execute(text("DELETE FROM hunt_served WHERE issued_at < :c"), {"c": cutoff})
            s.commit()
        except IntegrityError:
            s.rollback()
            row = _served_row(s, session, n)
            if row is not None:
                return row.field_id, n
    return fid, n


def insert_vote(
    engine: Engine,
    session: str,
    field: HuntField,
    label: str,
    mark: tuple[float, float] | None,
    country: str,
    expected_n: int,
    client_hash: str | None = None,
) -> None:
    """Store a vote and bump the country counter in one transaction.

    The insert is a single statement guarded by the session's vote count: it stores nothing
    unless the session still has exactly `expected_n` votes, so two requests holding tokens for
    the same count cannot both succeed (SQLite serializes writers). Raises VoteTokenError
    (VOTE_TOKEN_INVALID) when the count changed and DuplicateVote on a repeated field."""
    correct = (label == field.answer) if field.kind == "gold" else None
    with Session(engine) as s:
        try:
            res = s.execute(
                text(
                    "INSERT INTO hunt_votes (session, field_id, label, mark_ra_deg, mark_dec_deg,"
                    " gold_correct, created_at, client_hash) SELECT :session, :field_id, :label,"
                    " :ra, :dec, :correct, :created, :client WHERE (SELECT count(*) FROM hunt_votes"
                    " WHERE session = :session) = :n"
                ),
                {
                    "session": session,
                    "field_id": field.id,
                    "label": label,
                    "ra": mark[0] if mark else None,
                    "dec": mark[1] if mark else None,
                    "correct": correct,
                    "created": utc_now(),
                    "n": expected_n,
                    "client": client_hash,
                },
            )
            if res.rowcount != 1:  # type: ignore[attr-defined]
                s.rollback()
                raise VoteTokenError("VOTE_TOKEN_INVALID")
            row = s.get(HuntCountryRow, country)
            if row is None:
                s.add(HuntCountryRow(code=country, votes=1))
            else:
                row.votes += 1
                s.add(row)
            s.commit()
        except IntegrityError:
            raise DuplicateVote from None


def volunteer_weights(engine: Engine, gold_ids: set[str]) -> dict[str, float]:
    """Weight of every session that answered at least MIN_GOLD_ANSWERS current gold fields.

    Answers on fields that are no longer gold fields (removed from the bank) do not count, and a
    session with fewer answers is absent: its votes do not count toward consensus."""
    with Session(engine) as s:
        rows = s.exec(
            select(HuntVoteRow.session, HuntVoteRow.gold_correct).where(
                col(HuntVoteRow.gold_correct).is_not(None),
                col(HuntVoteRow.field_id).in_(sorted(gold_ids)),
            )
        )
        n: Counter[str] = Counter()
        c: Counter[str] = Counter()
        for sess, ok in rows:
            n[sess] += 1
            c[sess] += 1 if ok else 0
    return {
        k: consensus.volunteer_weight(c[k], n[k]) for k in n if n[k] >= consensus.MIN_GOLD_ANSWERS
    }


def counters(engine: Engine, field_ids: set[str]) -> dict[str, Any]:
    """Public totals over the fields of the current bank only (removed fields are not counted)."""
    ids = sorted(field_ids)
    in_bank = col(HuntVoteRow.field_id).in_(ids)
    with Session(engine) as s:
        total = int(s.exec(select(func.count()).select_from(HuntVoteRow).where(in_bank)).one())
        fields = int(
            s.exec(select(func.count(func.distinct(HuntVoteRow.field_id))).where(in_bank)).one()
        )
        gold_n = int(
            s.exec(
                select(func.count()).where(col(HuntVoteRow.gold_correct).is_not(None), in_bank)
            ).one()
        )
        gold_ok = int(
            s.exec(
                select(func.count()).where(HuntVoteRow.gold_correct == True, in_bank)  # noqa: E712
            ).one()
        )
        countries = int(
            s.exec(
                select(func.count()).where(
                    HuntCountryRow.code != UNKNOWN_COUNTRY, HuntCountryRow.votes > 0
                )
            ).one()
        )
    return {
        "fields_reviewed": fields,
        "classifications": total,
        "gold_votes": gold_n,
        "gold_accuracy": (gold_ok / gold_n) if gold_n else None,
        "countries": countries,
    }


def candidates(
    settings: Settings, engine: Engine, bank: HuntBank, ready: dict[str, dict[str, Any]]
) -> list[dict[str, Any]]:
    """Non gold fields whose consensus passes the threshold, strongest first."""
    gold_ids = {f.id for f in bank.fields if f.kind == "gold"}
    weights = volunteer_weights(engine, gold_ids)
    with Session(engine) as s:
        rows = s.exec(select(HuntVoteRow).order_by(col(HuntVoteRow.id))).all()
    by_field: dict[str, list[consensus.Vote]] = {}
    per_client: Counter[tuple[str, str]] = Counter()
    for row in rows:
        if row.field_id in gold_ids or row.session not in weights:
            continue  # gold fields are never listed; sessions below the gold minimum do not count
        if row.client_hash is not None:
            # At most MAX_SESSIONS_PER_CLIENT sessions per hashed address and field, the earliest
            # votes first (rows are in insertion order). Rows without a hash (stored before the
            # column existed) are not capped.
            key = (row.field_id, row.client_hash)
            per_client[key] += 1
            if per_client[key] > MAX_SESSIONS_PER_CLIENT:
                continue
        by_field.setdefault(row.field_id, []).append(
            consensus.Vote(row.session, row.label, row.mark_ra_deg, row.mark_dec_deg)
        )
    out: list[dict[str, Any]] = []
    for fid, votes in by_field.items():
        r = consensus.field_consensus(votes, weights)
        entry = ready.get(fid)
        if not r.is_candidate or entry is None:
            continue
        out.append(
            {
                "field_id": public_id(settings, CANDIDATE_SCOPE, fid),
                "status": consensus.CONSENSUS_STATUS,
                "label": r.top_label,
                "share": round(r.top_share, 3),
                "n_votes": r.n_votes,
                "sequence_id": entry["sequence_id"],
                "center_deg": {"ra": float(entry["ra_deg"]), "dec": float(entry["dec_deg"])},
                "mark": (
                    {
                        "ra_deg": r.mark_ra_deg,
                        "dec_deg": r.mark_dec_deg,
                        "rms_arcsec": r.mark_rms_arcsec,
                        "n_marks": r.n_marks,
                    }
                    if r.mark_ra_deg is not None
                    else None
                ),
            }
        )
    out.sort(key=lambda c: (-c["share"], -c["n_votes"], c["field_id"]))  # opaque id: arbitrary tie
    return out
