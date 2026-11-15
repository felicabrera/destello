// Produces one drawable bitmap per epoch for the current mode and detector, preloaded before playback.
import { useEffect, useMemo, useState } from 'react';
import { getDifference } from '../../lib/api';
import { loadBitmap, meanBitmap, rgbBitmap } from '../../lib/bitmaps';
import {
  frameDetector,
  type DetectorSel,
  type EpochInfo,
  type FrameInfo,
  type Mode,
  type RgbTriple,
} from '../../lib/types';

export interface DisplayItem {
  bitmap: ImageBitmap | null;
  frame: FrameInfo | null;
  /** True when the detector has no frame in this epoch. */
  missing: boolean;
  /** True in diff mode when this epoch is the reference. */
  atReference: boolean;
  /**
   * Difference modes: manifest index of the epoch subtracted from this one, or null when no epoch with a frame in
   * this detector can be subtracted (the reference, or every earlier epoch in Diff seq, has no frame here).
   */
  pair?: number | null;
  diff?: { scale: number; stars: number };
  failed?: boolean;
}

export interface DisplayFrames {
  items: DisplayItem[];
  /** Number of bitmaps ready out of those required. */
  loaded: number;
  required: number;
  ready: boolean;
  /** Flag masks keyed by flags_url; null when that mask could not be loaded. */
  masks: Map<string, ImageBitmap | null>;
}

export function frameFor(epoch: EpochInfo | undefined, det: DetectorSel): FrameInfo | null {
  if (!epoch) return null;
  const candidates = epoch.frames.filter((f) => frameDetector(f) === det);
  return candidates.find((f) => f.kind === 'coadd') ?? candidates[0] ?? null;
}

/**
 * Manifest index of the epoch subtracted from the epoch at position `pos`, or null when there is none.
 * Diff: the reference epoch, when it has a frame in this detector. Diff seq: the closest earlier epoch with a frame
 * in this detector, so a short revisit that did not observe the detector is skipped, never filled in (F-31).
 * `ref` is the manifest index of the reference epoch.
 */
export function pairEpoch(
  epochs: EpochInfo[],
  pos: number,
  det: DetectorSel,
  mode: 'diff' | 'diffseq',
  ref: number,
): number | null {
  const e = epochs[pos];
  if (!e) return null;
  if (mode === 'diff') {
    if (e.index === ref) return null;
    return frameFor(
      epochs.find((x) => x.index === ref),
      det,
    )
      ? ref
      : null;
  }
  for (let i = pos - 1; i >= 0; i--) if (frameFor(epochs[i], det)) return epochs[i].index;
  return null;
}

interface Args {
  epochs: EpochInfo[];
  det: DetectorSel;
  mode: Mode;
  /** Manifest index of the reference epoch for diff. */
  ref: number;
  sequenceId: string | null;
  /** Differences need the finished manifest; blink can run on partial epochs. */
  complete: boolean;
  wantFlags: boolean;
  /** Detectors of the color composite (red, green, blue); used in rgb mode only. */
  rgb: RgbTriple;
}

const EMPTY: DisplayFrames = { items: [], loaded: 0, required: 0, ready: false, masks: new Map() };

export function useDisplayFrames({
  epochs,
  det,
  mode,
  ref,
  sequenceId,
  complete,
  wantFlags,
  rgb,
}: Args): DisplayFrames {
  const [state, setState] = useState<DisplayFrames>(EMPTY);
  const [masks, setMasks] = useState<Map<string, ImageBitmap | null>>(new Map());

  // A stable signature of what must be loaded.
  const sig = useMemo(
    () =>
      `${mode}|${det}|${ref}|${sequenceId ?? ''}|${complete ? 1 : 0}|${mode === 'rgb' ? rgb.join('') : ''}|` +
      epochs
        .map((e) =>
          mode === 'rgb'
            ? `${e.index}:${rgb.map((d) => (frameFor(e, d) ? 1 : 0)).join('')}`
            : `${e.index}:${frameFor(e, det)?.url ?? 'x'}`,
        )
        .join(','),
    [mode, det, ref, sequenceId, complete, epochs, rgb],
  );

  useEffect(() => {
    let alive = true;
    // Composites made here (rgb, stack) are not in the bitmap cache: they are closed when replaced, so GPU
    // memory does not pile up on mode switches. Closing waits a moment so a pending draw never meets a closed one.
    const owned: ImageBitmap[] = [];
    const own = (b: ImageBitmap | null): ImageBitmap | null => {
      if (b && !alive) b.close();
      else if (b) owned.push(b);
      return alive ? b : null;
    };
    const isDiff = mode === 'diff' || mode === 'diffseq';
    const base: DisplayItem[] = epochs.map((e, i) => {
      // In rgb mode the item carries the first available channel frame for its time metadata.
      const f = mode === 'rgb' ? (rgb.map((d) => frameFor(e, d)).find((x) => x) ?? null) : frameFor(e, det);
      return {
        bitmap: null,
        frame: f,
        missing: f === null,
        atReference: mode === 'diff' && e.index === ref,
        ...(isDiff ? { pair: pairEpoch(epochs, i, det, mode, ref) } : {}),
      };
    });
    setState({ items: base, loaded: 0, required: 0, ready: false, masks: new Map() });

    const patch = (idx: number, item: Partial<DisplayItem>, doneInc = 1) => {
      if (!alive) return;
      setState((s) => {
        const items = s.items.slice();
        items[idx] = { ...items[idx], ...item };
        const loaded = s.loaded + doneInc;
        return { ...s, items, loaded, ready: s.required > 0 && loaded >= s.required };
      });
    };

    void (async () => {
      if (mode === 'blink') {
        const todo = base.map((b, i) => ({ b, i })).filter((x) => x.b.frame);
        if (alive) setState((s) => ({ ...s, required: todo.length, ready: todo.length === 0 }));
        await Promise.all(
          todo.map(async ({ b, i }) => {
            try {
              patch(i, { bitmap: await loadBitmap((b.frame as FrameInfo).url) });
            } catch {
              patch(i, { failed: true });
            }
          }),
        );
        return;
      }
      if (mode === 'rgb') {
        const todo = base.map((b, i) => ({ b, i })).filter((x) => x.b.frame);
        if (alive) setState((s) => ({ ...s, required: todo.length, ready: todo.length === 0 }));
        await Promise.all(
          todo.map(async ({ i }) => {
            try {
              const channels = await Promise.all(
                rgb.map((d) => {
                  const f = frameFor(epochs[i], d);
                  return f ? loadBitmap(f.url) : Promise.resolve(null);
                }),
              );
              patch(i, { bitmap: own(await rgbBitmap(channels)) });
            } catch {
              patch(i, { failed: true });
            }
          }),
        );
        return;
      }
      if (mode === 'stack') {
        const frames = base.filter((b) => b.frame);
        if (alive) setState((s) => ({ ...s, required: 1, ready: false }));
        try {
          const bms = await Promise.all(frames.map((b) => loadBitmap((b.frame as FrameInfo).url)));
          const mean = own(await meanBitmap(bms));
          if (!alive) return;
          setState((s) => ({
            ...s,
            items: s.items.map((it) => ({ ...it, bitmap: mean, missing: false })),
            loaded: 1,
            ready: true,
          }));
        } catch {
          patch(0, { failed: true });
        }
        return;
      }
      // diff and diffseq: pairs of manifest epochs, computed by the server on demand.
      if (!sequenceId || !complete) {
        if (alive) setState((s) => ({ ...s, required: 0, ready: false }));
        return;
      }
      const detNum = det === 'all' ? 0 : det;
      // Only epochs with a frame in this detector and an epoch to subtract that also has one: the server answers
      // 404 for a detector an epoch did not observe (F-31 short revisits).
      const pairs = base
        .map((b, i) => ({ i, a: epochs[i].index, b: b.pair ?? null }))
        .filter((p): p is { i: number; a: number; b: number } => p.b !== null && !!base[p.i].frame);
      if (alive) setState((s) => ({ ...s, required: pairs.length, ready: pairs.length === 0 }));
      await Promise.all(
        pairs.map(async (p) => {
          try {
            const d = await getDifference(sequenceId, p.a, p.b, detNum);
            const bm = await loadBitmap(d.url);
            patch(p.i, { bitmap: bm, diff: { scale: d.scale, stars: d.n_stars_used } });
          } catch {
            patch(p.i, { failed: true });
          }
        }),
      );
    })();

    return () => {
      alive = false;
      if (owned.length) setTimeout(() => owned.forEach((b) => b.close()), 1000);
    };
    // sig captures every input that changes what is loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Masks belong to one sequence: the map starts empty for the next one instead of growing.
  useEffect(() => setMasks(new Map()), [sequenceId]);

  // Flag masks are optional and loaded only while the overlay is on.
  useEffect(() => {
    if (!wantFlags) return;
    let alive = true;
    void (async () => {
      const urls = epochs.map((e) => frameFor(e, det)?.flags_url).filter((u): u is string => !!u);
      await Promise.all(
        urls.map(async (url) => {
          let bmp: ImageBitmap | null = null;
          try {
            bmp = await loadBitmap(url);
          } catch {
            /* mask unavailable for this frame */
          }
          // Each mask is published as soon as it is decoded, so the current frame does not wait for all.
          if (alive) setMasks((prev) => (prev.has(url) ? prev : new Map(prev).set(url, bmp)));
        }),
      );
    })();
    return () => {
      alive = false;
    };
  }, [wantFlags, det, epochs]);

  return { ...state, masks };
}
