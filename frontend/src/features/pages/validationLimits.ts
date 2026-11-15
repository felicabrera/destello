// Numbers shown next to the known limits on the validation page. Every value is read from the
// validation report; nothing here is a constant of the design. A group is null when the report
// does not hold the tests it needs, and the page then shows the limit without a measured line.
import type { ValidationTest } from '../../lib/types';

export const NATIVE_PIXEL_ARCSEC = 6.2;

export interface LimitFacts {
  epochs: { min: number; max: number } | null;
  /** Fitted proper motion against the published value, as fractions (0.05 = 5 percent). */
  motion: { min: number; max: number } | null;
  /** Observed position against the propagated catalog position, arcsec. */
  centroid: { median: number; max: number; pixelFraction: number } | null;
  /** Median offset from Gaia DR3 field stars before and after recalibration, arcsec. */
  astrometry: { before: number; after: number } | null;
  /** Ratio of Destello to 2MASS flux per band. */
  flux: { min: number; max: number; stars: number } | null;
}

function numbers(v: unknown): number[] {
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : [];
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function range(v: number[]): { min: number; max: number } | null {
  return v.length ? { min: Math.min(...v), max: Math.max(...v) } : null;
}

export function limitFacts(tests: ValidationTest[]): LimitFacts {
  const measured = tests.filter((t) => t.status !== 'not_measurable');
  const byId = (id: string) => measured.filter((t) => t.id === id);

  const epochs = range(
    byId('V-05')
      .map((t) => t.epochs_used)
      .filter((n): n is number => typeof n === 'number' && n > 0),
  );

  const motion = range(
    ['V-02', 'V-03', 'V-04']
      .flatMap(byId)
      .map((t) => t.reason_params?.relative_error)
      .filter((x): x is number => typeof x === 'number' && Number.isFinite(x)),
  );

  const seps = byId('V-05').flatMap((t) => numbers(t.reason_params?.separations_arcsec));
  const centroid = seps.length
    ? { median: median(seps), max: Math.max(...seps), pixelFraction: median(seps) / NATIVE_PIXEL_ARCSEC }
    : null;

  const before = byId('V-01').flatMap((t) => numbers(t.reason_params?.before_arcsec));
  const after = byId('V-01').flatMap((t) => numbers(t.reason_params?.after_arcsec));
  const astrometry = before.length && after.length ? { before: median(before), after: median(after) } : null;

  const bands = byId('V-08').flatMap((t) => {
    const b = t.reason_params?.bands;
    return Array.isArray(b) ? (b as Record<string, unknown>[]) : [];
  });
  const ratios = bands.map((b) => b.median_ratio).filter((x): x is number => typeof x === 'number');
  const stars = bands.map((b) => b.n_stars).filter((x): x is number => typeof x === 'number');
  const fluxRange = range(ratios);
  const flux = fluxRange && stars.length ? { ...fluxRange, stars: Math.max(...stars) } : null;

  return { epochs, motion, centroid, astrometry, flux };
}
