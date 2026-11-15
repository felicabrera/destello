// F-34: numbers that appear beside the embeds. Every value comes from GET /targets or GET /validation; when a
// value is not there the field is null and the page leaves the sentence out.
import type { TargetItem, ValidationReport } from '../../lib/types';

export interface PmFact {
  /** Total proper motion in arcsec per year, from the target astrometry. */
  arcsecPerYear: number;
}
export interface MeasuredFact {
  measured: number;
  err: number | null;
  reference: number | null;
  source: string | null;
  unit: string | null;
}

export function targetPm(targets: TargetItem[] | undefined, id: string): PmFact | null {
  const a = targets?.find((x) => x.id === id)?.astrometry;
  const { pmra_masyr: ra, pmdec_masyr: dec } = a ?? {};
  if (ra == null || dec == null || !Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  return { arcsecPerYear: Math.hypot(ra, dec) / 1000 };
}

/** The measured value of a validation row for a target, only when the row passed. */
export function measuredFact(
  report: ValidationReport | null | undefined,
  testId: string,
  target: string,
): MeasuredFact | null {
  const t = report?.tests.find((x) => x.id === testId && x.target === target);
  if (!t || t.status !== 'pass' || t.measured == null) return null;
  return {
    measured: t.measured,
    err: t.err ?? null,
    reference: t.reference ?? null,
    source: t.source ?? null,
    unit: t.unit ?? null,
  };
}
