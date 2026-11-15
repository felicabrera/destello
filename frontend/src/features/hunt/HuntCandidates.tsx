// F-35: read-only list of the fields where volunteers agree (GET /hunt/candidates). A candidate is an agreement
// between volunteers to review, not a detection; the page says so and shows only what the server returns.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { getHuntCandidates } from '../../lib/api';
import { isDemo, useBackend } from '../../lib/backend';
import { localNumber, localPercent } from '../../lib/format';
import type { HuntCandidates as Doc } from '../../lib/hunt';
import type { Lang } from '../../lib/types';

export function HuntCandidates({ lang }: { lang: Lang }) {
  const { t } = useTranslation('hunt');
  const probed = useBackend((s) => s.probed);
  const gen = useBackend((s) => s.generation);
  const mode = useBackend((s) => s.mode);
  const q = useQuery<Doc>({
    queryKey: ['hunt', 'candidates', gen],
    queryFn: ({ signal }) => getHuntCandidates(signal),
    enabled: probed && !isDemo(mode),
    staleTime: 30_000,
    retry: false,
  });
  // No answer (demo mode, older server, error): the block is left out rather than showing an invented list.
  if (!q.data) return null;
  const list = q.data.candidates;
  return (
    <section
      aria-labelledby="hunt-cands-h"
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      data-testid="hunt-candidates"
    >
      <h2 id="hunt-cands-h" className="text-title-20 font-semibold text-text">
        {t('candidates.title')}
      </h2>
      <p className="text-body-14 text-text-2">{t('candidates.note')}</p>
      {list.length === 0 ? (
        <p className="text-body-14 text-muted" data-testid="hunt-candidates-empty">
          {t('candidates.empty')}
        </p>
      ) : (
        <table className="w-full text-left text-body-14" data-testid="hunt-candidates-table">
          <caption className="sr-only">{t('candidates.title')}</caption>
          <thead className="text-caption-12 text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('candidates.field')}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t('candidates.label')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('candidates.votes')}
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                {t('candidates.share')}
              </th>
              <th scope="col" className="py-1 font-medium">
                <span className="sr-only">{t('candidates.open')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.map((c, i) => (
              <tr key={c.field_id} className="border-t border-border" data-testid="hunt-candidate">
                <th scope="row" className="tnum py-2 pr-3 font-medium text-text">
                  {i + 1}
                </th>
                <td className="py-2 pr-3">{t(`labels.${c.label}.name`)}</td>
                <td className="tnum py-2 pr-3 text-right">{localNumber(lang, c.n_votes, 0)}</td>
                <td className="tnum py-2 pr-3 text-right">{localPercent(lang, c.share)}</td>
                <td className="py-2">
                  <Link
                    to="/"
                    search={{ seq: c.sequence_id, lang }}
                    className="text-label-13 font-medium text-cyan underline underline-offset-2"
                    aria-label={t('candidates.openField', { n: i + 1 })}
                  >
                    {t('candidates.open')}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
