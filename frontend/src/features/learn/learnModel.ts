// F-38 "Measure it yourself": the pure rules of the activity. Everything the student sees as arithmetic is computed
// here from the clicks (frame pixels, edge coordinates, North up, East left) and from the manifest (frame times,
// grid). Nothing in this file is a measurement of its own and no result is typed in.
import { pixelToSky, type Grid } from '../../lib/astrometry';
import type { EpochInfo, FrameInfo, TargetItem } from '../../lib/types';
import { frameDetector, isLowCoverage } from '../../lib/types';
import { epochMid } from '../../lib/format';

export interface Px {
  x: number;
  y: number;
}
export interface Sky {
  ra: number;
  dec: number;
}

/** One epoch the student can click: its place in the epoch list, the manifest index and the frame time. */
export interface LearnEpoch {
  pos: number;
  index: number;
  mjd: number;
  /** Mission label read from the manifest frame; null when the frame does not carry one (the page names it). */
  mission: string | null;
}

export interface EpochPoint extends LearnEpoch {
  sky: Sky;
}

export const DAYS_PER_YEAR = 365.25;
export const ARCSEC_PER_DEG = 3600;

/** The frame of an epoch for the chosen detector (a number 1 to 6), or undefined. */
export function frameOfEpoch(e: EpochInfo, det: number): FrameInfo | undefined {
  return e.frames.find((f) => frameDetector(f) === det);
}

/** Mission label of an epoch, read from its frames; the first non-empty label wins. */
export function epochMission(e: EpochInfo, det?: number): string | null {
  const frames = det === undefined ? e.frames : [frameOfEpoch(e, det), ...e.frames];
  for (const f of frames) {
    const m = f?.mission;
    if (typeof m === 'string' && m.trim() !== '') return m.trim();
  }
  return null;
}

/**
 * Epochs the student clicks: full coverage epochs that have a frame in the detector and a time, in the order of
 * the manifest. Works for any number of epochs (and for epochs of other missions added to the manifest later).
 */
export function learnEpochs(epochs: EpochInfo[], det: number): LearnEpoch[] {
  const out: LearnEpoch[] = [];
  epochs.forEach((e, pos) => {
    if (isLowCoverage(e)) return;
    if (!frameOfEpoch(e, det)) return;
    const mjd = epochMid(e);
    if (mjd === undefined || !Number.isFinite(mjd)) return;
    out.push({ pos, index: e.index, mjd, mission: epochMission(e, det) });
  });
  return out;
}

/** The detector (1 to 6) with a frame in the most learnable epochs; ties go to the lower number. */
export function commonDetector(epochs: EpochInfo[]): number | null {
  let best: number | null = null;
  let bestN = 0;
  for (let d = 1; d <= 6; d++) {
    const n = learnEpochs(epochs, d).length;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** A click on the frame to sky coordinates with the grid of the frame. */
export function clickToSky(grid: Grid, p: Px): Sky {
  return pixelToSky(grid, p.x, p.y);
}

export function clampPx(p: Px, n: number): Px {
  return { x: Math.min(Math.max(p.x, 0), n), y: Math.min(Math.max(p.y, 0), n) };
}

export type CrosshairKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
export const CROSSHAIR_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** Moves the keyboard crosshair by `step` frame pixels (the screen directions: up is smaller y). */
export function moveCrosshair(p: Px, key: CrosshairKey, step: number, n: number): Px {
  const d = {
    ArrowUp: { x: 0, y: -step },
    ArrowDown: { x: 0, y: step },
    ArrowLeft: { x: -step, y: 0 },
    ArrowRight: { x: step, y: 0 },
  }[key];
  return clampPx({ x: p.x + d.x, y: p.y + d.y }, n);
}

/** Difference of two right ascensions in degrees, wrapped into (-180, 180]. */
export function wrapDeltaDeg(d: number): number {
  let w = ((d % 360) + 360) % 360;
  if (w > 180) w -= 360;
  return w;
}

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassPoint = (typeof COMPASS)[number];

/** Position angle in degrees, North through East, in [0, 360). */
export function positionAngleDeg(eastward: number, northward: number): number {
  const a = (Math.atan2(eastward, northward) * 180) / Math.PI;
  return ((a % 360) + 360) % 360;
}
export function compassPoint(angleDeg: number): CompassPoint {
  return COMPASS[Math.round((((angleDeg % 360) + 360) % 360) / 45) % 8];
}

export interface MotionSteps {
  first: EpochPoint;
  last: EpochPoint;
  /** More than two epochs were clicked: only the first and the last are used. */
  usesEnds: boolean;
  nClicked: number;
  /** Declination used for the cosine: the mean of the two clicked declinations. */
  decMean: number;
  cosDec: number;
  /** Differences, last minus first. */
  dRaDeg: number;
  dRaArcsec: number;
  dRaCosArcsec: number;
  dDecDeg: number;
  dDecArcsec: number;
  days: number;
  years: number;
  /** Components in arcsec per year: eastward (RA times cos dec) and northward. */
  pmRa: number;
  pmDec: number;
  total: number;
  /** Direction of motion, degrees from North toward East. */
  angleDeg: number;
  compass: CompassPoint;
}

export type MotionOutcome =
  { kind: 'ok'; steps: MotionSteps } | { kind: 'too-few'; nClicked: number } | { kind: 'no-time' };

/** The student's proper motion from the epochs they clicked (any number, in any order). */
export function measureMotion(points: EpochPoint[]): MotionOutcome {
  if (points.length < 2) return { kind: 'too-few', nClicked: points.length };
  const sorted = [...points].sort((a, b) => a.mjd - b.mjd);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const days = last.mjd - first.mjd;
  if (!(days > 0)) return { kind: 'no-time' };
  const years = days / DAYS_PER_YEAR;
  const decMean = (first.sky.dec + last.sky.dec) / 2;
  const cosDec = Math.cos((decMean * Math.PI) / 180);
  const dRaDeg = wrapDeltaDeg(last.sky.ra - first.sky.ra);
  const dDecDeg = last.sky.dec - first.sky.dec;
  const dRaArcsec = dRaDeg * ARCSEC_PER_DEG;
  const dRaCosArcsec = dRaArcsec * cosDec;
  const dDecArcsec = dDecDeg * ARCSEC_PER_DEG;
  const pmRa = dRaCosArcsec / years;
  const pmDec = dDecArcsec / years;
  const angleDeg = positionAngleDeg(pmRa, pmDec);
  return {
    kind: 'ok',
    steps: {
      first,
      last,
      usesEnds: sorted.length > 2,
      nClicked: sorted.length,
      decMean,
      cosDec,
      dRaDeg,
      dRaArcsec,
      dRaCosArcsec,
      dDecDeg,
      dDecArcsec,
      days,
      years,
      pmRa,
      pmDec,
      total: Math.hypot(pmRa, pmDec),
      angleDeg,
      compass: compassPoint(angleDeg),
    },
  };
}

// ------------------------------------------------------------------ reference values

export interface MotionValue {
  /** Components in arcsec per year. */
  pmRa: number;
  pmDec: number;
  total: number;
  angleDeg: number;
}

/** A proper motion given in mas per year (the unit of the API) as arcsec per year. */
export function motionFromMas(
  pmraMas: number | null | undefined,
  pmdecMas: number | null | undefined,
): MotionValue | null {
  if (pmraMas == null || pmdecMas == null || !Number.isFinite(pmraMas) || !Number.isFinite(pmdecMas))
    return null;
  const pmRa = pmraMas / 1000;
  const pmDec = pmdecMas / 1000;
  return { pmRa, pmDec, total: Math.hypot(pmRa, pmDec), angleDeg: positionAngleDeg(pmRa, pmDec) };
}

/** The catalog motion of the preset from GET /targets, or null when the API does not give it. */
export function catalogMotion(
  targets: TargetItem[] | undefined,
  id: string,
): (MotionValue & { source: string | null }) | null {
  const a = targets?.find((x) => x.id === id)?.astrometry;
  const m = motionFromMas(a?.pmra_masyr, a?.pmdec_masyr);
  return m ? { ...m, source: a?.source ?? null } : null;
}

/** Signed difference of the student's value from a reference, in percent of the reference; null for a zero reference. */
export function percentDifference(mine: number, reference: number): number | null {
  if (!Number.isFinite(mine) || !Number.isFinite(reference) || reference === 0) return null;
  return ((mine - reference) / reference) * 100;
}

/** Smallest angle between two directions in degrees, in [0, 180]. */
export function angleBetweenDeg(a: number, b: number): number {
  return Math.abs(wrapDeltaDeg(a - b));
}

/**
 * Spread of the total motion when each click is off by up to `clickArcsec` on the sky: the position difference of
 * two clicks changes by at most sqrt(2) times that, divided by the time between them.
 */
export function clickSpread(clickArcsec: number, years: number): number | null {
  if (!(clickArcsec > 0) || !(years > 0)) return null;
  return (Math.SQRT2 * clickArcsec) / years;
}

export interface AnswerRange {
  low: number;
  high: number;
  center: number;
  spread: number;
}

/** The range of total motion a careful class should find, around a reference value; null when an input is missing. */
export function answerRange(
  reference: number | null | undefined,
  clickArcsec: number | null | undefined,
  years: number | null | undefined,
): AnswerRange | null {
  if (reference == null || !Number.isFinite(reference) || reference <= 0) return null;
  const spread = clickSpread(clickArcsec ?? 0, years ?? 0);
  if (spread === null) return null;
  return { center: reference, spread, low: Math.max(0, reference - spread), high: reference + spread };
}

/** Time span in years between the first and last learnable epoch of a manifest, or null with fewer than two. */
export function baselineYears(epochs: EpochInfo[], det: number): number | null {
  const e = learnEpochs(epochs, det);
  if (e.length < 2) return null;
  const mjds = e.map((x) => x.mjd);
  const days = Math.max(...mjds) - Math.min(...mjds);
  return days > 0 ? days / DAYS_PER_YEAR : null;
}

/** Longest baseline over the detectors, for the guide (which has no detector chosen). */
export function bestBaseline(epochs: EpochInfo[]): { det: number; years: number } | null {
  const det = commonDetector(epochs);
  if (det === null) return null;
  const years = baselineYears(epochs, det);
  return years === null ? null : { det, years };
}
