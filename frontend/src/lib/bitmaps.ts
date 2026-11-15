// ImageBitmap loading with an in-memory cache. Frames are preloaded before playback so blink never flickers.
import { resolveAsset } from './api';

const cache = new Map<string, Promise<ImageBitmap>>();

export function loadBitmap(url: string): Promise<ImageBitmap> {
  const hit = cache.get(url);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(resolveAsset(url));
    if (!res.ok) throw new Error(`frame ${res.status}`);
    const blob = await res.blob();
    return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  })();
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

export function clearBitmaps(): void {
  cache.clear();
}

export interface Offset {
  dx: number;
  dy: number;
}

/**
 * Mean of same-size RGBA planes, plane j moved by a whole-pixel offset (F-23 stack along the track; zero
 * offsets give the plain stack). Pixels are copied, never interpolated. Only pixels covered by every plane
 * are kept, so the depth is the same everywhere; the rest stays transparent (no data).
 */
export function meanShifted(
  planes: Uint8ClampedArray[],
  w: number,
  h: number,
  offsets: Offset[] = [],
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  if (planes.length === 0) return out;
  const acc = new Float32Array(w * h * 3);
  const cnt = new Uint16Array(w * h);
  planes.forEach((d, j) => {
    const dx = Math.round(offsets[j]?.dx ?? 0);
    const dy = Math.round(offsets[j]?.dy ?? 0);
    for (let y = 0; y < h; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= h) continue;
      for (let x = 0; x < w; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= w) continue;
        const s = (y * w + x) * 4;
        const t = ty * w + tx;
        acc[t * 3] += d[s];
        acc[t * 3 + 1] += d[s + 1];
        acc[t * 3 + 2] += d[s + 2];
        cnt[t] += 1;
      }
    }
  });
  const n = planes.length;
  for (let t = 0; t < w * h; t++) {
    if (cnt[t] !== n) continue;
    out[t * 4] = acc[t * 3] / n;
    out[t * 4 + 1] = acc[t * 3 + 1] / n;
    out[t * 4 + 2] = acc[t * 3 + 2] / n;
    out[t * 4 + 3] = 255;
  }
  return out;
}

/** Mean of several same-size bitmaps (display-space stack), optionally moved by whole-pixel offsets. */
export async function meanBitmap(bitmaps: ImageBitmap[], offsets?: Offset[]): Promise<ImageBitmap | null> {
  if (bitmaps.length === 0) return null;
  const { width: w, height: h } = bitmaps[0];
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const planes = bitmaps.map((b) => {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(b, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  });
  const out = ctx.createImageData(w, h);
  out.data.set(meanShifted(planes, w, h, offsets));
  ctx.putImageData(out, 0, 0);
  return createImageBitmap(c);
}

/**
 * Color composite (F-20): the grey level of each detector frame becomes one channel, in the order red,
 * green, blue. Every channel keeps the stretch of its own detector, which all epochs of that detector
 * share, so colors stay comparable between epochs. A missing channel stays black.
 */
/**
 * F-20: pack the grey level (red byte) of up to three RGBA frames into one opaque RGBA image,
 * channel i taking frame i. A missing channel stays black.
 */
export function packRgb(planes: (Uint8ClampedArray | null)[], length: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(length);
  for (let i = 3; i < length; i += 4) out[i] = 255;
  planes.forEach((d, ch) => {
    if (!d || ch > 2) return;
    for (let i = 0; i < length; i += 4) out[i + ch] = d[i];
  });
  return out;
}

export async function rgbBitmap(channels: (ImageBitmap | null)[]): Promise<ImageBitmap | null> {
  const first = channels.find((c): c is ImageBitmap => c !== null);
  if (!first) return null;
  const { width: w, height: h } = first;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const planes = channels.map((bmp) => {
    if (!bmp) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  });
  const out = ctx.createImageData(w, h);
  out.data.set(packRgb(planes, out.data.length));
  ctx.putImageData(out, 0, 0);
  return createImageBitmap(c);
}

let probe: CanvasRenderingContext2D | null = null;
/** 8-bit grey level (0 to 255) of one frame pixel, or null when it cannot be read. */
export function pixelLevel(bmp: ImageBitmap, x: number, y: number): number | null {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= bmp.width || iy >= bmp.height) return null;
  if (!probe) {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    probe = c.getContext('2d', { willReadFrequently: true });
  }
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.drawImage(bmp, ix, iy, 1, 1, 0, 0, 1, 1);
  return probe.getImageData(0, 0, 1, 1).data[0];
}

/** Invert the backend asinh stretch: level 0 to 255 back to the data value (same unit as vmin and vmax). */
export function invertAsinh(level: number, vmin: number, vmax: number, softening: number): number {
  const y = level / 255;
  const x = softening * Math.sinh(y * Math.asinh(1 / softening));
  return vmin + x * (vmax - vmin);
}
