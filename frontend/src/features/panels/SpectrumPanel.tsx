// S-08: spectrum and per-epoch photometry for the selected position (F-19). Every number comes from
// GET /sequences/{id}/spectrum. Plotly is loaded lazily.
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Data } from 'plotly.js';
import { PlotlyChart } from '../../components/PlotlyChart';
import { Button } from '../../components/ui/button';
import { ApiError, getSpectrum } from '../../lib/api';
import { formatDec, formatRa } from '../../lib/coords';
import { epochMid, formatNumber, localDate, localNumber, mjdToDate } from '../../lib/format';
import {
  EPOCH_SYMBOLS,
  cssVar,
  destelloConfig,
  destelloLayout,
  detectorBoundary,
  detectorLabel,
  epochColor,
  epochTrace,
} from '../../lib/plotly';
import {
  DETECTORS,
  type DetectorNum,
  type Lang,
  type SpectrumPoint,
  type SpectrumResponse,
} from '../../lib/types';
import type { useExplorer } from '../explorer/useExplorer';
import { spectrumKey } from './queryKeys';
import { motionParams, useSelection } from './useSelection';
import { WarningList } from './WarningList';

type Model = ReturnType<typeof useExplorer>;

const SYMBOL_PATHS: Record<(typeof EPOCH_SYMBOLS)[number], string> = {
  circle: 'M0 -4.2a4.2 4.2 0 1 0 .01 0z',
  square: 'M-3.6 -3.6h7.2v7.2h-7.2z',
  'triangle-up': 'M0 -4.6 4.4 3.4h-8.8z',
  diamond: 'M0 -5 4.4 0 0 5 -4.4 0z',
  'triangle-down': 'M0 4.6 4.4 -3.4h-8.8z',
  cross: 'M-1.4 -4.4h2.8v3h3v2.8h-3v3h-2.8v-3h-3v-2.8h3z',
  hexagon: 'M-2.4 -4 2.4 -4 4.8 0 2.4 4 -2.4 4 -4.8 0z',
};

export function EpochGlyph({ i, className }: { i: number; className?: string }) {
  const sym = EPOCH_SYMBOLS[i % EPOCH_SYMBOLS.length];
  return (
    <svg
      width="12"
      height="12"
      viewBox="-6 -6 12 12"
      className={className}
      aria-hidden="true"
      style={{ overflow: 'visible' }}
    >
      <path d={SYMBOL_PATHS[sym]} style={{ fill: `var(--epoch-${(i % 7) + 1})`, stroke: 'var(--surface)' }} />
    </svg>
  );
}

export function fmtFlux(lang: Lang, v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 0.01 || a >= 10000))
    return v
      .toExponential(2)
      .replace('e+', 'e')
      .replace('.', lang === 'es' ? ',' : '.');
  return formatNumber(lang, v, { maximumSignificantDigits: 3 });
}

function windowLabel(lang: Lang, w: [number, number]): string {
  return `${localNumber(lang, w[0], 2)}-${localNumber(lang, w[1], 2)}`;
}

function csvOf(d: SpectrumResponse): string {
  const rows = [
    'epoch,obs_id,detector,wavelength_um,bandwidth_um,flux_' +
      d.unit +
      ',flux_err_' +
      d.unit +
      ',flagged,saturated',
  ];
  for (const p of d.points)
    rows.push(
      [
        p.epoch + 1,
        p.obs_id,
        p.detector,
        p.wavelength_um ?? '',
        p.bandwidth_um ?? '',
        p.flux ?? '',
        p.flux_err ?? '',
        p.flagged ? 1 : 0,
        p.saturated ? 1 : 0,
      ].join(','),
    );
  return rows.join('\n') + '\n';
}

export function SpectrumPanel({ x }: { x: Model }) {
  const { t } = useTranslation();
  const lang = x.lang;
  const sel = useSelection(x);
  const gen = x.mode;
  const id = x.seq.sequenceId;
  const enabled = x.complete && !x.demo && !!id && !!sel;
  const q = useQuery({
    queryKey: spectrumKey(id, sel?.key, gen),
    queryFn: ({ signal }) =>
      getSpectrum(
        id as string,
        {
          ra_deg: (sel as NonNullable<typeof sel>).ra_deg,
          dec_deg: (sel as NonNullable<typeof sel>).dec_deg,
          ...motionParams(sel as NonNullable<typeof sel>),
        },
        signal,
      ),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const [elapsed, setElapsed] = useState(0);
  const waiting = q.isPending && enabled;
  useEffect(() => {
    if (!waiting) {
      setElapsed(0);
      return;
    }
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [logY, setLogY] = useState<boolean | null>(null);
  const [photDet, setPhotDet] = useState<number | null>(null);

  const data = q.data;
  const outsideField = q.error instanceof ApiError && q.error.code === 'POSITION_OUTSIDE_FIELD';
  const epochIdx = useMemo(
    () => [...new Set((data?.points ?? []).map((p) => p.epoch))].sort((a, b) => a - b),
    [data],
  );
  const usable = useMemo(
    () =>
      (data?.points ?? []).filter(
        (p): p is SpectrumPoint & { flux: number; wavelength_um: number } =>
          !p.flagged && p.flux != null && Number.isFinite(p.flux) && p.wavelength_um != null,
      ),
    [data],
  );
  const allPositive = usable.length > 0 && usable.every((p) => (p.flux as number) > 0);
  const useLog = logY ?? allPositive;
  const flaggedCount = (data?.points.length ?? 0) - usable.length;

  const epochLabel = (e: number) => `E${e + 1}`;

  // Plot
  const plot = useMemo(() => {
    if (!data) return null;
    const traces: Partial<Data>[] = [];
    for (const e of epochIdx) {
      if (hidden.has(e)) continue;
      const pts = usable.filter((p) => p.epoch === e);
      traces.push(
        epochTrace(
          e,
          epochLabel(e),
          pts.map((p) => p.wavelength_um),
          pts.map((p) => p.flux as number),
          pts.map((p) => p.flux_err ?? 0),
          `%{x:.3f} µm · %{y:.3~e} ${data.unit}<extra>${epochLabel(e)}</extra>`,
        ),
      );
    }
    const layout = destelloLayout(lang, t('spec.xTitle'), t('spec.yTitle', { unit: data.unit }));
    layout.showlegend = false;
    layout.yaxis = { ...layout.yaxis, type: useLog ? 'log' : 'linear' };
    const shapes: NonNullable<typeof layout.shapes> = [];
    const annotations: NonNullable<typeof layout.annotations> = [];
    for (const d of DETECTORS) {
      const r = x.ranges[d as DetectorNum];
      if (!r) continue;
      if (d > 1) shapes.push(detectorBoundary(r[0]));
      annotations.push(detectorLabel((r[0] + r[1]) / 2, `D${d}`));
    }
    const mi = data.methane_index;
    if (mi && usable.length > 0) {
      // Windows of the methane index: continuum (blue, red) and the 3.3 um band.
      for (const [k, w] of Object.entries(mi.windows_um))
        shapes.push({
          type: 'rect',
          xref: 'x',
          yref: 'paper',
          x0: w[0],
          x1: w[1],
          y0: 0,
          y1: 1,
          fillcolor: cssVar(k === 'band' ? 'violet' : 'border-strong'),
          opacity: k === 'band' ? 0.16 : 0.1,
          line: { width: 0 },
          layer: 'below',
        });
      annotations.push({
        xref: 'x',
        yref: 'paper',
        x: (mi.windows_um.band[0] + mi.windows_um.band[1]) / 2,
        y: 0.02,
        yanchor: 'bottom',
        showarrow: false,
        text: t('spec2.ch4Short'),
        font: { family: 'Inter, sans-serif', size: 11, color: cssVar('muted') },
      });
    }
    layout.shapes = shapes;
    layout.annotations = annotations;
    const lows = DETECTORS.map((d) => x.ranges[d as DetectorNum]?.[0]).filter((v): v is number => v != null);
    const highs = DETECTORS.map((d) => x.ranges[d as DetectorNum]?.[1]).filter((v): v is number => v != null);
    if (lows.length)
      layout.xaxis = { ...layout.xaxis, range: [Math.min(...lows) - 0.05, Math.max(...highs) + 0.05] };
    layout.margin = { l: 64, r: 12, t: 28, b: 52 };
    if (usable.length === 0) {
      layout.yaxis = { ...layout.yaxis, range: [0, 1], showticklabels: false };
      annotations.push({
        xref: 'paper',
        yref: 'paper',
        x: 0.5,
        y: 0.5,
        showarrow: false,
        text: t('spec2.emptyPlot'),
        font: { family: 'Inter, sans-serif', size: 14, color: cssVar('text') },
      });
    }
    return { traces, layout };
  }, [data, usable, epochIdx, hidden, useLog, lang, x.ranges, t]);
  const config = useMemo(() => destelloConfig(lang, 'destello-spectrum'), [lang]);

  // Photometry table: one detector at a time.
  const detsInPhot = useMemo(
    () => [...new Set((data?.epoch_photometry ?? []).map((p) => p.detector))].sort((a, b) => a - b),
    [data],
  );
  const defaultDet = useMemo(() => {
    if (typeof x.det === 'number' && detsInPhot.includes(x.det)) return x.det;
    let best: number | null = null;
    let bestFlux = -Infinity;
    for (const d of detsInPhot) {
      const rows = (data?.epoch_photometry ?? []).filter((p) => p.detector === d);
      const withFlux = rows.filter((p) => p.flux != null);
      const mean = withFlux.reduce((a, p) => a + (p.flux as number), 0) / Math.max(withFlux.length, 1);
      if (withFlux.length >= epochIdx.length && mean > bestFlux) {
        best = d;
        bestFlux = mean;
      }
    }
    return best ?? detsInPhot[0] ?? null;
  }, [x.det, detsInPhot, data, epochIdx.length]);
  const det = photDet != null && detsInPhot.includes(photDet) ? photDet : defaultDet;
  const rows = useMemo(() => {
    const list = (data?.epoch_photometry ?? [])
      .filter((p) => p.detector === det)
      .sort((a, b) => a.epoch - b.epoch);
    const base = list.find((p) => p.flux != null) ?? list[0];
    return list.map((p) => {
      const ep = x.epochs.find((e) => e.index === p.epoch);
      const mid = ep ? epochMid(ep) : undefined;
      let pct: number | null = null;
      let sigma: number | null = null;
      if (base && p !== base && base.flux != null && p.flux != null && base.flux !== 0) {
        pct = ((p.flux - base.flux) / Math.abs(base.flux)) * 100;
        const err = Math.hypot(p.flux_err ?? 0, base.flux_err ?? 0);
        sigma = err > 0 ? (p.flux - base.flux) / err : null;
      }
      return { p, mid, pct, sigma };
    });
  }, [data, det, x.epochs]);

  const pos = sel ? `${formatRa(sel.ra_deg)} ${formatDec(sel.dec_deg)}` : '';

  if (x.demo) {
    return (
      <p className="text-body-14 text-text-2" data-testid="panel-demo-off">
        {t('panel2.demoOff')}
      </p>
    );
  }
  if (!sel) {
    return (
      <p className="text-body-14 text-text-2" data-testid="spectrum-empty">
        {t('panel.specEmpty')}
      </p>
    );
  }

  const download = () => {
    if (!data) return;
    const blob = new Blob([csvOf(data)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'destello-spectrum.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const last = [...rows].reverse().find((r) => r.pct != null) ?? null;
  const allFlagged = !!data && data.points.length > 0 && usable.length === 0;

  return (
    <div className="flex flex-col gap-4" data-testid="spectrum-panel">
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-body-15 font-semibold">{t('spec.title')}</h3>
          {data && (
            <span className="tnum whitespace-nowrap text-caption-12 text-muted">
              {t('spec2.usable', { n: usable.length, total: data.points.length })}
            </span>
          )}
        </div>
        <p className="tnum text-caption-12 text-muted">
          {t('spec.sub', { pos })}
          {data?.aperture_arcsec != null &&
            ` ${t('spec.aperture', { r: localNumber(lang, data.aperture_arcsec, 1) })}`}
        </p>
      </div>

      {q.isPending && enabled && (
        <div className="flex flex-col gap-3" role="status" aria-busy="true" data-testid="spectrum-loading">
          <div className="h-[260px] animate-pulse rounded-lg border border-border bg-surface-2 motion-reduce:animate-none" />
          <p className="text-label-13 text-text-2">{t('spec.loading')}</p>
          <p className="text-caption-12 text-muted">{t('spec2.loadingLong')}</p>
          <p className="tnum text-caption-12 text-muted" data-testid="spectrum-elapsed">
            {t('spec2.elapsed', { s: elapsed })}
          </p>
        </div>
      )}
      {!enabled && !q.isError && (
        <p className="text-label-13 text-muted" role="status">
          {t('spec.waiting')}
        </p>
      )}
      {q.isError && (
        <div className="rounded-lg border border-danger p-3" role="alert" data-testid="spectrum-error">
          <p className="text-label-13 text-text">
            {outsideField
              ? t('errors.POSITION_OUTSIDE_FIELD')
              : q.error instanceof ApiError && q.error.status === 429
                ? t('spec2.rateLimited')
                : t('spec.failed')}
          </p>
          {!outsideField && (
            <>
              <p className="mt-1 text-caption-12 text-muted">{t('spec2.retryHint')}</p>
              <Button variant="secondary" className="mt-2" onClick={() => void q.refetch()}>
                {t('states.retry')}
              </Button>
            </>
          )}
        </div>
      )}

      {data && data.points.length === 0 && (
        <p className="text-body-14 text-text-2" data-testid="spectrum-nopoints">
          {t('spec.noPoints')}
        </p>
      )}

      {data && data.points.length > 0 && plot && (
        <>
          {allFlagged && (
            <div
              className="flex flex-col gap-0.5 rounded-lg border border-warning bg-glint-soft p-3"
              role="note"
              data-testid="spectrum-saturated"
            >
              <span className="text-label-13 font-semibold text-warning">{t('spec2.satNoneTitle')}</span>
              <span className="text-label-13 text-text-2">{t('spec2.satNoneBody')}</span>
            </div>
          )}
          <WarningList warnings={data.warnings} testId="spectrum-warnings" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label={t('spec.legendAria')} className="flex flex-wrap gap-1">
              {epochIdx.map((e) => {
                const on = !hidden.has(e);
                return (
                  <button
                    key={e}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setHidden((h) => {
                        const n = new Set(h);
                        if (n.has(e)) n.delete(e);
                        else n.add(e);
                        return n;
                      })
                    }
                    className="tnum flex min-h-[var(--hit-min)] items-center gap-1.5 rounded-md border px-2 text-caption-12 font-medium"
                    style={{ borderColor: on ? epochColor(e) : 'var(--border)' }}
                    data-testid={`legend-${e}`}
                  >
                    <EpochGlyph i={e} />
                    <span className={on ? 'text-text' : 'text-muted line-through'}>{epochLabel(e)}</span>
                  </button>
                );
              })}
            </div>
            <div
              role="radiogroup"
              aria-label={t('spec.scale')}
              className="flex overflow-hidden rounded-md border border-border-strong"
            >
              {[
                { v: false, l: t('spec.linear') },
                { v: true, l: t('spec.log') },
              ].map((o) => (
                <button
                  key={String(o.v)}
                  type="button"
                  role="radio"
                  aria-checked={useLog === o.v}
                  disabled={o.v && !allPositive}
                  onClick={() => setLogY(o.v)}
                  className={`min-h-[var(--hit-min)] px-2.5 text-caption-12 ${useLog === o.v ? 'bg-glint-soft font-semibold text-glint' : 'text-text'} disabled:text-disabled`}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          <PlotlyChart
            data={plot.traces}
            layout={plot.layout}
            config={config}
            label={t('spec.plotAria')}
            height={280}
            testId="spectrum-plot"
          />

          {flaggedCount > 0 && (
            <p className="text-caption-12 text-muted" data-testid="spectrum-flagged">
              {t('spec2.flaggedHint', { count: flaggedCount, total: data.points.length })}
            </p>
          )}

          {data.methane_index && (
            <section
              aria-labelledby="ch4-h"
              className="flex flex-col gap-1 rounded-lg border border-border bg-surface-2 p-3"
              data-testid="methane-index"
            >
              <h4 id="ch4-h" className="text-label-13 font-semibold">
                {t('spec2.ch4Title')}
              </h4>
              {data.methane_index.index != null && data.methane_index.index_err != null ? (
                <>
                  <p className="tnum text-label-13 text-text" data-testid="methane-value">
                    {t('spec2.ch4Value', {
                      index: localNumber(lang, data.methane_index.index, 2),
                      err: localNumber(lang, data.methane_index.index_err, 2),
                      n: data.methane_index.epochs.length,
                      count: data.methane_index.epochs.length,
                    })}
                  </p>
                  <p className="text-caption-12 text-text-2">
                    {data.methane_index.depth_sigma != null && data.methane_index.depth_sigma >= 3
                      ? t('spec2.ch4Below', { sigma: localNumber(lang, data.methane_index.depth_sigma, 1) })
                      : t('spec2.ch4Flat')}
                  </p>
                </>
              ) : (
                <p className="text-caption-12 text-text-2" data-testid="methane-none">
                  {t('spec2.ch4None')}
                </p>
              )}
              <p className="text-caption-12 text-muted">
                {t('spec2.ch4Method', {
                  blue: windowLabel(lang, data.methane_index.windows_um.blue),
                  band: windowLabel(lang, data.methane_index.windows_um.band),
                  red: windowLabel(lang, data.methane_index.windows_um.red),
                })}
              </p>
            </section>
          )}

          <section aria-labelledby="phot-h" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 id="phot-h" className="text-label-13 font-semibold">
                {t('spec.photTitle')}
              </h4>
              {detsInPhot.length > 0 && (
                <label className="flex items-center gap-2 text-caption-12 text-muted">
                  {t('detector.label')}
                  <select
                    value={det ?? ''}
                    onChange={(e) => setPhotDet(Number(e.target.value))}
                    className="tnum min-h-[var(--hit-min)] rounded-md border border-border-strong bg-surface-2 px-2 text-label-13 text-text"
                    data-testid="phot-detector"
                  >
                    {detsInPhot.map((d) => (
                      <option key={d} value={d}>
                        D{d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div
              className="overflow-x-auto rounded-lg border border-border"
              role="region"
              aria-labelledby="phot-h"
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
              tabIndex={0}
              data-testid="phot-table"
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
                      {t('spec2.colExp')}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('spec.colFlux', { unit: data.unit })}
                    </th>
                    <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                      {t('spec.colChange')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, mid, pct, sigma }) => (
                    <tr key={p.epoch} className="border-t border-border">
                      <td className="px-2.5 py-1.5">
                        <span className="flex items-center gap-1.5">
                          <EpochGlyph i={p.epoch} />
                          {epochLabel(p.epoch)}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 text-muted">
                        {mid !== undefined ? localDate(lang, mjdToDate(mid)) : ''}
                      </td>
                      <td className="px-2.5 py-1.5 text-right text-muted">
                        {p.n_total != null ? `${p.n_images} / ${p.n_total}` : p.n_images}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        {p.flux == null && <span className="text-muted">{t('spec2.noFlux')}</span>}
                        {p.flux != null && fmtFlux(lang, p.flux)}
                        {p.flux != null && p.flux_err != null && (
                          <span className="text-muted">
                            {' '}
                            {'±'} {fmtFlux(lang, p.flux_err)}
                          </span>
                        )}
                        {p.saturated && <span className="ml-1 text-warning">{t('spec.satShort')}</span>}
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        {pct != null ? (
                          <span className="flex flex-col leading-4">
                            <span>
                              {pct > 0 ? '+' : ''}
                              {localNumber(lang, pct, 1)}%
                            </span>
                            {sigma != null && (
                              <span className="text-muted">
                                {t('spec.nSigma', { n: localNumber(lang, Math.abs(sigma), 1) })}
                              </span>
                            )}
                          </span>
                        ) : p.flux != null && p === rows.find((r) => r.p.flux != null)?.p ? (
                          <span className="text-muted">{t('spec.baseline')}</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-label-13 text-text" data-testid="phot-verdict">
              {last && last.pct != null
                ? t('spec.verdict', {
                    n: last.p.epoch + 1,
                    det: det ?? '',
                    pct: localNumber(lang, last.pct, 1),
                    sigma: last.sigma != null ? localNumber(lang, Math.abs(last.sigma), 1) : '-',
                  })
                : rows.some((r) => r.p.flux != null)
                  ? t('spec.verdictSingle')
                  : t('spec2.satNoneTitle')}
            </p>
          </section>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={download} data-testid="spectrum-csv">
              CSV
              <span className="tnum text-caption-12 text-muted">
                {t('spec.csvSub', { count: data.points.length })}
              </span>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
