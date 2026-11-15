/* The canvas wrapper is focusable on purpose (accessibility.md): role img, updating label, arrow keys step epochs. */
/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { epochMid, fmtMjd, formatNumber, hudBand, localPercent, mjdIso, bandRange } from '../../lib/format';
import { formatDec, formatRa } from '../../lib/coords';
import { pixelToSky, type Grid } from '../../lib/astrometry';
import {
  frameDetector,
  isLowCoverage,
  type DetectorSel,
  type EpochInfo,
  type Lang,
  type Mode,
  type OverlaySource,
  type RgbTriple,
  type StretchInfo,
} from '../../lib/types';
import { invertAsinh, pixelLevel } from '../../lib/bitmaps';
import { drawScene, nearestSource, readColors, type Colors, type PathScene, type Pt } from './draw';
import type { DisplayItem } from './useDisplayFrames';
import type { CandidateMarker } from '../candidates/candidateModel';
import type { MotionTrack } from '../motion/motionModel';
import { Button } from '../../components/ui/button';
import { LowCoverageBadge } from './LowCoverageBadge';

export interface PlayerCanvasProps {
  epochs: EpochInfo[];
  items: DisplayItem[];
  frameIdx: number;
  mode: Mode;
  det: DetectorSel;
  n: number;
  scaleArcsec: number;
  grid: Grid | null;
  showGaia: boolean;
  showCatwise: boolean;
  showFlags: boolean;
  gaia: OverlaySource[] | null;
  catwise: OverlaySource[] | null;
  mask: ImageBitmap | null;
  track: Pt[] | null;
  ring: Pt | null;
  targetName: string | null;
  targetMotion: string | null;
  labelOffset: { dx: number; dy: number };
  mark: Pt | null;
  refEpoch: number;
  totalEpochs: number;
  loading: { done: number; total: number } | null;
  waitingForEpochs: boolean;
  rmIdle: boolean;
  onPlay: () => void;
  onMark: (p: Pt) => void;
  /** Frame pixel under the pointer, or null when it leaves the canvas ("Measure at cursor"). */
  onCursor?: (p: Pt | null) => void;
  onStep: (delta: number) => void;
  announce: string;
  /** Stretch of the shown detector. When present (with softening) the hover readout shows the pixel value. */
  stretch?: StretchInfo | null;
  /** F-20: detectors shown as red, green and blue in RGB mode. */
  rgb?: RgbTriple;
  /** F-23: displacement of the shown frame in frame px (track mode), or null. */
  shift?: Pt | null;
  /** F-23: the frame is a stack aligned on the target, so the background has no single sky position. */
  alignedStack?: boolean;
  /** F-27: predicted path layer in frame px, or null when off. */
  path?: PathScene | null;
  /** F-29: candidate markers in frame px for the difference on screen, or null when off. */
  candidates?: CandidateMarker[] | null;
  /** F-32: tracks of the motion search in frame px, or null when not run. */
  motionTracks?: MotionTrack[] | null;
  className?: string;
}

function useSize(ref: React.RefObject<HTMLElement | null>): number {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(Math.round(el.getBoundingClientRect().width)));
    ro.observe(el);
    setSize(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function PlayerCanvas(p: PlayerCanvasProps) {
  const { t, i18n } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useSize(wrapRef);
  const [hover, setHover] = useState<{ pt: Pt; css: Pt } | null>(null);
  const [colors, setColors] = useState<Colors | null>(null);
  const onCursor = p.onCursor;
  useEffect(() => onCursor?.(hover?.pt ?? null), [hover, onCursor]);
  const item = p.items[p.mode === 'stack' ? 0 : p.frameIdx];
  const epoch = p.epochs[p.frameIdx];
  const isDiff = p.mode === 'diff' || p.mode === 'diffseq';
  // F-31: a short revisit is labelled wherever an epoch is shown (not in Stack, which shows no single epoch).
  const low = p.mode !== 'stack' && isLowCoverage(epoch);
  // Difference modes: position of the epoch subtracted on screen, or -1 when there is none for this detector.
  const pairPos = isDiff && item?.pair != null ? p.epochs.findIndex((e) => e.index === item.pair) : -1;
  const pairLow = pairPos >= 0 && isLowCoverage(p.epochs[pairPos]);
  const n = p.n || item?.bitmap?.width || 116;
  const k = size / n;

  useEffect(() => {
    setColors(readColors());
    const mo = new MutationObserver(() => setColors(readColors()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  // The scene only outlines the hovered frame pixel, so it is redrawn when the pointer enters another pixel,
  // not on every pointer move (the DOM readout still follows the pointer).
  const hoverPx = hover ? `${Math.floor(hover.pt.x)},${Math.floor(hover.pt.y)}` : '';
  const hoverCell = useMemo<Pt | null>(() => {
    if (!hoverPx) return null;
    const [x, y] = hoverPx.split(',').map(Number);
    return { x, y };
  }, [hoverPx]);

  // Draw whenever any input changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !colors || size === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.round(size * dpr);
    if (c.width !== px) {
      c.width = px;
      c.height = px;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    drawScene(ctx, {
      size,
      dpr,
      n,
      bitmap: item?.bitmap ?? null,
      mask: p.mask,
      // The flag mask belongs to one detector; it does not apply to a three-detector composite.
      showFlags: p.showFlags && p.mode !== 'rgb' && !p.alignedStack,
      gaia: p.showGaia && !p.alignedStack ? p.gaia : null,
      catwise: p.showCatwise && !p.alignedStack ? p.catwise : null,
      track: p.track,
      currentEpoch: p.frameIdx,
      ring: p.ring,
      mark: p.mark,
      hover: hoverCell,
      colors,
      isDiff,
      shift: p.shift ?? null,
      path: p.alignedStack ? null : (p.path ?? null),
      // Markers belong to the difference on screen: none on the reference epoch, which shows no difference.
      candidates: item?.atReference ? null : (p.candidates ?? null),
      // The aligned stack has no single sky position, so sky tracks would not line up with it.
      motion: p.alignedStack ? null : (p.motionTracks ?? null),
    });
  }, [
    size,
    colors,
    n,
    item,
    p.mask,
    p.showFlags,
    p.mode,
    p.showGaia,
    p.showCatwise,
    p.gaia,
    p.catwise,
    p.track,
    p.frameIdx,
    p.ring,
    p.mark,
    hoverCell,
    isDiff,
    p.shift,
    p.alignedStack,
    p.path,
    p.candidates,
    p.motionTracks,
  ]);

  const toFrame = useCallback(
    (e: React.PointerEvent | React.MouseEvent): { pt: Pt; css: Pt } => {
      const r = wrapRef.current?.getBoundingClientRect();
      const left = r?.left ?? 0;
      const top = r?.top ?? 0;
      const w = r?.width || 1;
      // Pointer positions are returned in the frame's own pixels, undoing the track-mode displacement.
      const sx = p.shift?.x ?? 0;
      const sy = p.shift?.y ?? 0;
      return {
        pt: { x: ((e.clientX - left) / w) * n - sx, y: ((e.clientY - top) / w) * n - sy },
        css: { x: e.clientX - left, y: e.clientY - top },
      };
    },
    [n, p.shift],
  );

  const date = epoch ? epochMid(epoch) : undefined;
  const iso = date !== undefined ? mjdIso(date) : '';
  const frame = item?.frame ?? epoch?.frames.find((f) => frameDetector(f) === p.det) ?? null;
  const rgbLegend =
    p.mode === 'rgb' && p.rgb
      ? t('mode.rgbLegend', { r: `D${p.rgb[0]}`, g: `D${p.rgb[1]}`, b: `D${p.rgb[2]}` })
      : null;
  // In RGB mode the frame of the selected detector is not what is shown: name the composite instead.
  const isRgb = p.mode === 'rgb' && rgbLegend !== null;
  const detLabel = isRgb ? t('mode.rgb') : p.det === 'all' ? t('detector.allDet') : `D${p.det}`;
  const iband = frame && !isRgb ? hudBand(frame) : undefined;
  const sentenceBand = isRgb
    ? (rgbLegend ?? '')
    : ((frame ? bandRange(frame, t('player.to', { defaultValue: 'to' })) : undefined) ?? '');
  const total = p.totalEpochs;
  // F-13: the flagged fraction of the frame on screen is always shown, with or without the mask overlay.
  // Stack mode shows a mean of several frames, so no single fraction applies there.
  const flagged =
    p.mode !== 'stack' &&
    p.mode !== 'rgb' &&
    frame &&
    Number.isFinite(frame.flagged_fraction) &&
    !item?.missing
      ? frame.flagged_fraction
      : null;
  const lang: Lang = i18n.language.startsWith('es') ? 'es' : 'en';

  const aria = useMemo(() => {
    if (!epoch) return t('presets.noMeasurement');
    const base = p.targetName
      ? t('player.aria', {
          epoch: p.frameIdx + 1,
          total,
          date: iso,
          detector: detLabel,
          band: sentenceBand,
          name: p.targetName,
        })
      : t('player.ariaNoName', {
          epoch: p.frameIdx + 1,
          total,
          date: iso,
          detector: detLabel,
          band: sentenceBand,
        });
    const withLow = low ? `${base} ${t('coverage.lowAria')}.` : base;
    if (isDiff) return `${withLow} ${t('player.diffAlt')}`;
    if (p.alignedStack) return `${withLow} ${t('player.trackStackTag')}`;
    return p.shift ? `${withLow} ${t('player.trackTag')}` : withLow;
  }, [
    low,
    epoch,
    p.frameIdx,
    total,
    iso,
    detLabel,
    sentenceBand,
    p.targetName,
    isDiff,
    p.shift,
    p.alignedStack,
    t,
  ]);

  // hover readout
  const hoverInfo = useMemo(() => {
    if (!hover || !p.grid) return null;
    if (p.alignedStack) return { ra: '', dec: '', near: null, value: null, aligned: true };
    const sky = pixelToSky(p.grid, hover.pt.x, hover.pt.y);
    const near =
      nearestSource(p.showGaia ? p.gaia : null, hover.pt) ??
      nearestSource(p.showCatwise ? p.catwise : null, hover.pt);
    // Pixel value: only in Blink, only when the manifest gives the stretch, so the 8-bit level can be inverted.
    let value: string | null = null;
    const st = p.stretch;
    if (p.mode === 'blink' && st?.softening && item?.bitmap) {
      const lvl = pixelLevel(item.bitmap, hover.pt.x, hover.pt.y);
      if (lvl !== null) {
        const v = invertAsinh(lvl, st.vmin, st.vmax, st.softening);
        const txt = Math.abs(v) >= 100 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(2) : v.toFixed(3);
        const lim = lvl === 0 ? '< ' : lvl === 255 ? '> ' : '';
        value = `${lim}${txt} ${st.unit}`;
      }
    }
    return { ra: formatRa(sky.ra, 1), dec: formatDec(sky.dec, 0), near, value, aligned: false };
  }, [hover, p.grid, p.gaia, p.catwise, p.showGaia, p.showCatwise, p.stretch, p.mode, item, p.alignedStack]);

  // target label placement
  const showLabel =
    !isDiff &&
    p.ring &&
    p.targetName &&
    !p.rmIdle &&
    !(item?.missing && (p.mode === 'blink' || p.mode === 'rgb'));
  const dx = p.labelOffset.dx;
  const labelLeft = p.ring ? (p.ring.x + (p.shift?.x ?? 0) + dx) * k : 0;
  const labelTop = p.ring ? (p.ring.y + (p.shift?.y ?? 0) + p.labelOffset.dy) * k : 0;
  const right = dx >= 0;

  const scaleBarPx = (60 / p.scaleArcsec) * k;
  const dir =
    hover && size
      ? { flipX: hover.css.x > size - 280, flipY: hover.css.y > size - 120 }
      : { flipX: false, flipY: false };
  // A detector that did not observe an epoch shows an explicit note in every mode: nothing is filled in.
  const noFrame = !!item?.missing && p.mode !== 'stack';
  const atRef = isDiff && item?.atReference;
  // Difference modes: the epoch has a frame, but no epoch to subtract has one in this detector (F-31).
  const noPair = isDiff && !!item && !item.missing && !atRef && item.pair === null && !p.waitingForEpochs;

  return (
    <div
      ref={wrapRef}
      className={cn(
        'relative aspect-square w-full touch-manipulation overflow-hidden rounded-xs bg-frame outline outline-1 outline-border',
        p.className,
      )}
      tabIndex={0}
      // A group, not an image: it holds the reduced-motion Play button and the live announcements, which the
      // presentational children of role="img" would hide from assistive technology.
      role="group"
      aria-label={aria}
      aria-describedby="player-help"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          p.onStep(-1);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          p.onStep(1);
        }
      }}
      onPointerMove={(e) => setHover(toFrame(e))}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => p.onMark(toFrame(e).pt)}
      data-testid="player-canvas"
      data-cand-markers={isDiff && p.candidates && !item?.atReference ? p.candidates.length : undefined}
      data-motion-tracks={!isDiff && !p.alignedStack && p.motionTracks ? p.motionTracks.length : undefined}
    >
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', imageRendering: 'pixelated' }}
        aria-hidden="true"
      />
      <span id="player-help" className="sr-live">
        {t('player.canvasHelp')}
      </span>
      <span className="sr-live" aria-live="polite" role="status" data-testid="player-announce">
        {p.announce}
      </span>

      {/* DOM HUD, pointer-events none and hidden from assistive tech (the canvas label carries the content) */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {showLabel && (
          <div
            className="absolute flex flex-col whitespace-nowrap"
            style={{
              left: labelLeft,
              top: labelTop,
              transform: right ? 'translate(0,-50%)' : 'translate(-100%,-50%)',
              textAlign: right ? 'left' : 'right',
            }}
            data-testid="target-label"
          >
            <span className="halo text-label-13 font-semibold text-glint">{p.targetName}</span>
            {p.targetMotion && (
              <span className="halo tnum text-caption-12 font-medium text-text">{p.targetMotion}</span>
            )}
          </div>
        )}

        {epoch && (
          <div
            className="hud-chip absolute left-2 top-2 flex max-w-[calc(100%-16px)] flex-col gap-px px-2 py-1.5"
            data-testid="epoch-chip"
          >
            <span className="tnum text-label-13 font-semibold">
              {iso}
              {date !== undefined && <span className="font-normal text-muted"> MJD {fmtMjd(date)}</span>}
            </span>
            <span className="tnum truncate text-caption-12 font-medium text-text-2">
              {t('player.epochLine', {
                epoch: p.frameIdx + 1,
                total,
                detector: isRgb ? t('mode.rgb') : p.det === 'all' ? t('detector.all') : `D${p.det}`,
                band: iband ?? '',
              }).replace(/\s·\s*$/, '')}
            </span>
            {low && <LowCoverageBadge testId="epoch-chip-low" className="mt-0.5 self-start text-text" />}
            {p.mode === 'stack' && (
              <span className="tnum text-caption-12 font-medium text-text">
                {t('player.stackTag', { count: total })}
              </span>
            )}
            {(p.shift || p.alignedStack) && (
              <span className="tnum text-caption-12 font-medium text-text" data-testid="track-tag">
                {p.alignedStack ? t('player.trackStackTag') : t('player.trackTag')}
              </span>
            )}
            {rgbLegend && (
              <span className="tnum text-caption-12 font-medium text-text" data-testid="rgb-legend">
                {rgbLegend}
              </span>
            )}
            {flagged !== null && (
              <span className="tnum text-caption-12 font-medium text-text-2" data-testid="epoch-chip-flagged">
                {t('player.flaggedLine', { fraction: localPercent(lang, flagged) })}
              </span>
            )}
          </div>
        )}

        {isDiff && !atRef && item && pairPos >= 0 && !noFrame && (
          <div
            className="hud-chip absolute bottom-2 left-2 flex w-[272px] max-w-[calc(100%-120px)] flex-col gap-1.5 px-2.5 py-2"
            data-testid="diff-legend"
          >
            <span className="tnum text-caption-12 font-semibold">
              {t('player.diffEq', { a: p.frameIdx + 1, b: pairPos + 1 })}
            </span>
            {pairLow && (
              <span className="text-caption-12 text-text" data-testid="diff-pair-low">
                {t('player.pairLow', { n: pairPos + 1 })}
              </span>
            )}
            <div
              className="h-2 rounded-xs"
              style={{ background: 'linear-gradient(90deg, var(--neg), var(--diff-zero) 50%, var(--glint))' }}
            />
            <div className="flex justify-between gap-2 text-caption-12 font-medium">
              <span className="text-neg-text">
                {'▼'} {t('player.was')}
              </span>
              <span className="text-glint">
                {'▲'} {t('player.now')}
              </span>
            </div>
            {item.diff && (
              <span className="tnum text-caption-12 text-muted" data-testid="diff-scale">
                {t('player.diffScale', { scale: item.diff.scale.toFixed(2), stars: item.diff.stars })}
              </span>
            )}
          </div>
        )}

        <div className="absolute bottom-2.5 right-2.5 flex items-end gap-4">
          <div className="flex flex-col items-center gap-1 pb-1.5" data-testid="scale-bar">
            <span className="tnum halo text-caption-12 font-semibold">{t('player.oneArcmin')}</span>
            <div
              style={{ width: scaleBarPx, height: 6 }}
              className="box-border border-2 border-t-0 border-text shadow-[0_1px_0_var(--bg)]"
            />
          </div>
          <div className="relative h-11 w-11 text-text" title={t('player.northUp')} data-testid="compass">
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M36 40V22m0 0-3.5 4.5M36 22l3.5 4.5" />
              <path d="M36 40H18m0 0 4.5-3.5M18 40l4.5 3.5" />
            </svg>
            <span className="tnum halo absolute right-0 top-[2px] text-caption-12 font-semibold leading-none">
              N
            </span>
            <span className="tnum halo absolute bottom-[19px] left-[2px] text-caption-12 font-semibold leading-none">
              E
            </span>
          </div>
        </div>

        {hoverInfo && hover && (
          <div
            className="hud-chip tnum absolute z-10 flex flex-col gap-0.5 px-2.5 py-1.5 text-caption-12 font-medium"
            style={{
              left: dir.flipX ? undefined : hover.css.x + 12,
              right: dir.flipX ? size - hover.css.x + 12 : undefined,
              top: dir.flipY ? undefined : hover.css.y + 12,
              bottom: dir.flipY ? size - hover.css.y + 12 : undefined,
            }}
            data-testid="hover-readout"
          >
            <span>
              {hoverInfo.aligned
                ? t('player.trackCoords')
                : t('player.hoverReadout', { ra: hoverInfo.ra, dec: hoverInfo.dec })}
            </span>
            {hoverInfo.value && (
              <span className="text-muted" data-testid="hover-value">
                {t('player.pixelValue', { value: hoverInfo.value })}
              </span>
            )}
            {hoverInfo.near && (
              <span className="text-muted" data-testid="hover-source">
                {hoverInfo.near.id}
                {hoverInfo.near.mag != null
                  ? ` · ${t('player.hoverMag', { mag: formatNumber(lang, hoverInfo.near.mag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })}`
                  : ''}
                {hoverInfo.near.pmra_masyr != null && hoverInfo.near.pmdec_masyr != null
                  ? ` · ${t('player.hoverPm', {
                      pmra: formatNumber(lang, hoverInfo.near.pmra_masyr, {
                        maximumFractionDigits: 1,
                        signDisplay: 'always',
                      }),
                      pmdec: formatNumber(lang, hoverInfo.near.pmdec_masyr, {
                        maximumFractionDigits: 1,
                        signDisplay: 'always',
                      }),
                    })}`
                  : ''}
              </span>
            )}
          </div>
        )}
      </div>

      {/* States over the frame */}
      {p.loading && !p.rmIdle && (
        <div className="absolute inset-x-0 bottom-14 flex justify-center" role="status">
          <div className="hud-chip px-3 py-1.5 text-caption-12 text-text-2">
            {t('player.preloading', p.loading)}
          </div>
        </div>
      )}
      {!item?.bitmap && !noFrame && !noPair && !atRef && (
        <div className="absolute inset-0 grid place-items-center text-caption-12 text-muted">
          <span className="hud-chip px-3 py-1.5">
            {p.waitingForEpochs
              ? t('build.skeleton')
              : item?.failed
                ? t('player.frameError')
                : t('app.loading')}
          </span>
        </div>
      )}
      {noFrame && (
        <div
          className="absolute inset-0 grid place-items-center p-6"
          role="status"
          data-testid="missing-frame"
        >
          <div className="hud-chip max-w-[300px] px-3.5 py-3 text-body-14 text-text">
            <p className="font-semibold">{t('player.missingInDetector')}</p>
            <p className="mt-1 text-text-2">
              {low
                ? t('player.lowMissing', { detector: detLabel, epoch: p.frameIdx + 1 })
                : t('detector.noDataWhy')}
            </p>
          </div>
        </div>
      )}
      {noPair && (
        <div
          className="absolute inset-0 grid place-items-center p-6"
          role="status"
          data-testid="missing-pair"
        >
          <div className="hud-chip max-w-[300px] px-3.5 py-3 text-body-14 text-text">
            <p className="font-semibold">{t('player.noPairTitle')}</p>
            <p className="mt-1 text-text-2">
              {p.mode === 'diff'
                ? t('player.noPairRef', { n: p.refEpoch + 1, detector: detLabel })
                : t('player.noPairPrev', { detector: detLabel })}
            </p>
          </div>
        </div>
      )}
      {atRef && (
        <div className="absolute inset-0 grid place-items-center p-6" role="status" data-testid="zero-diff">
          <div className="max-w-[300px] rounded-lg border border-border-strong bg-hud px-3.5 py-3 text-body-14 text-text">
            <p className="font-semibold">{t('player.zeroDiff')}</p>
            <p className="mt-1 text-text-2">{t('player.zeroDiffBody')}</p>
          </div>
        </div>
      )}
      {p.rmIdle && (
        <div className="absolute inset-0 z-[4] flex flex-col items-center justify-center gap-3.5 bg-frame/35">
          <Button
            variant="primary"
            className="size-[88px] min-h-0 rounded-full p-0 shadow-[0_0_0_8px_var(--hud-bg)]"
            aria-label={t('player.rmPlay', { count: total })}
            onClick={(e) => {
              e.stopPropagation();
              p.onPlay();
            }}
            data-testid="rm-play"
          >
            <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
          </Button>
          <div className="max-w-[320px] rounded-lg border border-border-strong bg-hud px-3.5 py-2.5 text-center">
            <p className="text-body-15 font-semibold">{t('player.rmTitle')}</p>
            <p className="text-caption-12 text-text-2">{t('player.rmBody')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
