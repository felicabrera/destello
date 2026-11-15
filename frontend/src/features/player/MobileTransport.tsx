// Mobile transport (S-20): step and play buttons with one chip per epoch, and the mini player shown at the top of
// the fully open sheet.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { cn } from '../../lib/cn';
import { epochMid, isoDay, localMonthYear, mjdToDate } from '../../lib/format';
import { isLowCoverage, type EpochInfo, type Lang } from '../../lib/types';
import { LowCoverageBadge } from './LowCoverageBadge';

function playLabelFor(t: TFunction, playing: boolean, reducedMotion: boolean): string {
  if (playing) return t('player.pause');
  return reducedMotion ? t('player.playMotionReduced') : t('player.play');
}

function PlayIcon({ playing }: { playing: boolean }) {
  return (
    <svg className="size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {playing ? <path d="M7 5h3v14H7zM14 5h3v14h-3z" /> : <path d="M8 5v14l11-7z" />}
    </svg>
  );
}

const stepBtn =
  'grid size-11 flex-none place-items-center rounded-lg border border-border-strong bg-surface-2 text-text hover:bg-border disabled:border-border disabled:text-disabled disabled:hover:bg-surface-2';
const playBtn =
  'grid flex-none place-items-center rounded-full border border-glint bg-primary text-primary-foreground hover:bg-glint-hover disabled:border-border disabled:bg-surface-2 disabled:text-disabled';

interface Props {
  playing: boolean;
  canPlay: boolean;
  atFirst: boolean;
  atLast: boolean;
  loop: boolean;
  reducedMotion: boolean;
  epochs: EpochInfo[];
  index: number;
  /** Epoch indices with no frame in the selected detector (dashed). */
  missing: Set<number>;
  /** Position of the reference epoch while a difference is shown, otherwise null. */
  refIndex: number | null;
  lang: Lang;
  onPlayPause: () => void;
  onStep: (d: number) => void;
  onJump: (i: number) => void;
}

export function MobileTransport(p: Props) {
  const { t } = useTranslation();
  const label = playLabelFor(t, p.playing, p.reducedMotion);
  // Chips with a low coverage label are wider, so they scroll instead of sharing the row (F-31).
  const few = p.epochs.length <= 3 && !p.epochs.some(isLowCoverage);
  return (
    <div className="flex items-center gap-2" data-testid="mobile-transport">
      <div className="flex flex-none items-center gap-1.5" role="group" aria-label={t('player.playback')}>
        <button
          type="button"
          className={stepBtn}
          onClick={() => p.onStep(-1)}
          disabled={p.atFirst && !p.loop}
          aria-label={t('player.prev')}
          data-testid="btn-prev"
        >
          <svg
            className="size-[18px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <button
          type="button"
          className={cn(playBtn, 'size-12')}
          onClick={p.onPlayPause}
          disabled={!p.canPlay}
          aria-label={label}
          aria-pressed={p.playing}
          data-testid="btn-play"
        >
          <PlayIcon playing={p.playing} />
        </button>
        <button
          type="button"
          className={stepBtn}
          onClick={() => p.onStep(1)}
          disabled={p.atLast && !p.loop}
          aria-label={t('player.next')}
          data-testid="btn-next"
        >
          <svg
            className="size-[18px]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>
      <div
        role="group"
        aria-label={t('player.timeline')}
        className={cn(
          'min-w-0 flex-1 gap-1.5',
          few ? 'grid auto-cols-fr grid-flow-col' : 'scroll-x-hide flex overflow-x-auto',
        )}
        data-testid="timeline"
      >
        {p.epochs.map((ep, i) => {
          const current = i === p.index;
          const miss = p.missing.has(ep.index);
          const mid = epochMid(ep);
          const isRef = p.refIndex === i;
          const low = isLowCoverage(ep);
          // The accessible name starts with the visible text (WCAG 2.5.3), then the full description.
          const visible =
            `E${i + 1}${mid !== undefined ? ` ${localMonthYear(p.lang, mjdToDate(mid))}` : ''}` +
            (low ? ` ${t('coverage.low')}` : '');
          const extra = [
            low ? t('coverage.lowAria') : '',
            miss ? (low ? t('player.lowMissingShort') : t('player.missingInDetector')) : '',
            isRef ? t('mode.reference') : '',
          ].filter(Boolean);
          const node = t('player.timelineNode', {
            epoch: i + 1,
            start: isoDay(ep.t_start) || '?',
            end: isoDay(ep.t_end) || '?',
            images: ep.n_images ?? ep.frames[0]?.n_images ?? 0,
          });
          return (
            <button
              key={ep.index}
              type="button"
              aria-pressed={current}
              aria-label={`${visible}: ${[node, ...extra].join('. ')}`}
              onClick={() => p.onJump(i)}
              className={cn(
                'flex min-h-11 flex-col items-center justify-center rounded-lg border px-1.5',
                !few && 'min-w-14 flex-none',
                current
                  ? 'border-glint bg-glint-soft text-glint'
                  : 'border-border-strong bg-surface-2 text-text',
                miss && !current && 'border-dashed text-muted',
              )}
              data-testid={`epoch-node-${i + 1}`}
            >
              <span className="tnum text-label-13 font-semibold" aria-hidden="true">
                E{i + 1}
                {isRef ? ' ·' : ''}
              </span>{' '}
              {mid !== undefined && (
                <span className="tnum whitespace-nowrap text-caption-12 text-muted" aria-hidden="true">
                  {localMonthYear(p.lang, mjdToDate(mid))}
                </span>
              )}
              {low && (
                <>
                  {' '}
                  <span aria-hidden="true">
                    <LowCoverageBadge testId={`epoch-low-${i + 1}`} className="mt-0.5" />
                  </span>
                </>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ bitmap }: { bitmap: ImageBitmap | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    if (bitmap) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    }
  }, [bitmap]);
  return (
    <canvas
      ref={ref}
      width={128}
      height={128}
      className="size-16 flex-none rounded-md border border-border bg-frame"
      aria-hidden="true"
    />
  );
}

/** Small copy of the current frame with a play button, shown while the open sheet covers the player. */
export function MiniPlayer(p: {
  bitmap: ImageBitmap | null;
  title: string;
  line: string;
  playing: boolean;
  canPlay: boolean;
  reducedMotion: boolean;
  onPlayPause: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-none items-center gap-3 border-b border-border px-4 pb-3"
      data-testid="mini-player"
    >
      <Thumb bitmap={p.bitmap} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-14 font-semibold text-text">{p.title}</p>
        <p className="tnum truncate text-caption-12 text-muted">{p.line}</p>
      </div>
      <button
        type="button"
        className={cn(playBtn, 'size-11')}
        onClick={p.onPlayPause}
        disabled={!p.canPlay}
        aria-label={playLabelFor(t, p.playing, p.reducedMotion)}
        aria-pressed={p.playing}
        data-testid="mini-play"
      >
        <PlayIcon playing={p.playing} />
      </button>
    </div>
  );
}
