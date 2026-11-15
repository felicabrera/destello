import { describe, expect, it } from 'vitest';
import { matchPresets, normalizeName } from './presets';

describe('preset name matching', () => {
  it('normalizes accents, apostrophes and case', () => {
    expect(normalizeName("Barnard's Star")).toBe('barnards star');
    expect(normalizeName('Épsilon Indi B')).toBe('epsilon indi b');
  });
  it('resolves localized names and aliases before SIMBAD', () => {
    expect(matchPresets('estrella de barnard', undefined)[0]?.id).toBe('barnard');
    expect(matchPresets('Barnard', undefined)[0]).toEqual({ id: 'barnard', exact: true });
    expect(matchPresets('épsilon Indi B', undefined)[0]?.id).toBe('epsindib');
    expect(matchPresets('WISE 0855-0714', undefined)[0]?.id).toBe('wise0855');
    expect(matchPresets('R Dra', undefined)[0]?.id).toBe('rdra');
    expect(matchPresets('rw aur', undefined)[0]?.id).toBe('rwaur');
  });
  it('does not match unrelated names', () => {
    expect(matchPresets('Sirius', undefined)).toEqual([]);
    expect(matchPresets('M31', undefined)).toEqual([]);
  });
  it('offers prefix suggestions', () => {
    expect(matchPresets('barn', undefined).map((m) => m.id)).toContain('barnard');
  });
});
