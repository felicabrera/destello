// F-35 Hunt: public counters. Totals only; nothing here identifies a person.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { getHuntCounters } from '../../lib/api';
import { useBackend, isDemo } from '../../lib/backend';
import { goldAccuracyPercent, type HuntCounters as Counters } from '../../lib/hunt';
import { localPercent } from '../../lib/format';
import type { Lang } from '../../lib/types';

export function useHuntCounters() {
  const probed = useBackend((s) => s.probed);
  const gen = useBackend((s) => s.generation);
  const mode = useBackend((s) => s.mode);
  return useQuery<Counters>({
    queryKey: ['hunt', 'counters', gen],
    queryFn: ({ signal }) => getHuntCounters(signal),
    enabled: probed && !isDemo(mode),
    staleTime: 30_000,
    retry: false,
  });
}

/** `compact` is the block on the home page: one line of totals and a link to the Hunt page. */
export function HuntCounters({ compact = false, lang }: { compact?: boolean; lang: Lang }) {
  const { t } = useTranslation('hunt');
  const q = useHuntCounters();
  const probed = useBackend((s) => s.probed);
  const c = q.data;
  // While the totals are on their way the compact block keeps its space, so that the page below does not move
  // when they arrive. It is released when the server gives no answer.
  if (!c && compact && (!probed || q.isFetching))
    return (
      <div aria-hidden="true" className="min-h-[var(--hunt-compact-h)]" data-testid="hunt-counters-reserve" />
    );
  // Without an answer (older server, demo mode) the block is not shown: it never invents numbers.
  if (!c) return null;
  const acc = goldAccuracyPercent(c);
  const items: { id: string; label: string; value: string }[] = [
    { id: 'fields', label: t('counters.fieldsReviewed'), value: String(c.fields_reviewed) },
    { id: 'votes', label: t('counters.classifications'), value: String(c.classifications) },
    {
      id: 'gold',
      label: t('counters.goldAccuracy'),
      value: acc === null ? t('counters.none') : localPercent(lang, c.gold_accuracy ?? 0),
    },
    { id: 'countries', label: t('counters.countries'), value: String(c.countries) },
  ];
  return (
    <section
      aria-labelledby={compact ? 'hunt-counters-compact' : 'hunt-counters'}
      className={
        compact
          ? 'flex flex-col gap-1.5'
          : 'flex flex-col gap-3 rounded-xl border border-border bg-surface p-4'
      }
      data-testid={compact ? 'hunt-counters-compact' : 'hunt-counters'}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id={compact ? 'hunt-counters-compact' : 'hunt-counters'}
          className={
            compact ? 'text-label-13 font-semibold text-text' : 'text-title-20 font-semibold text-text'
          }
        >
          {t('counters.title')}
        </h2>
        {compact && (
          <Link
            to="/hunt"
            className="text-label-13 font-medium text-cyan underline underline-offset-2"
            data-testid="hunt-open"
          >
            {t('counters.open')}
          </Link>
        )}
      </div>
      <dl className={compact ? 'flex flex-wrap gap-x-5 gap-y-1' : 'grid grid-cols-2 gap-3 md:grid-cols-4'}>
        {items.map((i) => (
          <div key={i.id} className="flex flex-col" data-testid={`counter-${i.id}`}>
            <dt className="text-caption-12 text-muted">{i.label}</dt>
            <dd className={compact ? 'tnum text-label-13 font-semibold' : 'tnum text-heading-24 font-medium'}>
              {i.value}
            </dd>
          </div>
        ))}
      </dl>
      {!compact && <p className="text-caption-12 text-muted">{t('counters.note')}</p>}
    </section>
  );
}
