// F-29 candidates to review: pure helpers shared by the panel and the player canvas. Unit tested.
// A candidate is a place where two epochs differ. Nothing here claims that an object was found.
import { ApiError } from '../../lib/api';
import { isLowCoverage } from '../../lib/types';
import type {
  Candidate,
  CandidateCatalog,
  CandidateStatus,
  CandidatesResult,
  EpochInfo,
  Mode,
} from '../../lib/types';

export interface Pt {
  x: number;
  y: number;
}

/** Statuses listed by default; the others sit in collapsed groups. */
export const PRIMARY_STATUSES: CandidateStatus[] = ['unmatched', 'unchecked'];
export const GROUP_STATUSES: CandidateStatus[] = ['target', 'known_source', 'not_measurable'];

/** Ring radius in frame px of an unpaired entry and of each end of a moved pair. */
export const RING_R = 3.2;
export const PAIR_RING_R = 2.2;

/**
 * Line dash per status in CSS px (empty = solid), used by the canvas and by the legend glyphs. The status is
 * readable without color: solid, long dash, short dash, and dotted with a cross.
 */
export const STATUS_DASH: Record<CandidateStatus, number[]> = {
  unmatched: [],
  unchecked: [7, 3],
  target: [3, 3],
  known_source: [3, 3],
  not_measurable: [1, 3],
};

export interface EpochPair {
  /** 0-based manifest epoch indices sent to the API (D = A - scaled B). */
  a: number;
  b: number;
  /** 0-based positions in the shown epoch list, for labels (epoch numbers are position + 1). */
  posA: number;
  posB: number;
}

/** The pair on screen in a difference mode, or null when no difference is shown (same epoch, first of a sequence). */
export function pairFor(
  mode: Mode,
  epochIndices: number[],
  frameIdx: number,
  refIdx: number,
  /** Diff seq: position of the epoch subtracted on screen, when it is not the previous one (F-31). */
  prevPos?: number,
): EpochPair | null {
  if (mode !== 'diff' && mode !== 'diffseq') return null;
  const posA = frameIdx;
  const posB = mode === 'diff' ? refIdx : (prevPos ?? frameIdx - 1);
  const a = epochIndices[posA];
  const b = epochIndices[posB];
  if (a === undefined || b === undefined || a === b) return null;
  return { a, b, posA, posB };
}

/** F-31: candidates are never computed for a pair that includes a low coverage epoch (a short revisit). */
export function pairHasLowEpoch(pair: EpochPair | null, epochs: EpochInfo[]): boolean {
  if (!pair) return false;
  return isLowCoverage(epochs[pair.posA]) || isLowCoverage(epochs[pair.posB]);
}

export interface CandidateGroups {
  primary: Candidate[];
  groups: Record<'target' | 'known_source' | 'not_measurable', Candidate[]>;
}

/** Splits the list keeping the server order (entries without a catalog match first, then by significance). */
export function groupCandidates(list: Candidate[]): CandidateGroups {
  const out: CandidateGroups = { primary: [], groups: { target: [], known_source: [], not_measurable: [] } };
  for (const c of list) {
    if (c.status === 'unmatched' || c.status === 'unchecked') out.primary.push(c);
    else out.groups[c.status].push(c);
  }
  // Unmatched before unchecked inside the default list, each keeping its relative order.
  out.primary.sort((x, y) => Number(x.status !== 'unmatched') - Number(y.status !== 'unmatched'));
  return out;
}

export function formatDetectors(detectors: number[]): string {
  return [...detectors]
    .sort((x, y) => x - y)
    .map((d) => `D${d}`)
    .join(' ');
}

/** Degrees with a fixed number of decimals and a point, as catalogs print them. */
export function formatDeg(v: number, digits = 4): string {
  return v.toFixed(digits);
}

/** Text placed on the clipboard: right ascension and declination in degrees, six decimals. */
export function coordsText(c: { ra_deg: number; dec_deg: number }): string {
  return `${c.ra_deg.toFixed(6)} ${c.dec_deg >= 0 ? '+' : ''}${c.dec_deg.toFixed(6)}`;
}

/** 1-based number of the epoch in which a "brighter" entry is brighter, or null for a moved pair. */
export function brighterEpoch(c: Pick<Candidate, 'kind'>, pair: EpochPair): number | null {
  if (c.kind === 'brighter_in_a') return pair.posA + 1;
  if (c.kind === 'brighter_in_b') return pair.posB + 1;
  return null;
}

/** Catalogs that did not answer for this pair. */
export function unavailableCatalogs(r: Pick<CandidatesResult, 'catalogs'>): CandidateCatalog[] {
  return (['gaia_dr3', 'catwise2020'] as const).filter((k) => r.catalogs[k] === 'unavailable');
}

export interface CandidateMarker {
  id: string;
  status: CandidateStatus;
  selected: boolean;
  /** One ring for an unpaired entry; two for a moved pair (epoch B first, then epoch A). */
  rings: { x: number; y: number; r: number }[];
  /** Moved pair: segment from the epoch B ring to the epoch A ring, trimmed at the ring edges. */
  line: [Pt, Pt] | null;
}

export function markerFor(c: Candidate, selected: boolean): CandidateMarker {
  if (c.kind === 'moved' && c.a && c.b) {
    const dx = c.a.x - c.b.x;
    const dy = c.a.y - c.b.y;
    const d = Math.hypot(dx, dy);
    const rings = [
      { x: c.b.x, y: c.b.y, r: PAIR_RING_R },
      { x: c.a.x, y: c.a.y, r: PAIR_RING_R },
    ];
    // Overlapping rings leave no room for a segment between them.
    if (d <= 2 * PAIR_RING_R) return { id: c.id, status: c.status, selected, rings, line: null };
    const ux = dx / d;
    const uy = dy / d;
    return {
      id: c.id,
      status: c.status,
      selected,
      rings,
      line: [
        { x: c.b.x + ux * PAIR_RING_R, y: c.b.y + uy * PAIR_RING_R },
        { x: c.a.x - ux * PAIR_RING_R, y: c.a.y - uy * PAIR_RING_R },
      ],
    };
  }
  return { id: c.id, status: c.status, selected, rings: [{ x: c.x, y: c.y, r: RING_R }], line: null };
}

/**
 * Markers drawn on the frame: the default list always, a collapsed group only while it is open, and the
 * selected entry in any case. The selected marker comes last so it is drawn on top.
 */
export function candidateMarkers(
  list: Candidate[],
  selectedId: string | null,
  open: Partial<Record<CandidateStatus, boolean>> = {},
): CandidateMarker[] {
  const out: CandidateMarker[] = [];
  let sel: CandidateMarker | null = null;
  for (const c of list) {
    const isSel = c.id === selectedId;
    if (isSel) sel = markerFor(c, true);
    else if (PRIMARY_STATUSES.includes(c.status) || open[c.status]) out.push(markerFor(c, false));
  }
  if (sel) out.push(sel);
  return out;
}

/** Marker under a point in frame px (inside a ring, with a small tolerance), nearest first. */
export function hitMarker(markers: CandidateMarker[], p: Pt, tolerance = 1): CandidateMarker | null {
  let best: CandidateMarker | null = null;
  let bd = Infinity;
  for (const m of markers) {
    for (const ring of m.rings) {
      const d = Math.hypot(ring.x - p.x, ring.y - p.y);
      if (d <= ring.r + tolerance && d < bd) {
        bd = d;
        best = m;
      }
    }
  }
  return best;
}

const KNOWN_ERRORS = [
  'TOO_FEW_EPOCHS',
  'INVALID_EPOCHS',
  'NO_FITS',
  'RATE_LIMITED',
  'NOT_FOUND',
  'DEMO_UNAVAILABLE',
  'LOW_COVERAGE_EPOCH',
];

/** Key under `cand.err` for a failed request. */
export function candidateErrorKey(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'RATE_LIMITED';
    if (KNOWN_ERRORS.includes(e.code)) return e.code;
    if (e.status === 0) return 'network';
    return 'generic';
  }
  return e instanceof TypeError ? 'network' : 'generic';
}

/**
 * Marks that prefill the report flow (F-22) for a candidate, keyed by manifest epoch index: the position in each
 * epoch for a moved pair, the same position in both epochs otherwise. The reporter adjusts them in the blink.
 */
export function reportMarksFor(c: Candidate, pair: EpochPair): Record<number, Pt> {
  const pa = c.a ?? c;
  const pb = c.b ?? c;
  return { [pair.a]: { x: pa.x, y: pa.y }, [pair.b]: { x: pb.x, y: pb.y } };
}
