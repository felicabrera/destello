import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useMovers } from '../comet/useComet';
import { cn } from '../../lib/cn';
import { PRESETS, type Glyph } from '../../lib/presets';

function GlyphIcon({ g }: { g: Glyph }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      className="flex-none"
      aria-hidden="true"
    >
      {g === 'barnard' && (
        <>
          <circle cx="8" cy="4.5" r="2.4" fill="currentColor" stroke="none" />
          <rect x="6.5" y="10.5" width="3" height="3" opacity=".55" />
        </>
      )}
      {g === 'wise' && (
        <>
          <circle cx="11.5" cy="8" r="1.8" fill="currentColor" stroke="none" />
          <rect x="2.5" y="6.5" width="3" height="3" opacity=".55" />
        </>
      )}
      {g === 'eps' && (
        <>
          <circle cx="6.3" cy="8" r="2.6" />
          <circle cx="9.7" cy="8" r="2.6" />
        </>
      )}
      {g === 'rwaur' && (
        <>
          <circle cx="8" cy="8" r="2.4" fill="currentColor" stroke="none" />
          <path d="M2 11 L14 5" strokeDasharray="2 1.5" />
        </>
      )}
      {g === 'rdra' && (
        <>
          <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="4.6" />
          <circle cx="8" cy="8" r="7" opacity=".45" />
        </>
      )}
    </svg>
  );
}

interface Props {
  selectedId: string | undefined;
  building: boolean;
  onSelect: (id: string) => void;
  /** Hero variant shows the "Pick a target" prompt instead of the "Presets" label. */
  label: string;
  /** F-28: open a random field from the curated list. */
  onSurprise?: () => void;
  /** Why "Surprise me" is unavailable (demo mode); the button stays focusable and explains itself. */
  surpriseOff?: string | null;
}

export function PresetChips({ selectedId, building, onSelect, label, onSurprise, surpriseOff }: Props) {
  const { t } = useTranslation();
  const { t: tc, i18n } = useTranslation('comet');
  const hasComet = (useMovers().data?.length ?? 0) > 0;
  return (
    <div
      className="flex min-w-0 items-center gap-2"
      role="group"
      aria-label={t('presets.label')}
      data-testid="preset-chips"
      data-tour="presets"
    >
      <span className="hidden whitespace-nowrap text-caption-12 font-semibold uppercase tracking-wider text-muted md:inline">
        {label}
      </span>
      <div className="scroll-x-hide -mx-4 flex min-w-0 gap-2 overflow-x-auto px-4 py-1 [scroll-snap-type:x_proximity] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
        {PRESETS.map((p) => {
          const on = selectedId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              aria-busy={on && building ? true : undefined}
              onClick={() => onSelect(p.id)}
              className={cn(
                'flex min-h-[var(--hit-min)] flex-none items-center gap-2 whitespace-nowrap rounded-lg border px-3 text-body-14 [scroll-snap-align:start] transition-colors duration-(--duration-fast)',
                on
                  ? 'border-glint bg-glint-soft font-semibold text-text'
                  : 'border-border-strong bg-transparent font-medium text-text hover:bg-surface-2',
              )}
              data-testid={`chip-${p.id}`}
            >
              <GlyphIcon g={p.glyph} />
              {t(`presetCopy.${p.id}.chip`)}
            </button>
          );
        })}
        {hasComet && (
          <Link
            to="/comet"
            search={{ lang: i18n.language === 'es' ? 'es' : 'en' }}
            className="flex min-h-[var(--hit-min)] flex-none items-center gap-2 whitespace-nowrap rounded-lg border border-border-strong bg-transparent px-3 text-body-14 font-medium text-text [scroll-snap-align:start] transition-colors duration-(--duration-fast) hover:bg-surface-2"
            data-testid="chip-comet"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              className="flex-none"
              aria-hidden="true"
            >
              <circle cx="11" cy="5" r="2.4" fill="currentColor" stroke="none" />
              <path d="M9.4 6.6 L2.5 13.5 M10 8 L5 13 M8 6 L13 11" opacity=".55" />
            </svg>
            {tc('chip')}
          </Link>
        )}
        {onSurprise && (
          <button
            type="button"
            onClick={surpriseOff ? undefined : onSurprise}
            aria-disabled={surpriseOff ? true : undefined}
            aria-describedby={surpriseOff ? 'surprise-off' : undefined}
            title={surpriseOff ?? t('surprise.hint')}
            className={cn(
              'flex min-h-[var(--hit-min)] flex-none items-center gap-2 whitespace-nowrap rounded-lg border border-dashed px-3 text-body-14 font-medium [scroll-snap-align:start] transition-colors duration-(--duration-fast)',
              surpriseOff
                ? 'border-border text-disabled'
                : 'border-border-strong bg-transparent text-text hover:bg-surface-2',
            )}
            data-testid="surprise-btn"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              className="flex-none"
              aria-hidden="true"
            >
              <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
              <circle cx="5.5" cy="5.5" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="10.5" cy="10.5" r="0.9" fill="currentColor" stroke="none" />
              <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
            </svg>
            {t('surprise.button')}
          </button>
        )}
        {onSurprise && surpriseOff && (
          <span id="surprise-off" className="sr-only">
            {surpriseOff}
          </span>
        )}
      </div>
    </div>
  );
}
