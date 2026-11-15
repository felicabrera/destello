import { describe, expect, it } from 'vitest';
import { buildPath, omitDefaults, parseSearch, searchToString, validateSearch } from './url-state';

describe('url-state', () => {
  it('parses the canonical example from docs/06', () => {
    const raw = parseSearch('?det=6&mode=diff&ref=1&frame=3&ov=catwise&tab=measure&lang=es');
    const v = validateSearch(raw);
    expect(v).toEqual({
      det: 6,
      mode: 'diff',
      ref: 1,
      frame: 3,
      ov: ['catwise'],
      tab: 'measure',
      lang: 'es',
    });
  });
  it('drops unknown and out-of-range values silently', () => {
    const v = validateSearch(
      parseSearch('?fov=7&det=9&mode=xyz&frame=0&fps=8&play=2&ov=wise,gaia&tab=foo&lang=fr&seq=nothex'),
    );
    expect(v).toEqual({ ov: ['gaia'] });
  });
  it('keeps epochs 1-based', () => {
    expect(validateSearch({ frame: '1', ref: '2' })).toEqual({ frame: 1, ref: 2 });
    expect(validateSearch({ frame: '-1' })).toEqual({});
  });
  it('requires both ra and dec', () => {
    expect(validateSearch({ ra: '133.79' })).toEqual({});
    expect(validateSearch({ ra: '08h55m10.8s', dec: '-07d14m42s' })).toEqual({
      ra: '08h55m10.8s',
      dec: '-07d14m42s',
    });
  });
  it('validates rgb triples', () => {
    expect(validateSearch({ rgb: '1,3,6' }).rgb).toEqual([1, 3, 6]);
    expect(validateSearch({ rgb: '1,1,6' }).rgb).toBeUndefined();
    expect(validateSearch({ rgb: '1,3' }).rgb).toBeUndefined();
  });
  it('omits defaults', () => {
    const o = omitDefaults(
      { fov: 6, det: 'all', mode: 'blink', ref: 1, frame: 1, fps: 2, play: 1, tab: 'info', ov: [] },
      { fov: 6, det: 'all', play: 1, lang: 'en' },
    );
    expect(o).toEqual({});
  });
  it('omits preset defaults but keeps changes', () => {
    const d = { fov: 8 as const, det: 6 as const, play: 1 as const, lang: 'en' as const };
    expect(omitDefaults({ fov: 8 as never, det: 6 }, d)).toEqual({});
    expect(omitDefaults({ fov: 6, det: 'all' }, d)).toEqual({ fov: 6, det: 'all' });
  });
  it('writes ov with plain commas and keeps order stable', () => {
    expect(searchToString({ det: 6, ov: ['gaia', 'catwise'], lang: 'es' })).toBe(
      '?det=6&ov=gaia,catwise&lang=es',
    );
  });
  it('builds preset paths', () => {
    expect(
      buildPath('wise0855', {
        det: 6,
        mode: 'diff',
        ref: 1,
        frame: 3,
        ov: ['catwise'],
        tab: 'measure',
        lang: 'es',
      }),
    ).toBe('/t/wise0855?det=6&mode=diff&frame=3&ov=catwise&tab=measure&lang=es');
    expect(buildPath(undefined, { ra: '133.79513', dec: '-7.24515' })).toBe('/?ra=133.79513&dec=-7.24515');
  });
  it('reads and writes the low coverage key (F-31)', () => {
    expect(validateSearch({ partial: '1' }).partial).toBe(1);
    expect(validateSearch({ partial: '0' }).partial).toBeUndefined();
    expect(validateSearch({ partial: 'yes' }).partial).toBeUndefined();
    expect(buildPath('barnard', { partial: 1, release: 'qr2', det: 3 })).toBe(
      '/t/barnard?release=qr2&partial=1&det=3',
    );
  });
});
