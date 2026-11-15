import { describe, expect, it } from 'vitest';
import type { ValidationTest } from '../../lib/types';
import { limitFacts } from './validationLimits';

function test(id: string, over: Partial<ValidationTest> = {}): ValidationTest {
  return { id, name: id, target: 'x', status: 'pass', ...over };
}

describe('limitFacts', () => {
  it('reads every group from the report', () => {
    const f = limitFacts([
      test('V-01', { reason_params: { before_arcsec: [0.4, 0.6], after_arcsec: [0.1, 0.3] } }),
      test('V-01', { reason_params: { before_arcsec: [0.5], after_arcsec: [0.2] } }),
      test('V-02', { reason_params: { relative_error: 0.06 } }),
      test('V-03', { reason_params: { relative_error: 0.16 } }),
      test('V-05', { epochs_used: 3, reason_params: { separations_arcsec: [0.4, 0.2, 0.6] } }),
      test('V-05', { epochs_used: 2, reason_params: { separations_arcsec: [3.1, 3.7] } }),
      test('V-08', {
        reason_params: {
          bands: [
            { band: 'J', n_stars: 3, median_ratio: 0.94 },
            { band: 'H', n_stars: 3, median_ratio: 0.99 },
          ],
        },
      }),
    ]);
    expect(f.epochs).toEqual({ min: 2, max: 3 });
    expect(f.motion).toEqual({ min: 0.06, max: 0.16 });
    expect(f.centroid?.median).toBeCloseTo(0.6);
    expect(f.centroid?.max).toBeCloseTo(3.7);
    expect(f.centroid?.pixelFraction).toBeCloseTo(0.6 / 6.2);
    expect(f.astrometry).toEqual({ before: 0.5, after: 0.2 });
    expect(f.flux).toEqual({ min: 0.94, max: 0.99, stars: 3 });
  });

  it('gives null groups when the report lacks the tests, and never invents a value', () => {
    expect(limitFacts([])).toEqual({
      epochs: null,
      motion: null,
      centroid: null,
      astrometry: null,
      flux: null,
    });
    const f = limitFacts([test('V-05', { reason_params: { separations_arcsec: 'n/a' } }), test('V-08')]);
    expect(f.centroid).toBeNull();
    expect(f.flux).toBeNull();
  });

  it('ignores tests that could not be measured', () => {
    const f = limitFacts([
      test('V-02', { status: 'not_measurable', reason_params: { relative_error: 0.9 } }),
      test('V-04', { reason_params: { relative_error: 0.05 } }),
    ]);
    expect(f.motion).toEqual({ min: 0.05, max: 0.05 });
  });
});
