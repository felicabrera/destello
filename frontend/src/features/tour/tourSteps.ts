// F-24 guided tour: the steps, in order. Each step names the `data-tour` anchors it frames; every visible element
// carrying one of those names is part of the spotlight. A step whose anchors are not on the page (for example a
// control the phone layout keeps in another place) is shown as a centered card without a spotlight.

export type TourStepKey =
  'player' | 'search' | 'transport' | 'detector' | 'mode' | 'overlays' | 'results' | 'motion' | 'share';

export interface TourStep {
  key: TourStepKey;
  /** `data-tour` attribute values framed by the spotlight. */
  anchors: string[];
  /** Keyboard shortcuts named on the card: key cap and i18n key of its label. */
  keys: { k: string; t: string }[];
}

export const TOUR_STEPS: readonly TourStep[] = [
  { key: 'player', anchors: ['player'], keys: [] },
  { key: 'search', anchors: ['search', 'presets'], keys: [] },
  {
    key: 'transport',
    anchors: ['transport'],
    keys: [
      { k: 'Space', t: 'tour.keyPlay' },
      { k: '← →', t: 'tour.keyStep' },
    ],
  },
  { key: 'detector', anchors: ['detector'], keys: [{ k: '1-6', t: 'tour.keyDetector' }] },
  { key: 'mode', anchors: ['mode'], keys: [{ k: 'D', t: 'tour.keyDiff' }] },
  {
    key: 'overlays',
    anchors: ['overlays'],
    keys: [
      { k: 'G', t: 'tour.keyGaia' },
      { k: 'W', t: 'tour.keyCatwise' },
    ],
  },
  { key: 'results', anchors: ['results'], keys: [{ k: 'M', t: 'tour.keyMeasure' }] },
  { key: 'motion', anchors: ['motion'], keys: [] },
  { key: 'share', anchors: ['share'], keys: [] },
];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of every rectangle with a size; null when none is visible. */
export function unionBox(rects: readonly Box[]): Box | null {
  const vis = rects.filter((r) => r.w > 0 && r.h > 0);
  if (vis.length === 0) return null;
  const x0 = Math.min(...vis.map((r) => r.x));
  const y0 = Math.min(...vis.map((r) => r.y));
  const x1 = Math.max(...vis.map((r) => r.x + r.w));
  const y1 = Math.max(...vis.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Next step index, or null when the tour ends. */
export function nextStep(step: number, total: number): number | null {
  return step + 1 < total ? step + 1 : null;
}

/** Previous step index, never before the first step. */
export function prevStep(step: number): number {
  return Math.max(0, step - 1);
}

const GAP = 16;
const EDGE = 16;

/**
 * Card position next to the spotlight: right, then left, then below, then above; clamped to the viewport. When no
 * side has room, the card goes to the edge of the screen away from the anchor.
 */
export function placeCard(
  box: Box | null,
  card: { w: number; h: number },
  vw: number,
  vh: number,
): { left: number; top: number } {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, Math.max(lo, hi)));
  if (!box)
    return {
      left: clamp((vw - card.w) / 2, EDGE, vw - card.w - EDGE),
      top: clamp((vh - card.h) / 2, EDGE, vh - card.h - EDGE),
    };
  const top = clamp(box.y, EDGE, vh - card.h - EDGE);
  if (box.x + box.w + GAP + card.w + EDGE <= vw) return { left: box.x + box.w + GAP, top };
  if (box.x - GAP - card.w >= EDGE) return { left: box.x - GAP - card.w, top };
  const left = clamp(box.x, EDGE, vw - card.w - EDGE);
  if (box.y + box.h + GAP + card.h + EDGE <= vh) return { left, top: box.y + box.h + GAP };
  if (box.y - GAP - card.h >= EDGE) return { left, top: box.y - GAP - card.h };
  // No free side: cover the half of the screen away from the anchor, so most of the spotlight stays visible.
  const lowAnchor = box.y + box.h / 2 > vh / 2;
  return { left, top: lowAnchor ? EDGE : clamp(vh - card.h - EDGE, EDGE, vh) };
}
