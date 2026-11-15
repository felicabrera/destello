import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { FPS_VALUES, type Fps } from '../../lib/types';

interface Props {
  playing: boolean;
  fps: Fps;
  loop: boolean;
  /** At least two epochs ready and bitmaps loaded. */
  canPlay: boolean;
  atFirst: boolean;
  atLast: boolean;
  reducedMotion: boolean;
  onPlayPause: () => void;
  onStep: (d: number) => void;
  onFirst: () => void;
  onLast: () => void;
  onFps: (f: Fps) => void;
  onLoop: (v: boolean) => void;
  compact?: boolean;
  /** Render only the speed and loop block (mobile speed dialog). */
  hideTransport?: boolean;
}

const icon = 'size-[18px]';
const btn =
  'flex min-h-[var(--hit-min)] min-w-[var(--hit-min)] items-center justify-center rounded-lg border border-border-strong bg-surface-2 text-text transition-colors duration-(--duration-fast) hover:bg-border disabled:border-border disabled:text-disabled disabled:hover:bg-surface-2';

export function PlaybackControls(p: Props) {
  const { t } = useTranslation();
  const stepPrevOff = p.atFirst && !p.loop;
  const stepNextOff = p.atLast && !p.loop;
  const playLabel = p.playing
    ? t('player.pause')
    : p.reducedMotion
      ? t('player.playMotionReduced')
      : t('player.play');
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      role="group"
      aria-label={t('player.playback')}
      data-testid="playback"
    >
      {!p.hideTransport && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={cn(btn, 'max-md:hidden')}
            onClick={p.onFirst}
            aria-label={t('player.first')}
            title={t('player.first')}
            data-testid="btn-first"
          >
            <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M6 5h2v14H6zM20 5v14L9 12z" />
            </svg>
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => p.onStep(-1)}
            disabled={stepPrevOff}
            aria-label={t('player.prev')}
            title={t('player.prev')}
            data-testid="btn-prev"
          >
            <svg
              className={icon}
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
            className={cn(
              btn,
              // No colour transition: when the button is enabled again (after a mode switch) a fading
              // background would leave the label at low contrast for a moment.
              'min-w-[88px] gap-2 transition-none border-glint bg-primary px-3 font-semibold text-primary-foreground hover:bg-glint-hover disabled:border-border disabled:bg-surface-2',
            )}
            onClick={p.onPlayPause}
            disabled={!p.canPlay}
            aria-label={playLabel}
            title={playLabel}
            data-testid="btn-play"
          >
            {p.playing ? (
              <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
              </svg>
            ) : (
              <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
            <span className="text-label-13">{p.playing ? t('player.pause') : t('player.play')}</span>
          </button>
          <button
            type="button"
            className={btn}
            onClick={() => p.onStep(1)}
            disabled={stepNextOff}
            aria-label={t('player.next')}
            title={t('player.next')}
            data-testid="btn-next"
          >
            <svg
              className={icon}
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
          <button
            type="button"
            className={cn(btn, 'max-md:hidden')}
            onClick={p.onLast}
            aria-label={t('player.last')}
            title={t('player.last')}
            data-testid="btn-last"
          >
            <svg className={icon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M16 5h2v14h-2zM4 5v14l11-7z" />
            </svg>
          </button>
        </div>
      )}

      {!p.compact && (
        <div className="flex basis-full flex-wrap items-center justify-between gap-x-4 gap-y-1 md:justify-start">
          <div className="flex items-center gap-2">
            <span
              className="text-caption-12 font-semibold uppercase tracking-wider text-muted"
              id="speed-label"
            >
              {t('player.speed')}
            </span>
            <div
              className="flex gap-0.5 rounded-lg border border-border bg-bg p-0.5"
              role="radiogroup"
              aria-labelledby="speed-label"
            >
              {FPS_VALUES.map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={p.fps === f}
                  onClick={() => p.onFps(f)}
                  title={t('player.fps', { fps: f })}
                  className={cn(
                    'tnum min-h-[calc(var(--hit-min)-6px)] min-w-10 rounded-md px-2 text-caption-12 font-semibold transition-colors duration-(--duration-fast)',
                    p.fps === f ? 'bg-glint-soft text-glint' : 'text-muted hover:text-text',
                  )}
                  data-testid={`fps-${f}`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={p.loop}
            onClick={() => p.onLoop(!p.loop)}
            className="flex min-h-[var(--hit-min)] items-center gap-2 rounded-lg px-2 text-label-13 text-text hover:bg-surface-2"
            data-testid="loop"
          >
            <span
              className={cn(
                'relative h-5 w-9 rounded-full border transition-colors duration-(--duration-base)',
                p.loop ? 'border-glint bg-glint-soft' : 'border-border-strong bg-surface-2',
              )}
              aria-hidden="true"
            >
              <span
                className={cn(
                  'absolute top-0.5 size-3.5 rounded-full transition-all duration-(--duration-base)',
                  p.loop ? 'left-[18px] bg-glint' : 'left-0.5 bg-muted',
                )}
              />
            </span>
            {t('player.loop')}
          </button>
        </div>
      )}
    </div>
  );
}
