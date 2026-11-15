// URL-backed view state. Control changes replace history; a target change pushes (docs/06 section 5).
import { useCallback, useMemo } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getTargets, getReleases } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import {
  BASE_DEFAULTS,
  browserLang,
  buildPath,
  parseSearch,
  prefersReducedMotion,
  validateSearch,
  type ViewDefaults,
  type ViewSearch,
} from '../../lib/url-state';
import { presetStatic, isPresetId } from '../../lib/presets';
import type { DetectorSel, Lang, TabKey, TargetItem } from '../../lib/types';
import { DETECTORS, type DetectorNum } from '../../lib/types';

export function useTargets() {
  const gen = useBackend((s) => s.generation);
  const probed = useBackend((s) => s.probed);
  return useQuery({
    queryKey: ['targets', gen],
    queryFn: getTargets,
    enabled: probed,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useReleases() {
  const gen = useBackend((s) => s.generation);
  const probed = useBackend((s) => s.probed);
  return useQuery({
    queryKey: ['releases', gen],
    queryFn: getReleases,
    enabled: probed,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function targetDefaultDet(t: TargetItem | undefined, id: string | undefined): DetectorSel {
  const d = t?.default_view?.det;
  if (d === 'all') return 'all';
  if (typeof d === 'number' && DETECTORS.includes(d as DetectorNum)) return d as DetectorNum;
  if (typeof d === 'string' && /^\d$/.test(d) && DETECTORS.includes(Number(d) as DetectorNum))
    return Number(d) as DetectorNum;
  return (id ? presetStatic(id)?.det : undefined) ?? 'all';
}

/** Panel opened by default: from the API (default_view.panel), falling back to the preset policy (F-19). */
export function defaultPanel(t: TargetItem | undefined, id: string | undefined): TabKey {
  const p = t?.default_view?.panel;
  if (p === 'spectrum' || p === 'measure' || p === 'context' || p === 'info') return p;
  return id === 'rdra' || id === 'rwaur' ? 'spectrum' : 'info';
}

export interface View extends Required<Pick<ViewSearch, 'mode' | 'ref' | 'frame' | 'fps' | 'tab' | 'lang'>> {
  fov: number;
  det: DetectorSel;
  play: 0 | 1;
  ov: NonNullable<ViewSearch['ov']>;
  ra?: string;
  dec?: string;
  name?: string;
  pick?: string;
  seq?: string;
  release?: string;
  /** F-31: short revisits shown as low coverage epochs. */
  partial: boolean;
  rgb?: ViewSearch['rgb'];
  track: boolean;
  /** F-29: the candidates toggle. */
  cand: boolean;
  controls?: ViewSearch['controls'];
  theme?: ViewSearch['theme'];
}

export function useView() {
  const router = useRouter();
  const loc = useRouterState({ select: (s) => s.location });
  const targets = useTargets().data;

  const search = useMemo(() => validateSearch(parseSearch(loc.searchStr ?? '')), [loc.searchStr]);
  const pathMatch = /^\/t\/([^/]+)/.exec(loc.pathname);
  const rawTarget = pathMatch ? decodeURIComponent(pathMatch[1]) : search.target;
  const targetId = isPresetId(rawTarget) ? rawTarget : undefined;
  const targetItem = targets?.find((t) => t.id === targetId);

  // First visit (no target, position, name, pick or sequence) shows Barnard's Star, so its defaults apply.
  const blank = !targetId && !search.ra && !search.name && !search.pick && !search.seq;
  const defaultItem = targetItem ?? (blank ? targets?.find((t) => t.id === 'barnard') : undefined);
  const defaultId = targetId ?? (blank ? 'barnard' : undefined);

  const defaults: ViewDefaults = useMemo(() => {
    const fov = defaultItem?.default_view?.fov_arcmin ?? BASE_DEFAULTS.fov;
    return {
      fov,
      det: targetDefaultDet(defaultItem, defaultId),
      play: prefersReducedMotion() ? 0 : 1,
      lang: browserLang(),
      tab: defaultPanel(defaultItem, defaultId),
    };
  }, [defaultItem, defaultId]);

  const view: View = useMemo(
    () => ({
      mode: search.mode ?? 'blink',
      ref: search.ref ?? 1,
      frame: search.frame ?? 1,
      fps: search.fps ?? 2,
      tab: search.tab ?? defaults.tab ?? 'info',
      lang: search.lang ?? defaults.lang,
      fov: search.fov ?? defaults.fov,
      det: search.det ?? defaults.det,
      play: search.play ?? defaults.play,
      ov: search.ov ?? [],
      ra: search.ra,
      dec: search.dec,
      name: search.name,
      pick: search.pick,
      seq: search.seq,
      release: search.release,
      partial: search.partial === 1,
      rgb: search.rgb,
      track: search.track === 1,
      cand: search.cand === 1,
      controls: search.controls,
      theme: search.theme,
    }),
    [search, defaults],
  );

  const go = useCallback(
    (path: string, push: boolean) => {
      const current = router.history.location.pathname + router.history.location.search;
      if (path === current) return;
      if (push) router.history.push(path);
      else router.history.replace(path);
    },
    [router],
  );

  /** Update view parameters. Replaces history unless `push` is set. */
  const update = useCallback(
    (patch: Partial<ViewSearch>, opts: { push?: boolean } = {}) => {
      const next: ViewSearch = { ...search, ...patch };
      for (const k of Object.keys(patch) as (keyof ViewSearch)[]) if (patch[k] === undefined) delete next[k];
      const built = buildPath(pathMatch ? (targetId ?? rawTarget) : undefined, next, defaults);
      // Off the /t/ routes (the embed, the validation page) the current page is kept: only its query changes.
      go(pathMatch ? built : loc.pathname + built.slice(1), !!opts.push);
    },
    [search, defaults, go, pathMatch, targetId, rawTarget, loc.pathname],
  );

  /** Open a preset: pushes a new history entry and keeps language. */
  const openPreset = useCallback(
    (id: string) => {
      const keep: ViewSearch = { lang: search.lang };
      go(buildPath(id, keep), true);
    },
    [go, search.lang],
  );

  /** Open an arbitrary position or name: pushes a new entry. */
  const openPath = useCallback((path: string) => go(path, true), [go]);

  /** F-28: open a curated "Surprise me" field. Pushes a new entry and keeps language. */
  const openPick = useCallback(
    (id: string) => {
      const keep: ViewSearch = { lang: search.lang, pick: id };
      go(buildPath(undefined, keep), true);
    },
    [go, search.lang],
  );

  const pagePath = useMemo(
    () => buildPath(pathMatch ? (targetId ?? rawTarget) : undefined, search, defaults),
    [search, defaults, pathMatch, targetId, rawTarget],
  );

  const setLang = useCallback(
    (lang: Lang) => {
      try {
        localStorage.setItem('destello.lang', lang);
      } catch {
        /* storage unavailable */
      }
      update({ lang });
    },
    [update],
  );

  return {
    view,
    search,
    targetId,
    targetItem,
    targets,
    defaults,
    update,
    openPreset,
    openPath,
    openPick,
    pagePath,
    setLang,
    pathname: loc.pathname,
  };
}
