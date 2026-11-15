// S-09: centroid per epoch, fitted proper motion against the published value, verdict, residual plot (F-14).
// Every number is returned by POST /sequences/{id}/astrometry; nothing is pre-filled.
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Data } from 'plotly.js';
import { PlotlyChart } from '../../components/PlotlyChart';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { ApiError, postAstrometry } from '../../lib/api';
import { formatDec, formatRa } from '../../lib/coords';
import { astrometryCsv, downloadCsv } from '../../lib/csv';
import { localDate, localNumber, mjdToDate } from '../../lib/format';
import { cssVar, destelloConfig, destelloLayout, epochColor, EPOCH_SYMBOLS } from '../../lib/plotly';
import type { AstrometryEpoch, AstrometryResponse, DetectorNum, Lang } from '../../lib/types';
import type { useExplorer } from '../explorer/useExplorer';
import { astrometryKey } from './queryKeys';
import { useSelection, motionParams } from './useSelection';
import { WarningList, hasCode } from './WarningList';

type Model = ReturnType<typeof useExplorer>;

type Verdict = 'agrees' | 'marginal' | 'differs';
export function verdictOf(sigma: number): Verdict {
  return sigma < 2 ? 'agrees' : sigma < 3 ? 'marginal' : 'differs';
}
const TONE = { agrees: 'success', marginal: 'warning', differs: 'danger' } as const;
const MARK = { agrees: '✓', marginal: '!', differs: '×' } as const;

/** Residuals after the fit, arcsec. Uses the API values when present; otherwise offsets minus the fitted motion. */
export function residualsOf(r: AstrometryResponse): { index: number; t: number; ra: number; dec: number }[] {
  if (!r.fit) return [];
  const fit = r.fit;
  if (fit.residuals?.length) {
    return fit.residuals.map((p) => ({
      index: p.index,
      t: p.t_mid_mjd ?? r.epochs.find((e) => e.index === p.index)?.t_mid_mjd ?? 0,
      ra: p.dra_arcsec,
      dec: p.ddec_arcsec,
    }));
  }
  const m = measuredEpochs(r);
  const e0 = m[0];
  if (!e0) return [];
  const cosd = Math.cos((e0.dec_deg * Math.PI) / 180);
  const off = m.map((e) => {
    const yr = (e.t_mid_mjd - e0.t_mid_mjd) / 365.25;
    return {
      index: e.index,
      t: e.t_mid_mjd,
      ra: (e.ra_deg - e0.ra_deg) * cosd * 3600 - (fit.pmra_masyr / 1000) * yr,
      dec: (e.dec_deg - e0.dec_deg) * 3600 - (fit.pmdec_masyr / 1000) * yr,
    };
  });
  const mra = off.reduce((a, o) => a + o.ra, 0) / off.length;
  const mdec = off.reduce((a, o) => a + o.dec, 0) / off.length;
  return off.map((o) => ({ ...o, ra: o.ra - mra, dec: o.dec - mdec }));
}

type MeasuredEpoch = AstrometryEpoch & { ra_deg: number; dec_deg: number };
export function measuredEpochs(r: AstrometryResponse): MeasuredEpoch[] {
  return r.epochs.filter((e): e is MeasuredEpoch => e.measured && e.ra_deg != null && e.dec_deg != null);
}

/** Proper motion given in mas/yr, written in arcsec/yr with its uncertainty. */
export function mas(lang: Lang, v: number, e?: number | null): string {
  const a = localNumber(lang, v / 1000, Math.abs(v) < 100 ? 3 : 2);
  if (e == null) return a;
  return e / 1000 < 0.0005 ? `${a} ± < 0.001` : `${a} ± ${localNumber(lang, e / 1000, e < 100 ? 3 : 2)}`;
}

export function MeasurePanel({ x }: { x: Model }) {
  const { t } = useTranslation();
  const lang = x.lang;
  const sel = useSelection(x);
  const id = x.seq.sequenceId;
  const tooFew = x.complete && x.nEpochs < 2;
  const det = typeof x.det === 'number' ? x.det : null;
  const enabled = x.complete && !x.demo && !!id && !!sel && !tooFew;
  const q = useQuery({
    queryKey: astrometryKey(id, sel?.key, det, x.mode),
    queryFn: ({ signal }) =>
      postAstrometry(
        id as string,
        {
          ra_deg: (sel as NonNullable<typeof sel>).ra_deg,
          dec_deg: (sel as NonNullable<typeof sel>).dec_deg,
          detector: det,
          fit_parallax: false,
          reference: 'literature',
          ...motionParams(sel as NonNullable<typeof sel>),
        },
        signal,
      ),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const r = q.data;
  const apiTooFew = q.error instanceof ApiError && q.error.code === 'TOO_FEW_EPOCHS';
  const notMeasurable = r?.status === 'not_measurable' || (r != null && r.fit == null);
  const fit = r?.fit ?? null;
  const rateLimited = q.error instanceof ApiError && q.error.status === 429;
  const outsideField = q.error instanceof ApiError && q.error.code === 'POSITION_OUTSIDE_FIELD';
  const unresolved = hasCode(r?.warnings, /UNRESOLVED/) || sel?.presetId === 'epsindib';

  const res = useMemo(() => (r ? residualsOf(r) : []), [r]);
  const plot = useMemo(() => {
    if (res.length < 3) return null;
    const layout = destelloLayout(lang, t('meas.resX'), t('meas.resY'));
    layout.showlegend = true;
    layout.xaxis = {
      ...layout.xaxis,
      tickmode: 'array',
      tickvals: res.map((p) => p.t),
      ticktext: res.map((p) => `E${p.index + 1}`),
    };
    layout.yaxis = {
      ...layout.yaxis,
      zeroline: true,
      zerolinecolor: cssVar('border-strong'),
      exponentformat: 'none',
    };
    layout.hovermode = 'closest';
    layout.margin = { l: 56, r: 12, t: 36, b: 48 };
    const mk = (i: number, name: string, ys: number[]): Partial<Data> => ({
      type: 'scatter',
      mode: 'markers',
      name,
      x: res.map((p) => p.t),
      y: ys,
      marker: {
        color: epochColor(i),
        size: 8,
        symbol: EPOCH_SYMBOLS[i],
        line: { color: cssVar('surface'), width: 1 },
      },
      hovertemplate: `${name}: %{y:.2f} arcsec<extra></extra>`,
    });
    const traces = [
      mk(
        0,
        'RA*',
        res.map((p) => p.ra),
      ),
      mk(
        1,
        'Dec',
        res.map((p) => p.dec),
      ),
    ];
    return { traces, layout };
  }, [res, lang, t]);
  const config = useMemo(() => destelloConfig(lang, 'destello-residuals'), [lang]);

  if (x.demo) {
    return (
      <p className="text-body-14 text-text-2" data-testid="panel-demo-off">
        {t('panel2.demoOff')}
      </p>
    );
  }
  if (!sel && !tooFew) {
    return (
      <p className="text-body-14 text-text-2" data-testid="measure-empty">
        {t('panel.measEmpty')}
      </p>
    );
  }
  if (tooFew || apiTooFew) {
    return (
      <div className="rounded-lg border border-border-strong p-3" role="note" data-testid="measure-toofew">
        <p className="text-label-13 font-semibold">{t('meas.tooFewTitle')}</p>
        <p className="mt-1 text-label-13 text-text-2">{t('meas.tooFewBody')}</p>
      </div>
    );
  }
  if (!sel) return null;

  const ref = r?.reference ?? null;
  const sigma = r?.agreement_sigma ?? null;
  const verdict = sigma != null ? verdictOf(sigma) : null;
  const totalFit = fit ? Math.hypot(fit.pmra_masyr, fit.pmdec_masyr) : 0;

  return (
    <div className="flex flex-col gap-4" data-testid="measure-panel">
      <div className="flex flex-col gap-1">
        <h3 className="text-body-15 font-semibold">{t('meas.title')}</h3>
        <p className="tnum text-caption-12 text-muted" data-testid="measure-position">
          {formatRa(sel.ra_deg)} {formatDec(sel.dec_deg)}
        </p>
      </div>

      {q.isPending && enabled && (
        <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="measure-loading">
          <div className="h-24 animate-pulse rounded-lg border border-border bg-surface-2 motion-reduce:animate-none" />
          <p className="text-label-13 text-muted">{t('meas.measuring')}</p>
        </div>
      )}
      {!x.complete && !q.isError && (
        // The sequence is still being built: say so instead of leaving the panel blank.
        <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="measure-waiting">
          <div className="h-24 animate-pulse rounded-lg border border-border bg-surface-2 motion-reduce:animate-none" />
          <p className="text-label-13 text-muted">{t('meas.waiting')}</p>
        </div>
      )}
      {q.isError && !apiTooFew && (
        <div className="rounded-lg border border-danger p-3" role="alert" data-testid="measure-error">
          <p className="text-label-13">
            {outsideField
              ? t('errors.POSITION_OUTSIDE_FIELD')
              : rateLimited
                ? t('meas2.rateLimited')
                : t('meas.failed')}
          </p>
          {!outsideField && (
            <>
              <p className="mt-1 text-caption-12 text-muted">{t('meas2.retryHint')}</p>
              <Button variant="secondary" className="mt-2" onClick={() => void q.refetch()}>
                {t('states.retry')}
              </Button>
            </>
          )}
        </div>
      )}

      {r && notMeasurable && (
        <>
          <div
            className="rounded-lg border border-warning p-3"
            role="note"
            data-testid="measure-notmeasurable"
          >
            <p className="text-label-13 font-semibold">{t('meas2.notMeasurableTitle')}</p>
            <p className="mt-1 text-label-13 text-text-2" data-testid="measure-notmeasurable-count">
              {t('meas2.notMeasurableCount', {
                measured: r.epochs_measured ?? measuredEpochs(r).length,
                total: r.epochs_total ?? r.epochs.length,
                detector: r.detector_used,
              })}
            </p>
            <p className="mt-1 text-label-13 text-text-2">{t('meas2.notMeasurableBody')}</p>
            {r.suggested_detector != null && (
              <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="measure-suggest">
                <Button
                  variant="secondary"
                  onClick={() => x.setDet(r.suggested_detector as DetectorNum)}
                  data-testid="measure-suggest-btn"
                >
                  {t('meas2.suggestDetector', { detector: r.suggested_detector })}
                </Button>
              </div>
            )}
          </div>
          <WarningList warnings={r.warnings} testId="measure-warnings" />
        </>
      )}
      {r && fit && (
        <>
          {unresolved && (
            <div
              className="rounded-lg border border-warning p-3"
              role="note"
              data-testid="measure-unresolved"
            >
              <span className="text-label-13 font-semibold text-warning">
                {t('sciWarn.codes.EPSILON_INDI_UNRESOLVED.t')}
              </span>{' '}
              <span className="text-label-13 text-text-2">{t('meas2.unresolvedNote')}</span>
            </div>
          )}
          <WarningList
            warnings={r.warnings}
            skip={unresolved ? new Set(['EPSILON_INDI_UNRESOLVED']) : undefined}
            testId="measure-warnings"
          />

          <section
            aria-labelledby="m-fit"
            className="rounded-lg border border-border p-3"
            data-testid="measure-result"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="m-fit" className="text-label-13 font-semibold">
                {t('meas.fitTitle')}
              </h4>
              {verdict && sigma != null && (
                <Badge tone={TONE[verdict]} data-testid="measure-verdict">
                  <span aria-hidden="true">{MARK[verdict]}</span>
                  {t(`meas.verdict.${verdict}`)} {localNumber(lang, sigma, 1)}σ
                </Badge>
              )}
            </div>
            <dl className="tnum mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-label-13">
              <dt className="text-muted">μα*</dt>
              <dd data-testid="fit-pmra">
                {mas(lang, fit.pmra_masyr, fit.pmra_err_masyr)} {t('meas.unit')}
              </dd>
              <dt className="text-muted">μδ</dt>
              <dd data-testid="fit-pmdec">
                {mas(lang, fit.pmdec_masyr, fit.pmdec_err_masyr)} {t('meas.unit')}
              </dd>
              <dt className="text-muted">μ</dt>
              <dd>
                {mas(lang, totalFit)} {t('meas.unit')}
              </dd>
              {fit.parallax_mas != null && (
                <>
                  <dt className="text-muted">{t('meas.parallax')}</dt>
                  <dd>
                    {localNumber(lang, fit.parallax_mas, 1)} mas{' '}
                    <span className="text-muted">
                      {fit.parallax_fixed ? t('meas.fixed') : t('meas.fitted')}
                    </span>
                  </dd>
                </>
              )}
              {fit.chi2_red != null && (
                <>
                  <dt className="text-muted">{t('meas2.chi2')}</dt>
                  <dd>{localNumber(lang, fit.chi2_red, 2)}</dd>
                </>
              )}
              <dt className="text-muted">{t('meas2.detectorUsed')}</dt>
              <dd data-testid="fit-detector">D{r.detector_used}</dd>
              <dt className="text-muted">{t('meas2.epochsLabel')}</dt>
              <dd data-testid="fit-epochs">
                {t('meas2.epochsValue', { n: measuredEpochs(r).length, total: r.epochs.length })}
              </dd>
              {r.recalibration_catalog && (
                <>
                  <dt className="text-muted">{t('meas2.recalCatalog')}</dt>
                  <dd className="font-sans">{r.recalibration_catalog}</dd>
                </>
              )}
            </dl>
            <div className="mt-3 border-t border-border pt-2" data-testid="measure-reference">
              <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
                {t('meas.refTitle')}
              </p>
              {ref ? (
                <dl className="tnum mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-label-13">
                  <dt className="text-muted">μα*</dt>
                  <dd>
                    {mas(lang, ref.pmra_masyr, ref.pmra_err_masyr)} {t('meas.unit')}
                  </dd>
                  <dt className="text-muted">μδ</dt>
                  <dd>
                    {mas(lang, ref.pmdec_masyr, ref.pmdec_err_masyr)} {t('meas.unit')}
                  </dd>
                  <dt className="text-muted">{t('meas.source')}</dt>
                  <dd className="font-sans">{ref.source}</dd>
                  {ref.ref_epoch && (
                    <>
                      <dt className="text-muted">{t('meas2.refEpoch')}</dt>
                      <dd>{ref.ref_epoch}</dd>
                    </>
                  )}
                </dl>
              ) : (
                <p className="mt-1 text-label-13 text-muted">{t('meas.noRef')}</p>
              )}
            </div>
          </section>

          <section aria-labelledby="m-cen" className="flex flex-col gap-2">
            <h4 id="m-cen" className="text-label-13 font-semibold">
              {t('meas.centroids')}
            </h4>
            <div
              className="overflow-x-auto rounded-lg border border-border"
              role="region"
              aria-labelledby="m-cen"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
              tabIndex={0}
              data-testid="centroid-table"
            >
              <table className="tnum w-full text-caption-12">
                <thead>
                  <tr className="text-left text-muted">
                    <th scope="col" className="px-2.5 py-1.5 font-medium">
                      {t('info.epoch')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">
                      {t('spec.colDate')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('meas2.colN')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('meas2.colSnr')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('meas2.colSat')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('meas2.colStars')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      RA
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      Dec
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('meas.err')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {r.epochs.map((e) => (
                    <tr key={e.index} className="border-t border-border" data-measured={e.measured}>
                      <td className="px-2.5 py-1.5">E{e.index + 1}</td>
                      <td className="px-2.5 py-1.5 text-muted">{localDate(lang, mjdToDate(e.t_mid_mjd))}</td>
                      <td className="px-2.5 py-1.5 text-right text-muted">{e.n_images ?? ''}</td>
                      <td className="px-2.5 py-1.5 text-right text-muted">
                        {e.snr != null ? localNumber(lang, e.snr, 1) : ''}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-muted">
                        {e.saturated_fraction != null ? `${Math.round(e.saturated_fraction * 100)}%` : ''}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-muted">{e.recalibration_stars ?? ''}</td>
                      {e.measured && e.ra_deg != null && e.dec_deg != null ? (
                        <>
                          <td className="px-2.5 py-1.5 text-right">{e.ra_deg.toFixed(6)}</td>
                          <td className="px-2.5 py-1.5 text-right">{e.dec_deg.toFixed(6)}</td>
                          <td className="px-2.5 py-1.5 text-right">
                            {e.err_arcsec != null ? localNumber(lang, e.err_arcsec, 2) : ''}
                          </td>
                        </>
                      ) : (
                        <td colSpan={3} className="px-2.5 py-1.5 text-right text-warning">
                          {t('meas2.notMeasured')}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-3">
              <Button
                variant="secondary"
                onClick={() => downloadCsv('destello-astrometry.csv', astrometryCsv(id ?? '', r))}
                data-testid="measure-csv"
              >
                {t('meas2.csv')}
              </Button>
            </div>
          </section>

          {!plot && (
            <p className="text-caption-12 text-muted" data-testid="measure-nores">
              {t('meas2.twoEpochsNote')}
            </p>
          )}
          {plot && (
            <section aria-labelledby="m-res" className="flex flex-col gap-2">
              <h4 id="m-res" className="text-label-13 font-semibold">
                {t('meas.residuals')}
              </h4>
              <PlotlyChart
                data={plot.traces}
                layout={plot.layout}
                config={config}
                label={t('meas.residualsAria')}
                height={220}
                testId="residual-plot"
              />
              <p className="text-caption-12 text-muted">{t('meas.residualsNote')}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
