// F-31: opt in to short survey revisits. They are built as extra epochs labelled low coverage, shown in the
// player and never used in measurements. The choice is the `partial=1` URL key and part of the sequence id.
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Mobile tool dialog: no uppercase heading, help text below. */
  inline?: boolean;
}

export function PartialToggle({ on, onChange, inline = false }: Props) {
  const { t } = useTranslation();
  const helpId = useId();
  return (
    <div
      className={cn('flex flex-col', inline ? 'gap-1.5' : 'max-w-[260px] gap-1')}
      data-testid="partial-control"
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby={helpId}
        onClick={() => onChange(!on)}
        className={cn(
          'flex min-h-[var(--hit-min)] items-center gap-2 self-start rounded-lg border px-2.5 text-left text-label-13 font-medium transition-colors duration-(--duration-fast)',
          on
            ? 'border-glint bg-glint-soft text-text'
            : 'border-border-strong bg-surface-2 text-text hover:bg-border',
        )}
        data-testid="partial-toggle"
      >
        <span
          aria-hidden="true"
          className={cn(
            'grid size-4 flex-none place-items-center rounded border',
            on ? 'border-glint bg-primary text-primary-foreground' : 'border-border-strong bg-surface',
          )}
        >
          {on && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.5"
            >
              <path d="m5 12 5 5 9-10" />
            </svg>
          )}
        </span>
        {t('partial.label')}
      </button>
      <p id={helpId} className="text-caption-12 text-muted" data-testid="partial-help">
        {t('partial.help')}
      </p>
    </div>
  );
}
