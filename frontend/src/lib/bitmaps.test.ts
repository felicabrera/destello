import { describe, expect, it } from 'vitest';
import { invertAsinh, meanShifted, packRgb } from './bitmaps';
import { DEFAULT_RGB } from './types';

// Forward stretch as written in backend pipeline/render.py: y = asinh(x / a) / asinh(1 / a).
const forward = (f: number, vmin: number, vmax: number, a: number) => {
  const x = Math.min(1, Math.max(0, (f - vmin) / (vmax - vmin)));
  return Math.round((Math.asinh(x / a) / Math.asinh(1 / a)) * 255);
};

describe('invertAsinh', () => {
  it('returns vmin at level 0 and vmax at level 255', () => {
    expect(invertAsinh(0, -0.5, 4, 0.1)).toBeCloseTo(-0.5, 9);
    expect(invertAsinh(255, -0.5, 4, 0.1)).toBeCloseTo(4, 9);
  });
  it('round-trips within one 8-bit step', () => {
    const [vmin, vmax, a] = [-0.02, 1.8, 0.1];
    for (const f of [0.0, 0.01, 0.1, 0.5, 1.2]) {
      const lvl = forward(f, vmin, vmax, a);
      const back = invertAsinh(lvl, vmin, vmax, a);
      const up = invertAsinh(Math.min(255, lvl + 1), vmin, vmax, a);
      const dn = invertAsinh(Math.max(0, lvl - 1), vmin, vmax, a);
      expect(f).toBeGreaterThanOrEqual(Math.min(dn, back) - 1e-9);
      expect(f).toBeLessThanOrEqual(Math.max(up, back) + 1e-9);
    }
  });
});

describe('packRgb', () => {
  const grey = (v: number) => new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]);
  it('maps each frame to its own channel and keeps the image opaque', () => {
    expect(Array.from(packRgb([grey(10), grey(20), grey(30)], 8))).toEqual([
      10, 20, 30, 255, 10, 20, 30, 255,
    ]);
  });
  it('leaves a missing channel black', () => {
    expect(Array.from(packRgb([grey(10), null, grey(30)], 4))).toEqual([10, 0, 30, 255]);
  });
  it('defaults to the longest wavelength in red and the shortest in blue', () => {
    expect(DEFAULT_RGB).toEqual([6, 3, 1]);
  });
});

describe('meanShifted', () => {
  // 3 x 1 grey planes: one value per pixel, written to the red, green and blue bytes.
  const row = (...v: number[]) => new Uint8ClampedArray(v.flatMap((x) => [x, x, x, 255]));
  const red = (d: Uint8ClampedArray) => Array.from(d).filter((_, i) => i % 4 === 0);
  const alpha = (d: Uint8ClampedArray) => Array.from(d).filter((_, i) => i % 4 === 3);
  it('is the plain mean without offsets', () => {
    const out = meanShifted([row(10, 20, 30), row(30, 40, 50)], 3, 1);
    expect(red(out)).toEqual([20, 30, 40]);
    expect(alpha(out)).toEqual([255, 255, 255]);
  });
  it('aligns a moving source and keeps only pixels covered by every plane', () => {
    // A source at x=0 in the first plane and x=1 in the second: shifting the second by -1 stacks it.
    const out = meanShifted([row(100, 0, 0), row(0, 100, 0)], 3, 1, [
      { dx: 0, dy: 0 },
      { dx: -1, dy: 0 },
    ]);
    expect(red(out)).toEqual([100, 0, 0]);
    expect(alpha(out)).toEqual([255, 255, 0]);
  });
  it('rounds offsets to whole pixels (no interpolation)', () => {
    const out = meanShifted([row(10, 20, 30)], 3, 1, [{ dx: 0.6, dy: 0.2 }]);
    expect(red(out)).toEqual([0, 10, 20]);
    expect(alpha(out)).toEqual([0, 255, 255]);
  });
});
