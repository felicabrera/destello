// F-25: animated GIF of the blink, encoded in the browser. One palette is shared by every frame, and gray levels
// map to the same palette entry in every frame, so the shared intensity stretch of the player is kept.
import { GIFEncoder, nearestColorIndex, quantize, type Palette } from 'gifenc';
import type { Mode } from './types';

export interface RgbaFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Gray levels reserved in the palette: many for grayscale frames, few when the frames are in color. */
export function grayLevelsFor(mode: Mode): number {
  return mode === 'rgb' || mode === 'diff' || mode === 'diffseq' ? 32 : 192;
}

/** Palette index of an 8-bit gray level. The same level always gets the same index. */
export function grayIndex(v: number, grays: number): number {
  return Math.round((v * (grays - 1)) / 255);
}

const MAX_SAMPLE = 1_000_000;

/**
 * Palette of 256 entries: `grays` evenly spaced gray levels, then the colors of the non-gray pixels of all frames
 * together (overlays, caption, color composites), quantized once.
 */
export function buildPalette(frames: RgbaFrame[], grays: number): Palette {
  const palette: Palette = [];
  for (let j = 0; j < grays; j++) {
    const v = Math.round((j * 255) / (grays - 1));
    palette.push([v, v, v]);
  }
  let count = 0;
  for (const f of frames) {
    const d = f.data;
    for (let p = 0; p < d.length; p += 4) if (d[p] !== d[p + 1] || d[p + 1] !== d[p + 2]) count++;
  }
  if (count > 0) {
    const stride = Math.max(1, Math.ceil(count / MAX_SAMPLE));
    const sample = new Uint8Array(Math.ceil(count / stride) * 4);
    let seen = 0;
    let o = 0;
    for (const f of frames) {
      const d = f.data;
      for (let p = 0; p < d.length; p += 4) {
        if (d[p] === d[p + 1] && d[p + 1] === d[p + 2]) continue;
        if (seen++ % stride !== 0 || o >= sample.length) continue;
        sample[o] = d[p];
        sample[o + 1] = d[p + 1];
        sample[o + 2] = d[p + 2];
        sample[o + 3] = 255;
        o += 4;
      }
    }
    for (const c of quantize(sample.subarray(0, o), 256 - grays)) palette.push([c[0], c[1], c[2]]);
  }
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette.slice(0, 256);
}

/** Palette indices of one frame: exact gray mapping for gray pixels, nearest palette color for the others. */
export function indexFrame(f: RgbaFrame, palette: Palette, grays: number): Uint8Array {
  const d = f.data;
  const out = new Uint8Array(d.length / 4);
  const colors = palette.slice(grays);
  const cache = new Map<number, number>();
  for (let p = 0, i = 0; p < d.length; p += 4, i++) {
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    if (r === g && g === b) {
      out[i] = grayIndex(r, grays);
      continue;
    }
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = colors.length ? grays + nearestColorIndex(colors, [r, g, b]) : grayIndex((r + g + b) / 3, grays);
      cache.set(key, idx);
    }
    out[i] = idx;
  }
  return out;
}

/** Looping GIF of the frames, `delayMs` per frame. */
export function encodeGif(frames: RgbaFrame[], delayMs: number, grays: number): Uint8Array {
  if (frames.length === 0) throw new Error('no frames');
  const palette = buildPalette(frames, grays);
  const gif = GIFEncoder();
  frames.forEach((f, i) => {
    const idx = indexFrame(f, palette, grays);
    gif.writeFrame(
      idx,
      f.width,
      f.height,
      i === 0 ? { palette, delay: delayMs, repeat: 0 } : { delay: delayMs },
    );
  });
  gif.finish();
  return gif.bytes();
}

/** Frames of the export, in playback order: the playable epochs, or the single stacked frame. */
export function exportOrder(mode: Mode, playable: number[]): number[] {
  return mode === 'stack' ? [0] : [...playable];
}

/** Integer magnification of the frame for the export, so frame pixels stay sharp and the caption stays readable. */
export function exportScale(n: number): number {
  return Math.max(1, Math.ceil(440 / Math.max(1, n)));
}

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** File name of the export, for example destello-barnard-s-star-d3-blink.gif. */
export function exportFileName(parts: string[]): string {
  const body = parts.map(slug).filter(Boolean).join('-');
  return `destello${body ? `-${body}` : ''}.gif`;
}
