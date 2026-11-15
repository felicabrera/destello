// Presentational parts shared by ReportFlow (S-14) and the public report page (S-14f).
// Result badges are neutral outlines: "no match" is neither good nor bad (design S-14 self-review).
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { localNumber } from '../../lib/format';
import type {
  Lang,
  ReportCatalog,
  ReportChecks,
  ReportMark,
  ReportMotion,
  ReportVerdict,
} from '../../lib/types';
import { REPORT_CATALOGS, compass, nearestOf, searchRadius } from './reportModel';

export function VerdictBox({ verdict }: { verdict: ReportVerdict }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-border-strong bg-surface-2 p-3"
      data-testid="report-verdict"
    >
      <span className="text-body-14 font-semibold text-text">{t(`report.verdict.${verdict}.t`)}</span>
      <span className="text-label-13 text-text-2">{t(`report.verdict.${verdict}.d`)}</span>
    </div>
  );
}

export function motionText(
  t: (k: string, o?: Record<string, unknown>) => string,
  m: ReportMotion,
  lang: Lang,
) {
  return t('report.motion.line', {
    rate: localNumber(lang, m.total_arcsec_yr, m.total_arcsec_yr < 10 ? 2 : 1),
    sigma: localNumber(lang, m.sigma_arcsec_yr, m.sigma_arcsec_yr < 10 ? 2 : 1),
    pa: localNumber(lang, m.position_angle_deg, 0),
    dir: t(`report.compass.${compass(m.position_angle_deg)}`),
    n: m.n_marks,
    days: localNumber(lang, m.baseline_days, 0),
  });
}

export function MotionLine({ motion, lang }: { motion: ReportMotion; lang: Lang }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5" data-testid="report-motion">
      <span className="tnum font-mono text-label-13 text-text">{motionText(t, motion, lang)}</span>
      <span className="text-caption-12 text-muted">
        {motion.parallax_fitted ? t('report.motion.parallaxFitted') : t('report.motion.noParallax')}
      </span>
    </div>
  );
}

function radiusText(
  t: (k: string, o?: Record<string, unknown>) => string,
  cat: ReportCatalog,
  r: number | null,
  lang: Lang,
) {
  if (r === null) return '';
  const v = localNumber(lang, r, 0);
  return cat === 'sbident' ? t('report.radius.box', { r: v }) : t('report.radius.cone', { r: v });
}

export function CheckRows({
  running,
  checks,
  lang = 'en',
  epochLabel,
  marks,
}: {
  running?: boolean;
  checks?: ReportChecks;
  lang?: Lang;
  epochLabel?: (epoch: number) => string;
  marks?: ReportMark[];
}) {
  const { t } = useTranslation();
  const markLabel = (i: number) => {
    const m = marks?.find((q) => q.index === i);
    return m && epochLabel ? epochLabel(m.epoch) : `#${i + 1}`;
  };
  return (
    <ul
      className="flex flex-col divide-y divide-border rounded-lg border border-border"
      data-testid="report-checks"
    >
      {REPORT_CATALOGS.map((cat) => {
        const s = checks?.summary[cat];
        const near = nearestOf(cat, s);
        const r = searchRadius(s);
        return (
          <li key={cat} className="flex flex-col gap-1 px-3 py-2.5" data-catalog={cat}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label-13 font-medium text-text">{t(`report.cat.${cat}`)}</span>
              <span className="text-caption-12 text-muted">
                {running ? t(`report.scope.${cat}`) : radiusText(t, cat, r, lang)}
              </span>
              <span className="ml-auto">
                {running ? (
                  <span className="text-caption-12 text-muted">{t('report.searching')}</span>
                ) : (
                  s && <Badge>{t(`report.status.${s.status}`)}</Badge>
                )}
              </span>
            </div>
            {!running && s && (
              <>
                <span className="tnum font-mono text-caption-12 text-text-2">
                  {s.status === 'unavailable'
                    ? t('report.res.unavailable')
                    : near === null
                      ? t('report.res.none', { r: r === null ? '' : localNumber(lang, r, 0) })
                      : near.kind === 'body'
                        ? t('report.res.body', {
                            name: near.name,
                            sep: near.sep === null ? '?' : localNumber(lang, near.sep, 1),
                            vmag: near.vmag === null ? '?' : localNumber(lang, near.vmag, 1),
                          })
                        : t('report.res.source', {
                            id: near.id,
                            sep: localNumber(lang, near.sep, 1),
                            mag:
                              near.mag === null
                                ? ''
                                : ` · ${near.band ?? ''} ${localNumber(lang, near.mag, 1)}`,
                            mark: markLabel((s.nearest as { mark?: number } | null)?.mark ?? 0),
                          })}
                </span>
                <span className="text-caption-12 text-muted">
                  {t(`report.note.${s.status}`)}
                  {s.complete === false && s.status !== 'unavailable'
                    ? ` ${t('report.note.incomplete')}`
                    : ''}
                  {cat === 'sbident' && s.status !== 'unavailable' ? ` ${t('report.note.sbident')}` : ''}
                </span>
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}
