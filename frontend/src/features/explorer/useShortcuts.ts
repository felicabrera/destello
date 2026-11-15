import { useEffect, useRef } from 'react';
import { FPS_VALUES, type DetectorNum, type Fps } from '../../lib/types';
import type { useExplorer } from './useExplorer';

type Model = ReturnType<typeof useExplorer>;

const TEXT = 'input, textarea, select, [contenteditable="true"], [role="combobox"]';

/** Global keyboard shortcuts (docs/07 section 6). Disabled while typing, with modifiers, or inside dialogs. */
export function useShortcuts(model: Model, measure: () => void): void {
  // One listener for the page's lifetime; it reads the latest model through refs (the model changes every tick).
  const modelRef = useRef(model);
  const measureRef = useRef(measure);
  modelRef.current = model;
  measureRef.current = measure;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const x = modelRef.current;
      const onMeasure = measureRef.current;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest(TEXT) || el?.closest('[role="dialog"]')) return;
      const interactive = !!el?.closest(
        'button, a, [role="radio"], [role="switch"], [role="tab"], [role="option"]',
      );
      const inGroup = !!el?.closest('[role="radiogroup"], [role="tablist"], [role="listbox"]');
      const key = e.key;

      if (key === ' ' || key === 'Spacebar') {
        if (interactive) return;
        e.preventDefault();
        x.setPlaying(!x.ui.playing);
        return;
      }
      if ((key === 'ArrowLeft' || key === 'ArrowRight') && !inGroup) {
        e.preventDefault();
        x.step(key === 'ArrowRight' ? 1 : -1);
        return;
      }
      if (key === 'Home' && !inGroup) {
        e.preventDefault();
        if (x.playable.length) x.setFrameFromUser(x.playable[0]);
        return;
      }
      if (key === 'End' && !inGroup) {
        e.preventDefault();
        if (x.playable.length) x.setFrameFromUser(x.playable[x.playable.length - 1]);
        return;
      }
      if (key === '+' || key === '=' || key === '-' || key === '_') {
        const i = FPS_VALUES.indexOf(x.view.fps as Fps);
        const next =
          FPS_VALUES[Math.max(0, Math.min(FPS_VALUES.length - 1, i + (key === '+' || key === '=' ? 1 : -1)))];
        x.setFps(next);
        return;
      }
      if (/^[0-6]$/.test(key)) {
        x.setDet(key === '0' ? 'all' : (Number(key) as DetectorNum));
        return;
      }
      const k = key.toLowerCase();
      if (k === 'b') x.setMode('blink');
      else if (k === 'd' && x.nEpochs >= 2 && x.complete) x.setMode('diff');
      else if (k === 's' && x.nEpochs >= 2) x.setMode('stack');
      else if (k === 'c' && x.rgbAvailable) x.setMode('rgb');
      else if (k === 't' && x.trackAvailable) x.setTrack(!x.view.track);
      else if (k === 'g') x.toggleOverlay('gaia');
      else if (k === 'w') x.toggleOverlay('catwise');
      else if (k === 'f') x.toggleOverlay('flags');
      else if (k === 'p' && x.pathReason === null) x.toggleOverlay('path');
      else if (k === 'm') onMeasure();
      else if (key === '?') x.ui.setHelpOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
