// F-32 motion search: pure helpers shared by the panel and the player canvas. Unit tested.
// A listed source moves consistently in two or more detectors. It is a candidate to review: nothing here claims
// that an object was found.
import { ApiError } from '../../lib/api';
import { localNumber } from '../../lib/format';
import type { CandidateCatalog, Lang, MotionSearchResult, MotionSource, MotionStatus } from '../../lib/types';

export interface Pt {
  x: number;
  y: number;
}

/** Line dash per status in CSS px (empty = solid), for the track on the frame and the legend glyph. */
export const MOTION_DASH: Record<MotionStatus, number[]> = {
  unmatched: [],
  unchecked: [7, 3],
  target: [3, 3],
  known_source: [3, 3],
};

/** Half side, in frame px, of the square drawn at the position of the shown epoch. */
export const MOTION_MARK_R = 2.4;

export interface MotionTrack {
  id: string;
  status: MotionStatus;
  selected: boolean;
  /** Fitted position at each searched epoch, in epoch order (frame EDGE px). */
  points: Pt[];
  /** Position at the epoch on screen, or null when that epoch was not searched (for example a short revisit). */
  current: Pt | null;
}

/**
 * Tracks drawn on the frame. `epochIndex` is the 0-based manifest index of the epoch on screen, or null when no
 * single epoch is shown. The selected track comes last so it is drawn on top.
 */
export function motionTracks(
  sources: MotionSource[],
  selectedId: string | null,
  epochIndex: number | null,
): MotionTrack[] {
  const out: MotionTrack[] = [];
  let sel: MotionTrack | null = null;
  for (const s of sources) {
    const pts = [...s.track].sort((p, q) => p.epoch - q.epoch);
    const cur = epochIndex === null ? undefined : pts.find((p) => p.epoch === epochIndex);
    const t: MotionTrack = {
      id: s.id,
      status: s.status,
      selected: s.id === selectedId,
      points: pts.map((p) => ({ x: p.x, y: p.y })),
      current: cur ? { x: cur.x, y: cur.y } : null,
    };
    if (t.selected) sel = t;
    else out.push(t);
  }
  if (sel) out.push(sel);
  return out;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y);
}

/** Track under a point in frame px (near its line or one of its epoch positions), nearest first. */
export function hitTrack(tracks: MotionTrack[], p: Pt, tolerance = 2.5): MotionTrack | null {
  let best: MotionTrack | null = null;
  let bd = Infinity;
  for (const t of tracks) {
    let d = Infinity;
    if (t.points.length === 1) d = Math.hypot(t.points[0].x - p.x, t.points[0].y - p.y);
    for (let i = 1; i < t.points.length; i++)
      d = Math.min(d, segmentDistance(p, t.points[i - 1], t.points[i]));
    if (t.current) d = Math.min(d, Math.hypot(t.current.x - p.x, t.current.y - p.y));
    if (d <= tolerance && d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

/** A motion in mas/yr shown in arcsec/yr, with its uncertainty when given (as the astrometry panel does). */
export function arcsecYr(lang: Lang, masyr: number, errMasyr?: number | null): string {
  const a = localNumber(lang, masyr / 1000, Math.abs(masyr) < 100 ? 3 : 2);
  if (errMasyr == null) return a;
  if (errMasyr / 1000 < 0.0005) return `${a} ± < 0.001`;
  return `${a} ± ${localNumber(lang, errMasyr / 1000, errMasyr < 100 ? 3 : 2)}`;
}

/** Catalogs that did not answer during the search. */
export function unavailableMotionCatalogs(r: Pick<MotionSearchResult, 'catalogs'>): CandidateCatalog[] {
  return (['gaia_dr3', 'catwise2020'] as const).filter((k) => r.catalogs[k] === 'unavailable');
}

/** Sources without a catalog counterpart first (unmatched, then unchecked), each group keeping the server order. */
export function orderSources(list: MotionSource[]): MotionSource[] {
  const rank: Record<MotionStatus, number> = { unmatched: 0, unchecked: 1, target: 2, known_source: 3 };
  return list
    .map((s, i) => ({ s, i }))
    .sort((p, q) => rank[p.s.status] - rank[q.s.status] || p.i - q.i)
    .map(({ s }) => s);
}

const KNOWN_ERRORS = ['TOO_FEW_EPOCHS', 'NO_FITS', 'RATE_LIMITED', 'NOT_FOUND', 'DEMO_UNAVAILABLE'];

/** Key under `motion.err` for a failed request. */
export function motionErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'RATE_LIMITED';
    if (KNOWN_ERRORS.includes(e.code)) return e.code;
    if (e.status === 0) return 'network';
    return 'generic';
  }
  return e instanceof TypeError ? 'network' : 'generic';
}

/** Errors that a new request cannot change, so no Retry button is offered. */
export function isFinalMotionError(key: string): boolean {
  return key === 'TOO_FEW_EPOCHS' || key === 'NO_FITS' || key === 'DEMO_UNAVAILABLE' || key === 'NOT_FOUND';
}
