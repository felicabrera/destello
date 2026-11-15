import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEMO_BASE,
  demoTarget,
  demoWiseUrl,
  getWiseAstrometry,
  getWiseManifest,
  setBackendMode,
} from './api';

const SID = 'ecd90b51f9c395e1';

describe('demoTarget', () => {
  it('maps the comet page documents', () => {
    expect(demoTarget('GET', '/movers')).toEqual({ url: `${DEMO_BASE}/movers.json`, optional: false });
    expect(demoTarget('GET', `/movers/${SID}/spectrum`)?.url).toBe(
      `${DEMO_BASE}/movers/${SID}/spectrum.json`,
    );
    expect(demoTarget('GET', `/movers/${SID}/ephemeris-check`)?.url).toBe(
      `${DEMO_BASE}/movers/${SID}/ephemeris-check.json`,
    );
    expect(demoTarget('GET', `/movers/${SID}/neossat`)).toEqual({
      url: `${DEMO_BASE}/movers/${SID}/neossat.json`,
      optional: true,
    });
  });
  it('keeps the earlier mappings', () => {
    expect(demoTarget('GET', '/targets')?.url).toBe(`${DEMO_BASE}/targets.json`);
    expect(demoTarget('GET', `/sequences/${SID}/difference?a=1&b=0&detector=0`)?.url).toBe(
      `${DEMO_BASE}/difference/${SID}/1-0-0.json`,
    );
    expect(demoTarget('GET', `/sequences/${SID}/candidates?a=2&b=1`)?.optional).toBe(true);
  });
  it('rejects unknown paths, bad ids and other methods', () => {
    expect(demoTarget('GET', '/movers/xyz/spectrum')).toBeUndefined();
    expect(demoTarget('GET', `/movers/${SID}/other`)).toBeUndefined();
    expect(demoTarget('POST', '/movers')).toBeUndefined();
  });
});

describe('demoWiseUrl', () => {
  it('maps the companion routes', () => {
    expect(demoWiseUrl(`/sequences/${SID}/wise`)).toEqual({
      sid: SID,
      kind: 'manifest',
      url: `${DEMO_BASE}/wise/${SID}.json`,
    });
    expect(demoWiseUrl(`/sequences/${SID}/wise/astrometry`)?.url).toBe(
      `${DEMO_BASE}/wise/${SID}.astrometry.json`,
    );
    expect(demoWiseUrl(`/sequences/${SID}/spectrum`)).toBeUndefined();
  });
});

describe('wiseGet in demo mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setBackendMode('unknown');
  });
  it('reads the index first and never requests a file that is not listed', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        calls.push(url);
        if (url.endsWith('/wise/index.json'))
          return Promise.resolve(
            new Response(JSON.stringify({ sequences: { [SID]: { manifest: true, astrometry: false } } })),
          );
        return Promise.resolve(new Response(JSON.stringify({ kind: 'wise_companion' })));
      }),
    );
    setBackendMode('demo');
    expect(await getWiseManifest(SID)).toEqual({ kind: 'wise_companion' });
    expect(await getWiseAstrometry(SID)).toBeNull();
    expect(await getWiseManifest('0000000000000000')).toBeNull();
    expect(calls).toEqual([`${DEMO_BASE}/wise/index.json`, `${DEMO_BASE}/wise/${SID}.json`]);
  });
  it('returns null when the bundle has no index', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    setBackendMode('demo');
    expect(await getWiseManifest(SID)).toBeNull();
  });
});
