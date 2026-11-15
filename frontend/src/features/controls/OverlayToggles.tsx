import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { formatNumber, localPercent } from '../../lib/format';
import { refEpochLabel } from '../../lib/astrometry';
import type { Lang, OverlayCount, OverlayKey, PathData } from '../../lib/types';
import { ellipseExtentPx, PATH_ELLIPSE_MIN_PX } from '../player/draw';

export interface FlagLegend {
  /** Masking flag names from the manifest (FLAGS headers); null for manifests that predate them. */
  names: string[] | null;
  fraction: number | null;
}

interface Props {
  active: Set<OverlayKey>;
  disabledInDiff: boolean;
  counts: Partial<Record<OverlayKey, OverlayCount>>;
  onToggle: (k: OverlayKey) => void;
  onRetry?: (k: OverlayKey) => void;
  flagLegend?: FlagLegend;
  /** F-27 predicted path: why it is off (null when available) and the computed path when loaded. */
  path?: { reason: 'demo' | 'noMotion' | null; data: PathData | null };
  lang?: Lang;
}

const LEGEND_ID = 'flags-legend';
const PATH_LEGEND_ID = 'path-legend';
const PATH_OFF_ID = 'path-off';

const KEYS: { key: OverlayKey; shortcut: string }[] = [
  { key: 'gaia', shortcut: 'G' },
  { key: 'catwise', shortcut: 'W' },
  { key: 'flags', shortcut: 'F' },
  { key: 'path', shortcut: 'P' },
];

function Glyph({ k, size = 16 }: { k: OverlayKey; size?: number }) {
  if (k === 'gaia')
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--cyan)"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5" />
      </svg>
    );
  if (k === 'catwise')
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--violet)"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="10" height="10" />
      </svg>
    );
  if (k === 'path')
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="var(--epoch-2)"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <path d="M2 13 C6 12 9 5 14 3" />
        <path d="M4 10.5 5.5 12 4 13.5 2.5 12Z M10.5 5 12 6.5 10.5 8 9 6.5Z" fill="var(--epoch-2)" />
      </svg>
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="var(--warning)"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M3 9 9 3M3 13 13 3M7 13 13 7" />
    </svg>
  );
}

function FlagsLegend({ legend, lang }: { legend: FlagLegend; lang: Lang }) {
  const { t } = useTranslation();
  const { names, fraction } = legend;
  return (
    <div
      id={LEGEND_ID}
      className="flex max-w-[360px] items-start gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2"
      data-testid="flags-legend"
    >
      <Glyph k="flags" size={20} />
      <div className="flex min-w-0 flex-col gap-1 text-caption-12 text-text-2">
        <span className="font-semibold text-text">{t('overlays.flagsLegendTitle')}</span>
        <span>
          {fraction !== null
            ? t('overlays.flagsLegendBody', { fraction: localPercent(lang, fraction) })
            : t('overlays.flagsLegendBodyNoFraction')}
        </span>
        {names === null ? (
          <span className="text-muted">{t('overlays.flagsLegendUnknown')}</span>
        ) : names.length === 0 ? (
          <span className="text-muted">{t('overlays.flagsLegendNoNames')}</span>
        ) : (
          <span>
            {t('overlays.flagsLegendNames')}{' '}
            <span className="inline-flex flex-wrap gap-1 align-middle" data-testid="flags-legend-names">
              {names.map((n) => (
                <code
                  key={n}
                  className="rounded-xs border border-border-strong px-1 font-mono text-caption-12 text-text"
                >
                  {n}
                </code>
              ))}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** The parallax loop, enlarged to fill the inset; orientation as on the frame (east left, north up). */
function EllipseInset({ points }: { points: [number, number][] }) {
  const cx = points.reduce((a, q) => a + q[0], 0) / points.length;
  const cy = points.reduce((a, q) => a + q[1], 0) / points.length;
  const r = Math.max(...points.map(([x, y]) => Math.hypot(x - cx, y - cy))) || 1;
  const d =
    points
      .map(
        ([x, y], i) =>
          `${i === 0 ? 'M' : 'L'}${(28 + ((x - cx) / r) * 22).toFixed(2)} ${(28 + ((y - cy) / r) * 22).toFixed(2)}`,
      )
      .join(' ') + 'Z';
  return (
    <svg
      width="56"
      height="56"
      viewBox="0 0 56 56"
      aria-hidden="true"
      className="shrink-0 rounded-md bg-frame"
    >
      <path d={d} fill="none" stroke="var(--epoch-2)" strokeWidth="1.25" strokeDasharray="3 3" />
      <circle cx="28" cy="28" r="1.5" fill="var(--epoch-2)" />
    </svg>
  );
}

function PathLegend({ data, lang }: { data: PathData; lang: Lang }) {
  const { t } = useTranslation();
  const ell = data.ellipse;
  const scale = data.pixel_scale_arcsec || 1;
  const fmt = (v: number, d: number) =>
    formatNumber(lang, v, { minimumFractionDigits: d, maximumFractionDigits: d });
  const onFrame = !!ell && ellipseExtentPx(ell.points.map(([x, y]) => ({ x, y }))) >= PATH_ELLIPSE_MIN_PX;
  return (
    <div
      id={PATH_LEGEND_ID}
      className="flex max-w-[360px] items-start gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2"
      data-testid="path-legend"
    >
      {ell ? <EllipseInset points={ell.points} /> : <Glyph k="path" size={20} />}
      <div className="flex min-w-0 flex-col gap-1 text-caption-12 text-text-2">
        <span className="font-semibold text-text">{t('overlays.pathLegendTitle')}</span>
        <span>
          {t('overlays.pathLegendBody', { epoch: refEpochLabel(data.ref_epoch) ?? data.ref_epoch })}
        </span>
        {ell ? (
          <span data-testid="path-ellipse">
            {t('overlays.pathEllipse', {
              major: fmt(ell.semi_major_arcsec, 3),
              majorPx: fmt(ell.semi_major_arcsec / scale, 2),
              minor: fmt(ell.semi_minor_arcsec, 3),
              minorPx: fmt(ell.semi_minor_arcsec / scale, 2),
            })}{' '}
            {onFrame ? t('overlays.pathEllipseOnFrame') : t('overlays.pathEllipseInset')}
          </span>
        ) : (
          <span className="text-muted" data-testid="path-no-parallax">
            {t('overlays.pathNoParallax')}
          </span>
        )}
        <span className="text-muted">{t('overlays.pathObserver')}</span>
      </div>
    </div>
  );
}

export function OverlayToggles({
  active,
  disabledInDiff,
  counts,
  onToggle,
  onRetry,
  flagLegend,
  path,
  lang = 'en',
}: Props) {
  const { t } = useTranslation();
  const showLegend = !!flagLegend && active.has('flags') && !disabledInDiff;
  const pathOff = path?.reason ?? null;
  const showPathLegend = !!path?.data && active.has('path') && !disabledInDiff && pathOff === null;
  const keys = path ? KEYS : KEYS.filter((k) => k.key !== 'path');
  return (
    <div className="flex flex-col gap-1.5" data-testid="overlay-toggles">
      <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted" id="ov-label">
        {t('overlays.label')}
      </span>
      <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="ov-label">
        {keys.map(({ key, shortcut }) => {
          const off = disabledInDiff || (key === 'path' && pathOff !== null);
          const on = active.has(key) && !(key === 'path' && pathOff !== null);
          const c = counts[key];
          const sub =
            on && c === 'loading'
              ? t('overlays.loading')
              : on && c === 'unavailable'
                ? t('overlays.unavailable')
                : on && c === 'failed'
                  ? t('overlays.failed')
                  : on && c === 'none' && key === 'flags'
                    ? t('overlays.flagsNone')
                    : on && typeof c === 'number'
                      ? t('overlays.count', { count: c })
                      : null;
          return (
            <span key={key} className="inline-flex items-center gap-1">
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-disabled={off || undefined}
                aria-describedby={
                  key === 'flags' && showLegend
                    ? LEGEND_ID
                    : key === 'path' && pathOff !== null
                      ? PATH_OFF_ID
                      : key === 'path' && showPathLegend
                        ? PATH_LEGEND_ID
                        : undefined
                }
                title={disabledInDiff ? t('overlays.hiddenInDiff') : t(`overlays.${key}Legend`)}
                onClick={() => {
                  if (!off) onToggle(key);
                }}
                className={cn(
                  'flex min-h-[var(--hit-min)] items-center gap-2 rounded-lg border px-2.5 text-label-13 font-medium transition-colors duration-(--duration-fast)',
                  on
                    ? 'border-glint bg-glint-soft text-text'
                    : 'border-border-strong bg-surface-2 text-text hover:bg-border',
                  off && 'border-border text-disabled hover:bg-surface-2',
                )}
                data-testid={`ov-${key}`}
              >
                <Glyph k={key} />
                <span className="flex flex-col items-start py-0.5 text-left leading-4">
                  <span>{t(`overlays.${key}`)}</span>
                  {sub && (
                    <span className="max-w-[220px] whitespace-normal text-caption-12 font-normal text-muted">
                      {sub}
                    </span>
                  )}
                </span>
                <kbd className="tnum rounded-sm border border-border-strong px-1 text-caption-12 text-muted">
                  {shortcut}
                </kbd>
              </button>
              {key === 'path' && pathOff !== null && (
                <span id={PATH_OFF_ID} className="sr-only">
                  {t(pathOff === 'demo' ? 'overlays.pathOffDemo' : 'overlays.pathOffNoMotion')}
                </span>
              )}
              {on && (c === 'unavailable' || c === 'failed') && onRetry && key !== 'flags' && (
                <button
                  type="button"
                  className="min-h-[var(--hit-min)] rounded-lg border border-border-strong px-2 text-caption-12 text-text hover:bg-border"
                  onClick={() => onRetry(key)}
                  data-testid={`ov-retry-${key}`}
                >
                  {t('overlays.retry')}
                </button>
              )}
            </span>
          );
        })}
      </div>
      {showLegend && flagLegend && <FlagsLegend legend={flagLegend} lang={lang} />}
      {showPathLegend && path?.data && <PathLegend data={path.data} lang={lang} />}
    </div>
  );
}
