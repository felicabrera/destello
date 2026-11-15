// F-22 helpers shared by the report flow and the public report page. Pure functions, unit tested.
import { pixelToSky, type Grid } from '../../lib/astrometry';
import type {
  CatalogHit,
  CheckSummary,
  EpochInfo,
  ReportCatalog,
  ReportChecks,
  ReportMarkIn,
  SmallBodyHit,
} from '../../lib/types';
import type { Mark } from '../../store/ui';

export const REPORT_CATALOGS: ReportCatalog[] = ['gaia_dr3', 'catwise2020', 'simbad', 'sbident'];
export const MIN_MARKS = 2;
export const MAX_MARKS = 12;
export const NOTES_MAX = 2000;
export const REPORT_ID_RE = /^[A-Za-z0-9_-]{10}$/;
/** Same rule as the backend (docs/10): one @, a dotted domain, no spaces or angle brackets. */
export const EMAIL_RE = /^[^@\s<>"',;]{1,64}@[A-Za-z0-9.-]{1,185}\.[A-Za-z]{2,24}$/;

export function isValidContact(v: string): boolean {
  const c = v.trim();
  return c === '' || (c.length <= 254 && EMAIL_RE.test(c));
}

/** Marks in frame px (keyed by manifest epoch index) to ICRS positions for the API, in epoch order. */
export function marksToSky(marks: Record<number, Mark>, grid: Grid): ReportMarkIn[] {
  return Object.entries(marks)
    .map(([k, m]) => {
      const sky = pixelToSky(grid, m.x, m.y);
      return { epoch: Number(k), ra_deg: round(sky.ra, 7), dec_deg: round(sky.dec, 7) };
    })
    .sort((a, b) => a.epoch - b.epoch);
}

/** Epochs that can hold a mark: those with at least one frame on screen. */
export function markableEpochs(epochs: EpochInfo[]): EpochInfo[] {
  return epochs.filter((e) => e.frames.length > 0);
}

/** Starting point of a keyboard placed mark: the mark of the nearest marked epoch, else the field center. */
export function seedMark(marks: Record<number, Mark>, epoch: number, n: number): Mark {
  const keys = Object.keys(marks)
    .map(Number)
    .sort((a, b) => Math.abs(a - epoch) - Math.abs(b - epoch));
  const near = keys.length ? marks[keys[0]] : undefined;
  return near ? { ...near } : { x: n / 2, y: n / 2 };
}

/** Moves a mark by whole frame px, kept inside the frame. North up, east left. */
export function nudge(m: Mark, dir: 'n' | 's' | 'e' | 'w', n: number, step = 1): Mark {
  const clamp = (v: number) => Math.min(n - 0.5, Math.max(0.5, v));
  if (dir === 'n') return { x: m.x, y: clamp(m.y - step) };
  if (dir === 's') return { x: m.x, y: clamp(m.y + step) };
  if (dir === 'e') return { x: clamp(m.x - step), y: m.y };
  return { x: clamp(m.x + step), y: m.y };
}

export function round(v: number, nd: number): number {
  const f = 10 ** nd;
  return Math.round(v * f) / f;
}

/** Search radius label of one check, in arcsec. */
export function searchRadius(s: CheckSummary | undefined): number | null {
  if (!s) return null;
  return s.radius_arcsec ?? s.half_width_arcsec ?? null;
}

export type NearestInfo =
  | { kind: 'source'; id: string; sep: number; mag: number | null; band: string | null }
  | { kind: 'body'; name: string; sep: number | null; vmag: number | null }
  | null;

export function nearestOf(cat: ReportCatalog, s: CheckSummary | undefined): NearestInfo {
  const n = s?.nearest;
  if (!n) return null;
  if (cat === 'sbident') {
    const b = n as SmallBodyHit;
    return { kind: 'body', name: b.name, sep: b.sep_arcsec, vmag: b.vmag };
  }
  const c = n as { source_id: string; sep_arcsec: number; mag: number | null; mag_band: string | null };
  return { kind: 'source', id: c.source_id, sep: c.sep_arcsec, mag: c.mag, band: c.mag_band };
}

/** Matched entries of one catalog, closest first (already sorted by the server). */
export function hitsOf(checks: ReportChecks, cat: ReportCatalog): (CatalogHit | SmallBodyHit)[] {
  return (checks[cat] as (CatalogHit | SmallBodyHit)[] | undefined) ?? [];
}

/** Compass point of a position angle (east of north), for the motion summary. */
export function compass(paDeg: number): 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' {
  const pts = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
  return pts[Math.round((((paDeg % 360) + 360) % 360) / 45) % 8];
}

/** Separation in arcsec of two ICRS positions (small angle, adequate below a degree). */
export function sepArcsec(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const d2r = Math.PI / 180;
  const dra = (((ra2 - ra1 + 540) % 360) - 180) * Math.cos(((dec1 + dec2) / 2) * d2r);
  return Math.hypot(dra, dec2 - dec1) * 3600;
}
