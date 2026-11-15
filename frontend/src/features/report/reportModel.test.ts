import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import es from '../../i18n/es.json';
import { pixelToSky, type Grid } from '../../lib/astrometry';
import type { CheckSummary, EpochInfo } from '../../lib/types';
import {
  REPORT_ID_RE,
  compass,
  isValidContact,
  markableEpochs,
  marksToSky,
  nearestOf,
  nudge,
  searchRadius,
  seedMark,
  sepArcsec,
} from './reportModel';

const grid: Grid = { ra0: 269.4521, dec0: 4.6934, scaleArcsec: 3.1, n: 116 };

describe('marksToSky', () => {
  it('converts frame px to ICRS in epoch order, rounded to 1e-7 deg', () => {
    const out = marksToSky({ 2: { x: 60, y: 50 }, 0: { x: 58, y: 58 } }, grid);
    expect(out.map((m) => m.epoch)).toEqual([0, 2]);
    expect(out[0].ra_deg).toBeCloseTo(grid.ra0, 6);
    expect(out[0].dec_deg).toBeCloseTo(grid.dec0, 6);
    const s = pixelToSky(grid, 60, 50);
    expect(out[1].ra_deg).toBeCloseTo(s.ra, 6);
    expect(out[1].dec_deg).toBeCloseTo(s.dec, 6);
    expect(Number.isInteger(out[1].ra_deg * 1e7)).toBe(true);
  });
});

describe('nudge', () => {
  it('moves north up and east left, by whole px', () => {
    const m = { x: 10, y: 10 };
    expect(nudge(m, 'n', 100)).toEqual({ x: 10, y: 9 });
    expect(nudge(m, 's', 100)).toEqual({ x: 10, y: 11 });
    expect(nudge(m, 'e', 100)).toEqual({ x: 9, y: 10 });
    expect(nudge(m, 'w', 100, 5)).toEqual({ x: 15, y: 10 });
  });
  it('keeps the mark inside the frame', () => {
    expect(nudge({ x: 0.5, y: 0.5 }, 'n', 20)).toEqual({ x: 0.5, y: 0.5 });
    expect(nudge({ x: 19.5, y: 3 }, 'w', 20, 4)).toEqual({ x: 19.5, y: 3 });
  });
  it('east on the frame is increasing RA on the sky', () => {
    const a = pixelToSky(grid, 58, 58);
    const b = pixelToSky(grid, nudge({ x: 58, y: 58 }, 'e', grid.n).x, 58);
    expect(b.ra).toBeGreaterThan(a.ra);
    const c = pixelToSky(grid, 58, nudge({ x: 58, y: 58 }, 'n', grid.n).y);
    expect(c.dec).toBeGreaterThan(a.dec);
  });
});

describe('seedMark', () => {
  it('starts from the nearest marked epoch, else the field center', () => {
    expect(seedMark({}, 1, 100)).toEqual({ x: 50, y: 50 });
    expect(seedMark({ 0: { x: 3, y: 4 }, 3: { x: 9, y: 9 } }, 1, 100)).toEqual({ x: 3, y: 4 });
  });
});

describe('markableEpochs', () => {
  it('drops epochs without frames', () => {
    const e = (index: number, n: number) => ({ index, frames: Array(n).fill({}) }) as unknown as EpochInfo;
    expect(markableEpochs([e(0, 2), e(1, 0), e(2, 1)]).map((x) => x.index)).toEqual([0, 2]);
  });
});

describe('isValidContact', () => {
  it('accepts empty or an email, rejects anything else', () => {
    expect(isValidContact('')).toBe(true);
    expect(isValidContact('  ')).toBe(true);
    expect(isValidContact('ana@example.org')).toBe(true);
    expect(isValidContact('not an email')).toBe(false);
    expect(isValidContact('a@b')).toBe(false);
    expect(isValidContact('<a@example.org>')).toBe(false);
    expect(isValidContact(`${'a'.repeat(65)}@example.org`)).toBe(false);
  });
});

describe('ids and geometry', () => {
  it('report ids are 10 url-safe characters', () => {
    expect(REPORT_ID_RE.test('fxReport01')).toBe(true);
    expect(REPORT_ID_RE.test('short')).toBe(false);
    expect(REPORT_ID_RE.test('../etc/pwd')).toBe(false);
  });
  it('compass points follow position angle east of north', () => {
    expect(compass(0)).toBe('n');
    expect(compass(90)).toBe('e');
    expect(compass(181)).toBe('s');
    expect(compass(-90)).toBe('w');
    expect(compass(337.6)).toBe('n');
    expect(compass(315)).toBe('nw');
  });
  it('separation handles the RA wrap and cos(dec)', () => {
    expect(sepArcsec(359.9999, 0, 0.0001, 0)).toBeCloseTo(0.72, 2);
    expect(sepArcsec(10, 60, 10.001, 60)).toBeCloseTo(1.8, 2);
  });
});

describe('check summaries', () => {
  it('reads cone radius or box half width', () => {
    expect(searchRadius(undefined)).toBeNull();
    expect(searchRadius({ status: 'no_match', nearest: null, radius_arcsec: 6 })).toBe(6);
    expect(searchRadius({ status: 'no_match', nearest: null, half_width_arcsec: 30 })).toBe(30);
  });
  it('nearest entry by catalog kind', () => {
    const src: CheckSummary = {
      status: 'match',
      nearest: { source_id: 'Gaia DR3 1', sep_arcsec: 0.4, mark: 0, mag: 8.2, mag_band: 'G' },
    };
    expect(nearestOf('gaia_dr3', src)).toEqual({
      kind: 'source',
      id: 'Gaia DR3 1',
      sep: 0.4,
      mag: 8.2,
      band: 'G',
    });
    const body: CheckSummary = {
      status: 'match',
      nearest: { mark: 1, name: '(433) Eros', sep_arcsec: 3, vmag: 12 },
    };
    expect(nearestOf('sbident', body)).toEqual({ kind: 'body', name: '(433) Eros', sep: 3, vmag: 12 });
    expect(nearestOf('simbad', { status: 'no_match', nearest: null })).toBeNull();
  });
});

describe('report copy (design S-14: never claim a discovery)', () => {
  const flat = (o: unknown): string[] =>
    typeof o === 'string' ? [o] : o && typeof o === 'object' ? Object.values(o).flatMap(flat) : [];
  it('English report strings avoid discovery language', () => {
    for (const s of flat(en.report)) expect(s).not.toMatch(/\b(discover\w*|new|found|confirmed)\b/i);
  });
  it('Spanish report strings avoid discovery language, except "no (está) confirmado"', () => {
    for (const s of flat(es.report)) {
      const t = s.replace(/no (está )?confirmad[oa]/gi, '');
      expect(t).not.toMatch(/\b(descubri\w*|nuev[oa]s?|encontrad[oa]s?|confirmad[oa]s?)\b/i);
    }
  });
  it('the flow states that Destello does not review or forward reports', () => {
    expect(en.report.next.noReview).toMatch(/does not review reports or send them anywhere/);
  });
});
