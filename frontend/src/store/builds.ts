// Builds started in this browser. A build keeps running on the server after the view is left;
// this list lets the header point back to it. Persisted so it survives a reload.
import { create } from 'zustand';
import { setBuildAcceptedListener, useSequence, type SeqSource } from './sequence';

export interface TrackedBuild {
  /** Sequence id. */
  id: string;
  /** Explorer path and search that started the build, for example `/?ra=200&dec=20&fov=30`. */
  href: string;
  label: string;
  fov: number;
  startedAt: number;
  state: 'building' | 'ready';
  /** Detectors published so far, from the last status poll. */
  detectorsReady?: number;
}

const KEY = 'destello:builds';
const MAX_AGE_MS = 24 * 3600 * 1000;
const MAX_BUILDS = 6;

/** Keep well-formed, recent entries only. Exported for tests. */
export function sanitizeBuilds(raw: unknown, now: number): TrackedBuild[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackedBuild[] = [];
  for (const b of raw as (Partial<TrackedBuild> | null)[]) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) continue;
    // Only in-app explorer paths: never a full URL.
    if (typeof b.href !== 'string' || !b.href.startsWith('/') || b.href.startsWith('//')) continue;
    if (typeof b.label !== 'string' || typeof b.fov !== 'number') continue;
    if (typeof b.startedAt !== 'number' || now - b.startedAt > MAX_AGE_MS) continue;
    if (out.some((x) => x.id === b.id)) continue;
    out.push({
      id: b.id,
      href: b.href,
      label: b.label.slice(0, 80),
      fov: b.fov,
      startedAt: b.startedAt,
      state: b.state === 'ready' ? 'ready' : 'building',
    });
  }
  return out.slice(0, MAX_BUILDS);
}

function load(): TrackedBuild[] {
  try {
    return sanitizeBuilds(JSON.parse(localStorage.getItem(KEY) ?? '[]'), Date.now());
  } catch {
    return [];
  }
}

function save(builds: TrackedBuild[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(builds));
  } catch {
    /* storage unavailable: the list lives for this page only */
  }
}

interface BuildsState {
  builds: TrackedBuild[];
  track: (b: Omit<TrackedBuild, 'startedAt' | 'state'>) => void;
  update: (id: string, patch: Partial<Pick<TrackedBuild, 'state' | 'detectorsReady'>>) => void;
  remove: (id: string) => void;
}

export const useBuilds = create<BuildsState>((set, get) => {
  const commit = (builds: TrackedBuild[]) => {
    save(builds);
    set({ builds });
  };
  return {
    builds: load(),
    track: (b) => {
      const cur = get().builds;
      const old = cur.find((x) => x.id === b.id);
      if (old && old.href === b.href && old.label === b.label && old.state === 'building') return;
      const entry: TrackedBuild = { ...b, startedAt: old?.startedAt ?? Date.now(), state: 'building' };
      commit([entry, ...cur.filter((x) => x.id !== b.id)].slice(0, MAX_BUILDS));
    },
    update: (id, patch) => {
      const cur = get().builds;
      const old = cur.find((x) => x.id === id);
      if (!old) return;
      const state = patch.state ?? old.state;
      const detectorsReady = patch.detectorsReady ?? old.detectorsReady;
      if (state === old.state && detectorsReady === old.detectorsReady) return;
      commit(cur.map((x) => (x.id === id ? { ...x, state, detectorsReady } : x)));
    },
    remove: (id) => {
      const cur = get().builds;
      if (cur.some((x) => x.id === id)) commit(cur.filter((x) => x.id !== id));
    },
  };
});

// Follow the sequence store: a build is listed from the moment the server accepts it, from the
// view that started it, even when that view is left before the server answers.
const origins = new Map<string, string>();
const isExplorer = () => window.location.pathname === '/' || window.location.pathname.startsWith('/t/');

function trackFrom(id: string, src: SeqSource, key: string) {
  const href = origins.get(key);
  if (!href || src.kind === 'seq') return;
  const lang = document.documentElement.lang === 'es' ? 'es' : 'en';
  const label =
    src.kind === 'preset' ? src.target.names[lang] : `RA ${src.ra.toFixed(4)}, Dec ${src.dec.toFixed(4)}`;
  useBuilds.getState().track({ id, href, label, fov: src.fov });
}

setBuildAcceptedListener(trackFrom);

useSequence.subscribe((s) => {
  if (s.phase === 'building' && s.key && !origins.has(s.key) && isExplorer())
    origins.set(s.key, window.location.pathname + window.location.search);
  if (!s.sequenceId || !s.source || !s.key) return;
  if (s.phase === 'building') trackFrom(s.sequenceId, s.source, s.key);
  else if (s.phase === 'ready') {
    // Finished while another page was open: keep it listed as ready until it is opened.
    if (!isExplorer()) useBuilds.getState().update(s.sequenceId, { state: 'ready' });
  } else if (s.phase === 'error') useBuilds.getState().remove(s.sequenceId);
});
