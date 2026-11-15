"""Hunt field bank file and scripts/build_hunt_bank.py (pure parts only; nothing is built)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from destello.models.hunt_bank import LABELS, load_bank

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "build_hunt_bank.py"
spec = importlib.util.spec_from_file_location("build_hunt_bank", SCRIPT)
assert spec and spec.loader
bhb = importlib.util.module_from_spec(spec)
sys.modules["build_hunt_bank"] = bhb
spec.loader.exec_module(bhb)


def test_bank_shape() -> None:
    bank = load_bank()
    kinds = [f.kind for f in bank.fields]
    assert len(bank.fields) == 25
    assert kinds.count("gold") == 5  # five gold stars removed in bank version 2 (science review)
    assert kinds.count("ecliptic") == kinds.count("random") == 10
    assert len({f.id for f in bank.fields}) == 25
    assert all(f.reason.strip() for f in bank.fields)
    for f in bank.fields:
        if f.kind == "gold":
            assert f.answer in LABELS and f.astrometry is not None
            assert f.astrometry.source.startswith("Gaia DR3 ") and f.astrometry.verified
            assert (f.astrometry.pmra_masyr**2 + f.astrometry.pmdec_masyr**2) ** 0.5 > 2000


def test_generated_fields_match_file() -> None:
    bank = load_bank()
    for kind, gen in (("ecliptic", bhb.ecliptic_fields()), ("random", bhb.random_fields())):
        got = [f for f in bank.fields if f.kind == kind]
        assert [g["id"] for g in gen] == [f.id for f in got]
        for g, f in zip(gen, got, strict=True):
            assert (f.ra_deg, f.dec_deg) == (g["ra_deg"], g["dec_deg"])


def test_ecliptic_and_random_constraints() -> None:
    for f in bhb.ecliptic_fields():
        assert abs(f["ecl_lat_deg"]) < 5 and abs(f["gal_lat_deg"]) >= 20
    assert len({f["ecl_lon_deg"] for f in bhb.ecliptic_fields()}) == 10
    for f in bhb.random_fields():
        assert 30 <= abs(f["gal_lat_deg"]) <= 60
    assert bhb.random_fields(35) == bhb.random_fields(35)
    assert bhb.random_fields(36) != bhb.random_fields(35)


def test_gold_center_moves_with_proper_motion() -> None:
    bank = load_bank()
    f = next(x for x in bank.fields if x.kind == "gold")
    ra, dec = bhb.field_center(f)
    a = f.astrometry
    assert a is not None
    # About 10 years of motion at several arcsec/yr: far from the J2016.0 position.
    sep = ((ra - a.ra_deg) * 0.7071) ** 2 + (dec - a.dec_deg) ** 2
    assert sep**0.5 * 3600 > 20
    p = bhb.field_params(bank, f)
    assert (p.ra_deg, p.dec_deg) == (ra, dec) and p.fov_arcmin == bank.fov_arcmin


def test_select_fields_resumes(tmp_path: Path) -> None:
    bank = load_bank()
    ids = [f.id for f in bank.fields]
    status = {i: bhb.empty_entry() for i in ids}
    status[ids[0]].update(status="ready", sequence_id="a" * 16)
    status[ids[1]].update(status="ready", sequence_id="b" * 16)
    status[ids[2]].update(status="failed")

    def exists(sid: str) -> bool:
        return sid.startswith("a")  # the manifest of ids[1] is gone

    def sel(**kw: object) -> list[str]:
        args: dict = {
            "only": None,
            "retry_failed": False,
            "force": False,
            "manifest_exists": exists,
        }
        args.update(kw)
        return [f.id for f in bhb.select_fields(bank, status, **args)]

    out = sel()
    assert ids[0] not in out and ids[1] in out and ids[2] not in out and len(out) == 23
    assert ids[2] in sel(retry_failed=True)
    assert sel(only={ids[2]}) == [ids[2]]
    assert ids[0] in sel(force=True)


def test_status_roundtrip_is_atomic(tmp_path: Path) -> None:
    bank = load_bank()
    path = tmp_path / "hunt" / "bank_status.json"
    assert bhb.load_status(path) == {}
    entry = bhb.empty_entry() | {"status": "ready", "sequence_id": "c" * 16, "epochs": 3}
    bhb.save_status(path, bank, {"gold-01": entry})
    assert bhb.load_status(path)["gold-01"]["epochs"] == 3
    assert json.loads(path.read_text())["bank_version"] == bank.version
    assert not path.with_suffix(".part").exists()


def test_bank_status_has_no_secrets() -> None:
    assert set(bhb.empty_entry()) == {"sequence_id", "epochs", "status", "updated", "error"}
    with pytest.raises(StopIteration):
        next(f for f in load_bank().fields if f.kind == "gold" and not f.answer)
