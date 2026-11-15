// Client-side sky position parser (F-01). Parsing is instant feedback; the server re-validates.

export type CoordError =
  | { code: 'empty' }
  | { code: 'format' }
  | { code: 'raRange'; value: string }
  | { code: 'decRange'; value: string }
  | { code: 'minRange' };

export interface ParsedCoords {
  ok: true;
  raDeg: number;
  decDeg: number;
  format: 'decimal' | 'sexagesimal';
}
export type ParseResult = ParsedCoords | { ok: false; error: CoordError };

const NUM = String.raw`\d+(?:\.\d+)?`;
const SEP = String.raw`\s*[,\s]\s*`;

const DECIMAL = new RegExp(String.raw`^([+-]?${NUM})${SEP}([+-]?${NUM})$`);
const UNITS = new RegExp(
  String.raw`^(\d+)h\s*(?:(\d+)m\s*(?:(${NUM})s?)?)?${SEP}([+-]?)(\d+)[d°]\s*(?:(\d+)['′m]\s*(?:(${NUM})(?:["″s]|'')?)?)?$`,
);
const COLON = new RegExp(String.raw`^(\d+):(\d+):(${NUM})${SEP}([+-]?)(\d+):(\d+):(${NUM})$`);
const SPACES = new RegExp(String.raw`^(\d+)\s+(\d+)\s+(${NUM})\s+([+-]?)(\d+)\s+(\d+)\s+(${NUM})$`);

function normalize(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/[−–—]/g, '-'); // unicode minus and dashes typed by the user
  s = s.replace(/′/g, "'").replace(/″/g, '"').replace(/º/g, '°');
  // Decimal comma in "133,79 -7,24": treat commas as decimal points when both tokens use them.
  if (/^[+-]?\d+,\d+\s+[+-]?\d+,\d+$/.test(s)) s = s.replace(/,/g, '.');
  return s.replace(/\s+/g, ' ');
}

function fromRa(raw: string): ParseResult | number {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0 || v >= 360) return { ok: false, error: { code: 'raRange', value: raw } };
  return v;
}

function sexa(
  h: string,
  m: string | undefined,
  s: string | undefined,
  sign: string,
  d: string,
  dm: string | undefined,
  ds: string | undefined,
): ParseResult {
  const hh = Number(h);
  const mm = m ? Number(m) : 0;
  const ss = s ? Number(s) : 0;
  const dd = Number(d);
  const dmm = dm ? Number(dm) : 0;
  const dss = ds ? Number(ds) : 0;
  if (mm >= 60 || ss >= 60 || dmm >= 60 || dss >= 60) return { ok: false, error: { code: 'minRange' } };
  const raHours = hh + mm / 60 + ss / 3600;
  if (raHours < 0 || raHours >= 24) {
    return { ok: false, error: { code: 'raRange', value: `${h}h` } };
  }
  const decAbs = dd + dmm / 60 + dss / 3600;
  // The sign comes from the text so that "-00 30 00" is negative.
  const decDeg = sign === '-' ? -decAbs : decAbs;
  if (decAbs > 90) return { ok: false, error: { code: 'decRange', value: `${sign}${d}` } };
  return { ok: true, raDeg: raHours * 15, decDeg, format: 'sexagesimal' };
}

/** Parse the four formats of F-01. Returns a typed error when the text looks like coordinates but is invalid. */
export function parseCoordinates(input: string): ParseResult {
  const s = normalize(input);
  if (!s) return { ok: false, error: { code: 'empty' } };

  let m = DECIMAL.exec(s);
  if (m) {
    const ra = fromRa(m[1]);
    if (typeof ra !== 'number') return ra;
    const dec = Number(m[2]);
    if (!Number.isFinite(dec) || Math.abs(dec) > 90) {
      return { ok: false, error: { code: 'decRange', value: m[2] } };
    }
    return { ok: true, raDeg: ra, decDeg: dec, format: 'decimal' };
  }
  m = UNITS.exec(s);
  if (m) return sexa(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  m = COLON.exec(s) ?? SPACES.exec(s);
  if (m) return sexa(m[1], m[2], m[3], m[4], m[5], m[6], m[7]);
  return { ok: false, error: { code: 'format' } };
}

/** True when the text looks like an attempt at coordinates (so errors are shown instead of a name lookup). */
export function looksLikeCoordinates(input: string): boolean {
  const s = normalize(input);
  return /^[+-]?\d/.test(s) && /^[\d+\-.:\s,hdms°'"]+$/.test(s);
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** Format RA as 08h55m10.83s (centi-seconds, with carry). */
export function formatRa(raDeg: number, secDecimals = 2): string {
  const f = 10 ** secDecimals;
  let total = Math.round(((((raDeg % 360) + 360) % 360) / 15) * 3600 * f);
  const max = 24 * 3600 * f;
  if (total >= max) total -= max;
  const h = Math.floor(total / (3600 * f));
  const m = Math.floor((total - h * 3600 * f) / (60 * f));
  const s = (total - h * 3600 * f - m * 60 * f) / f;
  return `${pad(h, 2)}h${pad(m, 2)}m${s.toFixed(secDecimals).padStart(3 + (secDecimals ? secDecimals : -1), '0')}s`;
}

/** Format Dec as -07°14′42.5″ (ASCII hyphen for the sign). */
export function formatDec(decDeg: number, secDecimals = 1): string {
  const f = 10 ** secDecimals;
  const total = Math.round(Math.abs(decDeg) * 3600 * f);
  const sign = decDeg < 0 && total > 0 ? '-' : '+';
  const d = Math.floor(total / (3600 * f));
  const m = Math.floor((total - d * 3600 * f) / (60 * f));
  const s = (total - d * 3600 * f - m * 60 * f) / f;
  return `${sign}${pad(d, 2)}°${pad(m, 2)}′${s.toFixed(secDecimals).padStart(3 + (secDecimals ? secDecimals : -1), '0')}″`;
}

/** Great-circle separation in degrees. */
export function separationDeg(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const r = Math.PI / 180;
  const s1 = Math.sin(((dec2 - dec1) * r) / 2);
  const s2 = Math.sin(((ra2 - ra1) * r) / 2);
  const a = s1 * s1 + Math.cos(dec1 * r) * Math.cos(dec2 * r) * s2 * s2;
  return (2 * Math.asin(Math.min(1, Math.sqrt(a)))) / r;
}

/** Human separation: arcsec under 2 arcmin, arcmin under 2 degrees, else degrees. ASCII prime marks avoided. */
export function formatSeparation(deg: number): string {
  const arcsec = deg * 3600;
  if (arcsec < 120) return `${arcsec.toFixed(arcsec < 10 ? 1 : 0)} arcsec`;
  if (deg < 2) return `${(deg * 60).toFixed(1)} arcmin`;
  return `${deg.toFixed(1)} deg`;
}

/** Decimal degrees string for URLs: 5 decimals, trailing zeros trimmed. */
export function fmtDeg(v: number): string {
  return String(Number(v.toFixed(5)));
}
