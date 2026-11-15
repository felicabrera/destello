// Date, MJD and band formatting. All times are UTC.
import type { EpochInfo, FrameInfo, Lang } from './types';

const MJD_UNIX_EPOCH = 40587; // MJD of 1970-01-01T00:00:00Z

export function mjdToDate(mjd: number): Date {
  return new Date((mjd - MJD_UNIX_EPOCH) * 86_400_000);
}
export function dateToMjd(d: Date): number {
  return d.getTime() / 86_400_000 + MJD_UNIX_EPOCH;
}
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function mjdIso(mjd: number): string {
  return isoDate(mjdToDate(mjd));
}
export function fmtMjd(mjd: number): string {
  return mjd.toFixed(1);
}
export function isoDay(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function localDate(lang: Lang, d: Date): string {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(d);
}
export function localMonthYear(lang: Lang, d: Date): string {
  return new Intl.DateTimeFormat(lang === 'es' ? 'es' : 'en', {
    month: 'short',
    // Four digits: "Aug 25" reads as a day of the month.
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}
/** Thousands separator for Spanish: a narrow no-break space (RAE Ortografía 2010, ISO 80000-1). */
export const ES_GROUP = ' ';

/**
 * Locale number formatting. Spanish uses a decimal comma and groups thousands with a narrow
 * no-break space, never a point; four-digit integers stay ungrouped (RAE rule, Intl default).
 */
export function formatNumber(lang: Lang, v: number, opts: Intl.NumberFormatOptions = {}): string {
  if (lang !== 'es') return new Intl.NumberFormat('en', opts).format(v);
  return new Intl.NumberFormat('es', opts)
    .formatToParts(v)
    .map((p) => (p.type === 'group' ? ES_GROUP : p.value))
    .join('');
}
export function localNumber(lang: Lang, v: number, digits = 0): string {
  return formatNumber(lang, v, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
export function localPercent(lang: Lang, fraction: number): string {
  return formatNumber(lang, fraction, {
    style: 'percent',
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
}

/** Mid-time of an epoch as MJD. Falls back to the midpoint of t_start and t_end. */
export function epochMid(e: EpochInfo): number | undefined {
  if (typeof e.t_mid_mjd === 'number') return e.t_mid_mjd;
  if (e.t_start && e.t_end) return (dateToMjd(new Date(e.t_start)) + dateToMjd(new Date(e.t_end))) / 2;
  return undefined;
}

/** Sentence band text: "4.42 to 5.00 µm" (localized connector supplied by caller). */
export function bandRange(f: FrameInfo | undefined, to: string): string | undefined {
  if (!f?.wavelength_um) return undefined;
  return `${f.wavelength_um[0].toFixed(2)} ${to} ${f.wavelength_um[1].toFixed(2)} µm`;
}

/** Compact HUD band label. The en dash range is the one place the design allows it (player-canvas.md). */
export function hudBand(f: FrameInfo | undefined): string | undefined {
  if (!f?.wavelength_um) return undefined;
  return `${f.wavelength_um[0].toFixed(2)}–${f.wavelength_um[1].toFixed(2)} µm`;
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtMinSec(totalSeconds: number, minLabel: string, secLabel: string): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} ${minLabel} ${s % 60} ${secLabel}` : `${s} ${secLabel}`;
}

/** Fills the broadband frame wavelength range with the union of the detector frames of the same epoch. */
export function withBroadbandBand(e: EpochInfo): EpochInfo {
  const ws = e.frames.map((f) => f.wavelength_um).filter((w): w is [number, number] => !!w);
  if (ws.length === 0) return e;
  const union: [number, number] = [Math.min(...ws.map((w) => w[0])), Math.max(...ws.map((w) => w[1]))];
  return {
    ...e,
    frames: e.frames.map((f) => (f.wavelength_um ? f : { ...f, wavelength_um: union })),
  };
}
