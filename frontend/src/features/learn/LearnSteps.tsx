// F-38: the arithmetic of the student's proper motion, one numbered step at a time. Every number is read from
// the MotionSteps computed in learnModel.ts (clicks and manifest times); the sentences only name them.
import { useTranslation } from 'react-i18next';
import { localDate, localNumber, mjdToDate } from '../../lib/format';
import { localUnit } from '../../lib/units';
import type { Lang } from '../../lib/types';
import { DAYS_PER_YEAR, type EpochPoint, type MotionSteps } from './learnModel';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li
      className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
      data-testid={`learn-step-${n}`}
    >
      <h3 className="text-title-20 font-semibold text-text">
        <span className="tnum text-glint">{n}.</span> {title}
      </h3>
      <div className="flex flex-col gap-2 text-body-14 text-text-2">{children}</div>
    </li>
  );
}

function Eq({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return (
    <p
      className="tnum overflow-x-auto rounded-lg bg-surface-2 px-3 py-2 font-mono text-label-13 text-text"
      data-testid={testid}
    >
      {children}
    </p>
  );
}

export function LearnSteps({
  steps,
  lang,
  missionName,
}: {
  steps: MotionSteps;
  lang: Lang;
  missionName: (p: EpochPoint) => string;
}) {
  const { t } = useTranslation('learn');
  const { t: tt } = useTranslation();
  const N = (v: number, d: number) => localNumber(lang, v, d);
  const asYr = localUnit(tt, 'arcsec/yr');
  const sec = t('units.arcsec');
  const when = (p: EpochPoint) => localDate(lang, mjdToDate(p.mjd));
  const { first, last } = steps;
  const sign = (v: number, d: number) => `${v >= 0 ? '+' : ''}${N(v, d)}`;

  return (
    <section aria-labelledby="learn-steps-h" className="flex flex-col gap-3" data-testid="learn-steps">
      <h2 id="learn-steps-h" className="font-display text-heading-24 font-medium text-text">
        {t('steps.title')}
      </h2>
      {steps.usesEnds && (
        <p className="text-body-14 text-text-2" data-testid="learn-uses-ends">
          {t('steps.usesEnds', { n: steps.nClicked })}
        </p>
      )}
      <ol className="flex flex-col gap-3">
        <Step n={1} title={t('steps.s1.title')}>
          <p>{t('steps.s1.body')}</p>
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region has to take keyboard focus */}
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="tnum w-full min-w-[420px] text-left text-label-13">
              <thead className="text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('steps.s1.epoch')}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('steps.s1.date')}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('steps.s1.ra')}
                  </th>
                  <th scope="col" className="py-1 font-medium">
                    {t('steps.s1.dec')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  { p: first, k: 'first' },
                  { p: last, k: 'last' },
                ].map(({ p, k }) => (
                  <tr key={k} className="border-t border-border" data-testid={`learn-pos-${k}`}>
                    <th scope="row" className="py-1 pr-3 font-medium text-text">
                      {t('steps.s1.epochName', { n: p.index + 1, mission: missionName(p) })}
                    </th>
                    <td className="py-1 pr-3">{when(p)}</td>
                    <td className="py-1 pr-3">{N(p.sky.ra, 5)}°</td>
                    <td className="py-1">{N(p.sky.dec, 5)}°</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Step>

        <Step n={2} title={t('steps.s2.title')}>
          <p>{t('steps.s2.body')}</p>
          <Eq testid="learn-dra">
            {t('steps.s2.dra', {
              ra2: N(last.sky.ra, 5),
              ra1: N(first.sky.ra, 5),
              deg: sign(steps.dRaDeg, 5),
              arcsec: sign(steps.dRaArcsec, 2),
              unit: sec,
            })}
          </Eq>
          <p>{t('steps.s2.cos', { dec: N(steps.decMean, 2), cos: N(steps.cosDec, 4) })}</p>
          <Eq testid="learn-dra-cos">
            {t('steps.s2.product', {
              arcsec: sign(steps.dRaArcsec, 2),
              cos: N(steps.cosDec, 4),
              result: sign(steps.dRaCosArcsec, 2),
              unit: sec,
            })}
          </Eq>
          <Eq testid="learn-ddec">
            {t('steps.s2.ddec', {
              dec2: N(last.sky.dec, 5),
              dec1: N(first.sky.dec, 5),
              deg: sign(steps.dDecDeg, 5),
              arcsec: sign(steps.dDecArcsec, 2),
              unit: sec,
            })}
          </Eq>
        </Step>

        <Step n={3} title={t('steps.s3.title')}>
          <p>
            {t('steps.s3.body', {
              first: when(first),
              last: when(last),
            })}
          </p>
          <Eq testid="learn-time">
            {t('steps.s3.eq', { days: N(steps.days, 1), dpy: N(DAYS_PER_YEAR, 2), years: N(steps.years, 3) })}
          </Eq>
        </Step>

        <Step n={4} title={t('steps.s4.title')}>
          <p>{t('steps.s4.body')}</p>
          <Eq testid="learn-pm-ra">
            {t('steps.s4.ra', {
              num: sign(steps.dRaCosArcsec, 2),
              sec,
              years: N(steps.years, 3),
              result: sign(steps.pmRa, 2),
              unit: asYr,
            })}
          </Eq>
          <Eq testid="learn-pm-dec">
            {t('steps.s4.dec', {
              num: sign(steps.dDecArcsec, 2),
              sec,
              years: N(steps.years, 3),
              result: sign(steps.pmDec, 2),
              unit: asYr,
            })}
          </Eq>
        </Step>

        <Step n={5} title={t('steps.s5.title')}>
          <p>{t('steps.s5.body')}</p>
          <Eq testid="learn-total-eq">
            {t('steps.s5.eq', {
              ra: N(steps.pmRa, 2),
              dec: N(steps.pmDec, 2),
              total: N(steps.total, 2),
              unit: asYr,
            })}
          </Eq>
          <p className="text-body-15 font-semibold text-text" data-testid="learn-result">
            {t('steps.s5.result', { total: N(steps.total, 2), unit: asYr })}
          </p>
          <p data-testid="learn-direction">
            {t('steps.s5.direction', {
              angle: N(steps.angleDeg, 0),
              compass: t(`compass.${steps.compass}`),
            })}
          </p>
        </Step>
      </ol>
    </section>
  );
}
