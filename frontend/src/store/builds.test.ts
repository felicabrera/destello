import { describe, expect, it } from 'vitest';
import { sanitizeBuilds } from './builds';

const now = 1_800_000_000_000;
const ok = {
  id: '0123456789abcdef',
  href: '/?ra=200&dec=20',
  label: 'RA 200, Dec 20',
  fov: 6,
  startedAt: now - 1000,
};

describe('sanitizeBuilds', () => {
  it('keeps a well-formed recent entry as building', () => {
    expect(sanitizeBuilds([ok], now)).toEqual([{ ...ok, state: 'building' }]);
  });

  it('drops malformed ids, external links, duplicates and old entries', () => {
    const raw = [
      { ...ok, id: 'nope' },
      { ...ok, href: 'https://example.org/' },
      { ...ok, href: '//example.org/' },
      { ...ok, startedAt: now - 25 * 3600 * 1000 },
      ok,
      { ...ok, state: 'ready' },
      null,
    ];
    expect(sanitizeBuilds(raw, now)).toHaveLength(1);
  });

  it('returns an empty list for anything that is not an array', () => {
    expect(sanitizeBuilds({ a: 1 }, now)).toEqual([]);
    expect(sanitizeBuilds('x', now)).toEqual([]);
  });
});
