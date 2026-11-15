// Progressive disclosure for the options that rarely change: field of view, data release and short revisits.
// Closed by default; it opens by itself when the URL holds a non-default value, so a shared link never hides the
// setting that makes the view differ. The open state is local, not part of the URL.
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

interface Props {
  fov: number;
  release: string | undefined;
  partial: boolean;
  /** True when any of the three values differs from its default (the URL carries it). */
  nonDefault: boolean;
  children: ReactNode;
}

export function DataOptions({ fov, release, partial, nonDefault, children }: Props) {
  const { t } = useTranslation();
  const panelId = useId();
  const [open, setOpen] = useState(nonDefault);
  useEffect(() => {
    if (nonDefault) setOpen(true);
  }, [nonDefault]);

  const parts = [
    t('fov.arcmin', { value: fov }),
    release ? release : t('options.summaryAll'),
    ...(partial ? [t('options.summaryPartial')] : []),
  ];

  return (
    <div className="flex w-full flex-col gap-3" data-testid="data-options">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-[var(--hit-min)] w-full items-center gap-2 rounded-lg px-1 text-left hover:bg-surface-2"
        data-testid="data-options-toggle"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={cn(
            'flex-none text-muted transition-transform duration-(--duration-fast)',
            open && 'rotate-90',
          )}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
          {t('options.title')}
        </span>
        {!open && (
          <span className="min-w-0 truncate text-label-13 text-text-2" data-testid="data-options-summary">
            {parts.join(', ')}
          </span>
        )}
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="flex flex-wrap items-start gap-x-6 gap-y-4 pl-1"
        data-testid="data-options-panel"
      >
        {children}
      </div>
    </div>
  );
}
