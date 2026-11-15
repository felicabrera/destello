// F-25: draws the frames of the export with the player's own drawing code, plus a caption band under the frame.
import type { RgbaFrame } from '../../lib/exportGif';
import type { ExportScene } from '../explorer/useExplorer';
import { drawScene, readColors, type Colors } from '../player/draw';

export interface ExportCaption {
  title: string;
  lines: string[];
}

const PAD = 12;
const TITLE_LH = 20;
const LINE_LH = 16;

export function captionHeight(c: ExportCaption): number {
  return PAD + TITLE_LH + c.lines.length * LINE_LH + PAD - 2;
}

/** Caption colors: the dark theme, because the caption sits on the frame background, which is dark in both themes. */
function captionColors(): Colors {
  const el = document.createElement('div');
  el.setAttribute('data-theme', 'dark');
  el.hidden = true;
  document.body.appendChild(el);
  try {
    return readColors(el);
  } finally {
    el.remove();
  }
}

function fit(ctx: CanvasRenderingContext2D, s: string, w: number): string {
  if (ctx.measureText(s).width <= w) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid)}...`).width <= w) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}...`;
}

/** Renders every frame to RGBA at `scale` screen px per frame px. Yields between frames so progress can paint. */
export async function renderExportFrames(
  scenes: ExportScene[],
  captions: ExportCaption[],
  scale: number,
  onProgress: (done: number) => void,
): Promise<{ frames: RgbaFrame[]; still: string }> {
  const colors = readColors();
  const cap = captionColors();
  if (typeof document.fonts?.ready?.then === 'function') await document.fonts.ready;
  const n = scenes[0]?.n ?? 0;
  const size = n * scale;
  const capH = Math.max(0, ...captions.map(captionHeight));
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size + capH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || size === 0) throw new Error('canvas unavailable');
  const frames: RgbaFrame[] = [];
  let still = '';
  for (let i = 0; i < scenes.length; i++) {
    const sc = scenes[i];
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, size, size);
    ctx.clip();
    drawScene(ctx, { ...sc, size, dpr: 1, colors, hover: null });
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cap.frame;
    ctx.fillRect(0, size, size, capH);
    const c = captions[i];
    const w = size - 2 * PAD;
    ctx.textBaseline = 'top';
    ctx.fillStyle = cap.glint;
    ctx.font = '600 14px Inter, sans-serif';
    ctx.fillText(fit(ctx, c.title, w), PAD, size + PAD);
    ctx.font = '500 12px Inter, sans-serif';
    ctx.fillStyle = cap.text;
    c.lines.forEach((line, j) => ctx.fillText(fit(ctx, line, w), PAD, size + PAD + TITLE_LH + j * LINE_LH));
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    frames.push({ data: img.data, width: img.width, height: img.height });
    if (i === 0) still = canvas.toDataURL('image/png');
    onProgress(i + 1);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { frames, still };
}
