// F-32 motion search: the button that starts the search and the list of sources that move consistently across the
// full coverage epochs (docs/03 section 4.7). Copy never states that an object was found: every listed source is a
// candidate to review.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { formatNumber, localNumber } from '../../lib/format';
import type { Lang, MotionSource, MotionStatus } from '../../lib/types';
import { coordsText, formatDeg, formatDetectors } from '../candidates/candidateModel';
import {
  MOTION_DASH,
  arcsecYr,
  isFinalMotionError,
  orderSources,
  unavailableMotionCatalogs,
} from './motionModel';
import type { MotionSearchModel } from './useMotionSearch';

/** Line glyph with the same pattern as the track on the frame, ending in the square of the shown epoch. */
export function MotionGlyph({ status }: { status: MotionStatus }) {
  const stroke = status === 'unchecked' ? 'var(--warning)' : 'var(--epoch-3)';
  const dash = MOTION_DASH[status].join(' ') || undefined;
  return (
    <svg
      width="22"
      height="16"
      viewBox="0 0 22 16"
      fill="none"
      stroke={stroke}
      strokeWidth="1.5"
      className="flex-none"
      aria-hidden
    >
      <path d="M2 13 14 5" strokeDasharray={dash} />
      <rect x="13" y="1.5" width="7" height="7" />
    </svg>
  );
}

const LIMITS = ['linear', 'saturated', 'parallax', 'lowCoverage', 'distant'] as const;

function Row({
  s,
  lang,
  selected,
  onSelect,
}: {
  s: MotionSource;
  lang: Lang;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // A track picked on the frame brings its row into view; no animated scroll.
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const n1 = (v: number) => localNumber(lang, v, 1);
  const unit = t('motion.unit');
  const m = s.match;
  const catalog =
    m && (m.catalog === 'gaia_dr3' || m.catalog === 'catwise2020')
      ? t(`cand.catalog.${m.catalog}`)
      : (m?.catalog ?? '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coordsText(s));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <li
      ref={ref}
      className={cn('rounded-lg border', selected ? 'border-cyan bg-surface-2' : 'border-border')}
      data-testid="motion-row"
      data-id={s.id}
      data-status={s.status}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : s.id)}
        className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
        data-testid="motion-select"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="tnum font-mono text-label-13 font-semibold text-text">{s.id}</span>
          <span className="inline-flex items-center gap-1 text-caption-12 font-semibold text-text">
            <MotionGlyph status={s.status} />
            {t(`motion.status.${s.status}`)}
          </span>
        </span>
        <span className="tnum font-mono text-caption-12 text-text" data-testid="motion-pm">
          {t('motion.pm', {
            pmra: arcsecYr(lang, s.pmra_masyr, s.pmra_err_masyr),
            pmdec: arcsecYr(lang, s.pmdec_masyr, s.pmdec_err_masyr),
            unit,
          })}
        </span>
        <span className="tnum flex flex-wrap gap-x-3 font-mono text-caption-12 text-text-2">
          <span>{t('motion.total', { value: arcsecYr(lang, s.pm_total_masyr), unit })}</span>
          <span>{t('cand.snr', { value: n1(s.snr) })}</span>
          <span>{formatDetectors(s.detectors)}</span>
        </span>
        {s.parallax_mas != null && s.parallax_err_mas != null && (
          <span
            className="tnum flex flex-wrap gap-x-3 font-mono text-caption-12 text-text-2"
            data-testid="motion-plx"
          >
            <span>{t('motion.parallax', { value: n1(s.parallax_mas), err: n1(s.parallax_err_mas) })}</span>
            {s.distance_pc != null && s.distance_err_pc != null ? (
              <span data-testid="motion-distance">
                {t('motion.distance', { value: n1(s.distance_pc), err: n1(s.distance_err_pc) })}
              </span>
            ) : (
              <span className="text-muted">{t('motion.noDistance')}</span>
            )}
          </span>
        )}
        <span className="tnum font-mono text-caption-12 text-text-2">
          {t('cand.coords', {
            ra: formatDeg(s.ra_deg),
            dec: `${s.dec_deg >= 0 ? '+' : ''}${formatDeg(s.dec_deg)}`,
          })}
        </span>
        {m && (
          <span className="tnum break-all text-caption-12 text-muted" data-testid="motion-match">
            {t('cand.match', { catalog, id: m.source_id, sep: n1(m.sep_arcsec) })}
            {m.pm_total_masyr !== null
              ? ` · ${t('motion.matchPm', { value: arcsecYr(lang, m.pm_total_masyr), unit })}`
              : ''}
            {m.agreement_sigma !== null
              ? ` · ${t('motion.agreement', { value: n1(m.agreement_sigma) })}`
              : ''}
            {m.parallax_mas != null && m.parallax_agreement_sigma != null
              ? ` · ${t('motion.matchParallax', { value: n1(m.parallax_mas), sigma: n1(m.parallax_agreement_sigma) })}`
              : ''}
          </span>
        )}
      </button>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        <Button size="sm" variant="ghost" onClick={copy} data-testid="motion-copy">
          {copied ? t('cand.copied') : t('cand.copy')}
        </Button>
      </div>
    </li>
  );
}

export function MotionSearchPanel({
  motion,
  lang,
  complete,
  hideTitle = false,
  className,
}: {
  motion: MotionSearchModel;
  lang: Lang;
  /** The build has finished, so every epoch coadd exists. */
  complete: boolean;
  /** The mobile dialog already carries the title. */
  hideTitle?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { data } = motion;
  const missing = data ? unavailableMotionCatalogs(data) : [];
  const int = (v: number) => formatNumber(lang, v, { maximumFractionDigits: 0 });
  const dec = (v: number, d = 1) => formatNumber(lang, v, { maximumFractionDigits: d });
  const sources = data ? orderSources(data.sources) : [];

  return (
    <section
      className={cn('flex min-w-0 flex-col gap-3', className)}
      aria-label={hideTitle ? t('motion.title') : undefined}
      aria-labelledby={hideTitle ? undefined : 'motion-heading'}
      data-testid="motion-panel"
    >
      <header className="flex flex-col gap-1">
        {!hideTitle && (
          <h2 id="motion-heading" className="text-body-15 font-semibold">
            {t('motion.title')}
          </h2>
        )}
        <p className="text-caption-12 text-text-2">{t('motion.intro')}</p>
      </header>

      {!motion.requested ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={!complete}
            onClick={motion.run}
            aria-describedby={complete ? undefined : 'motion-run-reason'}
            data-testid="motion-run"
          >
            {t('motion.run')}
          </Button>
          {!complete && (
            <p id="motion-run-reason" className="text-caption-12 text-muted">
              {t('motion.waiting')}
            </p>
          )}
        </div>
      ) : (
        <p
          className="rounded-lg border border-border-strong px-3 py-2 text-caption-12 text-text"
          data-testid="motion-disclaimer"
        >
          {t('motion.disclaimer')}
        </p>
      )}

      {motion.requested &&
        (motion.waiting ? (
          <p className="text-body-14 text-text-2" role="status" data-testid="motion-waiting">
            {t('motion.waiting')}
          </p>
        ) : motion.errorKey ? (
          <div
            className="flex flex-col items-start gap-2 rounded-lg border border-danger p-3"
            role="alert"
            data-testid="motion-error"
            data-code={motion.errorKey}
          >
            <p className="text-body-14 text-text">{t(`motion.err.${motion.errorKey}`)}</p>
            {!isFinalMotionError(motion.errorKey) && (
              <Button size="sm" onClick={motion.refetch}>
                {t('states.retry')}
              </Button>
            )}
          </div>
        ) : !data ? (
          <p className="text-body-14 text-text-2" role="status" data-testid="motion-loading">
            {t('motion.loading')}
          </p>
        ) : (
          <>
            <dl
              className="flex flex-wrap gap-x-4 gap-y-1 text-caption-12"
              aria-label={t('motion.countsLabel')}
              data-testid="motion-counts"
            >
              {(
                [
                  ['listed', t('motion.count.listed'), data.counts.listed],
                  ['unmatched', t('motion.status.unmatched'), data.counts.unmatched],
                  ['unchecked', t('motion.status.unchecked'), data.counts.unchecked],
                  ['target', t('motion.status.target'), data.counts.target],
                  ['known_source', t('motion.status.known_source'), data.counts.known_source],
                ] as const
              ).map(([k, label, v]) => (
                <div key={k} className="flex items-baseline gap-1" data-count={k}>
                  <dt className="text-muted">{label}</dt>
                  <dd className="tnum font-mono font-semibold text-text">{int(v ?? 0)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-caption-12 text-text-2" data-testid="motion-method">
              {t('motion.method', {
                epochs: data.epochs.length,
                years: dec(data.baseline_years, 2),
                mu: dec(data.mu_max_arcsec_yr),
                sigma: dec(data.threshold_sigma),
                n: data.min_detectors,
                radius: dec(data.match_radius_arcsec),
              })}{' '}
              {data.parallax_fitted
                ? t('motion.parallaxFitted', { sigma: dec(data.min_parallax_sigma ?? 3) })
                : t('motion.parallaxFixed')}
            </p>
            {missing.length > 0 && (
              <p
                className="rounded-lg border border-warning px-3 py-2 text-caption-12 text-text"
                role="status"
                data-testid="motion-unchecked-notice"
              >
                {t('motion.uncheckedNotice', {
                  catalogs: missing.map((k) => t(`cand.catalog.${k}`)).join(` ${t('cand.and')} `),
                })}
              </p>
            )}
            {data.truncated && (
              <p
                className="rounded-lg border border-warning px-3 py-2 text-caption-12 text-text"
                role="status"
                data-testid="motion-truncated"
              >
                {t('motion.truncated')}
              </p>
            )}
            {sources.length === 0 ? (
              <p className="text-body-14 font-medium text-text" data-testid="motion-empty">
                {t('motion.empty')}
              </p>
            ) : (
              <>
                <p className="text-caption-12 text-text-2" data-testid="motion-on-frame">
                  {t('motion.onFrame')}
                </p>
                <ul
                  className="flex flex-col gap-2"
                  aria-label={t('motion.listLabel')}
                  data-testid="motion-list"
                >
                  {sources.map((s) => (
                    <Row
                      key={s.id}
                      s={s}
                      lang={lang}
                      selected={motion.selected === s.id}
                      onSelect={motion.setSelected}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        ))}

      <details className="text-caption-12 text-text-2" data-testid="motion-limits">
        <summary className="min-h-[var(--hit-min)] cursor-pointer content-center font-semibold text-text">
          {t('motion.limits.title')}
        </summary>
        <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
          {LIMITS.map((k) => (
            <li key={k} data-limit={k}>
              {t(`motion.limits.${k}`)}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
