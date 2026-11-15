// Canvas drawing for PlayerCanvas, exactly per design/export/handoff/player-canvas.md.
// Geometry is in frame px (pixel i spans [i, i+1], centre at i + 0.5); stroke widths are CSS px and do not scale.
import type { OverlaySource } from '../../lib/types';
import { STATUS_DASH, type CandidateMarker } from '../candidates/candidateModel';
import { MOTION_DASH, MOTION_MARK_R, type MotionTrack } from '../motion/motionModel';

export interface Colors {
  frame: string;
  glint: string;
  cyan: string;
  violet: string;
  warning: string;
  text: string;
  /** F-27 predicted path: Okabe-Ito reddish purple, theme independent because sky frames stay dark. */
  path: string;
  /** F-32 motion search tracks: Okabe-Ito bluish green, theme independent for the same reason. */
  motion: string;
}

export function readColors(root: Element = document.documentElement): Colors {
  const cs = getComputedStyle(root);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    frame: v('--frame', 'black'),
    glint: v('--glint', 'orange'),
    cyan: v('--cyan', 'cyan'),
    violet: v('--violet', 'violet'),
    warning: v('--warning', 'yellow'),
    text: v('--text', 'white'),
    path: v('--epoch-2', 'violet'),
    motion: v('--epoch-3', 'green'),
  };
}

export interface Pt {
  x: number;
  y: number;
}

/** F-27 predicted path in frame px: dense samples, one point per epoch, and the parallax loop. */
export interface PathScene {
  line: Pt[];
  /** Aligned with the shown epochs; null where the path has no point for that epoch. */
  epochs: (Pt | null)[];
  /** Parallax loop at true scale; drawn only when it spans enough pixels to be seen. */
  ellipse: Pt[] | null;
}

/** Smallest parallax loop (semi-major axis in frame px) drawn on the frame at true scale. */
export const PATH_ELLIPSE_MIN_PX = 1.5;

export function ellipseExtentPx(points: Pt[]): number {
  if (points.length === 0) return 0;
  const cx = points.reduce((a, q) => a + q.x, 0) / points.length;
  const cy = points.reduce((a, q) => a + q.y, 0) / points.length;
  return Math.max(...points.map((q) => Math.hypot(q.x - cx, q.y - cy)));
}

function drawPath(
  ctx: CanvasRenderingContext2D,
  ps: PathScene,
  k: number,
  current: number,
  color: string,
  frame: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  if (ps.line.length > 1) {
    ctx.beginPath();
    ps.line.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x * k, q.y * k) : ctx.lineTo(q.x * k, q.y * k)));
    ctx.stroke();
  }
  if (ps.ellipse && ps.ellipse.length > 2 && ellipseExtentPx(ps.ellipse) >= PATH_ELLIPSE_MIN_PX) {
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ps.ellipse.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x * k, q.y * k) : ctx.lineTo(q.x * k, q.y * k)));
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Epoch markers: diamonds with a dark rim; the shown epoch is filled.
  ps.epochs.forEach((q, i) => {
    if (!q) return;
    const r = i === current ? 5 : 3.5;
    const x = q.x * k;
    const y = q.y * k;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x, y + r);
    ctx.lineTo(x - r, y);
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = frame;
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = color;
    ctx.stroke();
    if (i === current) {
      ctx.fillStyle = color;
      ctx.fill();
    }
  });
}

export interface Scene {
  /** CSS size of the square canvas. */
  size: number;
  dpr: number;
  /** Frame size in frame px. */
  n: number;
  bitmap: ImageBitmap | null;
  mask: ImageBitmap | null;
  showFlags: boolean;
  gaia: OverlaySource[] | null;
  catwise: OverlaySource[] | null;
  /** Motion track through all epoch positions (known movers, not in Diff). */
  track: Pt[] | null;
  currentEpoch: number;
  ring: Pt | null;
  mark: Pt | null;
  hover: Pt | null;
  colors: Colors;
  /** Diff mode hides overlays, track and ring label (the ring itself is hidden too, as in the boards). */
  isDiff: boolean;
  /**
   * F-23 track mode: displacement in frame px applied to the frame and to everything drawn on it, so the
   * predicted target position sits at the centre. Geometry stays in the frame's own pixel coordinates.
   */
  shift?: Pt | null;
  /** F-27 predicted path layer, or null when off. */
  path?: PathScene | null;
  /** F-29 candidates to review, drawn over difference images only. */
  candidates?: CandidateMarker[] | null;
  /** F-32 motion search tracks, drawn over sky frames only. */
  motion?: MotionTrack[] | null;
}

/**
 * F-32 tracks: a thin line through the fitted position at each searched epoch, and a square at the epoch on
 * screen. The status is carried by the line pattern, as for the F-29 markers; every stroke has a dark rim.
 */
function drawMotion(ctx: CanvasRenderingContext2D, list: MotionTrack[], k: number, colors: Colors) {
  for (const m of list) {
    const width = m.selected ? 2.5 : 1.25;
    const color = m.status === 'unchecked' ? colors.warning : colors.motion;
    const line = () => {
      if (m.points.length < 2) return;
      ctx.beginPath();
      m.points.forEach((q, i) => (i === 0 ? ctx.moveTo(q.x * k, q.y * k) : ctx.lineTo(q.x * k, q.y * k)));
      ctx.stroke();
    };
    ctx.globalAlpha = m.selected || m.status === 'unmatched' || m.status === 'unchecked' ? 1 : 0.85;
    ctx.setLineDash([]);
    ctx.strokeStyle = colors.frame;
    ctx.lineWidth = width + 2;
    line();
    ctx.setLineDash(MOTION_DASH[m.status]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    line();
    ctx.setLineDash([]);
    // Small ticks at the other epochs, a square at the epoch on screen.
    ctx.fillStyle = color;
    for (const q of m.points) ctx.fillRect(q.x * k - 1.5, q.y * k - 1.5, 3, 3);
    if (m.current) {
      const h = MOTION_MARK_R * k;
      const x = m.current.x * k;
      const y = m.current.y * k;
      ctx.strokeStyle = colors.frame;
      ctx.lineWidth = width + 2;
      ctx.strokeRect(x - h, y - h, 2 * h, 2 * h);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.strokeRect(x - h, y - h, 2 * h, 2 * h);
      if (m.selected) {
        ctx.strokeStyle = colors.glint;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - h - 4, y - h - 4, 2 * h + 8, 2 * h + 8);
      }
    }
    ctx.globalAlpha = 1;
  }
}

/**
 * F-29 markers: rings only, so the pixels stay visible. The status is carried by the line pattern (solid, long
 * dash, short dash, dotted with a cross), not by color alone; every stroke has a dark rim to stay readable on
 * both ends of the diverging colormap.
 */
function drawCandidates(ctx: CanvasRenderingContext2D, list: CandidateMarker[], k: number, colors: Colors) {
  for (const m of list) {
    const strong = m.status === 'unmatched' || m.status === 'unchecked' || m.selected;
    const color = m.status === 'unchecked' ? colors.warning : colors.text;
    const width = m.selected ? 2.5 : 1.5;
    const trace = () => {
      for (const ring of m.rings) {
        ctx.beginPath();
        ctx.arc(ring.x * k, ring.y * k, ring.r * k, 0, Math.PI * 2);
        ctx.stroke();
        if (m.status === 'not_measurable') {
          const h = ring.r * k * 0.5;
          ctx.beginPath();
          ctx.moveTo(ring.x * k - h, ring.y * k - h);
          ctx.lineTo(ring.x * k + h, ring.y * k + h);
          ctx.moveTo(ring.x * k + h, ring.y * k - h);
          ctx.lineTo(ring.x * k - h, ring.y * k + h);
          ctx.stroke();
        }
      }
      if (m.line) {
        ctx.beginPath();
        ctx.moveTo(m.line[0].x * k, m.line[0].y * k);
        ctx.lineTo(m.line[1].x * k, m.line[1].y * k);
        ctx.stroke();
      }
    };
    ctx.globalAlpha = strong ? 1 : 0.8;
    ctx.setLineDash([]);
    ctx.strokeStyle = colors.frame;
    ctx.lineWidth = width + 2;
    trace();
    ctx.setLineDash(STATUS_DASH[m.status]);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    trace();
    ctx.setLineDash([]);
    if (m.selected) {
      // Selection: a second, solid ring outside each ring.
      ctx.strokeStyle = colors.glint;
      ctx.lineWidth = 2;
      for (const ring of m.rings) {
        ctx.beginPath();
        ctx.arc(ring.x * k, ring.y * k, ring.r * k + 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
}

const hatchCache = new WeakMap<ImageBitmap, { size: number; canvas: HTMLCanvasElement }>();

function maskLayer(mask: ImageBitmap, size: number, color: string): HTMLCanvasElement {
  const hit = hatchCache.get(mask);
  if (hit && hit.size === size) return hit.canvas;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return c;
  g.imageSmoothingEnabled = false;
  // 1. mask shape
  g.drawImage(mask, 0, 0, size, size);
  // 2. 28% fill inside the mask
  g.globalCompositeOperation = 'source-in';
  g.globalAlpha = 0.28;
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  g.globalAlpha = 1;
  // 3. 45 degree hatch, 1 px line every 4 CSS px, restricted to the mask
  const hatch = document.createElement('canvas');
  hatch.width = size;
  hatch.height = size;
  const h = hatch.getContext('2d');
  if (h) {
    const shape = document.createElement('canvas');
    shape.width = size;
    shape.height = size;
    const s = shape.getContext('2d');
    if (s) {
      s.imageSmoothingEnabled = false;
      s.drawImage(mask, 0, 0, size, size);
      s.globalCompositeOperation = 'source-in';
      h.strokeStyle = color;
      h.lineWidth = 1;
      h.beginPath();
      for (let k = -size; k < size * 2; k += 4) {
        h.moveTo(k, size);
        h.lineTo(k + size, 0);
      }
      h.stroke();
      h.globalCompositeOperation = 'destination-in';
      h.drawImage(shape, 0, 0);
    }
    g.globalCompositeOperation = 'source-over';
    g.drawImage(hatch, 0, 0);
  }
  g.globalCompositeOperation = 'source-over';
  hatchCache.set(mask, { size, canvas: c });
  return c;
}

export function drawScene(ctx: CanvasRenderingContext2D, sc: Scene): void {
  const { size, dpr, n, colors } = sc;
  const k = size / n;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  // 0 clear
  ctx.fillStyle = colors.frame;
  ctx.fillRect(0, 0, size, size);
  if (sc.shift) ctx.setTransform(dpr, 0, 0, dpr, dpr * sc.shift.x * k, dpr * sc.shift.y * k);
  // 1 frame, nearest neighbour
  if (sc.bitmap) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sc.bitmap, 0, 0, size, size);
  }
  // 2 flags mask
  if (sc.showFlags && sc.mask) {
    const layer = maskLayer(sc.mask, Math.round(size), colors.warning);
    ctx.drawImage(layer, 0, 0, size, size);
  }
  if (!sc.isDiff) {
    // 3 catalog overlays
    if (sc.gaia) {
      ctx.strokeStyle = colors.cyan;
      ctx.lineWidth = 1.5;
      for (const s of sc.gaia) {
        ctx.beginPath();
        ctx.arc(s.x * k, s.y * k, 2.6 * k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (sc.catwise) {
      ctx.strokeStyle = colors.violet;
      ctx.lineWidth = 1.5;
      for (const s of sc.catwise) {
        ctx.strokeRect((s.x - 3) * k, (s.y - 3) * k, 6 * k, 6 * k);
      }
    }
    // 4 motion track
    if (sc.track && sc.track.length > 1) {
      ctx.strokeStyle = colors.glint;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([1, 3]);
      ctx.beginPath();
      sc.track.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * k, p.y * k) : ctx.lineTo(p.x * k, p.y * k)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.6;
      sc.track.forEach((p, i) => {
        if (i === sc.currentEpoch) return;
        const half = 0.8 * k;
        ctx.strokeRect(p.x * k - half, p.y * k - half, 1.6 * k, 1.6 * k);
      });
      ctx.globalAlpha = 1;
    }
    // 4b predicted path (F-27)
    if (sc.path) drawPath(ctx, sc.path, k, sc.currentEpoch, colors.path, colors.frame);
    // 4c motion search tracks (F-32)
    if (sc.motion && sc.motion.length) drawMotion(ctx, sc.motion, k, colors);
    // 5 target ring
    if (sc.ring) {
      ctx.strokeStyle = colors.glint;
      ctx.lineWidth = 1.75;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sc.ring.x * k, sc.ring.y * k, 4.6 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // 5b candidates to review (F-29), on difference images
  if (sc.isDiff && sc.candidates && sc.candidates.length) drawCandidates(ctx, sc.candidates, k, colors);
  // 6 user marks: crosshair, 4 arms of 4 frame px starting 2.5 frame px from the centre
  if (sc.mark) {
    const cx = sc.mark.x * k;
    const cy = sc.mark.y * k;
    const a = 2.5 * k;
    const b = 6.5 * k;
    ctx.strokeStyle = colors.glint;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - b, cy);
    ctx.lineTo(cx - a, cy);
    ctx.moveTo(cx + a, cy);
    ctx.lineTo(cx + b, cy);
    ctx.moveTo(cx, cy - b);
    ctx.lineTo(cx, cy - a);
    ctx.moveTo(cx, cy + a);
    ctx.lineTo(cx, cy + b);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }
  // 7 hover pixel
  if (sc.hover) {
    const px = Math.floor(sc.hover.x);
    const py = Math.floor(sc.hover.y);
    ctx.strokeStyle = colors.text;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.strokeRect(px * k + 0.5, py * k + 0.5, k - 1, k - 1);
    ctx.globalAlpha = 1;
  }
}

/** Nearest catalog source within `maxPx` frame px of a point. */
export function nearestSource(list: OverlaySource[] | null, p: Pt, maxPx = 4): OverlaySource | null {
  if (!list) return null;
  let best: OverlaySource | null = null;
  let bd = maxPx;
  for (const s of list) {
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d <= bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
