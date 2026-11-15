"""CDS Sesame name resolution through a CDS mirror (fixed host, name as the query string).

Used as a second resolver when SIMBAD TAP is unreachable. The response is plain text; the lines
used are %J (ICRS J2000 position in degrees), %P (proper motion in mas/yr), %X (parallax in mas)
and %I.0 (main identifier). Positions are ICRS at epoch J2000.0, like SIMBAD.
"""

from __future__ import annotations

from urllib.parse import quote, urlsplit

from destello.sources.base import SourceBase, SourceError, opt_float
from destello.sources.simbad import RESOLVER_TTL_S, SimbadObject

SESAME_URL = "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oI/SNV"
SESAME_HOST = urlsplit(SESAME_URL).hostname or ""


class _Unknown(Exception):
    """Sesame answered that the name is unknown."""


def parse_sesame(text: str, query: str) -> SimbadObject | None:
    """Parse a Sesame text body. None when the name is unknown; SourceError when malformed.

    The first service section that carries a %J line is used for every field, so that the
    position, motion and parallax come from the same catalogue.
    """
    sections: list[list[str]] = [[]]
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("#="):
            sections.append([])
        elif line.startswith("%"):
            sections[-1].append(line)
    section = next((s for s in sections if any(x.startswith("%J ") for x in s)), None)
    if section is None:
        if "#!" in text:  # "Nothing found" and similar service messages
            return None
        raise SourceError("Sesame returned an unexpected body")

    def fields(tag: str) -> list[str] | None:
        for line in section or []:
            head, _, rest = line.partition(" ")
            if head == tag:
                return rest.split()
        return None

    pos = fields("%J")
    try:
        ra, dec = float(pos[0]), float(pos[1])  # type: ignore[index]
    except (TypeError, IndexError, ValueError) as exc:
        raise SourceError("Sesame returned no coordinates") from exc
    if not (0.0 <= ra < 360.0 and -90.0 <= dec <= 90.0):
        raise SourceError("Sesame returned an out of range position")
    pm = fields("%P") or []
    plx = fields("%X") or []
    ident = fields("%I.0")
    main_id = " ".join(ident).lstrip("*").strip() if ident else ""
    return SimbadObject(
        query=query,
        main_id=main_id or query,
        ra_deg=ra,
        dec_deg=dec,
        ref_epoch="J2000.0",
        pmra_masyr=opt_float(pm[0]) if len(pm) >= 2 else None,
        pmdec_masyr=opt_float(pm[1]) if len(pm) >= 2 else None,
        parallax_mas=opt_float(plx[0]) if plx else None,
        rv_kms=None,
    )


class SesameClient(SourceBase):
    namespace = "sesame"

    async def resolve(self, name: str) -> SimbadObject | None:
        """Resolve an identifier; None when Sesame does not know it."""

        async def fetch() -> dict[str, object]:
            # The name is the query string of a fixed URL, percent-encoded (never a URL itself).
            response = await self.request(
                "GET", SESAME_URL + "?" + quote(name, safe=""), timeout_s=8.0
            )
            if response.status_code != 200:
                raise SourceError(f"Sesame HTTP {response.status_code}")
            obj = parse_sesame(response.text, name)
            if obj is None:
                raise _Unknown  # unknown names are not cached: the mirror can be flaky
            return obj.to_dict()

        try:
            row = await self.cached("name:" + name.lower(), fetch, ttl_s=RESOLVER_TTL_S)
        except _Unknown:
            return None
        return SimbadObject(**row)  # type: ignore[arg-type]
