import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { epochMid, isoDay, localMonthYear, mjdToDate } from '../../lib/format';
import { isLowCoverage, type EpochInfo, type Lang } from '../../lib/types';
import { LowCoverageBadge } from './LowCoverageBadge';

interface Props {
  epochs: EpochInfo[];
  /** Total expected epochs while building (shown hollow), 0 when unknown. */
  expected: number;
  index: number;
  /** Epoch indices with no frame in the selected detector (dashed). */
  missing: Set<number>;
  lang: Lang;
  onJump: (i: number) => void;
}

const PAD = 28;

export function EpochTimeline({ epochs, expected, index, missing, lang, onJump }: Props) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const mids = epochs.map((e) => epochMid(e));
  const known = mids.filter((m): m is number => m !== undefined);
  const min = known.length ? Math.min(...known) : 0;
  const max = known.length ? Math.max(...known) : 1;
  const span = max - min || 1;
  const count = Math.max(epochs.length, expected);
  // F-31: a row under the epoch labels holds the low coverage badges.
  const anyLow = epochs.some(isLowCoverage);

  const frac = (i: number): number => {
    const m = mids[i];
    if (known.length >= 2 && m !== undefined) return (m - min) / span;
    return count <= 1 ? 0.5 : i / (count - 1);
  };

  const onKey = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(epochs.length - 1, i + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = epochs.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onJump(next);
    refs.current[next]?.focus();
  };

  const pos = (f: number) => `calc(${PAD}px + (100% - ${PAD * 2}px) * ${f})`;

  return (
    <div className={cn('relative w-full', anyLow ? 'h-[92px]' : 'h-[68px]')} data-testid="timeline">
      <div
        className="absolute left-0 right-0 top-[22px] h-px bg-border-strong"
        style={{ left: PAD, right: PAD }}
        aria-hidden="true"
      />
      <div role="radiogroup" aria-label={t('player.timeline')} className="absolute inset-0">
        {Array.from({ length: count }, (_, i) => {
          const ep = epochs[i];
          const building = !ep;
          const current = i === index && !!ep;
          const miss = ep ? missing.has(ep.index) : false;
          const start = isoDay(ep?.t_start);
          const end = isoDay(ep?.t_end);
          const low = isLowCoverage(ep);
          const f = frac(i);
          const label = ep
            ? [
                t('player.timelineNode', {
                  epoch: i + 1,
                  start: start || '?',
                  end: end || '?',
                  images: ep.n_images ?? ep.frames[0]?.n_images ?? 0,
                }),
                low ? t('coverage.lowAria') : '',
                miss ? (low ? t('player.lowMissingShort') : t('player.missingInDetector')) : '',
              ]
                .filter(Boolean)
                .join('. ')
            : t('build.epochPending');
          return (
            <div key={i} className="group absolute top-0 -translate-x-1/2" style={{ left: pos(f) }}>
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={current}
                aria-label={label}
                disabled={building}
                tabIndex={current || (index < 0 && i === 0) ? 0 : -1}
                onClick={() => onJump(i)}
                onKeyDown={(e) => onKey(e, i)}
                className="grid min-h-[var(--hit-min)] min-w-[var(--hit-min)] place-items-center rounded-full"
                data-testid={`epoch-node-${i + 1}`}
              >
                <span
                  className={cn(
                    'block rounded-full border-2 transition-all duration-(--duration-fast)',
                    current
                      ? 'size-[18px] border-glint bg-glint shadow-[0_0_0_4px_var(--glint-soft)]'
                      : 'size-3.5 border-text bg-bg hover:border-glint',
                    miss && 'border-dashed border-muted',
                    building && 'border-dashed border-border-strong motion-safe:animate-pulse',
                  )}
                />
              </button>
              <span
                className={cn(
                  'tnum block text-center text-caption-12 font-semibold',
                  current ? 'text-glint' : 'text-text-2',
                )}
                aria-hidden="true"
              >
                E{i + 1}
              </span>
              {low && (
                <span
                  className={cn(
                    'absolute top-[62px]',
                    f < 0.15 ? 'left-0' : f > 0.85 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                  )}
                  aria-hidden="true"
                >
                  <LowCoverageBadge
                    testId={`epoch-low-${i + 1}`}
                    className={current ? 'text-glint' : 'text-text-2'}
                  />
                </span>
              )}
              <span
                role="tooltip"
                className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-max max-w-[220px] -translate-x-1/2 rounded-md border border-border-strong bg-surface-2 px-2.5 py-1.5 text-caption-12 text-text shadow-pop group-focus-within:block group-hover:block"
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
      {known.length >= 1 && (
        <div
          className="tnum absolute inset-x-0 bottom-0 flex justify-between px-1 text-caption-12 text-muted"
          aria-hidden="true"
        >
          <span>{localMonthYear(lang, mjdToDate(min))}</span>
          <span>{known.length >= 2 ? localMonthYear(lang, mjdToDate(max)) : ''}</span>
        </div>
      )}
    </div>
  );
}
