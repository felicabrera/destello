// Backend availability: live API, development fixtures, or static demo host. Re-probed periodically so the app
// switches to the real backend as soon as GET /api/v1/health answers.
import { create } from 'zustand';
import { API_BASE, DEMO_BASE, getHealth, setBackendMode, type BackendMode } from './api';
import type { Health } from './types';

interface BackendState {
  mode: BackendMode;
  health: Health | null;
  /** True once the first probe finished. */
  probed: boolean;
  /** Incremented every time the mode changes, so data hooks refetch. */
  generation: number;
  probe: () => Promise<void>;
}

/** Development-only simulation switch, e.g. ?fx=demo. Ignored in production builds. */
export function fixtureFlag(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('fx') ?? sessionStorage.getItem('destello.fx');
}

export const useBackend = create<BackendState>((set, get) => ({
  mode: 'unknown',
  health: null,
  probed: false,
  generation: 0,
  probe: async () => {
    const prev = get().mode;
    let mode: BackendMode;
    let health: Health | null = null;
    try {
      // Development only: ask the dev server whether the backend is listening, so a stopped backend does not
      // fill the console with proxy errors.
      if (import.meta.env.DEV) {
        // fx=fixtures (or sessionStorage destello.fx) forces the fixtures even when a backend is listening.
        if (sessionStorage.getItem('destello.fx') === 'fixtures' || fixtureFlag() === 'fixtures')
          throw new Error('fixtures forced');
        // fx=demo-bundle: behave as in production with the API down, reading the static bundle at DEMO_BASE.
        if (fixtureFlag() === 'demo-bundle') throw new Error('demo bundle forced');
        const up = await fetch('/__backend_up')
          .then((r) => r.json() as Promise<{ up: boolean }>)
          .catch(() => ({ up: false }));
        if (!up.up) throw new Error('backend down');
      }
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(`${API_BASE}/health`, {
        signal: ctl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`health ${res.status}`);
      health = (await res.json()) as Health;
      mode = 'live';
    } catch {
      if (import.meta.env.DEV && fixtureFlag() !== 'demo-bundle') mode = 'fixture';
      else {
        // Production: fall back to the static demo build when it is bundled or configured (F-18).
        const demoOk = await fetch(`${DEMO_BASE}/health.json`, { headers: { Accept: 'application/json' } })
          .then((r) => r.ok && (r.headers.get('content-type') ?? '').includes('json'))
          .catch(() => false);
        mode = demoOk ? 'demo' : 'unknown';
      }
    }
    if (mode === 'fixture' || mode === 'demo') {
      setBackendMode(mode);
      try {
        health = await getHealth();
      } catch {
        health = null;
      }
    } else {
      setBackendMode(mode);
    }
    set((s) => ({ mode, health, probed: true, generation: prev === mode ? s.generation : s.generation + 1 }));
  },
}));

let timer: ReturnType<typeof setInterval> | null = null;
export function startBackendProbe(): void {
  void useBackend.getState().probe();
  if (timer) return;
  timer = setInterval(() => {
    const s = useBackend.getState();
    if (s.mode !== 'live') void s.probe();
  }, 8000);
}

/** True when the UI should show the demo banner and disable free search. */
export function isDemo(mode: BackendMode): boolean {
  return mode === 'demo' || fixtureFlag() === 'demo';
}
