// F-35 Hunt keyboard: the Explorer keys that make sense here (arrows, Home and End, Space, speed, B and D), the
// number keys 1 to 5 for the five answers (the Explorer uses them for detectors), Z for zoom and X for the mark.
import { useEffect, useRef } from 'react';
import { FPS_VALUES, type Fps } from '../../lib/types';
import { labelForKey, type HuntLabel } from '../../lib/hunt';
import type { useExplorer } from '../explorer/useExplorer';

type Model = ReturnType<typeof useExplorer>;
const TEXT = 'input, textarea, select, [contenteditable="true"], [role="combobox"]';

export interface HuntKeyActions {
  vote: (l: HuntLabel) => void;
  cycleZoom: () => void;
  clearMark: () => void;
}

export function useHuntShortcuts(model: Model, actions: HuntKeyActions): void {
  const m = useRef(model);
  const a = useRef(actions);
  m.current = model;
  a.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const x = m.current;
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest(TEXT) || el?.closest('[role="dialog"]')) return;
      const interactive = !!el?.closest('button, a, [role="radio"], [role="switch"], [role="tab"]');
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
      if ((key === 'Home' || key === 'End') && !inGroup) {
        e.preventDefault();
        if (x.playable.length) x.setFrameFromUser(x.playable[key === 'Home' ? 0 : x.playable.length - 1]);
        return;
      }
      if (key === '+' || key === '=' || key === '-' || key === '_') {
        const i = FPS_VALUES.indexOf(x.view.fps as Fps);
        const up = key === '+' || key === '=';
        x.setFps(FPS_VALUES[Math.max(0, Math.min(FPS_VALUES.length - 1, i + (up ? 1 : -1)))]);
        return;
      }
      const label = labelForKey(key);
      if (label) {
        e.preventDefault();
        a.current.vote(label);
        return;
      }
      const k = key.toLowerCase();
      if (k === 'b') x.setMode('blink');
      else if (k === 'd' && x.nEpochs >= 2 && x.complete) x.setMode('diff');
      else if (k === 'z') a.current.cycleZoom();
      else if (k === 'x') a.current.clearMark();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
