import { describe, expect, it } from 'vitest';
import { frameSize, pixelToSky, propagate, refEpochToMjd, skyToPixel, totalPm } from './astrometry';

const g = { ra0: 133.79513, dec0: -7.24515, scaleArcsec: 3.1, n: 116 };

describe('astrometry', () => {
  it('puts the grid centre at N/2', () => {
    const p = skyToPixel(g, g.ra0, g.dec0);
    expect(p.x).toBeCloseTo(58, 6);
    expect(p.y).toBeCloseTo(58, 6);
  });
  it('North is up and East is left', () => {
    const north = skyToPixel(g, g.ra0, g.dec0 + 60 / 3600);
    expect(north.y).toBeCloseTo(58 - 60 / 3.1, 2);
    expect(north.x).toBeCloseTo(58, 2);
    const east = skyToPixel(g, g.ra0 + 60 / 3600 / Math.cos((g.dec0 * Math.PI) / 180), g.dec0);
    expect(east.x).toBeLessThan(58 - 15);
  });
  it('round trips pixel to sky', () => {
    const s = pixelToSky(g, 40.3, 77.7);
    const p = skyToPixel(g, s.ra, s.dec);
    expect(p.x).toBeCloseTo(40.3, 5);
    expect(p.y).toBeCloseTo(77.7, 5);
  });
  it('parses Julian epochs and ISO dates', () => {
    expect(refEpochToMjd('J2000.0')).toBeCloseTo(51544.5, 6);
    expect(refEpochToMjd('J2016.0')).toBeCloseTo(51544.5 + 16 * 365.25, 6);
    expect(refEpochToMjd('MJD57338.571065')).toBeCloseTo(57338.571065, 6);
    expect(refEpochToMjd('2026-03-01T00:00:00Z')).toBeCloseTo(61100, 6);
    expect(refEpochToMjd(null)).toBeUndefined();
  });
  it('propagates proper motion from the reference epoch', () => {
    const t0 = refEpochToMjd('J2016.0') as number;
    const p = propagate(
      { ra_deg: 10, dec_deg: 0, ref_epoch: 'J2016.0', pmra_masyr: 0, pmdec_masyr: 1000 },
      t0 + 2 * 365.25,
    );
    expect(p.dec).toBeCloseTo(2 / 3600, 8);
    expect(p.ra).toBeCloseTo(10, 8);
  });
  it('does not move a source without epoch or motion', () => {
    expect(
      propagate({ ra_deg: 5, dec_deg: 5, ref_epoch: null, pmra_masyr: 100, pmdec_masyr: 100 }, 60000),
    ).toEqual({ ra: 5, dec: 5 });
  });
  it('frame size follows the design (6 arcmin is 116 px at 3.1 arcsec)', () => {
    expect(frameSize(6, 3.1)).toBe(116);
    expect(totalPm({ pmra_masyr: 3000, pmdec_masyr: 4000 })).toBeCloseTo(5, 8);
  });
});
