// Plotly theme for the spectrum and residual plots. Derived from design/export/handoff/plotly-theme.ts,
// reading colours from CSS variables at draw time so dark and light themes both work.
import type { Config, Layout, PlotData } from 'plotly.js';
import type { Lang } from './types';
import { ES_GROUP } from './format';

type PlotlyModule = typeof import('plotly.js');
let loader: Promise<PlotlyModule> | null = null;

// Spanish month and day names for date axes (`locale: 'es'` in destelloConfig). Number formats keep Plotly's
// defaults; values shown as text go through lib/format.
const ES_LOCALE = {
  moduleType: 'locale' as const,
  name: 'es',
  dictionary: {},
  format: {
    days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'],
    shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
    months: [
      'enero',
      'febrero',
      'marzo',
      'abril',
      'mayo',
      'junio',
      'julio',
      'agosto',
      'septiembre',
      'octubre',
      'noviembre',
      'diciembre',
    ],
    shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
    date: '%d/%m/%Y',
  },
};

/** Lazy loader: Plotly is a large bundle and is only fetched when a plot is first needed. */
export function loadPlotly(): Promise<PlotlyModule> {
  loader ??= import('plotly.js-basic-dist-min').then((m) => {
    const plotly = (m.default ?? m) as unknown as PlotlyModule;
    plotly.register(ES_LOCALE);
    return plotly;
  });
  return loader;
}

export const cssVar = (n: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim();

export const EPOCH_SYMBOLS = [
  'circle',
  'square',
  'triangle-up',
  'diamond',
  'triangle-down',
  'cross',
  'hexagon',
] as const;
export const epochColor = (i: number): string => cssVar(`epoch-${(i % 7) + 1}`);

export function destelloLayout(lang: Lang, xTitle: string, yTitle: string): Partial<Layout> {
  const text = cssVar('text');
  const muted = cssVar('muted');
  const grid = cssVar('border');
  const axis = cssVar('border-strong');
  const surface = cssVar('surface');
  const axisBase = {
    gridcolor: grid,
    gridwidth: 1,
    zeroline: false,
    linecolor: axis,
    linewidth: 1,
    showline: true,
    ticks: 'outside' as const,
    ticklen: 5,
    tickcolor: axis,
    tickfont: { family: 'JetBrains Mono, monospace', size: 12, color: muted },
  };
  return {
    paper_bgcolor: surface,
    plot_bgcolor: surface,
    font: { family: 'Inter, sans-serif', size: 13, color: text },
    margin: { l: 64, r: 16, t: 44, b: 52 },
    xaxis: {
      ...axisBase,
      title: { text: xTitle, font: { family: 'Inter, sans-serif', size: 13, color: text }, standoff: 12 },
    },
    yaxis: {
      ...axisBase,
      exponentformat: 'power',
      showexponent: 'all',
      title: { text: yTitle, font: { family: 'Inter, sans-serif', size: 13, color: text }, standoff: 12 },
    },
    legend: {
      orientation: 'h',
      x: 1,
      xanchor: 'right',
      y: 1.02,
      yanchor: 'bottom',
      bgcolor: 'transparent',
      font: { family: 'JetBrains Mono, monospace', size: 12, color: text },
    },
    hovermode: 'x unified',
    hoverlabel: {
      bgcolor: cssVar('surface-2'),
      bordercolor: axis,
      font: { family: 'JetBrains Mono, monospace', size: 12, color: text },
    },
    shapes: [],
    annotations: [],
    separators: lang === 'es' ? `,${ES_GROUP}` : '.,', // decimal comma, narrow no-break space for thousands
    dragmode: 'zoom',
  };
}

export const detectorBoundary = (x: number) => ({
  type: 'line' as const,
  xref: 'x' as const,
  yref: 'paper' as const,
  x0: x,
  x1: x,
  y0: 0,
  y1: 1,
  line: { color: cssVar('border-strong'), width: 1, dash: 'dot' as const },
  layer: 'below' as const,
});
export const detectorLabel = (x: number, text: string) => ({
  xref: 'x' as const,
  yref: 'paper' as const,
  x,
  y: 1,
  yanchor: 'bottom' as const,
  showarrow: false,
  text,
  font: { family: 'JetBrains Mono, monospace', size: 12, color: cssVar('muted') },
});

export function epochTrace(
  i: number,
  label: string,
  x: number[],
  y: number[],
  err: number[],
  hover: string,
): Partial<PlotData> {
  const c = epochColor(i);
  return {
    type: 'scatter',
    mode: 'markers',
    name: label,
    x,
    y,
    marker: { color: c, size: 7, symbol: EPOCH_SYMBOLS[i % 7], line: { color: cssVar('surface'), width: 1 } },
    error_y: { type: 'data', array: err, visible: true, color: c, thickness: 1, width: 0 },
    hovertemplate: hover,
  };
}

export const destelloConfig = (lang: Lang, filename: string): Partial<Config> => ({
  displaylogo: false,
  responsive: true,
  locale: lang,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toggleSpikelines'],
  toImageButtonOptions: { format: 'png', filename, scale: 2 },
});
