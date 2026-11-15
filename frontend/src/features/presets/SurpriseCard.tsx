import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { localNumber } from '../../lib/format';
import { surpriseField } from '../../lib/surprise';
import type { Lang } from '../../lib/types';

interface Props {
  id: string;
  lang: Lang;
  onAnother: () => void;
}

/**
 * F-28 card for a "Surprise me" field: why the object is interesting, the catalog the position comes from and its
 * reference epoch. Every number shown is copied from the catalog entry in `lib/surprise.ts`.
 */
export function SurpriseCard({ id, lang, onAnother }: Props) {
  const { t } = useTranslation();
  const f = surpriseField(id);
  if (!f) return null;
  const k = `surprise.items.${id}`;
  const hasPm = f.pmra_masyr != null && f.pmdec_masyr != null;
  const pmTotal = hasPm ? Math.hypot(f.pmra_masyr as number, f.pmdec_masyr as number) : null;
  return (
    <section
      className="rounded-xl border border-border bg-surface p-4"
      aria-labelledby={`sc-${id}`}
      data-testid="surprise-card"
    >
      <p className="text-caption-12 text-muted">{t(`surprise.kind.${f.kind}`)}</p>
      <h2 id={`sc-${id}`} className="mt-0.5 text-title-20 font-medium text-text">
        {t(`${k}.name`)}
      </h2>
      <dl className="mt-3 space-y-3">
        <div>
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('surprise.why')}
          </dt>
          <dd className="mt-0.5 text-body-14 text-text-2">{t(`${k}.why`)}</dd>
        </div>
        <div data-testid="surprise-catalog">
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('surprise.position')}
          </dt>
          <dd className="mt-0.5 text-body-14 text-text-2">
            <span className="tnum font-mono text-body-14">{f.catalog}</span>
            {', '}
            {t('surprise.refEpoch', { epoch: f.ref_epoch })}
          </dd>
          <dd className="mt-0.5 text-body-14 text-text-2">
            {pmTotal != null
              ? t('surprise.pm', { value: localNumber(lang, pmTotal / 1000, 2) })
              : t('surprise.noPm')}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-caption-12 text-muted">{t('surprise.coverage')}</p>
      <div className="mt-3">
        <Button onClick={onAnother} data-testid="surprise-another">
          {t('surprise.another')}
        </Button>
      </div>
    </section>
  );
}
