import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { localNumber } from '../../lib/format';
import type { Lang, TargetItem } from '../../lib/types';
import { localUnit } from '../../lib/units';

interface Props {
  id: string;
  target: TargetItem | undefined;
  lang: Lang;
}

export const KNOWN_UNITS = new Set(['mas/yr', 'arcsec/yr', 'mag', 'percent']);

/** Result card for a preset. Text copy comes from i18n; every number comes from the API (`target.result`). */
export function ResultCard({ id, target, lang }: Props) {
  const { t } = useTranslation();
  const k = `presetCopy.${id}`;
  // The label and unit follow what the server measured. A result whose unit is not a physical quantity of the kind
  // (for example a count of difference image dipoles) is not a measurement of motion or variability and is not shown.
  const raw = target?.result ?? null;
  const r = raw && KNOWN_UNITS.has(raw.unit) ? raw : null;
  const digits = r?.unit === 'mag' ? 3 : r?.unit === 'mas/yr' ? 0 : 2;
  const badge = (() => {
    if (!r) return null;
    if (r.kind === 'variability' && r.significance_sigma != null) {
      return {
        tone: 'warning' as const,
        text: `${t('presets.variable')} · ${localNumber(lang, r.significance_sigma, 0)}σ`,
      };
    }
    if (r.kind === 'motion' && r.agreement_sigma != null) {
      const agrees = r.agreement_sigma <= 2;
      return {
        tone: agrees ? ('success' as const) : ('danger' as const),
        text: `${agrees ? t('presets.agrees') : t('presets.differs')} · ${localNumber(lang, r.agreement_sigma, 1)}σ`,
      };
    }
    return null;
  })();

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4"
      aria-labelledby={`rc-${id}`}
      data-testid="result-card"
    >
      <p className="text-caption-12 text-muted">{t(`${k}.kind`)}</p>
      <h2 id={`rc-${id}`} className="mt-0.5 text-title-20 font-medium text-text">
        {t(`${k}.headline`)}
      </h2>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('presets.lookFor')}
          </dt>
          <dd className="mt-0.5 text-body-14 text-text-2">{t(`${k}.look`)}</dd>
        </div>
        <div data-testid="result-measured">
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('presets.measured')}
          </dt>
          <dd className="mt-0.5 text-body-14 text-text-2">
            {r ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-label-13 text-muted">
                  {r.kind === 'motion'
                    ? t('presets.labelMotion')
                    : r.unit === 'mag'
                      ? t('presets.labelMag')
                      : t(`${k}.measuredLabel`)}
                </span>
                <span className="tnum text-title-20 font-medium text-text">
                  {localNumber(lang, r.value, digits)}
                  {r.err != null && (
                    <span className="text-body-14 text-muted">
                      {' '}
                      {'±'} {localNumber(lang, r.err, digits)}
                    </span>
                  )}
                </span>
                <span className="text-label-13 text-muted">{localUnit(t, r.unit)}</span>
                {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                {r.reference_value != null && (
                  <span className="tnum w-full text-caption-12 text-muted">
                    {t('presets.reference')}: {localNumber(lang, r.reference_value, digits)}
                    {r.reference_source ? ` (${r.reference_source})` : ''}
                  </span>
                )}
              </div>
            ) : (
              <span className="text-label-13 text-muted" data-testid="result-none">
                {target?.not_measurable ? t('presets.notMeasurable') : t('presets.noMeasurement')}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('presets.limit')}
          </dt>
          <dd className="mt-0.5 text-body-14 text-text-2">{t(`${k}.limit`)}</dd>
        </div>
      </dl>
    </section>
  );
}
