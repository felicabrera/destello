// Manifest warnings as shown in the Info panel. Every number comes from the manifest of the sequence; the text
// is only localized and grouped here (several skipped partial revisits read as one line, not one line each).
import { localDate, mjdToDate } from '../../lib/format';
import type { Lang } from '../../lib/types';

type T = (key: string, opts?: Record<string, unknown>) => string;
export interface ManifestWarning {
  code: string;
  detail: string;
}

const SATURATED = /saturated in (\d+) of (\d+) coadds \(detectors ([^)]+)\)/;
const PARTIAL = /(\d+) images around MJD ([\d.]+)/;

/**
 * Codes that describe the data set rather than a problem with this target: they hold for every SPHEREx Quick
 * Release sequence, or record images that were left out. They are shown as notes, not as warnings.
 */
export const NOTE_CODES: ReadonlySet<string> = new Set([
  'EPOCH_LOW_COVERAGE',
  'EPOCH_PARTIAL_SKIPPED',
  'QUICK_RELEASE_CALIBRATION',
  'WAVELENGTH_MIXTURE',
]);

export interface WarningLines {
  /** Statements that change how this target must be read (saturation, an unresolved pair, a fallback). */
  warnings: string[];
  /**
   * Notes on the data set. Short revisits shown as low coverage epochs (F-31) are merged into the first line,
   * skipped partial revisits into the next one.
   */
  notes: string[];
}

/** Localized lines for the manifest warnings, split into warnings about this target and notes on the data. */
export function warningLines(t: T, list: ManifestWarning[], lang: Lang): WarningLines {
  const partial: { n: number; mjd: number }[] = [];
  const low: { n: number; mjd: number }[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const w of list) {
    const m = w.code === 'EPOCH_PARTIAL_SKIPPED' ? PARTIAL.exec(w.detail) : null;
    if (m) {
      partial.push({ n: Number(m[1]), mjd: Number(m[2]) });
      continue;
    }
    const lowMatch = w.code === 'EPOCH_LOW_COVERAGE' ? PARTIAL.exec(w.detail) : null;
    if (lowMatch) {
      low.push({ n: Number(lowMatch[1]), mjd: Number(lowMatch[2]) });
      continue;
    }
    const sat = w.code === 'SATURATED_CORE' ? SATURATED.exec(w.detail) : null;
    if (sat) {
      warnings.push(t('info.warn.SATURATED_CORE', { n: sat[1], total: sat[2], detectors: sat[3] }));
      continue;
    }
    const key = `info.warn.${w.code}`;
    const txt = t(key);
    (NOTE_CODES.has(w.code) ? notes : warnings).push(txt === key ? w.detail : txt);
  }
  const item = (p: { n: number; mjd: number }) =>
    t('info.warn.partialItem', {
      n: p.n,
      date: localDate(lang, mjdToDate(p.mjd)),
      mjd: p.mjd.toFixed(1),
    });
  if (partial.length > 0) {
    notes.unshift(
      partial.length === 1
        ? t('info.warn.partialOne', { item: item(partial[0]) })
        : t('info.warn.partialMany', { count: partial.length, list: partial.map(item).join('; ') }),
    );
  }
  if (low.length > 0) {
    notes.unshift(
      low.length === 1
        ? t('info.warn.lowOne', { item: item(low[0]) })
        : t('info.warn.lowMany', { count: low.length, list: low.map(item).join('; ') }),
    );
  }
  return { warnings, notes };
}
