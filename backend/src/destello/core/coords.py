"""Coordinate string parsing (docs/11 section 1.1).

Accepts decimal degrees ("133.795 -7.245"), sexagesimal with units ("08h55m10.831s
-07d14m42.53s"), colon separated ("08:55:10.831 -07:14:42.53") and space separated
("08 55 10.831 -07 14 42.53") input. The sign of the declination is taken from the text, so that
a declination such as "-00 30 00" is negative.
"""

from __future__ import annotations

import re

_NUM = re.compile(r"[+-]?\d+(?:\.\d*)?|[+-]?\.\d+")
_ALLOWED = re.compile(r"^[\d\s+\-.:,hmsdHMSD°'\"′″]+$")


class CoordinateError(ValueError):
    """Raised for unparseable or out of range coordinates."""

    code = "INVALID_COORDINATES"


def _sexagesimal(tokens: list[str]) -> float:
    """Convert [d, m, s] (strings, sign on the first) to a signed decimal value."""
    first = tokens[0].strip()
    negative = first.startswith("-")
    parts = [abs(float(t)) for t in tokens]
    while len(parts) < 3:
        parts.append(0.0)
    deg, minutes, seconds = parts[:3]
    if minutes >= 60.0 or seconds >= 60.0:
        raise CoordinateError("Minutes and seconds must be below 60.")
    value = deg + minutes / 60.0 + seconds / 3600.0
    return -value if negative else value


def parse_coordinates(text: str) -> tuple[float, float]:
    """Parse a coordinate string and return (ra_deg, dec_deg) in ICRS.

    Raises CoordinateError for garbage, RA outside [0, 360) or Dec outside [-90, 90].
    """
    if not isinstance(text, str) or not text.strip() or len(text) > 100:
        raise CoordinateError("Empty or too long coordinate string.")
    if not _ALLOWED.match(text.strip()):
        raise CoordinateError("Unrecognised characters in coordinates.")
    tokens = _NUM.findall(text)
    n = len(tokens)
    if n == 2:
        ra = float(tokens[0])
        dec = float(tokens[1])
    elif n in (4, 6):
        half = n // 2
        ra_h = _sexagesimal(tokens[:half])
        if ra_h < 0 or ra_h >= 24.0:
            raise CoordinateError("Right ascension must be between 0 and 24 hours.")
        ra = ra_h * 15.0
        dec = _sexagesimal(tokens[half:])
    else:
        raise CoordinateError("Expected two decimal values or a sexagesimal pair.")
    if not (0.0 <= ra < 360.0):
        raise CoordinateError("Right ascension must be in [0, 360) degrees.")
    if not (-90.0 <= dec <= 90.0):
        raise CoordinateError("Declination must be between -90 and 90 degrees.")
    return ra, dec
