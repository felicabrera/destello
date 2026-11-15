// S-15 and S-22: validation page. Rendered only from the validation.json served by the API (GET /validation).
// No number on this page is written in the source. If the endpoint has no run, an unavailable state is shown.
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Data } from 'plotly.js';
import { PlotlyChart } from '../../components/PlotlyChart';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { getValidation } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import { localDate, localNumber } from '../../lib/format';
import { EPOCH_SYMBOLS, cssVar, destelloConfig, destelloLayout, epochColor } from '../../lib/plotly';
import { localUnit } from '../../lib/units';
import type { Lang, ValidationReport, ValidationTest } from '../../lib/types';
import { useView } from '../explorer/useView';
import { localizedCriterion, localizedReason, localizedSource, localizedTestName } from './validationCopy';
import { limitFacts } from './validationLimits';

const TONE = { pass: 'success', fail: 'danger', not_measurable: 'neutral' } as const;
const MARK = { pass: '✓', fail: '×', not_measurable: '?' } as const;

function num(
  t: TFunction,
  lang: Lang,
  v: number | null | undefined,
  unit?: string | null,
  err?: number | null,
): string {
  if (v == null) return '';
  const d = unit === 'count' || Math.abs(v) >= 100 ? 0 : unit === 'index' ? 3 : Math.abs(v) >= 1 ? 2 : 3;
  const e = err != null ? ` ± ${localNumber(lang, err, d)}` : '';
  // "count" is a bare tally of detections and "index" a dimensionless ratio: neither has a unit.
  const u = unit && unit !== 'count' && unit !== 'index' ? ` ${localUnit(t, unit)}` : '';
  return `${localNumber(lang, v, d)}${e}${u}`;
}

function ResidualPlot({ r, lang }: { r: NonNullable<ValidationReport['residuals']>[number]; lang: Lang }) {
  const { t, i18n } = useTranslation();
  const name = i18n.exists(`presetCopy.${r.target}.name`) ? t(`presetCopy.${r.target}.name`) : r.target;
  const plot = useMemo(() => {
    const layout = destelloLayout(lang, t('meas.resX'), t('meas.resY'));
    layout.showlegend = true;
    layout.hovermode = 'closest';
    layout.margin = { l: 56, r: 12, t: 36, b: 48 };
    layout.xaxis = {
      ...layout.xaxis,
      tickmode: 'array',
      tickvals: r.epochs.map((e) => e.t_mid_mjd),
      ticktext: r.epochs.map((e) => `E${e.index + 1}`),
    };
    layout.yaxis = {
      ...layout.yaxis,
      zeroline: true,
      zerolinecolor: cssVar('border-strong'),
      exponentformat: 'none',
    };
    const mk = (i: number, n: string, ys: number[]): Partial<Data> => ({
      type: 'scatter',
      mode: 'markers',
      name: n,
      x: r.epochs.map((e) => e.t_mid_mjd),
      y: ys,
      marker: {
        color: epochColor(i),
        size: 8,
        symbol: EPOCH_SYMBOLS[i],
        line: { color: cssVar('surface'), width: 1 },
      },
      hovertemplate: `${n}: %{y:.2f} arcsec<extra></extra>`,
    });
    return {
      traces: [
        mk(
          0,
          'RA*',
          r.epochs.map((e) => e.dra_arcsec),
        ),
        mk(
          1,
          'Dec',
          r.epochs.map((e) => e.ddec_arcsec),
        ),
      ],
      layout,
    };
  }, [r, lang, t]);
  const config = useMemo(() => destelloConfig(lang, `destello-residuals-${r.target}`), [lang, r.target]);
  return (
    <figure className="rounded-xl border border-border bg-surface p-3" data-testid="validation-residuals">
      <figcaption className="text-label-13 font-semibold text-text">{name}</figcaption>
      <PlotlyChart
        data={plot.traces}
        layout={plot.layout}
        config={config}
        label={t('val.resAria', { name })}
        height={240}
      />
    </figure>
  );
}

export function ValidationPage() {
  const { t, i18n } = useTranslation();
  const { view, update } = useView();
  const lang = view.lang;
  const gen = useBackend((s) => s.generation);
  const probed = useBackend((s) => s.probed);
  const q = useQuery({
    queryKey: ['validation', gen],
    queryFn: getValidation,
    enabled: probed,
    staleTime: 60_000,
    retry: 1,
  });
  const light = view.theme === 'light';

  useEffect(() => {
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [light]);

  const data = q.data;
  const nPass = data?.tests.filter((x) => x.status === 'pass').length ?? 0;
  const nFail = data?.tests.filter((x) => x.status === 'fail').length ?? 0;
  const nNm = data?.tests.filter((x) => x.status === 'not_measurable').length ?? 0;
  const resPlots = data?.residuals?.filter((r) => r.epochs.length >= 3) ?? [];
  const resSkipped = (data?.residuals?.length ?? 0) > resPlots.length;
  // Measured lines of the limits section: read from the report, absent when it lacks the tests.
  const facts = limitFacts(data?.tests ?? []);
  const n = (v: number, digits: number) => localNumber(lang, v, digits);
  const limitLines: Record<'l1' | 'l2' | 'l3', string[]> = {
    l1: [
      facts.epochs &&
        t('val.limits.l1.mEpochs', { min: n(facts.epochs.min, 0), max: n(facts.epochs.max, 0) }),
      facts.motion &&
        t('val.limits.l1.mMotion', { min: n(facts.motion.min * 100, 0), max: n(facts.motion.max * 100, 0) }),
    ].filter((x): x is string => Boolean(x)),
    l2: [
      facts.centroid &&
        t('val.limits.l2.mCentroid', {
          median: n(facts.centroid.median, 1),
          fraction: n(facts.centroid.pixelFraction, 2),
          max: n(facts.centroid.max, 1),
        }),
    ].filter((x): x is string => Boolean(x)),
    l3: [
      facts.astrometry &&
        t('val.limits.l3.mAstrometry', {
          before: n(facts.astrometry.before, 2),
          after: n(facts.astrometry.after, 2),
        }),
      facts.flux &&
        t('val.limits.l3.mFlux', {
          min: n(facts.flux.min, 2),
          max: n(facts.flux.max, 2),
          stars: n(facts.flux.stars, 0),
        }),
    ].filter((x): x is string => Boolean(x)),
  };
  const targetName = (id: string) =>
    i18n.exists(`val.targets.${id}`)
      ? t(`val.targets.${id}`)
      : i18n.exists(`presetCopy.${id}.name`)
        ? t(`presetCopy.${id}.name`)
        : id;

  const card = (x: ValidationTest) => {
    // A published value of zero is the expected null (an offset, a residual, a count of false detections), not a
    // literature measurement: it is stated by the criterion, so it is not repeated as a "published" figure.
    const showRef = x.reference != null && x.reference !== 0;
    const meta = [
      x.id,
      targetName(x.target),
      x.epochs_used != null ? `${t('val.colEpochs')} ${x.epochs_used}` : null,
      x.detector != null ? (typeof x.detector === 'number' ? `D${x.detector}` : x.detector) : null,
    ].filter(Boolean);
    const metric = (label: string, value: string, testid?: string) => (
      <div className="min-w-0">
        <dt className="text-caption-12 text-muted">{label}</dt>
        <dd
          className="tnum text-body-14 font-semibold text-text [overflow-wrap:anywhere]"
          data-testid={testid}
        >
          {value}
        </dd>
      </div>
    );
    return (
      <li
        key={`${x.id}-${x.target}`}
        className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface p-4"
        data-testid="validation-row"
        data-status={x.status}
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-[12rem]">
            <h3 className="text-body-15 font-semibold text-text [overflow-wrap:anywhere]">
              {localizedTestName(t, lang, x)}
            </h3>
            <p className="mt-0.5 text-caption-12 text-muted [overflow-wrap:anywhere]">{meta.join(' · ')}</p>
          </div>
          <Badge tone={TONE[x.status]}>
            <span aria-hidden="true">{MARK[x.status]}</span>
            {t(`val.status.${x.status}`)}
          </Badge>
        </div>
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-4 gap-y-2">
          {metric(
            t('val.colMeasured'),
            num(t, lang, x.measured, x.unit, x.err) || '-',
            'validation-measured',
          )}
          {showRef &&
            metric(
              t(x.source === 'field_stars_gaia' ? 'val.colFieldMedian' : 'val.colReference'),
              num(t, lang, x.reference, x.unit),
              'validation-reference',
            )}
          {x.sigma != null &&
            metric(
              t('val.colSigma'),
              t('val.sigma', { n: localNumber(lang, x.sigma, 1) }),
              'validation-sigma',
            )}
        </dl>
        <dl className="flex flex-col gap-2 border-t border-border pt-3 text-label-13">
          <div className="min-w-0">
            <dt className="text-caption-12 text-muted">{t('val.colCriterion')}</dt>
            <dd className="text-text-2 [overflow-wrap:anywhere]" data-testid="validation-criterion">
              {localizedCriterion(t, lang, x)}
            </dd>
          </div>
          {x.reason && (
            <div className="min-w-0">
              <dt className="text-caption-12 text-muted">{t('val.colResult')}</dt>
              <dd className="text-text-2 [overflow-wrap:anywhere]" data-testid="validation-reason">
                {localizedReason(t, lang, x)}
              </dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-caption-12 text-muted">{t('val.colSource')}</dt>
            <dd className="text-text-2 [overflow-wrap:anywhere]">{localizedSource(t, lang, x)}</dd>
          </div>
        </dl>
      </li>
    );
  };

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto max-w-[1100px] px-4 py-10 md:px-6"
      data-testid="page-validation"
    >
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="text-caption-12 font-semibold uppercase tracking-wider text-glint">
            {t('val.kicker')}
          </p>
          <div
            role="radiogroup"
            aria-label={t('share.theme')}
            className="flex overflow-hidden rounded-md border border-border-strong"
          >
            {(['dark', 'light'] as const).map((th) => (
              <button
                key={th}
                type="button"
                role="radio"
                aria-checked={light === (th === 'light')}
                onClick={() => update({ theme: th === 'dark' ? undefined : th })}
                className={`min-h-[var(--hit-min)] px-3 text-label-13 ${light === (th === 'light') ? 'bg-glint-soft font-semibold text-glint' : 'text-text'}`}
                data-testid={`val-theme-${th}`}
              >
                {t(`share.${th}`)}
              </button>
            ))}
          </div>
        </div>
        <h1 className="font-display text-display-32 font-medium md:text-display-48">{t('val.title')}</h1>
        <p className="max-w-[680px] text-body-15 text-text-2">{t('val.lead')}</p>
      </header>

      {q.isPending && probed && (
        <p className="mt-10 text-body-14 text-muted" role="status" data-testid="validation-loading">
          {t('val.loading')}
        </p>
      )}
      {q.isError && (
        <div
          className="mt-10 rounded-xl border border-danger p-4"
          role="alert"
          data-testid="validation-error"
        >
          <p className="text-body-14">{t('val.errorBody')}</p>
          <Button variant="secondary" className="mt-3" onClick={() => void q.refetch()}>
            {t('val.retry')}
          </Button>
        </div>
      )}
      {q.isSuccess && !data && (
        <section
          className="mt-10 rounded-xl border border-border-strong bg-surface p-5"
          data-testid="validation-unavailable"
        >
          <h2 className="text-title-20 font-medium">{t('val.unavailTitle')}</h2>
          <p className="mt-2 max-w-[560px] text-body-14 text-text-2">{t('val.unavailBody')}</p>
          <Link to="/" className="mt-4 inline-block text-label-13 text-cyan underline underline-offset-2">
            {t('pages.back')}
          </Link>
        </section>
      )}

      {data && (
        <>
          <p className="tnum mt-6 text-label-13 text-muted" data-testid="validation-run">
            {t('val.run', {
              date: localDate(lang, new Date(data.generated_at)),
              version: data.pipeline_version,
              release: data.release ?? t('val.noRelease'),
            })}
          </p>
          <section aria-labelledby="val-tests" className="mt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="val-tests" className="font-display text-heading-24 font-medium">
                {t('val.tableTitle')}
              </h2>
              <p className="tnum text-label-13 font-semibold text-text" data-testid="validation-summary">
                {t('val.summary', { pass: nPass, total: data.tests.length })}
                <span className="ml-2 font-normal text-muted" data-testid="validation-breakdown">
                  {t('val.summaryAll', { pass: nPass, fail: nFail, nm: nNm })}
                </span>
              </p>
            </div>
            <ul className="mt-3 grid gap-3 lg:grid-cols-2" data-testid="validation-tests">
              {data.tests.map(card)}
            </ul>
            <p className="mt-2 max-w-[680px] text-caption-12 text-muted">{t('val.caption')}</p>
            {nFail > 0 && (
              <p className="mt-2 max-w-[680px] text-label-13 text-text-2" data-testid="validation-failnote">
                {t('val.failNote')}
              </p>
            )}
          </section>

          {resPlots.length > 0 && (
            <section aria-labelledby="val-res" className="mt-10">
              <h2 id="val-res" className="font-display text-heading-24 font-medium">
                {t('val.resTitle')}
              </h2>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {resPlots.map((r) => (
                  <ResidualPlot key={r.target} r={r} lang={lang} />
                ))}
              </div>
              <p className="mt-2 text-caption-12 text-muted">{t('val.resNote')}</p>
              {resSkipped && <p className="mt-1 text-caption-12 text-muted">{t('val.resTwo')}</p>}
            </section>
          )}
        </>
      )}

      <section aria-labelledby="val-limits" className="mt-10">
        <h2 id="val-limits" className="font-display text-heading-24 font-medium">
          {t('val.limitsTitle')}
        </h2>
        <p className="mt-2 max-w-[680px] text-label-13 text-text-2">{t('val.limitsIntro')}</p>
        <dl className="mt-3 grid gap-3 lg:grid-cols-3" data-testid="validation-limits">
          {(['l1', 'l2', 'l3'] as const).map((k) => (
            <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-3">
              <dt className="text-label-13 font-semibold text-text">{t(`val.limits.${k}.t`)}</dt>
              <dd className="mt-1 text-label-13 text-text-2">{t(`val.limits.${k}.b`)}</dd>
              <dd className="mt-2 text-label-13 text-text-2">
                <span className="block text-caption-12 font-semibold text-text">{t('val.limitsDoes')}</span>
                {t(`val.limits.${k}.d`)}
              </dd>
              {limitLines[k].length > 0 && (
                <dd className="mt-2 text-label-13 text-text" data-testid={`validation-limit-measured-${k}`}>
                  <span className="block text-caption-12 font-semibold text-text">
                    {t('val.limitsMeasured')}
                  </span>
                  {limitLines[k].map((line) => (
                    <span key={line} className="block">
                      {line}
                    </span>
                  ))}
                </dd>
              )}
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="val-rules" className="mt-10">
        <h2 id="val-rules" className="font-display text-heading-24 font-medium">
          {t('val.rulesTitle')}
        </h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="validation-rules">
          {(['l4', 'l5'] as const).map((k) => (
            <div key={k} className="min-w-0 rounded-lg border border-border bg-surface p-3">
              <dt className="text-label-13 font-semibold text-text">{t(`val.limits.${k}.t`)}</dt>
              <dd className="mt-1 text-label-13 text-text-2">{t(`val.limits.${k}.b`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="methods" aria-labelledby="val-methods" className="mt-10">
        <h2 id="val-methods" className="font-display text-heading-24 font-medium">
          {t('val.methodsTitle')}
        </h2>
        <ol className="mt-3 flex flex-col gap-3">
          {(['m1', 'm2', 'm3', 'm4', 'm5'] as const).map((k, i) => (
            <li key={k} className="flex gap-3">
              <span className="tnum mt-0.5 text-caption-12 text-muted">{String(i + 1).padStart(2, '0')}</span>
              <span>
                <span className="block text-label-13 font-semibold text-text">{t(`val.methods.${k}.t`)}</span>
                <span className="block text-label-13 text-text-2">{t(`val.methods.${k}.b`)}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-4 text-caption-12 text-muted">{t('val.data')}</p>
      </section>
    </main>
  );
}
