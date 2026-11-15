// F-35 Hunt: short first-visit tutorial in the style of the guided tour (card, skip, step dots). "Seen" is kept in
// localStorage like the tour flag, under its own key. It never starts playback.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { createSeenFlag } from '../tour/useTour';

export const HUNT_TUTORIAL_KEY = 'destello.huntTutorialSeen';
export const TUTORIAL_STEPS = ['look', 'controls', 'classify', 'trust'] as const;

const flag = createSeenFlag(undefined, HUNT_TUTORIAL_KEY);

interface TutorialState {
  step: number | null;
  autoChecked: boolean;
  start: () => void;
  maybeAutoStart: () => void;
  next: () => void;
  back: () => void;
  close: () => void;
}

export const useHuntTutorial = create<TutorialState>((set, get) => ({
  step: null,
  autoChecked: false,
  start: () => set({ step: 0, autoChecked: true }),
  maybeAutoStart: () => {
    if (get().autoChecked) return;
    set({ autoChecked: true });
    if (!flag.read()) set({ step: 0 });
  },
  next: () => {
    const s = get().step;
    if (s === null) return;
    if (s + 1 < TUTORIAL_STEPS.length) set({ step: s + 1 });
    else {
      flag.write();
      set({ step: null });
    }
  },
  back: () => {
    const s = get().step;
    if (s !== null) set({ step: Math.max(0, s - 1) });
  },
  close: () => {
    flag.write();
    set({ step: null });
  },
}));

export function HuntTutorial() {
  const { t } = useTranslation('hunt');
  const { step, next, back, close } = useHuntTutorial();
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (step !== null) nextRef.current?.focus();
  }, [step]);
  if (step === null) return null;
  const key = TUTORIAL_STEPS[step];
  const last = step === TUTORIAL_STEPS.length - 1;
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && close()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-frame/75" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nextRef.current?.focus();
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[min(420px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 overflow-y-auto rounded-2xl border border-border-strong bg-surface p-5 text-text shadow-pop"
          data-testid="hunt-tutorial"
          data-step={key}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="tnum font-mono text-caption-12 font-semibold text-muted">
              {t('tutorial.count', { n: step + 1, total: TUTORIAL_STEPS.length })}
            </span>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="sm"
                className="px-2 text-label-13"
                data-testid="hunt-tutorial-skip"
              >
                {t('tutorial.skip')}
              </Button>
            </DialogPrimitive.Close>
          </div>
          <DialogPrimitive.Title className="font-display text-title-20 font-semibold">
            {t(`tutorial.steps.${key}.title`)}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-body-14 text-text-2">
            {t(`tutorial.steps.${key}.body`)}
          </DialogPrimitive.Description>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1.5" aria-hidden="true">
              {TUTORIAL_STEPS.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'h-1.5 rounded-xs',
                    i === step ? 'w-[18px] bg-text' : 'w-1.5 bg-border-strong',
                  )}
                />
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              {step > 0 && (
                <Button variant="secondary" onClick={back} data-testid="hunt-tutorial-back">
                  {t('tutorial.back')}
                </Button>
              )}
              <Button variant="primary" ref={nextRef} onClick={next} data-testid="hunt-tutorial-next">
                {last ? t('tutorial.finish') : t('tutorial.next')}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
