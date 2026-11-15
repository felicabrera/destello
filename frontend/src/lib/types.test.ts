import { describe, expect, it } from 'vitest';
import { isLowCoverage } from './types';

describe('isLowCoverage (F-31)', () => {
  it('is true only for an epoch marked low', () => {
    expect(isLowCoverage({ coverage: 'low' })).toBe(true);
    expect(isLowCoverage({ coverage: 'full' })).toBe(false);
  });

  it('treats an absent field or a missing epoch as full coverage', () => {
    expect(isLowCoverage({})).toBe(false);
    expect(isLowCoverage(null)).toBe(false);
    expect(isLowCoverage(undefined)).toBe(false);
  });
});
