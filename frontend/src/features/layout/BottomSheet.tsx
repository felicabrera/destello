// Mobile bottom sheet (S-20): drag handle with a one-line summary and three snap states (peek, half, full). A tap
// on the handle cycles the states, a swipe down closes to peek, arrow keys and Escape work for keyboard users.
// The half state leaves the frame and its transport row visible above the sheet.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type SheetState = 'peek' | 'half' | 'full';
const ORDER: SheetState[] = ['peek', 'half', 'full'];
const PEEK_PX = 92;
const TOP_GAP = 56;
const TAP_PX = 6;
const SWIPE_CLOSE_PX = 90;
/** Header, tools row and transport row heights that stay visible above the half-open sheet. */
const HEADER_PX = 56;
const TOOLS_PX = 60;
const TRANSPORT_PX = 60;
const GUTTER_PX = 32;

const HALF_MIN_PX = 168;

function heights(halfPx?: number): Record<SheetState, number> {
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight;
  const vw = typeof window === 'undefined' ? 390 : window.innerWidth;
  const full = vh - TOP_GAP;
  const belowFrame = vh - (HEADER_PX + TOOLS_PX + (vw - GUTTER_PX) + TRANSPORT_PX);
  const half =
    halfPx !== undefined
      ? Math.min(full, Math.max(halfPx, HALF_MIN_PX))
      : Math.min(full, Math.max(belowFrame, Math.round(vh * 0.34)));
  return { peek: PEEK_PX, half, full };
}

export function BottomSheet({
  children,
  state,
  onStateChange,
  summary,
  mini,
  halfPx,
}: {
  children: React.ReactNode;
  state: SheetState;
  /** Called on every state change; the Explorer pauses playback at `full`. */
  onStateChange: (s: SheetState) => void;
  /** One line shown under the grip: what the panel holds right now. */
  summary: string;
  /** Mini player, rendered only while the sheet is fully open. */
  mini?: React.ReactNode;
  /** Measured height of the half state: the space under the transport row. Falls back to an estimate. */
  halfPx?: number;
}) {
  const { t } = useTranslation();
  const [dragH, setDragH] = useState<number | null>(null);
  const drag = useRef<{ y0: number; h0: number; moved: number } | null>(null);
  const suppressClick = useRef(false);

  const go = onStateChange;
  const cycle = () => go(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]);

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, h0: heights(halfPx)[state], moved: 0 };
  };
  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    d.moved = Math.max(d.moved, Math.abs(dy));
    if (d.moved > TAP_PX) {
      const h = heights(halfPx);
      setDragH(Math.max(h.peek, Math.min(h.full, d.h0 - dy)));
    }
  };
  const onUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dy = e.clientY - d.y0;
    if (d.moved <= TAP_PX) {
      setDragH(null);
      return; // the click handler cycles
    }
    const h = heights(halfPx);
    const finalH = Math.max(h.peek, Math.min(h.full, d.h0 - dy));
    let next: SheetState;
    if (dy > SWIPE_CLOSE_PX && state !== 'peek') next = 'peek';
    else
      next = ORDER.reduce(
        (best, s) => (Math.abs(h[s] - finalH) < Math.abs(h[best] - finalH) ? s : best),
        'peek' as SheetState,
      );
    setDragH(null);
    go(next);
    // The click that follows pointerup must not also cycle.
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const i = ORDER.indexOf(state);
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      go(ORDER[Math.min(ORDER.length - 1, i + 1)]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      go(ORDER[Math.max(0, i - 1)]);
    } else if (e.key === 'Escape' && state !== 'peek') {
      e.preventDefault();
      go('peek');
    }
  };

  const h = dragH ?? heights(halfPx)[state];
  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-2xl border-t border-border-strong bg-surface shadow-pop md:hidden ${dragH === null ? 'transition-[height] duration-(--duration-slow)' : ''}`}
      style={{ height: h }}
      data-testid="mobile-sheet"
      data-tour="results"
      data-state={state}
    >
      <button
        type="button"
        onKeyDown={onKey}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => {
          drag.current = null;
          setDragH(null);
        }}
        onClick={() => {
          if (!suppressClick.current) cycle();
        }}
        className="flex min-h-[var(--hit-min)] w-full flex-none touch-none flex-col items-center justify-center gap-1.5 px-4 pb-1 pt-2"
        aria-expanded={state !== 'peek'}
        aria-label={`${t('sheet2.grab')}: ${t(`sheet.state.${state}`)}. ${summary}. ${t('sheet.hint')}`}
        data-testid="sheet-handle"
      >
        <span className="h-1 w-10 flex-none rounded-full bg-border-strong" />
        <span
          className="tnum w-full truncate text-center text-caption-12 font-medium text-text-2"
          data-testid="sheet-summary"
        >
          {summary}
        </span>
      </button>
      {state === 'full' && dragH === null && mini}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">{children}</div>
    </div>
  );
}
