// F-33 moving-target model. Pure functions over the manifest, the spectrum and the ephemeris check of the API.
// Nothing here invents a value: every number shown comes from those documents.
import type {
  FrameInfo,
  Manifest,
  MoverBand,
  MoverCampaign,
  MoverEphemerisCheck,
  MoverListing,
  MoverPoint,
  MoverSpectrum,
  ValidationReport,
} from '../../lib/types';

export const CO2_BAND_UM: [number, number] = [4.23, 4.27];
export const H2O_BAND_UM: [number, number] = [2.7, 2.8];
export const CREDIT_NEOSSAT = 'NEOSSat, Canadian Space Agency; Canadian Astronomy Data Centre';

export interface ExposureFrame {
  /** 0-based position in the time ordered list. */
  index: number;
  frame: FrameInfo;
  detector: number;
  t_mid_mjd: number;
  t_start?: string;
  t_end?: string;
  obsId: string;
  wavelengthUm: number | null;
  center: [number, number] | null;
  campaign: number | null;
}

const detNum = (d: FrameInfo['detector']): number | null => {
  const n = typeof d === 'number' ? d : typeof d === 'string' ? Number(d) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
};

/** Detectors that have at least one single exposure. */
export function exposureDetectors(m: Manifest): number[] {
  const set = new Set<number>();
  for (const e of m.epochs)
    for (const f of e.frames) {
      const d = detNum(f.detector);
      if (f.kind === 'exposure' && d !== null) set.add(d);
    }
  return [...set].sort((a, b) => a - b);
}

/** Single exposures of one detector, ordered by observation time. Frames of other kinds are never mixed in. */
export function exposuresFor(m: Manifest, detector: number): ExposureFrame[] {
  const rows: Omit<ExposureFrame, 'index'>[] = [];
  for (const e of m.epochs)
    for (const f of e.frames) {
      if (f.kind !== 'exposure' || detNum(f.detector) !== detector) continue;
      const t = f.t_mid_mjd ?? e.t_mid_mjd;
      if (t === undefined) continue;
      rows.push({
        frame: f,
        detector,
        t_mid_mjd: t,
        t_start: f.t_start ?? e.t_start,
        t_end: f.t_end ?? e.t_end,
        obsId: f.obs_ids[0] ?? '',
        wavelengthUm: f.target_wavelength_um ?? null,
        center: f.center_deg ?? null,
        campaign: f.campaign ?? null,
      });
    }
  rows.sort((a, b) => a.t_mid_mjd - b.t_mid_mjd || a.obsId.localeCompare(b.obsId));
  return rows.map((r, index) => ({ ...r, index }));
}

/** The object-aligned stack of a detector (one per campaign when several exist, in manifest order). */
export function stacksFor(m: Manifest, detector: number): FrameInfo[] {
  return (m.moving_target?.stacks ?? []).filter((f) => f.kind === 'stack' && detNum(f.detector) === detector);
}

/** Stretch of a detector shared by all its exposures; the stack has its own entry. */
export function stretchKey(kind: 'exposure' | 'stack', detector: number): string {
  return kind === 'stack' ? `stack${detector}` : String(detector);
}

/** Pixel of a sky position on a frame grid centered on `center` (north up, east left, TAN, small field). */
export function skyToFramePixel(
  ra: number,
  dec: number,
  center: [number, number],
  scaleArcsec: number,
  naxis: [number, number],
): { x: number; y: number } {
  const dra = (((ra - center[0] + 540) % 360) - 180) * Math.cos((center[1] * Math.PI) / 180);
  const ddec = dec - center[1];
  return {
    x: naxis[0] / 2 - (dra * 3600) / scaleArcsec,
    y: naxis[1] / 2 - (ddec * 3600) / scaleArcsec,
  };
}

/** Where to draw the target reticle on an exposure: its own frame center, from its own center_deg. */
export function reticleFor(
  f: ExposureFrame,
  m: Manifest,
): { x: number; y: number; ra: number; dec: number } | null {
  const eph = f.frame.ephemeris;
  const c = f.center;
  if (!c || !eph) return null;
  const p = skyToFramePixel(eph.ra_deg, eph.dec_deg, c, m.grid.pixel_scale_arcsec, m.grid.naxis);
  return { ...p, ra: eph.ra_deg, dec: eph.dec_deg };
}

// --------------------------------------------------------------------------------------------- spectrum
export interface BandStatus {
  /** "measured": the rule could be evaluated; "not_measurable": a window lacked usable points. */
  state: 'measured' | 'not_measurable' | 'absent';
  band: MoverBand | null;
}

export function bandStatus(
  spec: MoverSpectrum | undefined,
  campaign: number,
  key: 'co2' | 'h2o',
): BandStatus {
  const b = spec?.bands?.[String(campaign)]?.[key] ?? null;
  if (!b) return { state: 'absent', band: null };
  return { state: b.significance === null ? 'not_measurable' : 'measured', band: b };
}

/** Values for the copy of a band measured against an undetected continuum (no ratio is defined). */
export function bandDifference(b: MoverBand): { band: number; upper: number; sig: number } | null {
  if (b.excess !== null || b.significance === null) return null;
  if (typeof b.band_flux_jy !== 'number' || typeof b.continuum_upper_limit_jy !== 'number') return null;
  return { band: b.band_flux_jy, upper: b.continuum_upper_limit_jy, sig: b.significance };
}

/** Validation row V-13 of a sequence and campaign, when the published report carries it. */
export function validationRow(
  report: ValidationReport | null | undefined,
  id: 'V-13' | 'V-14',
  seq: string,
  campaign: number,
): { status: string; sigma?: number | null } | null {
  const row = (report?.tests ?? []).find(
    (r) => r.id === id && r.target === seq && Number(r.reason_params?.campaign ?? 0) === campaign,
  );
  return row ? { status: row.status, sigma: row.sigma } : null;
}

export interface PlotPoint {
  x: number;
  y: number;
  err: number;
  flagged: boolean;
  obsId: string;
  mjd: number;
}

/** Points of a campaign for the plot. Flagged points keep their value but are drawn apart. */
export function plotPoints(spec: MoverSpectrum | undefined, campaign: number): PlotPoint[] {
  const out: PlotPoint[] = [];
  for (const p of spec?.points ?? []) {
    if (p.campaign !== campaign || p.flux === null || !Number.isFinite(p.flux)) continue;
    out.push({
      x: p.wavelength_um,
      y: p.flux,
      err: p.flux_err ?? 0,
      flagged: p.flagged,
      obsId: p.obs_id,
      mjd: p.t_mid_mjd,
    });
  }
  return out.sort((a, b) => a.x - b.x);
}

export function pointCounts(points: MoverPoint[], campaign: number): { total: number; flagged: number } {
  const own = points.filter((p) => p.campaign === campaign);
  return { total: own.length, flagged: own.filter((p) => p.flagged).length };
}

// --------------------------------------------------------------------------------------------- listing
export interface MoverChoice {
  sequenceId: string;
  campaign: MoverCampaign | null;
}

/** Sequences of the first (only) moving target, newest campaign first, as listed by the API. */
export function choices(list: MoverListing[] | undefined): MoverChoice[] {
  const g = list?.[0];
  return (g?.sequences ?? []).map((s) => ({ sequenceId: s.sequence_id, campaign: s.campaigns[0] ?? null }));
}

export function checkFor(
  chk: MoverEphemerisCheck | undefined,
  campaign: number,
): MoverEphemerisCheck['campaigns'][string] | null {
  return chk?.campaigns?.[String(campaign)] ?? null;
}

// --------------------------------------------------------------------------------------------- stepping
/** Index after a key press on the exposure timeline; null when the key is not handled. */
export function stepKey(key: string, i: number, n: number): number | null {
  if (n <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return Math.min(i + 1, n - 1);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return Math.max(i - 1, 0);
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  return null;
}
