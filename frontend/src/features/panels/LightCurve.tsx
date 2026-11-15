// F-26: light curve of the target, one detector at a time, from the photometry sidecar of the sequence
// (<id>.photometry.json). Every value is a measurement written by the build; nothing is interpolated.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Data } from 'plotly.js';
import { PlotlyChart } from '../../components/PlotlyChart';
import { Button } from '../../components/ui/button';
import { getPhotometry } from '../../lib/api';
import { downloadCsv, lightCurveCsv } from '../../lib/csv';
import { epochMid, isoDate, localDate, localNumber, mjdToDate } from '../../lib/format';
import { EPOCH_SYMBOLS, cssVar, destelloConfig, destelloLayout, epochColor } from '../../lib/plotly';
import type { EpochInfo, EpochPhotometry, Lang } from '../../lib/types';
import { cn } from '../../lib/cn';
import type { useExplorer } from '../explorer/useExplorer';
import { photometryKey } from './queryKeys';
import { EpochGlyph, fmtFlux } from './SpectrumPanel';

type Model = ReturnType<typeof useExplorer>;

/** Reason codes written by the build (pipeline/photometry.point_reason). Unknown codes get a generic label. */
export const LC_REASONS = [
  'off_image',
  'saturated_core',
  'no_valid_pixels',
  'no_background',
  'core_masked',
  'aperture_masked',
] as const;

export interface LcRow {
  p: EpochPhotometry;
  mid: number | undefined;
}

/** Detectors present in the sidecar, in order. */
export function lcDetectors(rows: EpochPhotometry[]): number[] {
  return [...new Set(rows.map((r) => r.detector))].sort((a, b) => a - b);
}

/** Default detector: the shown one when it has data, else the one with the most measured epochs (lowest first). */
export function lcDefaultDetector(rows: EpochPhotometry[], shown: number | 'all'): number | null {
  const dets = lcDetectors(rows);
  if (typeof shown === 'number' && dets.includes(shown)) return shown;
  let best: number | null = null;
  let bestN = -1;
  for (const d of dets) {
    const n = rows.filter((r) => r.detector === d && r.flux != null).length;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Rows of one detector in epoch order, with the epoch mid time from the manifest. */
export function lcRows(rows: EpochPhotometry[], det: number | null, epochs: EpochInfo[]): LcRow[] {
  return rows
    .filter((r) => r.detector === det)
    .sort((a, b) => a.epoch - b.epoch)
    .map((p) => {
      const ep = epochs.find((e) => e.index === p.epoch);
      return { p, mid: ep ? epochMid(ep) : undefined };
    });
}

function band(lang: Lang, w: [number, number] | null | undefined): string {
  return w ? `${localNumber(lang, w[0], 2)} - ${localNumber(lang, w[1], 2)} µm` : '';
}

export function LightCurve({ x }: { x: Model }) {
  const { t } = useTranslation();
  const lang = x.lang;
  const url = x.seq.manifest?.photometry_url ?? null;
  const q = useQuery({
    queryKey: photometryKey(url, x.mode),
    queryFn: ({ signal }) => getPhotometry(url as string, signal),
    enabled: !!url && x.complete,
    staleTime: Infinity,
    retry: 1,
  });
  const [chosen, setChosen] = useState<number | null>(null);
  const all = useMemo(() => q.data?.epoch_photometry ?? [], [q.data]);
  const dets = useMemo(() => lcDetectors(all), [all]);
  const det = chosen != null && dets.includes(chosen) ? chosen : lcDefaultDetector(all, x.det);
  const rows = useMemo(() => lcRows(all, det, x.epochs), [all, det, x.epochs]);
  const measured = useMemo(() => rows.filter((r) => r.p.flux != null && r.mid !== undefined), [rows]);
  const unit = q.data?.unit ?? 'Jy';
  // No detector has a coadd value (for example a target saturated everywhere): say so once, not per detector.
  const noneAnywhere = all.length > 0 && all.every((r) => r.flux == null);

  const plot = useMemo(() => {
    if (!q.data) return null;
    const traces: Partial<Data>[] = [];
    if (measured.length > 1)
      traces.push({
        type: 'scatter',
        mode: 'lines',
        x: measured.map((r) => isoDate(mjdToDate(r.mid as number))),
        y: measured.map((r) => r.p.flux as number),
        line: { color: cssVar('border-strong'), width: 1 },
        hoverinfo: 'skip',
        showlegend: false,
      });
    for (const r of measured) {
      const c = epochColor(r.p.epoch);
      traces.push({
        type: 'scatter',
        mode: 'markers',
        name: `E${r.p.epoch + 1}`,
        x: [isoDate(mjdToDate(r.mid as number))],
        y: [r.p.flux as number],
        marker: {
          color: c,
          size: 9,
          symbol: EPOCH_SYMBOLS[r.p.epoch % EPOCH_SYMBOLS.length],
          line: { color: cssVar('surface'), width: 1 },
        },
        error_y: {
          type: 'data',
          array: [r.p.flux_err ?? 0],
          visible: true,
          color: c,
          thickness: 1,
          width: 0,
        },
        hovertemplate: `%{x|%Y-%m-%d} · %{y:.3~e} ${unit} ± ${(r.p.flux_err ?? 0).toExponential(1)}<br>${band(lang, r.p.wavelength_um)}<extra>E${r.p.epoch + 1} D${r.p.detector}</extra>`,
      });
    }
    const layout = destelloLayout(lang, t('lc.xTitle'), t('spec.yTitle', { unit }));
    layout.showlegend = false;
    layout.hovermode = 'closest';
    layout.xaxis = { ...layout.xaxis, type: 'date' };
    layout.margin = { l: 64, r: 12, t: 16, b: 52 };
    if (measured.length === 0) {
      layout.yaxis = { ...layout.yaxis, range: [0, 1], showticklabels: false };
      // Without a point the date axis keeps the span of the epochs instead of a default year.
      const mids = rows.map((r) => r.mid).filter((m): m is number => m !== undefined);
      layout.xaxis = mids.length
        ? {
            ...layout.xaxis,
            range: [isoDate(mjdToDate(Math.min(...mids) - 20)), isoDate(mjdToDate(Math.max(...mids) + 20))],
          }
        : { ...layout.xaxis, showticklabels: false };
      layout.annotations = [
        {
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0.5,
          showarrow: false,
          text: t(noneAnywhere ? 'lc.emptyAll' : 'lc.emptyPlot'),
          font: { family: 'Inter, sans-serif', size: 14, color: cssVar('text') },
        },
      ];
    }
    return { traces, layout };
  }, [q.data, measured, rows, unit, lang, t, noneAnywhere]);
  const config = useMemo(() => destelloConfig(lang, 'destello-light-curve'), [lang]);

  const reasonLabel = (code: string | null | undefined) =>
    code && (LC_REASONS as readonly string[]).includes(code)
      ? t(`lc.reason.${code}`)
      : t('lc.reason.unknown');

  return (
    <section aria-labelledby="lc-h" className="flex flex-col gap-2" data-testid="light-curve">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="lc-h" className="text-body-15 font-semibold">
          {t('lc.title')}
        </h3>
        {dets.length > 0 && (
          <div role="radiogroup" aria-label={t('lc.detector')} className="flex flex-wrap gap-1">
            {dets.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={det === d}
                onClick={() => setChosen(d)}
                className={cn(
                  'tnum min-h-[var(--hit-min)] min-w-[var(--hit-min)] rounded-md border px-2 text-caption-12',
                  det === d
                    ? 'border-glint bg-glint-soft font-semibold text-text'
                    : 'border-border-strong text-text hover:bg-border',
                )}
                data-testid={`lc-det-${d}`}
              >
                D{d}
              </button>
            ))}
          </div>
        )}
      </div>

      {!url && (
        <p className="text-body-14 text-text-2" data-testid="lc-unavailable">
          {x.complete ? t('lc.unavailable') : t('lc.waiting')}
        </p>
      )}
      {url && q.isPending && x.complete && (
        <p className="text-label-13 text-muted" role="status">
          {t('lc.loading')}
        </p>
      )}
      {url && q.isError && (
        <p className="text-label-13 text-text" role="alert" data-testid="lc-error">
          {t('lc.failed')}
        </p>
      )}

      {q.data && plot && (
        <>
          <p className="text-caption-12 text-muted" data-testid="lc-note">
            {t('lc.note', {
              r:
                q.data.aperture_radius_arcsec != null
                  ? localNumber(lang, q.data.aperture_radius_arcsec, 0)
                  : '-',
            })}
          </p>
          <PlotlyChart
            data={plot.traces}
            layout={plot.layout}
            config={config}
            label={t('lc.plotAria', { det: det ?? '' })}
            height={220}
            testId="lc-plot"
          />
          <div
            className="overflow-x-auto rounded-lg border border-border"
            role="region"
            aria-labelledby="lc-h"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
            tabIndex={0}
            data-testid="lc-table"
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
                  <th scope="col" className="px-2.5 py-1.5 font-medium">
                    {t('lc.colBand')}
                  </th>
                  <th scope="col" className="px-2.5 py-1.5 text-right font-medium">
                    {t('spec.colFlux', { unit })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ p, mid }) => (
                  <tr key={p.epoch} className="border-t border-border" data-testid={`lc-row-${p.epoch}`}>
                    <td className="px-2.5 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <EpochGlyph i={p.epoch} />E{p.epoch + 1}
                      </span>
                    </td>
                    <td className="px-2.5 py-1.5 text-muted">
                      {mid !== undefined ? localDate(lang, mjdToDate(mid)) : ''}
                    </td>
                    <td className="whitespace-nowrap px-2.5 py-1.5 text-muted">
                      {band(lang, p.wavelength_um)}
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      {p.flux != null ? (
                        <>
                          {fmtFlux(lang, p.flux)}
                          {p.flux_err != null && (
                            <span className="text-muted">
                              {' '}
                              {'±'} {fmtFlux(lang, p.flux_err)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-warning" data-testid={`lc-reason-${p.epoch}`}>
                          {reasonLabel(p.reason)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {noneAnywhere ? (
            <p className="text-caption-12 text-muted" data-testid="lc-none-anywhere">
              {t('lc.emptyAllHint')}
            </p>
          ) : (
            rows.some((r) => r.p.flux == null) && (
              <p className="text-caption-12 text-muted">{t('lc.missingHint')}</p>
            )
          )}
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                downloadCsv(
                  `destello-light-curve-D${det}.csv`,
                  lightCurveCsv(x.seq.sequenceId ?? '', unit, rows),
                )
              }
              data-testid="lc-csv"
            >
              {t('lc.csv')}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
