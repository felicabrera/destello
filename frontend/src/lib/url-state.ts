// URL contract (docs/06 section 5). All URL state goes through this module.
// Unknown or out-of-range values fall back to the default silently. Epochs are 1-based in the URL.
import {
  DETECTORS,
  FOVS,
  FPS_VALUES,
  MODES,
  OVERLAYS,
  TABS,
  type DetectorNum,
  type DetectorSel,
  type Fov,
  type Fps,
  type Lang,
  type Mode,
  type OverlayKey,
  type TabKey,
} from './types';
import { SURPRISE_IDS } from './surprise';

export const PRESET_IDS = ['barnard', 'wise0855', 'epsindib', 'rwaur', 'rdra'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export type EmbedControls = 'full' | 'minimal' | 'none';
export type EmbedTheme = 'dark' | 'light';

export interface ViewSearch {
  ra?: string;
  dec?: string;
  name?: string;
  /** F-28: a field from the curated "Surprise me" list (lib/surprise.ts). */
  pick?: string;
  fov?: Fov;
  det?: DetectorSel;
  mode?: Mode;
  ref?: number;
  frame?: number;
  rgb?: [DetectorNum, DetectorNum, DetectorNum];
  /** F-23 track mode: recenter every epoch on the predicted position of a known mover. */
  track?: 1;
  /** F-29: candidates to review, listed and marked on the difference image. */
  cand?: 1;
  fps?: Fps;
  play?: 0 | 1;
  ov?: OverlayKey[];
  tab?: TabKey;
  release?: string;
  /** F-31: also show short revisits as low coverage epochs (never used in measurements). */
  partial?: 1;
  lang?: Lang;
  seq?: string;
  // Embed only
  target?: string;
  controls?: EmbedControls;
  theme?: EmbedTheme;
}

export interface ViewDefaults {
  fov: number;
  det: DetectorSel;
  play: 0 | 1;
  lang: Lang;
  /** Default panel tab (R Draconis and RW Aurigae open Spectrum). */
  tab?: TabKey;
}

export const BASE_DEFAULTS: ViewDefaults = { fov: 6, det: 'all', play: 1, lang: 'en' };

export function parseSearch(search: string): Record<string, string> {
  const out: Record<string, string> = {};
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  p.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

export function stringifySearch(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString().replace(/%2C/gi, ',').replace(/\+/g, '%20');
  return s ? `?${s}` : '';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
function oneOf<T extends string | number>(list: readonly T[], v: unknown): T | undefined {
  const n = typeof v === 'string' ? (list.some((x) => typeof x === 'number') ? Number(v) : v) : v;
  return list.find((x) => x === n);
}
function epoch(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : undefined;
}

export function validateSearch(raw: Record<string, unknown>): ViewSearch {
  const out: ViewSearch = {};
  const ra = str(raw.ra);
  const dec = str(raw.dec);
  if (ra && dec) {
    out.ra = ra;
    out.dec = dec;
  }
  const name = str(raw.name);
  if (name) out.name = name.slice(0, 120);
  const pick = str(raw.pick);
  if (pick && SURPRISE_IDS.includes(pick)) out.pick = pick;
  const fov = oneOf(FOVS, raw.fov);
  if (fov) out.fov = fov;
  if (raw.det === 'all') out.det = 'all';
  else {
    const d = oneOf(DETECTORS, raw.det);
    if (d) out.det = d;
  }
  const mode = oneOf(MODES, raw.mode);
  if (mode) out.mode = mode;
  const ref = epoch(raw.ref);
  if (ref) out.ref = ref;
  const frame = epoch(raw.frame);
  if (frame) out.frame = frame;
  if (typeof raw.rgb === 'string') {
    const t = raw.rgb.split(',').map(Number);
    if (t.length === 3 && t.every((x) => DETECTORS.includes(x as DetectorNum)) && new Set(t).size === 3) {
      out.rgb = t as [DetectorNum, DetectorNum, DetectorNum];
    }
  }
  if (raw.track === '1' || raw.track === 1) out.track = 1;
  if (raw.cand === '1' || raw.cand === 1) out.cand = 1;
  const fps = oneOf(FPS_VALUES, raw.fps);
  if (fps) out.fps = fps;
  if (raw.play === '0' || raw.play === 0) out.play = 0;
  else if (raw.play === '1' || raw.play === 1) out.play = 1;
  if (typeof raw.ov === 'string') {
    const list = raw.ov
      .split(',')
      .filter((x): x is OverlayKey => (OVERLAYS as readonly string[]).includes(x));
    const uniq = OVERLAYS.filter((o) => list.includes(o));
    if (uniq.length) out.ov = uniq;
  }
  const tab = oneOf(TABS, raw.tab);
  if (tab) out.tab = tab;
  const release = str(raw.release);
  if (release && /^[A-Za-z0-9_.-]{1,64}$/.test(release)) out.release = release;
  if (raw.partial === '1' || raw.partial === 1) out.partial = 1;
  if (raw.lang === 'en' || raw.lang === 'es') out.lang = raw.lang;
  const seq = str(raw.seq);
  if (seq && /^[0-9a-f]{16}$/.test(seq)) out.seq = seq;
  const target = str(raw.target);
  if (target && (PRESET_IDS as readonly string[]).includes(target)) out.target = target;
  if (raw.controls === 'full' || raw.controls === 'minimal' || raw.controls === 'none')
    out.controls = raw.controls;
  if (raw.theme === 'dark' || raw.theme === 'light') out.theme = raw.theme;
  return out;
}

/** Remove parameters that equal their default so URLs stay short and canonical. */
export function omitDefaults(s: ViewSearch, d: ViewDefaults = BASE_DEFAULTS): ViewSearch {
  const o: ViewSearch = { ...s };
  if (o.fov === d.fov) delete o.fov;
  if (o.det === d.det) delete o.det;
  if (o.mode === 'blink') delete o.mode;
  if (o.ref === 1) delete o.ref;
  if (o.frame === 1) delete o.frame;
  if (o.fps === 2) delete o.fps;
  if (o.play === d.play) delete o.play;
  if (o.tab === (d.tab ?? 'info')) delete o.tab;
  if (o.ov && o.ov.length === 0) delete o.ov;
  // `lang` is kept when explicitly set so shared links reproduce the language (F-16).
  if (o.mode !== 'rgb') delete o.rgb;
  if (o.mode !== 'diff') delete o.ref;
  return o;
}

const KEY_ORDER: (keyof ViewSearch)[] = [
  'ra',
  'dec',
  'name',
  'pick',
  'target',
  'seq',
  'release',
  'partial',
  'fov',
  'det',
  'mode',
  'ref',
  'frame',
  'rgb',
  'track',
  'cand',
  'fps',
  'play',
  'ov',
  'tab',
  'controls',
  'theme',
  'lang',
];

export function searchToString(s: ViewSearch): string {
  const ordered: Record<string, unknown> = {};
  for (const k of KEY_ORDER) if (s[k] !== undefined) ordered[k] = s[k];
  return stringifySearch(ordered);
}

export function buildPath(target: string | undefined, s: ViewSearch, d?: ViewDefaults): string {
  const path = target ? `/t/${target}` : '/';
  return path + searchToString(omitDefaults(s, d));
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

export function browserLang(): Lang {
  const stored = (() => {
    try {
      return localStorage.getItem('destello.lang');
    } catch {
      return null;
    }
  })();
  if (stored === 'en' || stored === 'es') return stored;
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('es') ? 'es' : 'en';
}
