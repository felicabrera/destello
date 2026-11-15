// F-38: the student's result beside Destello's own fit and the Gaia DR3 catalog value. A row whose value the API
// does not give is left out. The percentage is the student's value against the row, in percent of the row.
import { useTranslation } from 'react-i18next';
import { localNumber } from '../../lib/format';
import { localUnit } from '../../lib/units';
import type { Lang } from '../../lib/types';
import { angleBetweenDeg, percentDifference, type MotionSteps, type MotionValue } from './learnModel';
import type { DestelloValue } from './useLearnReference';

export interface CompareRow {
  key: 'mine' | 'destello' | 'gaia';
  total: number;
  angleDeg: number | null;
  source?: string | null;
}

export function compareRows(
  steps: MotionSteps,
  destello: DestelloValue | null,
  gaia: (MotionValue & { source: string | null }) | null,
): CompareRow[] {
  const rows: CompareRow[] = [{ key: 'mine', total: steps.total, angleDeg: steps.angleDeg }];
  if (destello)
    rows.push({
      key: 'destello',
      total: destello.total,
      angleDeg: Number.isFinite(destello.angleDeg) ? destello.angleDeg : null,
    });
  if (gaia) rows.push({ key: 'gaia', total: gaia.total, angleDeg: gaia.angleDeg, source: gaia.source });
  return rows;
}

export function LearnCompare({
  steps,
  rows,
  lang,
  pending,
}: {
  steps: MotionSteps;
  rows: CompareRow[];
  lang: Lang;
  pending: boolean;
}) {
  const { t } = useTranslation('learn');
  const { t: tt } = useTranslation();
  const N = (v: number, d: number) => localNumber(lang, v, d);
  const na = t('compare.na');
  return (
    <section aria-labelledby="learn-cmp-h" className="flex flex-col gap-3" data-testid="learn-compare">
      <h2 id="learn-cmp-h" className="font-display text-heading-24 font-medium text-text">
        {t('compare.title')}
      </h2>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region has to take keyboard focus */}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="tnum w-full min-w-[480px] text-left text-body-14">
          <caption className="sr-only">{t('compare.caption')}</caption>
          <thead className="text-label-13 text-muted">
            <tr>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t('compare.value')}
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t('compare.total', { unit: localUnit(tt, 'arcsec/yr') })}
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                {t('compare.direction')}
              </th>
              <th scope="col" className="py-1.5 font-medium">
                {t('compare.diff')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = r.key === 'mine' ? null : percentDifference(steps.total, r.total);
              return (
                <tr key={r.key} className="border-t border-border" data-testid={`learn-cmp-${r.key}`}>
                  <th scope="row" className="py-1.5 pr-3 font-medium text-text">
                    {t(`compare.rows.${r.key}`)}
                    {r.source && (
                      <span className="block text-caption-12 font-normal text-muted">{r.source}</span>
                    )}
                  </th>
                  <td className="py-1.5 pr-3" data-testid={`learn-cmp-${r.key}-total`}>
                    {N(r.total, 2)}
                  </td>
                  <td className="py-1.5 pr-3">
                    {r.angleDeg === null
                      ? na
                      : r.key === 'mine'
                        ? `${N(r.angleDeg, 0)}°`
                        : t('compare.angle', {
                            angle: N(r.angleDeg, 0),
                            apart: N(angleBetweenDeg(steps.angleDeg, r.angleDeg), 0),
                          })}
                  </td>
                  <td className="py-1.5" data-testid={`learn-cmp-${r.key}-pct`}>
                    {r.key === 'mine'
                      ? t('compare.self')
                      : pct === null
                        ? na
                        : `${pct >= 0 ? '+' : ''}${N(pct, 1)} %`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pending && (
        <p role="status" className="text-caption-12 text-muted">
          {t('compare.loading')}
        </p>
      )}
      <p className="text-body-14 text-text-2" data-testid="learn-why">
        {t('compare.why')}
      </p>
    </section>
  );
}
