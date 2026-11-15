// F-24 guided tour (design S-18): coach marks over the live Explorer. A spotlight with the focus ring (cyan, never
// glint) frames the part of the page each step talks about. "Skip tour" and Esc end it and count as seen. The tour
// never starts playback; positions follow layout changes without animated transitions.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { TOUR_STEPS, placeCard, unionBox, type Box, type TourStep } from './tourSteps';
import { useTour } from './useTour';

const CARD_W = 360;
const EDGE = 16;
const PAD = 4;

function visibleAnchors(step: TourStep): HTMLElement[] {
  const sel = step.anchors.map((a) => `[data-tour="${a}"]`).join(',');
  return Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

function anchorBox(step: TourStep): Box | null {
  return unionBox(
    visibleAnchors(step).map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
}

export function TourOverlay() {
  const { t } = useTranslation();
  const step = useTour((s) => s.step);
  const next = useTour((s) => s.next);
  const back = useTour((s) => s.back);
  const close = useTour((s) => s.close);
  const [box, setBox] = useState<Box | null>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [cardH, setCardH] = useState(280);
  const current = step === null ? null : (TOUR_STEPS[step] ?? null);

  // Bring the anchor into view once per step (no smooth scrolling), then follow it through layout changes,
  // scrolling and resizing.
  useEffect(() => {
    if (!current) return;
    visibleAnchors(current)[0]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    let raf = 0;
    const measure = () => {
      raf = 0;
      setVp({ w: window.innerWidth, h: window.innerHeight });
      setBox(anchorBox(current));
    };
    const queue = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('resize', queue);
    window.addEventListener('scroll', queue, true);
    // Frames and panels load while the tour is open; a slow poll keeps the spotlight on its target.
    const poll = window.setInterval(queue, 300);
    return () => {
      window.removeEventListener('resize', queue);
      window.removeEventListener('scroll', queue, true);
      window.clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [current]);

  // Keyboard focus follows the primary action on every step.
  useEffect(() => {
    if (step !== null) nextRef.current?.focus();
  }, [step]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.getBoundingClientRect().height);
  }, [step, vp.w, box?.w]);

  if (step === null || !current) return null;
  const total = TOUR_STEPS.length;
  const last = step === total - 1;
  const cardW = Math.max(0, Math.min(CARD_W, vp.w - 2 * EDGE));
  const pos = placeCard(box, { w: cardW, h: cardH }, vp.w, vp.h);

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && close('skip')}>
      <DialogPrimitive.Portal>
        <div className="fixed inset-0 z-50" data-testid="tour">
          {box ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute rounded-lg"
              style={{
                left: box.x - PAD,
                top: box.y - PAD,
                width: box.w + 2 * PAD,
                height: box.h + 2 * PAD,
                boxShadow:
                  '0 0 0 2px var(--cyan), 0 0 0 9999px color-mix(in srgb, var(--frame) 74%, transparent)',
              }}
              data-testid="tour-spotlight"
            />
          ) : (
            <div aria-hidden="true" className="absolute inset-0 bg-frame/75" />
          )}
        </div>
        <DialogPrimitive.Content
          ref={cardRef}
          onPointerDownOutside={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nextRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Focus goes back to the control that opened the tour (for example the header replay button).
            const back = useTour.getState().returnTo;
            if (back?.isConnected) {
              e.preventDefault();
              back.focus();
            }
          }}
          className="fixed z-50 flex max-h-[calc(100dvh-2rem)] flex-col gap-3 overflow-y-auto rounded-2xl border border-border-strong bg-surface p-5 text-text shadow-pop"
          style={{ left: pos.left, top: pos.top, width: cardW }}
          data-testid="tour-card"
          data-step={current.key}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className="tnum font-mono text-caption-12 font-semibold text-muted"
              data-testid="tour-count"
            >
              {t('tour.count', { n: step + 1, total })}
            </span>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="sm" className="px-2 text-label-13" data-testid="tour-skip">
                {t('tour.skip')}
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Title className="font-display text-title-20 font-semibold">
            {t(`tour.steps.${current.key}.title`)}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-body-14 text-text-2">
            {t(`tour.steps.${current.key}.body`)}
          </DialogPrimitive.Description>
          {current.keys.length > 0 && (
            <ul
              aria-label={t('tour.keysLabel')}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-label-13 text-muted"
            >
              {current.keys.map((k) => (
                <li key={k.k} className="inline-flex items-center gap-1.5">
                  <kbd className="tnum min-w-7 rounded-sm border border-b-2 border-border-strong bg-surface-2 px-1.5 py-0.5 text-center font-mono text-caption-12 font-medium text-text">
                    {k.k}
                  </kbd>
                  {t(k.t)}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5" aria-hidden="true">
              {TOUR_STEPS.map((s, i) => (
                <span
                  key={s.key}
                  className={cn(
                    'h-1.5 rounded-xs',
                    i === step ? 'w-[18px] bg-text' : 'w-1.5 bg-border-strong',
                  )}
                />
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              {step > 0 && (
                <Button variant="secondary" onClick={back} data-testid="tour-back">
                  {t('tour.back')}
                </Button>
              )}
              <Button variant="primary" ref={nextRef} onClick={next} data-testid="tour-next">
                {last ? t('tour.finish') : t('tour.next')}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
