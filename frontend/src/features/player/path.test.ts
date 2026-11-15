// F-27 predicted path: drawing helpers, API epoch form and URL state.
import { describe, expect, it } from 'vitest';
import { apiRefEpoch, refEpochToMjd } from '../../lib/astrometry';
import { buildPath, parseSearch, validateSearch } from '../../lib/url-state';
import { ellipseExtentPx, PATH_ELLIPSE_MIN_PX } from './draw';

describe('F-27 path helpers', () => {
  it('measures the loop extent from its centre', () => {
    const pts = Array.from({ length: 72 }, (_, i) => {
      const a = (2 * Math.PI * i) / 72;
      return { x: 10 + 2 * Math.cos(a), y: 20 + Math.sin(a) };
    });
    expect(ellipseExtentPx(pts)).toBeCloseTo(2, 6);
    expect(ellipseExtentPx([])).toBe(0);
    expect(PATH_ELLIPSE_MIN_PX).toBeGreaterThan(1);
  });

  it('sends the reference epoch in a form the API accepts', () => {
    expect(apiRefEpoch('J2016.0')).toBe('J2016.0');
    expect(apiRefEpoch(' J2000 ')).toBe('J2000');
    expect(apiRefEpoch('MJD57388.5')).toBe('MJD57388.50000');
    const iso = apiRefEpoch('2016-01-01T00:00:00Z');
    expect(iso).toMatch(/^MJD\d+\.\d{5}$/);
    expect(Number(iso?.slice(3))).toBeCloseTo(refEpochToMjd('2016-01-01T00:00:00Z') ?? 0, 4);
    expect(apiRefEpoch(null)).toBeNull();
    expect(apiRefEpoch('soon')).toBeNull();
  });

  it('keeps ov=path in the URL in the canonical overlay order', () => {
    const s = validateSearch(parseSearch('?ov=path,gaia'));
    expect(s.ov).toEqual(['gaia', 'path']);
    expect(buildPath('barnard', s)).toBe('/t/barnard?ov=gaia,path');
  });
});
