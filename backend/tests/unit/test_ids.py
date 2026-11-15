from typing import Any

from destello.core.ids import cutout_key, frame_key, sequence_id


def base(**kw: Any) -> str:
    args: dict[str, Any] = {
        "ra_deg": 133.79513,
        "dec_deg": -7.24515,
        "fov_arcmin": 6,
        "detectors": [1, 2, 3],
        "release": "spherex_qr3",
        "pipeline_version": "0.3.0",
    }
    args.update(kw)
    return sequence_id(**args)


def test_format() -> None:
    sid = base()
    assert len(sid) == 16 and all(c in "0123456789abcdef" for c in sid)


def test_stable_across_order_and_float_noise() -> None:
    assert base(detectors=[3, 1, 2]) == base()
    assert base(ra_deg=133.79513 + 1e-9, dec_deg=-7.24515 - 1e-9) == base()
    assert base(mode_params={"a": 1, "b": 2}) == base(mode_params={"b": 2, "a": 1})


def test_changes_with_release_version_and_inputs() -> None:
    assert base(release="spherex_qr2") != base()
    assert base(pipeline_version="0.3.1") != base()
    assert base(fov_arcmin=8) != base()
    assert base(detectors=[1, 2]) != base()
    assert base(ra_deg=133.8) != base()


def test_cutout_and_frame_keys() -> None:
    assert cutout_key("a", 1.0, 2.0, 7.0) == cutout_key("a", 1.0 + 1e-9, 2.0, 7.0)
    assert cutout_key("a", 1.0, 2.0, 7.0) != cutout_key("b", 1.0, 2.0, 7.0)
    assert frame_key("s", 0, "6", "coadd") != frame_key("s", 1, "6", "coadd")
    assert frame_key("s", 0, "6", "coadd", {"vmin": 0.1}) != frame_key("s", 0, "6", "coadd")
