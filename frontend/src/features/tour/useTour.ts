// F-24 guided tour state. The tour opens by itself once, on the first visit to the Explorer, and can be replayed
// from the header. "Seen" (finished or skipped) is kept in localStorage; when the browser refuses storage, the
// flag falls back to sessionStorage and then to memory, so the tour shows at most once per session.
import { create } from 'zustand';
import { TOUR_STEPS, nextStep, prevStep } from './tourSteps';

export const TOUR_SEEN_KEY = 'destello.tourSeen';
const SEEN = '1';

type StorageGetter = () => Storage | null | undefined;

const browserLocal: StorageGetter = () => (typeof window === 'undefined' ? null : window.localStorage);
const browserSession: StorageGetter = () => (typeof window === 'undefined' ? null : window.sessionStorage);

/** "Seen" flag over a list of storages tried in order, with an in-memory last resort. Never throws. */
export function createSeenFlag(
  getters: StorageGetter[] = [browserLocal, browserSession],
  key: string = TOUR_SEEN_KEY,
) {
  let memory = false;
  return {
    read(): boolean {
      if (memory) return true;
      for (const get of getters) {
        try {
          if (get()?.getItem(key) === SEEN) return true;
        } catch {
          // Storage blocked (private mode, sandboxed frame, quota): try the next one.
        }
      }
      return false;
    },
    write(): void {
      memory = true;
      for (const get of getters) {
        try {
          const s = get();
          if (s) {
            s.setItem(key, SEEN);
            return;
          }
        } catch {
          // Try the next storage; the in-memory flag already holds.
        }
      }
    },
  };
}

export type TourEnd = 'finish' | 'skip';

interface TourState {
  /** 0-based step on screen, or null when the tour is closed. */
  step: number | null;
  /** The automatic first-visit check ran in this page load. */
  autoChecked: boolean;
  /** Element that had focus when the tour opened; focus goes back to it when the tour closes. */
  returnTo: HTMLElement | null;
  start: () => void;
  /** Opens the tour when it has never been seen; runs once per page load. */
  maybeAutoStart: () => void;
  next: () => void;
  back: () => void;
  close: (how: TourEnd) => void;
}

function focused(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement && el !== document.body ? el : null;
}

export function createTourStore(flag = createSeenFlag(), total = TOUR_STEPS.length) {
  return create<TourState>((set, get) => ({
    step: null,
    autoChecked: false,
    returnTo: null,
    start: () => set({ step: 0, autoChecked: true, returnTo: focused() }),
    maybeAutoStart: () => {
      if (get().autoChecked) return;
      set({ autoChecked: true });
      if (!flag.read()) set({ step: 0, returnTo: focused() });
    },
    next: () => {
      const s = get().step;
      if (s === null) return;
      const n = nextStep(s, total);
      if (n === null) {
        flag.write();
        set({ step: null });
      } else set({ step: n });
    },
    back: () => {
      const s = get().step;
      if (s !== null) set({ step: prevStep(s) });
    },
    close: () => {
      flag.write();
      set({ step: null });
    },
  }));
}

export const useTour = createTourStore();
