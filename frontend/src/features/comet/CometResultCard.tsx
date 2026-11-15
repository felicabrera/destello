// F-33 result card. Built only from measurements read from the API (manifest, ephemeris check, spectrum bands,
// validation rows). The CO2 line states a detection nowhere: it is a measurement or "not measurable".
import { useTranslation } from 'react-i18next';
import { localDate, localNumber } from '../../lib/format';
import type { Lang, Manifest, MoverEphemerisCheck, MoverSpectrum, ValidationReport } from '../../lib/types';
import { bandDifference, bandStatus, checkFor, validationRow } from './cometModel';

interface Props {
  lang: Lang;
  manifest: Manifest;
  spectrum: MoverSpectrum | undefined;
  check: MoverEphemerisCheck | undefined;
  report: ValidationReport | null | undefined;
  campaign: number;
}

export function campaignLabel(lang: Lang, c: { t_start: string; t_end: string }): string {
  const f = (iso: string) => localDate(lang, new Date(iso));
  return `${f(c.t_start)} - ${f(c.t_end)}`;
}

export function CometResultCard({ lang, manifest, spectrum, check, report, campaign }: Props) {
  const { t } = useTranslation('comet');
  const mt = manifest.moving_target;
  const camp = mt?.campaigns.find((c) => c.index === campaign) ?? mt?.campaigns[0];
  const chk = checkFor(check, campaign);
  const co2 = bandStatus(spectrum, campaign, 'co2');
  const v13 = validationRow(report, 'V-13', manifest.sequence_id, campaign);
  const statusWord =
    v13?.status === 'pass'
      ? t('spectrum.v13Pass')
      : v13?.status === 'fail'
        ? t('spectrum.v13Fail')
        : v13?.status === 'not_measurable'
          ? t('spectrum.v13NotMeasurable')
          : t('spectrum.v13Unknown');
  return (
    <section
      className="rounded-xl border border-border bg-surface p-4"
      aria-labelledby="comet-rc-h"
      data-testid="comet-result-card"
    >
      <p className="text-caption-12 text-muted">{t('result.kind')}</p>
      <h2 id="comet-rc-h" className="mt-0.5 text-title-20 font-medium text-text">
        {t('result.headline')}
      </h2>
      <dl className="mt-3 space-y-3">
        <div>
          <dd className="text-body-14 text-text-2">{t('result.look')}</dd>
        </div>
        <div data-testid="comet-measured">
          <dt className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('result.measured')}
          </dt>
          <dd className="mt-0.5 flex flex-col gap-1 text-body-14 text-text-2">
            {camp && (
              <span data-testid="comet-n">
                {t('result.exposures', { n: camp.n_images, label: campaignLabel(lang, camp) })}
              </span>
            )}
            {chk && chk.n_measured > 0 && (
              <span data-testid="comet-v14">
                {t('result.check', {
                  within: chk.n_within,
                  measured: chk.n_measured,
                  median: localNumber(lang, chk.median_offset_arcsec ?? 0, 2),
                })}
              </span>
            )}
            {mt && mt.campaigns.length > 0 && (
              <span data-testid="comet-campaigns">
                {t('result.campaigns', { list: mt.campaigns.map((c) => campaignLabel(lang, c)).join('; ') })}
              </span>
            )}
            {co2.state === 'not_measurable' && <span data-testid="comet-co2">{t('result.co2')}</span>}
            {co2.state === 'measured' && co2.band && bandDifference(co2.band) && (
              <span data-testid="comet-co2">
                {t('result.co2Difference', {
                  band: localNumber(lang, (bandDifference(co2.band)?.band ?? 0) * 1000, 1),
                  upper: localNumber(lang, (bandDifference(co2.band)?.upper ?? 0) * 1000, 1),
                  sig: localNumber(lang, co2.band.significance ?? 0, 1),
                  status: statusWord,
                })}
              </span>
            )}
            {co2.state === 'measured' && co2.band && !bandDifference(co2.band) && (
              <span data-testid="comet-co2">
                {t('result.co2Measured', {
                  excess: localNumber(lang, co2.band.excess ?? 0, 3),
                  err: localNumber(lang, co2.band.excess_err ?? 0, 3),
                  sig: localNumber(lang, co2.band.significance ?? 0, 1),
                  status: statusWord,
                })}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dd className="text-body-14 text-text-2">{t('result.limit')}</dd>
        </div>
      </dl>
    </section>
  );
}
