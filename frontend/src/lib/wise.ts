// F-40: WISE/NEOWISE companion of a SPHEREx sequence. Types of the API documents and the pure timeline model.
// Nothing here makes up data: every entry is a frame the manifests list, and every number shown comes from the API.
import { epochMid, mjdToDate } from './format';
import type { FrameInfo, Manifest, StretchInfo } from './types';

export type WiseMission = 'WISE' | 'NEOWISE';
export type TimelineMission = WiseMission | 'SPHEREx';

export interface WiseCoaddFrame {
  mission: 'WISE';
  phase: WiseMission;
  band: 'W1' | 'W2';
  kind: 'coadd';
  url: string;
  fits_url: string;
  flags_url: string;
  wavelength_um: [number, number];
  n_images: number;
  flagged_fraction: number;
  flux_scale: number;
  flux_scale_stars: number;
  t_start: string;
  t_end: string;
  t_mid_mjd: number;
  data_releases: string[];
  dois: string[];
}

export interface WiseEpoch {
  index: number;
  t_start: string;
  t_end: string;
  t_mid_mjd: number;
  phase: WiseMission;
  n_images: number;
  frames: WiseCoaddFrame[];
}

export interface WiseManifest {
  sequence_id: string;
  spherex_sequence_id: string;
  band: 'W1' | 'W2';
  grid: Manifest['grid'];
  reference_epoch: number;
  epochs: WiseEpoch[];
  /** Keyed "WISE:W2": one stretch per mission and band, shared by every WISE epoch. */
  stretch: Record<string, StretchInfo>;
  provenance: {
    frame_list_source: string;
    data_releases: string[];
    dois: string[];
    services: string[];
  };
  warnings: { code: string; detail: string }[];
}

export interface PmFit {
  pmra_masyr: number;
  pmdec_masyr: number;
  pmra_err_masyr: number;
  pmdec_err_masyr: number;
  n_epochs?: number;
  chi2_red?: number | null;
}

/** Stored long-baseline fit (GET /sequences/{sid}/wise/astrometry). Only the fields the view reads. */
export interface WiseAstrometry {
  status: 'pass' | 'fail' | 'not_measurable';
  reason?: string;
  epochs_per_mission: { WISE: number; SPHEREx: number };
  fit?: PmFit & { ref_epoch_jyear: number };
  reference?: Omit<PmFit, 'n_epochs' | 'chi2_red'>;
  reference_source?: string;
  agreement_sigma?: number;
  sigma_per_axis?: [number, number];
  spherex_only?: PmFit;
  error_ratio_spherex_only?: [number, number];
}

export interface TimelineEntry {
  key: string;
  mission: TimelineMission;
  /** Index in its own manifest (0-based). */
  epochIndex: number;
  mjd: number;
  /** Decimal calendar year of `mjd`, for the axis. */
  year: number;
  url: string;
  nImages: number;
  wavelengthUm: [number, number] | null;
  /** SPHEREx only. */
  detector?: number;
  stretchKey: string;
  stretch: StretchInfo | null;
}

export const AXIS_START_YEAR = 2010;
export const AXIS_END_YEAR = 2026;

export function decimalYear(mjd: number): number {
  const d = mjdToDate(mjd);
  const y = d.getUTCFullYear();
  const t0 = Date.UTC(y, 0, 1);
  const t1 = Date.UTC(y + 1, 0, 1);
  return y + (d.getTime() - t0) / (t1 - t0);
}

/** Position on the axis as a fraction 0..1; values outside 2010 to 2026 are clamped to the ends. */
export function axisFraction(year: number, start = AXIS_START_YEAR, end = AXIS_END_YEAR): number {
  return Math.min(1, Math.max(0, (year - start) / (end - start)));
}

export function axisTicks(start = AXIS_START_YEAR, end = AXIS_END_YEAR, every = 2): number[] {
  const out: number[] = [];
  for (let y = start; y <= end; y += every) out.push(y);
  return out;
}

function overlap(a: [number, number], b: [number, number]): number {
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/**
 * The SPHEREx coadd of an epoch that overlaps the WISE band window most (per-detector coadds only; the
 * broadband frame is never used). Null when no detector overlaps the window.
 */
export function pickSpherexFrame(frames: FrameInfo[], window: [number, number]): FrameInfo | null {
  let best: FrameInfo | null = null;
  let bestOv = 0;
  for (const f of frames) {
    if (f.kind !== 'coadd' || !f.wavelength_um) continue;
    const ov = overlap(f.wavelength_um, window);
    if (ov > bestOv) {
      best = f;
      bestOv = ov;
    }
  }
  return best;
}

/** Window of the WISE band from the manifest (every frame of the band carries the same one). */
export function wiseWindow(w: WiseManifest): [number, number] | null {
  for (const e of w.epochs) for (const f of e.frames) return f.wavelength_um;
  return null;
}

/** All markers, sorted by time. Each WISE epoch uses its first frame of the companion band. */
export function buildTimeline(spherex: Manifest | null, wise: WiseManifest): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  const wkey = `WISE:${wise.band}`;
  for (const e of wise.epochs) {
    const f = e.frames[0];
    if (!f) continue;
    out.push({
      key: `w${e.index}`,
      mission: f.phase,
      epochIndex: e.index,
      mjd: e.t_mid_mjd,
      year: decimalYear(e.t_mid_mjd),
      url: f.url,
      nImages: e.n_images,
      wavelengthUm: f.wavelength_um,
      stretchKey: wkey,
      stretch: wise.stretch[wkey] ?? null,
    });
  }
  const win = wiseWindow(wise);
  if (spherex && win) {
    for (const e of spherex.epochs) {
      const mid = epochMid(e);
      const f = pickSpherexFrame(e.frames, win);
      if (mid === undefined || !f) continue;
      const det = typeof f.detector === 'number' ? f.detector : undefined;
      out.push({
        key: `s${e.index}`,
        mission: 'SPHEREx',
        epochIndex: e.index,
        mjd: mid,
        year: decimalYear(mid),
        url: f.url,
        nImages: f.n_images,
        wavelengthUm: f.wavelength_um ?? null,
        detector: det,
        stretchKey: `SPHEREx:D${det ?? '?'}`,
        stretch: det !== undefined ? (spherex.stretch[String(det)] ?? null) : null,
      });
    }
  }
  return out.sort((a, b) => a.mjd - b.mjd);
}

/** Next index when stepping; wraps only when `wrap` is set (playback), otherwise stops at the ends. */
export function stepIndex(i: number, delta: number, n: number, wrap: boolean): number {
  if (n <= 0) return 0;
  const j = i + delta;
  if (wrap) return ((j % n) + n) % n;
  return Math.min(n - 1, Math.max(0, j));
}

export type TimelineKey = 'next' | 'prev' | 'first' | 'last' | 'toggle' | null;
export function keyAction(key: string): TimelineKey {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return 'next';
    case 'ArrowLeft':
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case ' ':
    case 'Spacebar':
      return 'toggle';
    default:
      return null;
  }
}

/** Counts per mission label, for the legend. */
export function missionCounts(entries: TimelineEntry[]): Record<TimelineMission, number> {
  const c: Record<TimelineMission, number> = { WISE: 0, NEOWISE: 0, SPHEREx: 0 };
  for (const e of entries) c[e.mission] += 1;
  return c;
}
