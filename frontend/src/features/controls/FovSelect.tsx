import { useEffect, useId, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { getEstimate } from '../../lib/api';
import { FOVS } from '../../lib/types';

interface Props {
  value: number;
  /** Position of the sequence centre, used for the estimate endpoint. */
  center: { ra: number; dec: number } | null;
  release?: string;
  /** F-31: the estimate counts the short revisits too. */
  partial?: boolean;
  /** Smallest listed FoV that keeps a fast mover in the field, when the current one loses it. */
  fastMoverNext: number | null;
  onChange: (v: number) => void;
  /** Render the option list in place, always open, without the trigger (mobile tool dialog). */
  inline?: boolean;
}

export function FovSelect({
  value,
  center,
  release,
  partial = false,
  fastMoverNext,
  onChange,
  inline = false,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<number | null>(null);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const shown = inline || open;
  const options: number[] = [...FOVS];
  if (!options.includes(value)) options.push(value);
  options.sort((a, b) => a - b);

  const estimates = useQueries({
    queries: options.map((v) => ({
      queryKey: ['estimate', center?.ra, center?.dec, v, release, partial],
      queryFn: () =>
        getEstimate({
          ra_deg: center?.ra ?? 0,
          dec_deg: center?.dec ?? 0,
          fov_arcmin: v,
          release,
          include_partial: partial,
        }),
      enabled: shown && center !== null,
      staleTime: 60_000,
      retry: false,
    })),
  });

  useEffect(() => {
    if (!open || inline) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setPending(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, inline]);

  const choose = (v: number, seconds: number | undefined) => {
    if (v === value) {
      setOpen(false);
      if (inline) onChange(v);
      return;
    }
    if (seconds !== undefined && seconds > 60 && pending !== v) {
      setPending(v);
      return;
    }
    setPending(null);
    setOpen(false);
    onChange(v);
  };

  return (
    <div ref={root} className="relative" data-testid="fov-select">
      {!inline && (
        <span
          className="mb-1.5 block text-caption-12 font-semibold uppercase tracking-wider text-muted"
          id={`${listId}-label`}
        >
          {t('fov.label')}
        </span>
      )}
      <button
        type="button"
        hidden={inline}
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={`${listId}-label ${listId}-btn`}
        id={`${listId}-btn`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        className="tnum flex min-h-[var(--hit-min)] min-w-[132px] items-center justify-between gap-3 rounded-lg border border-border-strong bg-surface-2 px-3 text-label-13 font-medium text-text hover:bg-border"
        data-testid="fov-button"
      >
        {t('fov.arcmin', { value })}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {fastMoverNext !== null && (
        <p
          className="mt-1.5 max-w-[240px] text-caption-12 text-warning"
          role="status"
          data-testid="fast-mover"
        >
          {t('fov.fastMover', { next: fastMoverNext })}
        </p>
      )}
      {shown && (
        // A disclosure with a list of buttons (not a listbox, whose options cannot contain buttons). Arrow keys move
        // between the choices and the list closes when focus leaves it.
        <ul
          id={listId}
          aria-label={t('fov.label')}
          onBlur={(e) => {
            if (inline || root.current?.contains(e.relatedTarget as Node | null)) return;
            setOpen(false);
            setPending(null);
          }}
          className={cn(
            'rounded-xl border border-border-strong bg-surface-2 p-1.5',
            inline ? 'mt-2 w-full' : 'absolute bottom-full left-0 z-30 mb-1 w-[280px] shadow-pop',
          )}
        >
          {options.map((v, i) => {
            const est = estimates[i]?.data;
            const on = v === value;
            return (
              <li key={v}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => choose(v, est?.seconds)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault();
                      const items = [...(e.currentTarget.closest('ul')?.querySelectorAll('button') ?? [])];
                      const at = items.indexOf(e.currentTarget);
                      const next =
                        items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
                      next?.focus();
                    } else if (e.key === 'Escape') {
                      setOpen(false);
                      (document.getElementById(`${listId}-btn`) as HTMLElement | null)?.focus();
                    }
                  }}
                  className={cn(
                    'flex min-h-[var(--hit-min)] w-full flex-col items-start justify-center rounded-md px-2.5 py-1 text-left hover:bg-border',
                    on && 'bg-glint-soft',
                  )}
                  data-testid={`fov-${v}`}
                >
                  <span className="tnum flex w-full items-center justify-between text-label-13 font-semibold">
                    {t('fov.arcmin', { value: v })}
                    {v === fastMoverNext && <span className="text-caption-12 text-warning">{'▲'}</span>}
                  </span>
                  <span className="tnum text-caption-12 text-muted">
                    {est
                      ? t('fov.estimate', {
                          images: est.images,
                          megabytes: est.megabytes,
                          seconds: est.seconds,
                        })
                      : t('fov.estimateNone')}
                  </span>
                  {pending === v && (
                    <span className="mt-0.5 text-caption-12 text-warning">{t('fov.confirm')}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
