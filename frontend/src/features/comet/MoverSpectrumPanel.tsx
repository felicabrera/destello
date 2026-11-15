// F-33 spectrum panel: forced photometry per exposure with error bars, flagged points apart, the H2O and CO2
// bands, the aperture, the V-13 status as measured and the provenance of the positions. No detection is claimed.
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Data } from 'plotly.js';
import { PlotlyChart } from '../../components/PlotlyChart';
import { cssVar, destelloConfig, destelloLayout } from '../../lib/plotly';
import { localNumber } from '../../lib/format';
import type {
  Lang,
  Manifest,
  MoverBand,
  MoverEphemerisCheck,
  MoverSpectrum,
  ValidationReport,
} from '../../lib/types';
import {
  CO2_BAND_UM,
  H2O_BAND_UM,
  bandDifference,
  bandStatus,
  checkFor,
  plotPoints,
  pointCounts,
  validationRow,
} from './cometModel';

const MIN_POINTS = 2;

interface Props {
  lang: Lang;
  manifest: Manifest;
  spectrum: MoverSpectrum | undefined;
  check: MoverEphemerisCheck | undefined;
  report: ValidationReport | null | undefined;
  campaign: number;
}

export function MoverSpectrumPanel({ lang, manifest, spectrum, check, report, campaign }: Props) {
  const { t } = useTranslation('comet');
  const mt = manifest.moving_target;
  const pts = useMemo(() => plotPoints(spectrum, campaign), [spectrum, campaign]);
  const counts = pointCounts(spectrum?.points ?? [], campaign);
  const co2 = bandStatus(spectrum, campaign, 'co2');
  const h2o = bandStatus(spectrum, campaign, 'h2o');
  const v13 = validationRow(report, 'V-13', manifest.sequence_id, campaign);
  const chk = checkFor(check, campaign);
  const camp = mt?.campaigns.find((c) => c.index === campaign) ?? mt?.campaigns[0];

  const plot = useMemo(() => {
    const ok = pts.filter((p) => !p.flagged);
    const bad = pts.filter((p) => p.flagged);
    const traces: Partial<Data>[] = [
      {
        type: 'scatter',
        mode: 'markers',
        name: t('spectrum.measured'),
        x: ok.map((p) => p.x),
        y: ok.map((p) => p.y),
        marker: { color: cssVar('epoch-1'), size: 7, symbol: 'circle' },
        error_y: {
          type: 'data',
          array: ok.map((p) => p.err),
          visible: true,
          color: cssVar('epoch-1'),
          thickness: 1,
          width: 0,
        },
        hovertemplate: `%{x:.3f} µm · %{y:.3~e} Jy<extra>${t('spectrum.measured')}</extra>`,
      },
      {
        type: 'scatter',
        mode: 'markers',
        name: t('spectrum.flagged'),
        x: bad.map((p) => p.x),
        y: bad.map((p) => p.y),
        marker: {
          color: cssVar('muted'),
          size: 8,
          symbol: 'x-thin-open',
          line: { color: cssVar('muted'), width: 1.5 },
        },
        error_y: {
          type: 'data',
          array: bad.map((p) => p.err),
          visible: true,
          color: cssVar('muted'),
          thickness: 1,
          width: 0,
        },
        hovertemplate: `%{x:.3f} µm · %{y:.3~e} Jy<extra>${t('spectrum.flagged')}</extra>`,
      },
    ];
    const layout = destelloLayout(lang, t('spectrum.xTitle'), t('spectrum.yTitle'));
    layout.showlegend = true;
    layout.margin = { l: 64, r: 12, t: 28, b: 52 };
    const bands: [string, [number, number]][] = [
      [t('spectrum.h2o'), H2O_BAND_UM],
      [t('spectrum.co2'), CO2_BAND_UM],
    ];
    layout.shapes = bands.map(([, w]) => ({
      type: 'rect' as const,
      xref: 'x' as const,
      yref: 'paper' as const,
      x0: w[0],
      x1: w[1],
      y0: 0,
      y1: 1,
      fillcolor: cssVar('violet'),
      opacity: 0.18,
      line: { width: 0 },
      layer: 'below' as const,
    }));
    layout.annotations = bands.map(([label, w]) => ({
      xref: 'x' as const,
      yref: 'paper' as const,
      x: (w[0] + w[1]) / 2,
      y: 1,
      yanchor: 'bottom' as const,
      showarrow: false,
      text: label,
      font: { family: 'Inter, sans-serif', size: 11, color: cssVar('muted') },
    }));
    return { traces, layout };
  }, [pts, lang, t]);

  const config = useMemo(() => destelloConfig(lang, '3i-atlas-spectrum'), [lang]);

  const belowSnrText = (band: MoverBand | null): string | null => {
    const w = band?.windows;
    if (!band || !w || !band.reason?.startsWith('window_below_snr')) return null;
    if (w.blue.snr === null || w.band.snr === null || w.red.snr === null) return null;
    return t('spectrum.belowSnr', {
      nBlue: w.blue.n_points,
      nBand: w.band.n_points,
      nRed: w.red.n_points,
      snrBlue: localNumber(lang, w.blue.snr, 1),
      snrBand: localNumber(lang, w.band.snr, 1),
      snrRed: localNumber(lang, w.red.snr, 1),
    });
  };

  const diff = (band: MoverBand) => {
    const d = bandDifference(band);
    return d
      ? {
          band: localNumber(lang, d.band * 1000, 1),
          upper: localNumber(lang, d.upper * 1000, 1),
          sig: localNumber(lang, d.sig, 1),
        }
      : null;
  };

  const status = (b: ReturnType<typeof bandStatus>, label: string) => {
    if (b.state === 'absent') return null;
    const win = b.band
      ? t('spectrum.bandWindows', {
          band: label,
          lo: b.band.windows_um.band[0],
          hi: b.band.windows_um.band[1],
        })
      : label;
    return (
      <li key={label} className="flex flex-col gap-0.5" data-testid={`band-${label}`} data-state={b.state}>
        <span className="text-label-13 font-semibold text-text">{win}</span>
        <span className="text-body-14 text-text-2">
          {b.state === 'not_measurable' || !b.band
            ? (belowSnrText(b.band) ??
              t('spectrum.notMeasurable', { n: b.band?.n_points.band ?? 0, min: MIN_POINTS }))
            : diff(b.band)
              ? t('spectrum.measuredDifference', diff(b.band) ?? {})
              : t('spectrum.measuredExcess', {
                  excess: localNumber(lang, b.band.excess ?? 0, 3),
                  err: localNumber(lang, b.band.excess_err ?? 0, 3),
                  sig: localNumber(lang, b.band.significance ?? 0, 1),
                })}
        </span>
      </li>
    );
  };

  if (!spectrum || pts.length === 0)
    return (
      <section className="rounded-xl border border-border bg-surface p-4" data-testid="mover-spectrum">
        <h2 className="text-title-20 font-medium">{t('spectrum.title')}</h2>
        <p className="mt-2 text-body-14 text-text-2">{t('spectrum.none')}</p>
      </section>
    );

  const v13Text =
    v13?.status === 'pass'
      ? t('spectrum.v13Pass')
      : v13?.status === 'fail'
        ? t('spectrum.v13Fail')
        : v13?.status === 'not_measurable'
          ? t('spectrum.v13NotMeasurable')
          : t('spectrum.v13Unknown');

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
      aria-labelledby="mover-spec-h"
      data-testid="mover-spectrum"
    >
      <h2 id="mover-spec-h" className="text-title-20 font-medium text-text">
        {t('spectrum.title')}
      </h2>
      <PlotlyChart
        data={plot.traces}
        layout={plot.layout}
        config={config}
        label={t('spectrum.plotAria')}
        height={300}
        testId="mover-spectrum-plot"
      />
      <p className="text-caption-12 text-muted" data-testid="mover-counts">
        {t('spectrum.counts', { total: counts.total, flagged: counts.flagged })}
      </p>
      <p className="text-body-14 text-text-2" data-testid="mover-aperture">
        {t('spectrum.aperture', {
          ap: localNumber(lang, spectrum.aperture_arcsec, 1),
          in: spectrum.annulus_arcsec[0],
          out: spectrum.annulus_arcsec[1],
        })}
      </p>
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
        <h3 className="text-label-13 font-semibold">{t('spectrum.bandsTitle')}</h3>
        <ul className="flex flex-col gap-2">
          {status(co2, 'CO2')}
          {status(h2o, 'H2O')}
        </ul>
        <p className="text-body-14 text-text" data-testid="v13-status" data-status={v13?.status ?? 'unknown'}>
          {t('spectrum.v13')}: {v13Text}
        </p>
      </div>
      {chk && chk.n_measured > 0 && (
        <p className="text-body-14 text-text-2" data-testid="mover-ephemeris-check">
          <span className="font-semibold">{t('spectrum.ephemerisTitle')}. </span>
          {t('spectrum.ephemeris', {
            within: chk.n_within,
            measured: chk.n_measured,
            median: localNumber(lang, chk.median_offset_arcsec ?? 0, 2),
            max: localNumber(lang, chk.max_offset_arcsec ?? 0, 2),
          })}
        </p>
      )}
      <p className="text-caption-12 text-muted" data-testid="mover-positions">
        {t('spectrum.positions', { solution: mt?.solution ?? spectrum.solution })}{' '}
        {camp?.parallax_bound_arcsec != null &&
          t('spectrum.parallax', { value: localNumber(lang, camp.parallax_bound_arcsec, 1) })}
      </p>
    </section>
  );
}
