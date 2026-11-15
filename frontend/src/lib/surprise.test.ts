import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import es from '../i18n/es.json';
import { separationDeg } from './coords';
import { refEpochToMjd } from './astrometry';
import {
  SURPRISE_CENTER_MJD,
  SURPRISE_FIELDS,
  SURPRISE_IDS,
  pickSurprise,
  surpriseCenter,
  surpriseField,
} from './surprise';
import { buildPath, parseSearch, validateSearch } from './url-state';

type Items = Record<string, { name?: string; why?: string }>;

describe('surprise (F-28)', () => {
  it('has unique ids and a stated reference epoch for every field', () => {
    expect(new Set(SURPRISE_IDS).size).toBe(SURPRISE_IDS.length);
    expect(SURPRISE_IDS.length).toBeGreaterThanOrEqual(10);
    for (const f of SURPRISE_FIELDS) {
      expect(f.ref_epoch).toMatch(/^J\d{4}\.\d$/);
      expect(f.ra_deg).toBeGreaterThanOrEqual(0);
      expect(f.ra_deg).toBeLessThan(360);
      expect(Math.abs(f.dec_deg)).toBeLessThanOrEqual(90);
      // Proper motion components come in pairs: both known or both unknown.
      expect(f.pmra_masyr == null).toBe(f.pmdec_masyr == null);
    }
  });

  it('has a name and a reason in English and Spanish for every field', () => {
    const items = [en.surprise.items as Items, es.surprise.items as Items];
    for (const id of SURPRISE_IDS)
      for (const it of items) {
        expect(it[id]?.name, id).toBeTruthy();
        expect(it[id]?.why, id).toBeTruthy();
      }
    expect(Object.keys(en.surprise.items).sort()).toEqual([...SURPRISE_IDS].sort());
  });

  it('never picks the field on screen and covers the whole pool', () => {
    for (const id of SURPRISE_IDS) {
      for (const r of [0, 0.5, 0.999999]) expect(pickSurprise(id, () => r).id).not.toBe(id);
    }
    const seen = new Set<string>();
    const n = SURPRISE_FIELDS.length;
    for (let i = 0; i < n; i++) seen.add(pickSurprise(undefined, () => (i + 0.5) / n).id);
    expect(seen.size).toBe(n);
    // A generator that returns exactly 1 must not index past the end.
    expect(SURPRISE_IDS).toContain(pickSurprise(undefined, () => 1).id);
  });

  it('propagates the centre from the catalog epoch with the catalog proper motion', () => {
    const f = surpriseField('kapteyn');
    expect(f).toBeDefined();
    if (!f || f.pmra_masyr == null || f.pmdec_masyr == null) return;
    const c = surpriseCenter(f);
    const years = (SURPRISE_CENTER_MJD - (refEpochToMjd(f.ref_epoch) ?? Number.NaN)) / 365.25;
    expect(years).toBeCloseTo(10, 6);
    const expected = (Math.hypot(f.pmra_masyr, f.pmdec_masyr) * years) / 3.6e6;
    const sep = separationDeg(f.ra_deg, f.dec_deg, c.ra, c.dec);
    expect(Math.abs(sep - expected) / expected).toBeLessThan(0.005);
  });

  it('keeps a field without proper motion at its catalog position', () => {
    const f = surpriseField('sn2023ixf');
    expect(f).toBeDefined();
    if (!f) return;
    const c = surpriseCenter(f);
    expect(c.ra).toBeCloseTo(f.ra_deg, 9);
    expect(c.dec).toBeCloseTo(f.dec_deg, 9);
  });

  it('accepts only known picks in the URL', () => {
    expect(validateSearch(parseSearch('?pick=proxima'))).toEqual({ pick: 'proxima' });
    expect(validateSearch(parseSearch('?pick=nowhere'))).toEqual({});
    expect(buildPath(undefined, { pick: 'ttau', lang: 'es' })).toBe('/?pick=ttau&lang=es');
  });
});
