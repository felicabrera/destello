import pytest
from hypothesis import given
from hypothesis import strategies as st

from destello.core.coords import CoordinateError, parse_coordinates


def test_decimal() -> None:
    assert parse_coordinates("133.79513 -7.24515") == pytest.approx((133.79513, -7.24515))
    assert parse_coordinates("133.79513, -7.24515") == pytest.approx((133.79513, -7.24515))


def test_hms_dms_units() -> None:
    ra, dec = parse_coordinates("08h55m10.831s -07d14m42.53s")
    assert ra == pytest.approx(133.795129, abs=1e-6)
    assert dec == pytest.approx(-7.245147, abs=1e-6)


def test_colon_and_space_separated() -> None:
    a = parse_coordinates("08:55:10.831 -07:14:42.53")
    b = parse_coordinates("08 55 10.831 -07 14 42.53")
    assert a == pytest.approx(b)


def test_negative_zero_declination() -> None:
    _, dec = parse_coordinates("10 00 00 -00 30 00")
    assert dec == pytest.approx(-0.5)
    _, dec2 = parse_coordinates("10:00:00 -00:30:00")
    assert dec2 == pytest.approx(-0.5)


@pytest.mark.parametrize("text", ["360 0", "-1 0", "10 91", "10 -90.5", "25 00 00 +10 00 00"])
def test_out_of_range(text: str) -> None:
    with pytest.raises(CoordinateError):
        parse_coordinates(text)


@pytest.mark.parametrize("text", ["", "hello world", "10", "1 2 3", "10 20; DROP TABLE", "x" * 200])
def test_garbage(text: str) -> None:
    with pytest.raises(CoordinateError):
        parse_coordinates(text)


@given(st.floats(0, 359.999999), st.floats(-90, 90))
def test_decimal_roundtrip(ra: float, dec: float) -> None:
    got = parse_coordinates(f"{ra:.7f} {dec:.7f}")
    assert got[0] == pytest.approx(ra, abs=1e-6)
    assert got[1] == pytest.approx(dec, abs=1e-6)


@given(
    st.integers(0, 23),
    st.integers(0, 59),
    st.integers(0, 89),
    st.integers(0, 59),
    st.integers(0, 59),
    st.booleans(),
)
def test_sexagesimal_roundtrip(h: int, m: int, d: int, dm: int, ds: int, neg: bool) -> None:
    sign = "-" if neg else "+"
    ra, dec = parse_coordinates(f"{h:02d}:{m:02d}:00 {sign}{d:02d}:{dm:02d}:{ds:02d}")
    assert ra == pytest.approx(15 * (h + m / 60))
    expected = d + dm / 60 + ds / 3600
    assert dec == pytest.approx(-expected if neg else expected)
