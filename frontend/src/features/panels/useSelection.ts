// The sky position that Spectrum and Measure work on: the clicked mark; when nothing is marked, the preset
// target or, in a view opened by coordinates, the searched position (field center).
import { useMemo } from 'react';
import { pixelToSky } from '../../lib/astrometry';
import type { useExplorer } from '../explorer/useExplorer';

type Model = ReturnType<typeof useExplorer>;

export interface Selection {
  ra_deg: number;
  dec_deg: number;
  /** Set only when the selection is the catalog target, so its motion is propagated to each epoch. */
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  ref_epoch: string | null;
  kind: 'target' | 'mark';
  /** Set when the selection is a preset target: the server matches it and applies its own catalog motion. */
  presetId: string | null;
  name: string | null;
  /** Stable key for queries. */
  key: string;
}

const NEAR_PX = 3;

export function useSelection(x: Model): Selection | null {
  const { grid, astro, ring, track } = x;
  const mark = x.ui.mark;
  return useMemo(() => {
    const asTarget = (): Selection | null =>
      astro
        ? {
            ra_deg: astro.ra,
            dec_deg: astro.dec,
            pmra_masyr: astro.pmra,
            pmdec_masyr: astro.pmdec,
            ref_epoch: astro.ref_epoch,
            kind: 'target',
            presetId: astro.presetId ?? null,
            name: astro.name,
            key: `t:${astro.ra.toFixed(6)}:${astro.dec.toFixed(6)}`,
          }
        : null;
    if (!grid) return null;
    // Nothing marked and no catalog target (a view opened by coordinates): the searched position,
    // which is the center of the field.
    const asCenter = (): Selection => ({
      ra_deg: grid.ra0,
      dec_deg: grid.dec0,
      pmra_masyr: null,
      pmdec_masyr: null,
      ref_epoch: null,
      kind: 'mark',
      presetId: null,
      name: null,
      key: `c:${grid.ra0.toFixed(6)}:${grid.dec0.toFixed(6)}`,
    });
    if (!mark) return asTarget() ?? asCenter();
    // A mark on the target (or on its track) means the target, with its motion.
    const near = [ring, ...(track ?? [])].some((p) => p && Math.hypot(p.x - mark.x, p.y - mark.y) <= NEAR_PX);
    if (near) {
      const t = asTarget();
      if (t) return t;
    }
    const sky = pixelToSky(grid, mark.x, mark.y);
    return {
      ra_deg: sky.ra,
      dec_deg: sky.dec,
      pmra_masyr: null,
      pmdec_masyr: null,
      ref_epoch: null,
      kind: 'mark',
      presetId: null,
      name: null,
      key: `m:${sky.ra.toFixed(6)}:${sky.dec.toFixed(6)}`,
    };
  }, [grid, astro, ring, track, mark]);
}

/** Motion parameters to send with a science request. A preset is identified by its position alone, so the server
 * applies its own verified astrometry (parallax included). Other targets send what the client knows. */
export function motionParams(sel: Selection): {
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  ref_epoch: string | null;
} {
  if (sel.presetId) return { pmra_masyr: null, pmdec_masyr: null, ref_epoch: null };
  return { pmra_masyr: sel.pmra_masyr, pmdec_masyr: sel.pmdec_masyr, ref_epoch: sel.ref_epoch };
}
