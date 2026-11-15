// F-25 GIF export: one palette for all frames keeps the shared stretch; the file is a looping GIF.
import { describe, expect, it } from 'vitest';
import {
  buildPalette,
  encodeGif,
  exportFileName,
  exportOrder,
  exportScale,
  grayIndex,
  grayLevelsFor,
  indexFrame,
  type RgbaFrame,
} from './exportGif';

/** Test input only: a w x h frame with a horizontal gray ramp and, optionally, one colored pixel. */
function ramp(w: number, h: number, color?: [number, number, number]): RgbaFrame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const v = Math.round((x * 255) / (w - 1));
      data[p] = data[p + 1] = data[p + 2] = v;
      data[p + 3] = 255;
    }
  if (color) data.set([...color, 255], 0);
  return { data, width: w, height: h };
}

/** Number of images in a GIF, read by walking its blocks. */
function gifImages(b: Uint8Array): number {
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  const skipSub = () => {
    while (b[p] !== 0) p += b[p] + 1;
    p++;
  };
  let images = 0;
  while (p < b.length && b[p] !== 0x3b) {
    if (b[p] === 0x21) {
      p += 2;
      skipSub();
    } else if (b[p] === 0x2c) {
      images++;
      const flags = b[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++;
      skipSub();
    } else throw new Error(`bad block at ${p}`);
  }
  return images;
}

describe('F-25 GIF export', () => {
  it('maps a gray level to the same index in every frame, within one 8-bit level', () => {
    const grays = grayLevelsFor('blink');
    const a = ramp(256, 2);
    const b = ramp(256, 2, [0, 200, 220]);
    const pal = buildPalette([a, b], grays);
    expect(pal).toHaveLength(256);
    const ia = indexFrame(a, pal, grays);
    const ib = indexFrame(b, pal, grays);
    // Same gray pixel, same palette entry, in both frames (pixel 0 of b is the colored one).
    for (let i = 1; i < ia.length; i++) expect(ib[i]).toBe(ia[i]);
    for (let v = 0; v < 256; v++) {
      const c = pal[grayIndex(v, grays)];
      expect(Math.abs(c[0] - v)).toBeLessThanOrEqual(1);
    }
    // The colored pixel gets a non-gray entry close to its color.
    const c = pal[ib[0]];
    expect(ib[0]).toBeGreaterThanOrEqual(grays);
    expect(Math.hypot(c[0] - 0, c[1] - 200, c[2] - 220)).toBeLessThan(24);
  });

  it('writes a looping GIF89a with one image per frame', () => {
    const frames = [ramp(8, 6), ramp(8, 6, [230, 120, 20]), ramp(8, 6)];
    const bytes = encodeGif(frames, 500, grayLevelsFor('blink'));
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');
    expect(bytes[6] | (bytes[7] << 8)).toBe(8);
    expect(bytes[8] | (bytes[9] << 8)).toBe(6);
    const text = String.fromCharCode(...bytes);
    expect(text).toContain('NETSCAPE2.0');
    expect(gifImages(bytes)).toBe(3);
    expect(bytes[bytes.length - 1]).toBe(0x3b);
    expect(() => encodeGif([], 500, 192)).toThrow();
  });

  it('exports the playable epochs in order, or the single stacked frame', () => {
    expect(exportOrder('blink', [0, 2, 3])).toEqual([0, 2, 3]);
    expect(exportOrder('stack', [])).toEqual([0]);
    expect(grayLevelsFor('rgb')).toBeLessThan(grayLevelsFor('blink'));
  });

  it('keeps frame pixels whole and names the file after the view', () => {
    expect(exportScale(116)).toBe(4);
    expect(exportScale(1000)).toBe(1);
    expect(exportFileName(["Barnard's Star", 'd3', 'blink'])).toBe('destello-barnard-s-star-d3-blink.gif');
    expect(exportFileName(['Épsilon Indi', 'all'])).toBe('destello-epsilon-indi-all.gif');
  });
});
