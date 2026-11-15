// Ephemeral UI state. View state that must be shareable lives in the URL (lib/url-state.ts), not here.
import { create } from 'zustand';
import type { CandidateStatus } from '../lib/types';

export interface Mark {
  x: number;
  y: number;
}

interface UiState {
  playing: boolean;
  /** 0-based epoch index currently shown. Mirrors the URL `frame` parameter on user actions. */
  frame: number;
  mark: Mark | null;
  loop: boolean;
  shareOpen: boolean;
  helpOpen: boolean;
  noticeDismissed: boolean;
  demoBannerDismissed: boolean;
  /** IRSA status banner dismissed for the current status (`degraded` or `down`); a worse status shows it again. */
  irsaDismissed: string | null;
  /** F-22: the report flow replaces the right panel while open. */
  reportOpen: boolean;
  /** F-22: candidate marks in frame px, keyed by manifest epoch index (one mark per epoch). */
  reportMarks: Record<number, Mark>;
  /** F-29: id of the highlighted candidate of the current pair, or null. */
  candSel: string | null;
  /** F-29: candidate groups opened in the panel; their markers are drawn too. */
  candOpen: Partial<Record<CandidateStatus, boolean>>;
  setCandSel: (id: string | null) => void;
  /** F-32: id of the sequence whose motion search the user started, or null. The search never runs on its own. */
  motionRun: string | null;
  /** F-32: id of the highlighted source of the motion search, or null. */
  motionSel: string | null;
  setMotionRun: (sequenceId: string | null) => void;
  setMotionSel: (id: string | null) => void;
  toggleCandGroup: (s: CandidateStatus) => void;
  setPlaying: (v: boolean) => void;
  setFrame: (i: number) => void;
  setMark: (m: Mark | null) => void;
  setLoop: (v: boolean) => void;
  setShareOpen: (v: boolean) => void;
  setHelpOpen: (v: boolean) => void;
  dismissNotice: () => void;
  dismissDemoBanner: () => void;
  dismissIrsa: (status: string) => void;
  setReportOpen: (v: boolean) => void;
  setReportMark: (epoch: number, m: Mark | null) => void;
  clearReportMarks: () => void;
}

const DISMISS_KEY = 'destello.dismissed';

/** Banners dismissed in this browser session, so a dismissed banner stays dismissed across presets and reloads. */
function readDismissed(): string[] {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(list: string[]): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the dismissal lasts until reload */
  }
}

const initialDismissed = readDismissed();

export const useUi = create<UiState>((set) => ({
  playing: false,
  frame: 0,
  mark: null,
  loop: true,
  shareOpen: false,
  helpOpen: false,
  noticeDismissed: initialDismissed.includes('notice'),
  demoBannerDismissed: initialDismissed.includes('demo'),
  irsaDismissed: initialDismissed.find((k) => k.startsWith('irsa:'))?.slice(5) ?? null,
  reportOpen: false,
  reportMarks: {},
  candSel: null,
  candOpen: {},
  setCandSel: (candSel) => set({ candSel }),
  motionRun: null,
  motionSel: null,
  setMotionRun: (motionRun) => set({ motionRun }),
  setMotionSel: (motionSel) => set({ motionSel }),
  toggleCandGroup: (st) => set((s) => ({ candOpen: { ...s.candOpen, [st]: !s.candOpen[st] } })),
  setPlaying: (playing) => set({ playing }),
  setFrame: (frame) => set({ frame }),
  setMark: (mark) => set({ mark }),
  setLoop: (loop) => set({ loop }),
  setShareOpen: (shareOpen) => set({ shareOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  dismissNotice: () => {
    writeDismissed([...readDismissed().filter((k) => k !== 'notice'), 'notice']);
    set({ noticeDismissed: true });
  },
  dismissDemoBanner: () => {
    writeDismissed([...readDismissed().filter((k) => k !== 'demo'), 'demo']);
    set({ demoBannerDismissed: true });
  },
  dismissIrsa: (status) => {
    writeDismissed([...readDismissed().filter((k) => !k.startsWith('irsa:')), `irsa:${status}`]);
    set({ irsaDismissed: status });
  },
  setReportOpen: (reportOpen) => set({ reportOpen }),
  setReportMark: (epoch, m) =>
    set((s) => {
      const next = { ...s.reportMarks };
      if (m) next[epoch] = m;
      else delete next[epoch];
      return { reportMarks: next };
    }),
  clearReportMarks: () => set({ reportMarks: {} }),
}));
