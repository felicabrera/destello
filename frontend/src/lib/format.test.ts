import { describe, expect, it } from 'vitest';
import { ES_GROUP, localNumber, localPercent } from './format';

describe('Spanish number format', () => {
  it('groups thousands with a narrow no-break space and uses a decimal comma', () => {
    expect(localNumber('es', 12345.678, 2)).toBe(`12${ES_GROUP}345,68`);
    expect(localNumber('es', 1234567)).toBe(`1${ES_GROUP}234${ES_GROUP}567`);
  });

  it('leaves four-digit numbers ungrouped', () => {
    expect(localNumber('es', 2048)).toBe('2048');
  });

  it('never uses a point as thousands separator', () => {
    expect(localNumber('es', 98765)).not.toContain('.');
  });

  it('keeps English unchanged', () => {
    expect(localNumber('en', 12345.678, 2)).toBe('12,345.68');
  });

  it('formats percentages with a decimal comma', () => {
    expect(localPercent('es', 0.024)).toMatch(/^2,4\s?%$/);
  });
});
