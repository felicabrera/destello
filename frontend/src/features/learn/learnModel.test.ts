import { describe, expect, it } from 'vitest';
import { pixelToSky, skyToPixel, type Grid } from '../../lib/astrometry';
import type { EpochInfo, FrameInfo } from '../../lib/types';
import { LESSON_MINUTES, TIMELINE } from './LearnGuide';
import {
  answerRange,
  baselineYears,
  clickToSky,
  commonDetector,
  compassPoint,
  epochMission,
  learnEpochs,
  measureMotion,
  moveCrosshair,
  percentDifference,
  wrapDeltaDeg,
  type EpochPoint,
} from './learnModel';

const grid: Grid = { ra0: 269.45, dec0: 4.69, scaleArcsec: 3.1, n: 200 };
const frame = (detector: number, mission?: string): FrameInfo => ({
  detector,
  kind: 'coadd',
  url: 'x',
  n_images: 3,
  flagged_fraction: 0,
  obs_ids: [],
  ...(mission ? { mission } : {}),
});
const ep = (index: number, mjd: number, dets: number[], extra: Partial<EpochInfo> = {}): EpochInfo => ({
  index,
  t_mid_mjd: mjd,
  frames: dets.map((d) => frame(d)),
  ...extra,
});
const pt = (index: number, mjd: number, ra: number, dec: number): EpochPoint => ({
  pos: index,
  index,
  mjd,
  mission: null,
  sky: { ra, dec },
});

describe('click conversion', () => {
  it('round trips with the grid and keeps North up, East left', () => {
    const s = clickToSky(grid, { x: 120, y: 80 });
    const p = skyToPixel(grid, s.ra, s.dec);
    expect(p.x).toBeCloseTo(120, 6);
    expect(p.y).toBeCloseTo(80, 6);
    expect(clickToSky(grid, { x: 100, y: 60 }).dec).toBeGreaterThan(clickToSky(grid, { x: 100, y: 140 }).dec);
    expect(clickToSky(grid, { x: 60, y: 100 }).ra).toBeGreaterThan(clickToSky(grid, { x: 140, y: 100 }).ra);
    expect(pixelToSky(grid, 100, 100).dec).toBeCloseTo(grid.dec0, 9);
  });
  it('moves the crosshair and clamps it to the frame', () => {
    expect(moveCrosshair({ x: 10, y: 10 }, 'ArrowUp', 1, 200)).toEqual({ x: 10, y: 9 });
    expect(moveCrosshair({ x: 10, y: 10 }, 'ArrowRight', 5, 200)).toEqual({ x: 15, y: 10 });
    expect(moveCrosshair({ x: 0, y: 0 }, 'ArrowLeft', 5, 200)).toEqual({ x: 0, y: 0 });
    expect(moveCrosshair({ x: 200, y: 200 }, 'ArrowDown', 5, 200)).toEqual({ x: 200, y: 200 });
  });
});

describe('measureMotion', () => {
  it('computes the arithmetic of two epochs', () => {
    const dec = 60;
    const r = measureMotion([
      pt(0, 60000, 100, dec),
      pt(1, 60000 + 365.25, 100 + 0.001 / Math.cos((dec * Math.PI) / 180), dec + 0.002),
    ]);
    if (r.kind !== 'ok') throw new Error('expected ok');
    const s = r.steps;
    expect(s.years).toBeCloseTo(1, 9);
    expect(s.usesEnds).toBe(false);
    expect(s.cosDec).toBeCloseTo(Math.cos(((dec + 0.001) * Math.PI) / 180), 9);
    expect(s.pmDec).toBeCloseTo(7.2, 6);
    expect(s.pmRa).toBeCloseTo((3.6 * s.cosDec) / Math.cos((dec * Math.PI) / 180), 3);
    expect(s.total).toBeCloseTo(Math.hypot(s.pmRa, s.pmDec), 9);
  });
  it('uses first and last with more epochs, in any order of clicks', () => {
    const r = measureMotion([pt(2, 60400, 10, 0.2), pt(0, 60000, 10, 0), pt(1, 60200, 10, 5)]);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.steps.usesEnds).toBe(true);
    expect(r.steps.nClicked).toBe(3);
    expect(r.steps.first.index).toBe(0);
    expect(r.steps.last.index).toBe(2);
    expect(r.steps.compass).toBe('N');
  });
  it('wraps right ascension across 0 and 360', () => {
    expect(wrapDeltaDeg(359.9999 - 0.0001)).toBeCloseTo(-0.0002, 6);
    const r = measureMotion([pt(0, 60000, 359.9995, 0), pt(1, 60365.25, 0.0005, 0)]);
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.steps.dRaDeg).toBeCloseTo(0.001, 9);
    expect(r.steps.compass).toBe('E');
  });
  it('handles too few clicks and equal times', () => {
    expect(measureMotion([]).kind).toBe('too-few');
    expect(measureMotion([pt(0, 1, 1, 1)]).kind).toBe('too-few');
    expect(measureMotion([pt(0, 5, 1, 1), pt(1, 5, 2, 2)]).kind).toBe('no-time');
  });
  it('names the eight compass points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(271)).toBe('W');
    expect(compassPoint(359)).toBe('N');
  });
});

describe('epochs and references', () => {
  const eps = [
    ep(0, 100, [1, 2]),
    ep(1, 300, [2]),
    ep(2, 500, [2, 3], { coverage: 'low' }),
    ep(3, 465.25, [1, 2]),
  ];
  it('lists the epochs with a frame in the detector, skipping low coverage', () => {
    expect(learnEpochs(eps, 2).map((e) => e.index)).toEqual([0, 1, 3]);
    expect(learnEpochs(eps, 1).map((e) => e.index)).toEqual([0, 3]);
    expect(commonDetector(eps)).toBe(2);
    expect(commonDetector([])).toBeNull();
  });
  it('reads the mission label from the frames, null when absent', () => {
    const e: EpochInfo = { index: 4, t_mid_mjd: 1, frames: [frame(1), frame(2, ' WISE ')] };
    expect(epochMission(e)).toBe('WISE');
    expect(epochMission(eps[0])).toBeNull();
  });
  it('gives the baseline and the answer range from inputs, or null', () => {
    expect(baselineYears(eps, 2)).toBeCloseTo(365.25 / 365.25 + 0, 9);
    expect(baselineYears(eps, 3)).toBeNull();
    const r = answerRange(10, 3, 1);
    expect(r?.spread).toBeCloseTo(3 * Math.SQRT2, 9);
    expect(r?.low).toBeCloseTo(10 - 3 * Math.SQRT2, 9);
    expect(answerRange(undefined, 3, 1)).toBeNull();
    expect(answerRange(10, 3, 0)).toBeNull();
    expect(answerRange(10, undefined, 1)).toBeNull();
  });
  it('gives a signed percentage difference', () => {
    expect(percentDifference(11, 10)).toBeCloseTo(10, 9);
    expect(percentDifference(9, 10)).toBeCloseTo(-10, 9);
    expect(percentDifference(1, 0)).toBeNull();
  });
});

describe('guide timeline', () => {
  it('adds up to forty minutes', () => {
    expect(TIMELINE.length).toBeGreaterThan(0);
    expect(LESSON_MINUTES).toBe(40);
  });
});
