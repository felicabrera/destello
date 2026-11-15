// Shared model for the Explorer and the embed: source resolution, sequence build, frames, playback and overlays.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { withBroadbandBand } from '../../lib/format';
import { ApiError, getOverlay, getPath } from '../../lib/api';
import { meanBitmap } from '../../lib/bitmaps';
import { useBackend, isDemo } from '../../lib/backend';
import { apiRefEpoch, frameSize, propagate, skyToPixel, totalPm, type Grid } from '../../lib/astrometry';
import { epochMid } from '../../lib/format';
import { presetStatic } from '../../lib/presets';
import { prefersReducedMotion } from '../../lib/url-state';
import { shownDetector } from '../../lib/progressive';
import {
  DEFAULT_RGB,
  DETECTORS,
  FOVS,
  FPS_VALUES,
  OVERLAYS,
  frameDetector,
  isLowCoverage,
  type DetectorNum,
  type DetectorSel,
  type FrameInfo,
  type Fov,
  type Fps,
  type Lang,
  type Mode,
  type OverlayData,
  type OverlayCount,
  type OverlayKey,
  type RgbTriple,
} from '../../lib/types';
import { sourceKey, useSequence } from '../../store/sequence';
import { useUi } from '../../store/ui';
import type { PathScene, Pt, Scene } from '../player/draw';
import { frameFor, useDisplayFrames } from '../player/useDisplayFrames';
import { useCandidates } from '../candidates/useCandidates';
import { useMotionSearch } from '../motion/useMotionSearch';
import { useExplorerSource } from './useExplorerSource';
import { useTargets, useView } from './useView';

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** F-25: one frame of the export, drawn with drawScene at the export size. */
export type ExportScene = Omit<Scene, 'size' | 'dpr' | 'colors' | 'hover'> & {
  frame: FrameInfo | null;
  missing: boolean;
  atReference: boolean;
};

export function useExplorer() {
  const { t } = useTranslation();
  const v = useView();
  const { view, update, targetId, targetItem, targets } = v;
  const lang: Lang = view.lang;
  const tq = useTargets();
  const mode = useBackend((s) => s.mode);
  const health = useBackend((s) => s.health);
  const demo = isDemo(mode);
  const ui = useUi();
  const seq = useSequence();
  const reduced = prefersReducedMotion();

  const openPresetReplace = useCallback((id: string) => v.openPath(`/t/${id}`), [v]);
  const src = useExplorerSource({
    view,
    targetId,
    targetItem,
    targets,
    targetsLoading: tq.isPending && !tq.isError,
    targetsError: tq.isError,
    openPresetReplace,
    lang,
  });

  // Start (or keep) the sequence for the current source.
  const key = src.status === 'ready' ? sourceKey(src.source) : null;
  useEffect(() => {
    if (src.status === 'ready') seq.start(src.source, view.det === 'all' ? undefined : view.det);
    else if (src.status === 'empty' || src.status === 'error') seq.cancel();
    // `seq` actions are stable; the key identifies the source.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src.status]);

  // The broadband frame carries no wavelength range: derive the union from the detector frames of the epoch.
  const epochs = useMemo(() => seq.epochs.map(withBroadbandBand), [seq.epochs]);
  const nEpochs = epochs.length;
  const complete = seq.phase === 'ready';
  // While a build runs, the selected detector may not be published yet: show the first one that is.
  const det: DetectorSel = shownDetector(view.det, seq.phase === 'building', seq.detectorsReady, epochs);
  const fallbackDetector = det !== view.det && det !== 'all' ? det : null;
  const wantFlags = view.ov.includes('flags');
  const refIdx = Math.max(0, Math.min(view.ref - 1, Math.max(nEpochs - 1, 0)));
  const rgb: RgbTriple = view.rgb ?? DEFAULT_RGB;

  // F-23 track mode: only for a target with known proper motion, never on differences (computed on the sky grid).
  const astro = src.status === 'ready' ? src.astro : null;
  const pmTotal = astro ? totalPm({ pmra_masyr: astro.pmra, pmdec_masyr: astro.pmdec }) : 0;
  const isMover = pmTotal > 0.1 && epochs.length >= 2;
  const trackAvailable = isMover;
  const tracking = view.track && trackAvailable && view.mode !== 'diff' && view.mode !== 'diffseq';
  // The stack along the track is built here from the individual epoch frames, so those are loaded as in Blink.
  const trackStack = tracking && view.mode === 'stack';

  const display = useDisplayFrames({
    epochs,
    det,
    mode: trackStack ? 'blink' : view.mode,
    ref: epochs[refIdx]?.index ?? refIdx,
    sequenceId: seq.sequenceId,
    complete,
    wantFlags,
    rgb,
  });
  const items = display.items;

  // Playable epochs for the current mode.
  const playable = useMemo(() => {
    const out: number[] = [];
    items.forEach((it, i) => {
      if (view.mode === 'stack') return;
      if (it.missing) return;
      if (view.mode === 'diff' && it.atReference) return;
      // Difference modes: an epoch with nothing to subtract in this detector is not played (F-31).
      if ((view.mode === 'diff' || view.mode === 'diffseq') && it.pair == null) return;
      if (view.mode === 'diffseq' && i === 0) return;
      out.push(i);
    });
    return out;
  }, [items, view.mode]);

  // Reset per-sequence state when a new sequence starts.
  const sequenceKey = seq.key;
  const autoplayed = useRef<string | null>(null);
  useEffect(() => {
    ui.setPlaying(false);
    ui.setMark(null);
    ui.setFrame(Math.max(0, view.frame - 1));
    autoplayed.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sequenceKey]);

  const frameIdx = Math.max(0, Math.min(ui.frame, Math.max(nEpochs - 1, 0)));
  const frameIdxRef = useRef(frameIdx);
  frameIdxRef.current = frameIdx;

  const canPlay = display.ready && playable.length >= 2 && view.mode !== 'stack';

  // Keep the shown epoch inside the playable set when the mode changes.
  useEffect(() => {
    if (!display.ready || playable.length === 0) return;
    if (!playable.includes(frameIdxRef.current) && view.mode !== 'blink') ui.setFrame(playable[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.mode, display.ready, playable.join(',')]);

  // The URL frame is written once the user stops stepping: a held arrow key would otherwise call
  // history.replaceState on every step and hit the browsers' rate limits. The store holds the live frame.
  const updateRef = useRef(update);
  updateRef.current = update;
  const frameUrlTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(frameUrlTimer.current), []);
  const setFrameFromUser = useCallback(
    (i: number) => {
      const c = Math.max(0, Math.min(i, nEpochs - 1));
      ui.setFrame(c);
      clearTimeout(frameUrlTimer.current);
      frameUrlTimer.current = setTimeout(() => updateRef.current({ frame: frameIdxRef.current + 1 }), 250);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nEpochs],
  );

  const step = useCallback(
    (delta: number) => {
      if (playable.length === 0) return;
      const cur = playable.indexOf(frameIdxRef.current);
      let next = cur === -1 ? (delta > 0 ? 0 : playable.length - 1) : cur + delta;
      const wrap = useUi.getState().loop;
      if (next < 0) next = wrap ? playable.length - 1 : 0;
      if (next >= playable.length) next = wrap ? 0 : playable.length - 1;
      setFrameFromUser(playable[next]);
    },
    [playable, setFrameFromUser],
  );

  // Autoplay once per sequence when everything is preloaded (never under reduced motion).
  useEffect(() => {
    if (!canPlay || autoplayed.current === sequenceKey) return;
    autoplayed.current = sequenceKey;
    if (view.play === 1 && !reduced && view.mode === 'blink') ui.setPlaying(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canPlay, sequenceKey]);

  // F-29 candidates to review for the pair shown in a difference mode.
  // Diff seq subtracts the closest earlier epoch with a frame in this detector (F-31): candidates follow it.
  const shownPair = items[frameIdx]?.pair;
  const prevPos = shownPair == null ? undefined : epochs.findIndex((e) => e.index === shownPair);
  const cand = useCandidates({
    on: view.cand,
    mode: view.mode,
    epochs,
    frameIdx,
    refIdx,
    prevPos: prevPos !== undefined && prevPos >= 0 ? prevPos : undefined,
    sequenceId: seq.sequenceId,
    complete,
    backendMode: mode,
  });
  const setCand = useCallback((on: boolean) => update({ cand: on ? 1 : undefined }), [update]);

  // F-32 motion search over the full coverage epochs, started by the user. Tracks are drawn on sky frames only;
  // the square at the shown epoch only when a single epoch is on screen.
  const singleEpochShown = view.mode === 'blink' && !trackStack;
  const motion = useMotionSearch({
    sequenceId: seq.sequenceId,
    complete,
    backendMode: mode,
    epochIndex: singleEpochShown ? (epochs[frameIdx]?.index ?? null) : null,
    showTracks: view.mode !== 'diff' && view.mode !== 'diffseq',
  });

  // Playback tick.
  const fps = view.fps;
  useEffect(() => {
    if (!ui.playing || !canPlay) return;
    const id = setInterval(() => {
      const cur = playable.indexOf(frameIdxRef.current);
      let next = cur + 1;
      if (next >= playable.length) {
        if (!useUi.getState().loop) {
          useUi.getState().setPlaying(false);
          return;
        }
        next = 0;
      }
      useUi.getState().setFrame(playable[next]);
    }, 1000 / fps);
    return () => clearInterval(id);
  }, [ui.playing, canPlay, fps, playable]);

  const setPlaying = useCallback(
    (p: boolean) => {
      if (p && !canPlay) return;
      ui.setPlaying(p);
      if (!p) update({ frame: frameIdxRef.current + 1 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canPlay, update],
  );

  // Panels never pause playback; the mobile sheet at full height does (handled by the layout).

  // Overlays
  const overlayCatalogs: Record<'gaia' | 'catwise', 'gaia_dr3' | 'catwise2020'> = {
    gaia: 'gaia_dr3',
    catwise: 'catwise2020',
  };
  const ovQueries = useQueries({
    queries: (['gaia', 'catwise'] as const).map((k) => ({
      queryKey: ['overlay', seq.sequenceId, k, mode],
      queryFn: () => getOverlay(seq.sequenceId as string, overlayCatalogs[k]),
      enabled: complete && !!seq.sequenceId && view.ov.includes(k),
      staleTime: Infinity,
      retry: false,
    })),
  });
  const overlayData: Record<'gaia' | 'catwise', OverlayData | undefined> = {
    gaia: ovQueries[0].data,
    catwise: ovQueries[1].data,
  };
  const sourcesAt = (k: 'gaia' | 'catwise', epochIndex: number) =>
    overlayData[k]?.epochs.find((e) => e.index === epochIndex)?.sources ?? null;
  const epochAtFrame = epochs[frameIdx];
  const gaiaNow = view.ov.includes('gaia') ? sourcesAt('gaia', epochAtFrame?.index ?? 0) : null;
  const catwiseNow = view.ov.includes('catwise') ? sourcesAt('catwise', epochAtFrame?.index ?? 0) : null;
  const maskFrame = frameFor(epochAtFrame, det);
  const maskUrl = maskFrame?.flags_url ?? null;
  const maskEntry = maskUrl ? display.masks.get(maskUrl) : undefined;
  const overlayCounts: Partial<Record<OverlayKey, OverlayCount>> = {
    gaia: ovQueries[0].isError
      ? ovQueries[0].error instanceof ApiError && ovQueries[0].error.code === 'CATALOG_UNAVAILABLE'
        ? 'unavailable'
        : 'failed'
      : ovQueries[0].isFetching || !complete
        ? 'loading'
        : gaiaNow
          ? gaiaNow.length
          : 'none',
    catwise: ovQueries[1].isError
      ? ovQueries[1].error instanceof ApiError && ovQueries[1].error.code === 'CATALOG_UNAVAILABLE'
        ? 'unavailable'
        : 'failed'
      : ovQueries[1].isFetching || !complete
        ? 'loading'
        : catwiseNow
          ? catwiseNow.length
          : 'none',
    flags: !maskUrl ? 'none' : maskEntry === undefined ? 'loading' : maskEntry === null ? 'none' : 'ready',
  };
  const mask = wantFlags ? (maskEntry ?? null) : null;
  // Legend content for the flags overlay: names come from the manifest (FLAGS headers), never from the client.
  const flagLegend = {
    names: maskFrame?.mask_flags ?? null,
    fraction: maskFrame?.flagged_fraction ?? null,
  };

  // Grid, target ring and motion track (epoch-correct positions).
  const firstBitmap = items.find((i) => i.bitmap)?.bitmap;
  const centerRa = seq.manifest?.grid.crval_deg[0] ?? (src.status === 'ready' ? src.center.ra : 0);
  const centerDec = seq.manifest?.grid.crval_deg[1] ?? (src.status === 'ready' ? src.center.dec : 0);
  const scaleArcsec = seq.manifest?.grid.pixel_scale_arcsec ?? 3.1;
  const n = seq.manifest?.grid.naxis[0] ?? firstBitmap?.width ?? frameSize(view.fov, scaleArcsec);
  const grid: Grid | null =
    src.status === 'ready' ? { ra0: centerRa, dec0: centerDec, scaleArcsec, n } : null;

  const meanMid = useMemo(() => {
    const mids = epochs.map((e) => epochMid(e)).filter((m): m is number => m !== undefined);
    return mids.length ? mids.reduce((a, b) => a + b, 0) / mids.length : undefined;
  }, [epochs]);

  const epochPositions: Pt[] | null = useMemo(() => {
    if (!grid || epochs.length === 0) return null;
    if (!astro) return epochs.map(() => ({ x: n / 2, y: n / 2 }));
    return epochs.map((e) => {
      const mid = epochMid(e) ?? meanMid;
      const pos =
        mid !== undefined
          ? propagate(
              {
                ra_deg: astro.ra,
                dec_deg: astro.dec,
                ref_epoch: astro.ref_epoch,
                pmra_masyr: astro.pmra,
                pmdec_masyr: astro.pmdec,
              },
              mid,
            )
          : { ra: astro.ra, dec: astro.dec };
      return skyToPixel(grid, pos.ra, pos.dec);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epochs, astro, centerRa, centerDec, scaleArcsec, n, meanMid]);

  const predicted = epochPositions ? (epochPositions[frameIdx] ?? epochPositions[0] ?? null) : null;

  // Track mode: each epoch is moved so the predicted position sits at the frame centre (sub-pixel in Blink
  // and RGB, where the frame is only drawn displaced). The stack along the track moves whole pixels.
  const shifts: Pt[] | null = useMemo(
    () =>
      tracking && epochPositions ? epochPositions.map((p) => ({ x: n / 2 - p.x, y: n / 2 - p.y })) : null,
    [tracking, epochPositions, n],
  );
  const [alignedStack, setAlignedStack] = useState<ImageBitmap | null>(null);
  const stackSig =
    trackStack && display.ready && shifts
      ? `${seq.key}|${det}|${shifts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')}`
      : '';
  useEffect(() => {
    setAlignedStack(null);
    if (!stackSig || !shifts) return;
    let alive = true;
    let made: ImageBitmap | null = null;
    const used = items.map((it, i) => ({ it, i })).filter((x) => x.it.bitmap && !x.it.missing);
    const bms = used.map((x) => x.it.bitmap as ImageBitmap);
    const k = bms.length ? bms[0].width / n : 1;
    void meanBitmap(
      bms,
      used.map((x) => ({ dx: shifts[x.i].x * k, dy: shifts[x.i].y * k })),
    ).then((bm) => {
      if (alive) {
        made = bm;
        setAlignedStack(bm);
      } else bm?.close();
    });
    return () => {
      alive = false;
      // Not cached anywhere else: released once the next stack (or none) has replaced it on screen.
      const old = made;
      if (old) setTimeout(() => old.close(), 1000);
    };
    // stackSig captures the frames and offsets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackSig]);
  const shownItems = useMemo(
    () => (trackStack ? items.map((it) => ({ ...it, bitmap: alignedStack, missing: false })) : items),
    [trackStack, items, alignedStack],
  );
  const shift: Pt | null = tracking && !trackStack && shifts ? (shifts[frameIdx] ?? null) : null;
  const ring = trackStack ? { x: n / 2, y: n / 2 } : predicted;
  const track = isMover && !trackStack ? epochPositions : null;
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __destello?: unknown }).__destello = { epochPositions, ring, n };
  }

  // F-27 predicted path and parallax ellipse, computed by the API from the catalog astrometry over this sequence.
  const pathRefEpoch = astro ? apiRefEpoch(astro.ref_epoch) : null;
  const pathReason: 'demo' | 'noMotion' | null = demo
    ? 'demo'
    : !astro || !isMover || !pathRefEpoch
      ? 'noMotion'
      : null;
  const wantPath = view.ov.includes('path') && pathReason === null;
  const pathQuery = useQuery({
    queryKey: [
      'path',
      seq.sequenceId,
      astro?.ra,
      astro?.dec,
      astro?.pmra,
      astro?.pmdec,
      astro?.parallax,
      pathRefEpoch,
      mode,
    ],
    queryFn: () =>
      getPath(seq.sequenceId as string, {
        ra_deg: astro?.ra ?? 0,
        dec_deg: astro?.dec ?? 0,
        pmra_masyr: astro?.pmra ?? 0,
        pmdec_masyr: astro?.pmdec ?? 0,
        parallax_mas: astro?.parallax ?? null,
        ref_epoch: pathRefEpoch as string,
      }),
    enabled: wantPath && complete && !!seq.sequenceId,
    staleTime: Infinity,
    retry: false,
  });
  const pathData = wantPath ? (pathQuery.data ?? null) : null;
  const pathScene: PathScene | null = useMemo(() => {
    if (!pathData) return null;
    return {
      line: pathData.path.map((q) => ({ x: q.x, y: q.y })),
      epochs: epochs.map((e) => {
        const q = pathData.epochs.find((x) => x.index === e.index);
        return q ? { x: q.x, y: q.y } : null;
      }),
      ellipse: pathData.ellipse ? pathData.ellipse.points.map(([x, y]) => ({ x, y })) : null,
    };
  }, [pathData, epochs]);
  // F-25: the drawing inputs of any shown frame, exactly as PlayerCanvas receives them for that frame (overlays
  // propagated to that frame's epoch, same bitmap and therefore the same shared stretch).
  const sceneAt = (i: number): ExportScene => {
    const e = epochs[i];
    const it = shownItems[view.mode === 'stack' ? 0 : i];
    const mf = frameFor(e, det);
    const mUrl = mf?.flags_url ?? null;
    const plain = !trackStack;
    return {
      n,
      bitmap: it?.bitmap ?? null,
      mask: wantFlags && mUrl ? (display.masks.get(mUrl) ?? null) : null,
      showFlags: wantFlags && view.mode !== 'rgb' && plain,
      gaia: view.ov.includes('gaia') && plain ? sourcesAt('gaia', e?.index ?? 0) : null,
      catwise: view.ov.includes('catwise') && plain ? sourcesAt('catwise', e?.index ?? 0) : null,
      track,
      currentEpoch: i,
      ring: trackStack ? { x: n / 2, y: n / 2 } : epochPositions ? (epochPositions[i] ?? null) : null,
      mark: ui.mark,
      isDiff: view.mode === 'diff' || view.mode === 'diffseq',
      shift: tracking && !trackStack && shifts ? (shifts[i] ?? null) : null,
      path: plain ? pathScene : null,
      frame: it?.frame ?? mf,
      missing: !!it?.missing,
      atReference: !!it?.atReference,
    };
  };

  overlayCounts.path = !wantPath
    ? undefined
    : pathQuery.isError
      ? 'failed'
      : pathQuery.isFetching || !complete || !pathData
        ? 'loading'
        : 'ready';

  const fastMoverNext = useMemo(() => {
    if (!isMover || !epochPositions) return null;
    const out = epochPositions.some((p) => p.x < 0 || p.y < 0 || p.x > n || p.y > n);
    if (!out) return null;
    const needPx =
      Math.max(...epochPositions.map((p) => Math.max(Math.abs(p.x - n / 2), Math.abs(p.y - n / 2)))) * 2;
    const needArcmin = (needPx * scaleArcsec * 1.1) / 60;
    return FOVS.find((f) => f >= needArcmin && f > view.fov) ?? null;
  }, [isMover, epochPositions, n, scaleArcsec, view.fov]);

  const motionLabel = useMemo(() => {
    if (!astro) return null;
    if (isMover) {
      const ang = (Math.atan2(astro.pmra ?? 0, astro.pmdec ?? 0) * 180) / Math.PI;
      const dir = DIRS[Math.round(((ang + 360) % 360) / 45) % 8];
      return t('player.motionLabel', { value: pmTotal.toFixed(1), dir: t(`player.dir.${dir}`) });
    }
    if (astro.presetId && !presetStatic(astro.presetId)?.mover) return t('presets.variable').toLowerCase();
    return null;
  }, [astro, isMover, pmTotal, t]);

  // Detector availability and ranges from the manifest only.
  // Memoized so the plots that depend on them do not redraw on every playback tick.
  const { ranges, coverage } = useMemo(() => {
    const ranges: Partial<Record<DetectorNum, [number, number]>> = {};
    const coverage: Partial<Record<DetectorNum, boolean>> = {};
    for (const d of DETECTORS) {
      let has = false;
      for (const e of epochs) {
        const f = e.frames.find((x) => frameDetector(x) === d);
        if (f) {
          has = true;
          if (f.wavelength_um && !ranges[d]) ranges[d] = f.wavelength_um;
        }
      }
      // A detector without frames is only reported as missing once the build is complete.
      if (epochs.length > 0 && (complete || has)) coverage[d] = has;
    }
    return { ranges, coverage };
  }, [epochs, complete]);
  // F-20: the color composite needs at least three detectors with data in this sequence.
  const rgbAvailable = DETECTORS.filter((d) => coverage[d]).length >= 3;
  // F-31: positions of the low coverage epochs (short revisits), labelled in the reference list.
  const lowEpochs = useMemo(() => new Set(epochs.flatMap((e, i) => (isLowCoverage(e) ? [i] : []))), [epochs]);
  const missingEpochs = new Set<number>();
  epochs.forEach((e) => {
    if (!frameFor(e, det)) missingEpochs.add(e.index);
  });

  // Stretch of the shown detector (exact key only, so a pixel value is never computed with another detector's limits).
  const stretch =
    seq.manifest?.stretch[det === 'all' ? '0' : String(det)] ??
    (det === 'all' ? seq.manifest?.stretch['all'] : undefined) ??
    null;

  const currentFrame = items[view.mode === 'stack' ? 0 : frameIdx]?.frame ?? frameFor(epochAtFrame, det);
  const announce = useMemo(() => {
    if (ui.playing) return '';
    const base = `${t('player.epoch')} ${frameIdx + 1} ${t('player.of')} ${nEpochs}`;
    return isLowCoverage(epochAtFrame) ? `${base}. ${t('coverage.lowAria')}` : base;
  }, [ui.playing, frameIdx, nEpochs, epochAtFrame, t]);

  const toggleOverlay = useCallback(
    (k: OverlayKey) => {
      const on = new Set(view.ov);
      if (on.has(k)) on.delete(k);
      else on.add(k);
      update({ ov: OVERLAYS.filter((o) => on.has(o)) });
    },
    [update, view.ov],
  );

  const setMode = useCallback(
    (m: Mode) => {
      ui.setPlaying(false);
      update({ mode: m, frame: frameIdxRef.current + 1 });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [update],
  );
  const setTrack = useCallback((on: boolean) => update({ track: on ? 1 : undefined }), [update]);
  const setRgb = useCallback(
    (triple: RgbTriple) => update({ rgb: [triple[0], triple[1], triple[2]] }),
    [update],
  );
  const setFps = useCallback((f: Fps) => update({ fps: f }), [update]);
  const setDet = useCallback(
    (d: DetectorSel) => update({ det: d, frame: frameIdxRef.current + 1 }),
    [update],
  );
  const setFov = useCallback((f: number) => update({ fov: f as Fov }), [update]);
  const setRelease = useCallback((r: string | undefined) => update({ release: r }), [update]);
  // F-31: the epoch list changes, so the frame and the reference start again from the first epoch.
  const setPartial = useCallback(
    (on: boolean) => update({ partial: on ? 1 : undefined, frame: undefined, ref: undefined }),
    [update],
  );

  const hasData = seq.phase !== 'error' && src.status === 'ready';
  const building =
    src.status === 'ready' && (seq.phase === 'building' || (seq.phase === 'idle' && src.status === 'ready'));
  const single = complete && nEpochs === 1;

  return {
    v,
    view,
    lang,
    src,
    seq,
    ui,
    mode,
    health,
    demo,
    reduced,
    targets,
    tq,
    epochs,
    nEpochs,
    complete,
    det,
    refIdx,
    display,
    items: shownItems,
    playable,
    canPlay,
    frameIdx,
    step,
    setFrameFromUser,
    setPlaying,
    setMode,
    setFps,
    setDet,
    setFov,
    setRelease,
    setPartial,
    toggleOverlay,
    retryOverlay: (k: OverlayKey) =>
      void (k === 'path'
        ? pathQuery.refetch()
        : k === 'flags'
          ? undefined
          : ovQueries[k === 'gaia' ? 0 : 1].refetch()),
    pathReason,
    pathData,
    pathScene,
    sceneAt,
    overlayCounts,
    gaiaNow,
    catwiseNow,
    mask,
    flagLegend,
    grid,
    scaleArcsec,
    n,
    astro,
    ring,
    track,
    isMover,
    trackAvailable,
    tracking,
    trackStack,
    shift,
    setTrack,
    cand,
    setCand,
    motion,
    fastMoverNext,
    motionLabel,
    fallbackDetector,
    ranges,
    coverage,
    rgb,
    rgbAvailable,
    setRgb,
    missingEpochs,
    lowEpochs,
    currentFrame,
    stretch,
    announce,
    hasData,
    building,
    single,
    meanMid,
    fps: FPS_VALUES.includes(view.fps) ? view.fps : (2 as Fps),
  };
}
