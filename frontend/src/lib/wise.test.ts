import { describe, expect, it } from 'vitest';
import type { FrameInfo, Manifest } from './types';
import {
  axisFraction,
  axisTicks,
  buildTimeline,
  decimalYear,
  keyAction,
  missionCounts,
  pickSpherexFrame,
  stepIndex,
  type WiseManifest,
} from './wise';

const frame = (detector: number | string, lo: number | null, hi: number | null, url: string): FrameInfo => ({
  detector,
  kind: detector === 'all' ? 'broadband' : 'coadd',
  url,
  wavelength_um: lo === null || hi === null ? null : [lo, hi],
  n_images: 10,
  flagged_fraction: 0,
  obs_ids: [],
});

const spherex = {
  epochs: [
    {
      index: 0,
      t_mid_mjd: 60988.98,
      frames: [
        frame(5, 3.8, 4.42, '/frames/d5.webp'),
        frame(6, 4.4, 4.99, '/frames/d6.webp'),
        frame('all', null, null, '/frames/all.webp'),
      ],
    },
  ],
  stretch: {
    '5': { method: 'asinh', vmin: 0, vmax: 1, unit: 'MJy/sr' },
    '6': { method: 'asinh', vmin: 2, vmax: 3, unit: 'MJy/sr' },
  },
} as unknown as Manifest;

const wise = {
  band: 'W2',
  epochs: [
    {
      index: 1,
      t_mid_mjd: 56974.68,
      phase: 'NEOWISE',
      n_images: 12,
      frames: [{ url: '/frames/w1.webp', wavelength_um: [4.0842, 5.19], phase: 'NEOWISE' }],
    },
    {
      index: 0,
      t_mid_mjd: 55400,
      phase: 'WISE',
      n_images: 20,
      frames: [{ url: '/frames/w0.webp', wavelength_um: [4.0842, 5.19], phase: 'WISE' }],
    },
  ],
  stretch: { 'WISE:W2': { method: 'asinh', vmin: -60, vmax: 1153, unit: 'DN' } },
} as unknown as WiseManifest;

describe('axis', () => {
  it('maps dates to decimal years', () => {
    expect(decimalYear(51544)).toBeCloseTo(2000.0, 2);
    expect(decimalYear(55197)).toBeCloseTo(2010.0, 2);
  });
  it('clamps to the 2010 to 2026 axis', () => {
    expect(axisFraction(2010)).toBe(0);
    expect(axisFraction(2018)).toBeCloseTo(0.5);
    expect(axisFraction(2030)).toBe(1);
    expect(axisFraction(2000)).toBe(0);
  });
  it('ticks every two years', () => {
    expect(axisTicks()).toEqual([2010, 2012, 2014, 2016, 2018, 2020, 2022, 2024, 2026]);
  });
});

describe('pickSpherexFrame', () => {
  it('takes the coadd with the largest overlap with the window and never the broadband', () => {
    expect(pickSpherexFrame(spherex.epochs[0].frames, [4.0842, 5.19])?.url).toBe('/frames/d6.webp');
  });
  it('returns null when no detector overlaps', () => {
    expect(pickSpherexFrame(spherex.epochs[0].frames, [10, 12])).toBeNull();
  });
});

describe('buildTimeline', () => {
  const t = buildTimeline(spherex, wise);
  it('sorts all markers by time with the mission label', () => {
    expect(t.map((e) => e.mission)).toEqual(['WISE', 'NEOWISE', 'SPHEREx']);
    expect(missionCounts(t)).toEqual({ WISE: 1, NEOWISE: 1, SPHEREx: 1 });
  });
  it('keeps one shared stretch per mission and band', () => {
    expect(t[0].stretch).toBe(t[1].stretch);
    expect(t[0].stretchKey).toBe('WISE:W2');
    expect(t[2].stretchKey).toBe('SPHEREx:D6');
    expect(t[2].stretch?.vmin).toBe(2);
  });
  it('lists only the WISE epochs without a SPHEREx manifest', () => {
    expect(buildTimeline(null, wise)).toHaveLength(2);
  });
});

describe('stepping and keys', () => {
  it('stops at the ends when stepping and wraps in playback', () => {
    expect(stepIndex(0, -1, 5, false)).toBe(0);
    expect(stepIndex(4, 1, 5, false)).toBe(4);
    expect(stepIndex(4, 1, 5, true)).toBe(0);
    expect(stepIndex(0, -1, 5, true)).toBe(4);
    expect(stepIndex(0, 1, 0, true)).toBe(0);
  });
  it('maps keys', () => {
    expect(keyAction('ArrowRight')).toBe('next');
    expect(keyAction('ArrowLeft')).toBe('prev');
    expect(keyAction(' ')).toBe('toggle');
    expect(keyAction('x')).toBeNull();
  });
});
