import { describe, expect, it } from 'vitest';
import { formatDec, formatRa, parseCoordinates, separationDeg, fmtDeg } from './coords';

const RA = 133.79513;
const DEC = -7.24515;

function ok(input: string) {
  const r = parseCoordinates(input);
  if (!r.ok) throw new Error(`expected ok for "${input}", got ${JSON.stringify(r.error)}`);
  return r;
}

describe('parseCoordinates, F-01 formats', () => {
  it('decimal degrees', () => {
    const r = ok('133.79513 -7.24515');
    expect(r.format).toBe('decimal');
    expect(r.raDeg).toBeCloseTo(RA, 5);
    expect(r.decDeg).toBeCloseTo(DEC, 5);
  });
  it('decimal with comma separator', () => {
    const r = ok('133.79513, -7.24515');
    expect(r.raDeg).toBeCloseTo(RA, 5);
  });
  it('decimal with decimal commas (Spanish keyboards)', () => {
    const r = ok('133,79513 -7,24515');
    expect(r.decDeg).toBeCloseTo(DEC, 5);
  });
  it('hms dms with letters', () => {
    const r = ok('08h55m10.831s -07d14m42.53s');
    expect(r.format).toBe('sexagesimal');
    expect(r.raDeg).toBeCloseTo(RA, 4);
    expect(r.decDeg).toBeCloseTo(DEC, 4);
  });
  it('colon separated', () => {
    const r = ok('08:55:10.831 -07:14:42.53');
    expect(r.raDeg).toBeCloseTo(RA, 4);
    expect(r.decDeg).toBeCloseTo(DEC, 4);
  });
  it('space separated', () => {
    const r = ok('08 55 10.831 -7 14 42.53');
    expect(r.raDeg).toBeCloseTo(RA, 4);
    expect(r.decDeg).toBeCloseTo(DEC, 4);
  });
  it('degree, prime and double prime symbols', () => {
    const r = ok('08h55m10.831s -07°14′42.53″');
    expect(r.decDeg).toBeCloseTo(DEC, 4);
  });
  it('explicit plus sign', () => {
    expect(ok('10 00 00 +20 30 00').decDeg).toBeCloseTo(20.5, 6);
  });
});

describe('parseCoordinates, negative zero and boundaries', () => {
  it('keeps the sign of a negative zero declination degree', () => {
    expect(ok('12 00 00 -00 30 00').decDeg).toBeCloseTo(-0.5, 8);
    expect(ok('12:00:00 -00:15:00').decDeg).toBeCloseTo(-0.25, 8);
    expect(ok('12h00m00s -00d30m00s').decDeg).toBeCloseTo(-0.5, 8);
  });
  it('accepts Dec of exactly +-90', () => {
    expect(ok('10 -90').decDeg).toBe(-90);
    expect(ok('10 90').decDeg).toBe(90);
  });
  it('accepts RA 0 and rejects 360', () => {
    expect(ok('0 0').raDeg).toBe(0);
    const r = parseCoordinates('360 10');
    expect(r.ok).toBe(false);
  });
});

describe('parseCoordinates, errors', () => {
  it('RA out of range (decimal)', () => {
    const r = parseCoordinates('400 10');
    expect(r).toEqual({ ok: false, error: { code: 'raRange', value: '400' } });
  });
  it('Dec out of range (decimal)', () => {
    const r = parseCoordinates('10 -95.5');
    expect(r).toEqual({ ok: false, error: { code: 'decRange', value: '-95.5' } });
  });
  it('RA hours out of range', () => {
    const r = parseCoordinates('25h00m00s +10d00m00s');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('raRange');
  });
  it('Dec beyond 90 with minutes', () => {
    const r = parseCoordinates('10 00 00 +90 10 00');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('decRange');
  });
  it('minutes and seconds must be below 60', () => {
    const r = parseCoordinates('08 75 10 -07 14 42');
    expect(r).toEqual({ ok: false, error: { code: 'minRange' } });
    const r2 = parseCoordinates('08:55:10 -07:14:61');
    expect(r2).toEqual({ ok: false, error: { code: 'minRange' } });
  });
  it('empty and unrecognised input', () => {
    expect(parseCoordinates('  ')).toEqual({ ok: false, error: { code: 'empty' } });
    expect(parseCoordinates("Barnard's Star")).toEqual({ ok: false, error: { code: 'format' } });
  });
});

describe('formatting', () => {
  it('formats RA and Dec with rounding carry', () => {
    expect(formatRa(RA)).toBe('08h55m10.83s');
    expect(formatDec(DEC)).toBe('-07°14′42.5″');
    expect(formatRa(359.9999999)).toBe('00h00m00.00s');
    expect(formatDec(-0.0000001)).toBe('+00°00′00.0″');
  });
  it('round trips a parsed position', () => {
    const r = ok('08h55m10.831s -07d14m42.53s');
    const again = ok(`${formatRa(r.raDeg, 3)} ${formatDec(r.decDeg, 2)}`);
    expect(again.raDeg).toBeCloseTo(r.raDeg, 5);
    expect(again.decDeg).toBeCloseTo(r.decDeg, 5);
  });
  it('separation and degree formatting', () => {
    expect(separationDeg(10, 0, 10, 1)).toBeCloseTo(1, 8);
    expect(fmtDeg(133.7951300001)).toBe('133.79513');
  });
});
