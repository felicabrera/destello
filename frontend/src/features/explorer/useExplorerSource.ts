// Decides what to show from the URL: preset, coordinates, a resolved name, a stored sequence, or the first-visit default.
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, resolveName } from '../../lib/api';
import { totalPm } from '../../lib/astrometry';
import { parseCoordinates, separationDeg } from '../../lib/coords';
import { matchPresets, PRESETS } from '../../lib/presets';
import type { Lang, Resolved, TargetItem } from '../../lib/types';
import type { SeqSource } from '../../store/sequence';
import { useBackend } from '../../lib/backend';
import { surpriseCenter, surpriseField, type SurpriseField } from '../../lib/surprise';
import type { View } from './useView';

export interface Astro {
  name: string;
  ra: number;
  dec: number;
  ref_epoch: string | null;
  pmra: number | null;
  pmdec: number | null;
  /** Catalog parallax (mas), when known: drives the predicted path (F-27). */
  parallax: number | null;
  presetId?: string;
}

export type SourceState =
  | { status: 'empty' }
  | { status: 'loading' }
  | { status: 'error'; code: string }
  | {
      status: 'ready';
      source: SeqSource;
      astro: Astro | null;
      presetId?: string;
      center: { ra: number; dec: number };
      firstVisit: boolean;
      /** F-28: id of the curated field when the view came from "Surprise me". */
      pickId?: string;
    };

interface Args {
  view: View;
  targetId: string | undefined;
  targetItem: TargetItem | undefined;
  targets: TargetItem[] | undefined;
  targetsLoading: boolean;
  targetsError: boolean;
  openPresetReplace: (id: string) => void;
  lang: Lang;
}

function presetAstro(t: TargetItem, lang: Lang): Astro {
  const a = t.astrometry;
  return {
    name: t.names[lang] ?? t.names.en,
    ra: a?.ra_deg ?? t.ra_deg,
    dec: a?.dec_deg ?? t.dec_deg,
    ref_epoch: a?.ref_epoch ?? null,
    pmra: a?.pmra_masyr ?? null,
    pmdec: a?.pmdec_masyr ?? null,
    parallax: a?.parallax_mas ?? null,
    presetId: t.id,
  };
}

function pickAstro(f: SurpriseField, name: string): Astro {
  return {
    name,
    ra: f.ra_deg,
    dec: f.dec_deg,
    ref_epoch: f.ref_epoch,
    pmra: f.pmra_masyr,
    pmdec: f.pmdec_masyr,
    parallax: f.parallax_mas,
  };
}

/** Radius within which typed coordinates are matched to a moving preset (about 15 years of WISE 0855 motion). */
export const MOVER_MATCH_RADIUS_ARCSEC = 120;
/** Minimum total proper motion (arcsec/yr) for a preset to count as a mover in that match. */
const MOVER_MIN_PM_ARCSEC_YR = 0.5;

/** Closest preset with catalog astrometry and high proper motion within the match radius, if any. */
export function nearbyMover(
  targets: TargetItem[] | undefined,
  ra: number,
  dec: number,
): TargetItem | undefined {
  let best: { t: TargetItem; sep: number } | undefined;
  for (const t of targets ?? []) {
    const a = t.astrometry;
    if (!a || !a.ref_epoch || totalPm(a) < MOVER_MIN_PM_ARCSEC_YR) continue;
    const sep = separationDeg(ra, dec, a.ra_deg ?? t.ra_deg, a.dec_deg ?? t.dec_deg) * 3600;
    if (sep <= MOVER_MATCH_RADIUS_ARCSEC && (!best || sep < best.sep)) best = { t, sep };
  }
  return best?.t;
}

export function useExplorerSource({
  view,
  targetId,
  targetItem,
  targets,
  targetsLoading,
  targetsError,
  openPresetReplace,
  lang,
}: Args): SourceState {
  const { t } = useTranslation();
  const gen = useBackend((s) => s.generation);
  const probed = useBackend((s) => s.probed);

  const names = useMemo(() => {
    const loc: Partial<Record<string, Record<Lang, string>>> = {};
    for (const p of PRESETS)
      loc[p.id] = {
        en: t(`presetCopy.${p.id}.name`, { lng: 'en' }),
        es: t(`presetCopy.${p.id}.name`, { lng: 'es' }),
      };
    return loc;
  }, [t]);

  const pastedCoords = useMemo(
    () => (view.ra && view.dec ? parseCoordinates(`${view.ra} ${view.dec}`) : null),
    [view.ra, view.dec],
  );
  const nameMatch = useMemo(() => {
    if (!view.name || targetId || pastedCoords) return undefined;
    return matchPresets(view.name, targets, names).find((m) => m.exact);
  }, [view.name, targetId, pastedCoords, targets, names]);

  const needResolve = !!view.name && !targetId && !pastedCoords && !nameMatch && !view.seq;
  const resolve = useQuery<Resolved, ApiError>({
    queryKey: ['resolve', view.name, gen],
    queryFn: () => resolveName(view.name as string),
    enabled: needResolve && probed,
    staleTime: 10 * 60_000,
    retry: false,
  });

  useEffect(() => {
    if (nameMatch && targets) openPresetReplace(nameMatch.id);
  }, [nameMatch, targets, openPresetReplace]);

  return useMemo<SourceState>(() => {
    const release = view.release;
    // F-31: only sent when on, so sources without it keep their existing keys and pinned sequences.
    const partial = view.partial ? { partial: true as const } : {};
    if (view.seq) {
      return {
        status: 'ready',
        source: { kind: 'seq', id: view.seq },
        astro: targetItem ? presetAstro(targetItem, lang) : null,
        presetId: targetId,
        center: { ra: targetItem?.ra_deg ?? 0, dec: targetItem?.dec_deg ?? 0 },
        firstVisit: false,
      };
    }
    if (targetId) {
      if (targetsLoading || !probed) return { status: 'loading' };
      if (!targetItem) return { status: 'error', code: targetsError ? 'NETWORK' : 'NOT_FOUND' };
      return {
        status: 'ready',
        source: { kind: 'preset', target: targetItem, fov: view.fov, release, ...partial },
        astro: presetAstro(targetItem, lang),
        presetId: targetId,
        center: { ra: targetItem.ra_deg, dec: targetItem.dec_deg },
        firstVisit: false,
      };
    }
    const pick = surpriseField(view.pick);
    if (pick) {
      if (!probed) return { status: 'loading' };
      // Catalog astrometry with a stated reference epoch: the centre is propagated to the survey span and the
      // player propagates the marker to every epoch (docs/00 non-negotiable 4).
      const c = surpriseCenter(pick);
      return {
        status: 'ready',
        source: { kind: 'coords', ra: c.ra, dec: c.dec, fov: view.fov, release, ...partial },
        astro: pickAstro(pick, t(`surprise.items.${pick.id}.name`)),
        center: c,
        firstVisit: false,
        pickId: pick.id,
      };
    }
    if (pastedCoords) {
      if (!probed) return { status: 'loading' };
      if (!pastedCoords.ok) return { status: 'error', code: 'INVALID_COORDINATES' };
      // Typed coordinates carry no epoch (docs/03 section 5, WISE 0855). When they fall next to a
      // high proper motion preset, its catalog astrometry drives the propagated marker and notice.
      const mover = nearbyMover(targets, pastedCoords.raDeg, pastedCoords.decDeg);
      return {
        status: 'ready',
        source: {
          kind: 'coords',
          ra: pastedCoords.raDeg,
          dec: pastedCoords.decDeg,
          fov: view.fov,
          release,
          ...partial,
        },
        astro: mover ? presetAstro(mover, lang) : null,
        center: { ra: pastedCoords.raDeg, dec: pastedCoords.decDeg },
        firstVisit: false,
      };
    }
    if (view.name) {
      if (nameMatch) return { status: 'loading' };
      if (resolve.isPending || !probed) return { status: 'loading' };
      if (resolve.isError)
        return {
          status: 'error',
          code:
            resolve.error instanceof ApiError && resolve.error.status === 404
              ? 'RESOLVE_FAILED'
              : ((resolve.error as ApiError).code ?? 'UNKNOWN'),
        };
      const r = resolve.data;
      const ra = r.propagated?.ra_deg ?? r.ra_deg;
      const dec = r.propagated?.dec_deg ?? r.dec_deg;
      return {
        status: 'ready',
        source: { kind: 'coords', ra, dec, fov: view.fov, release, ...partial },
        astro: {
          name: r.main_id.replace(/^NAME\s+/i, ''),
          ra: r.ra_deg,
          dec: r.dec_deg,
          ref_epoch: r.ref_epoch,
          pmra: r.pmra_masyr,
          pmdec: r.pmdec_masyr,
          parallax: r.parallax_mas,
        },
        center: { ra, dec },
        firstVisit: false,
      };
    }
    // First visit: Barnard's Star preset without changing the URL (docs/07 UX principle 1).
    if (targetsLoading || !probed) return { status: 'loading' };
    const barnard = targets?.find((x) => x.id === 'barnard');
    if (!barnard) return { status: 'empty' };
    return {
      status: 'ready',
      source: { kind: 'preset', target: barnard, fov: view.fov, release, ...partial },
      astro: presetAstro(barnard, lang),
      presetId: 'barnard',
      center: { ra: barnard.ra_deg, dec: barnard.dec_deg },
      firstVisit: true,
    };
  }, [
    view.seq,
    view.fov,
    view.release,
    view.partial,
    view.name,
    view.pick,
    targetId,
    targetItem,
    targets,
    targetsLoading,
    targetsError,
    probed,
    pastedCoords,
    nameMatch,
    resolve.isPending,
    resolve.isError,
    resolve.data,
    resolve.error,
    lang,
    t,
  ]);
}
