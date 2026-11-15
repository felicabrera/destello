// F-29 candidates to review: the toggle and the list of places where the two epochs on screen differ.
// Copy never states that an object was found: a candidate is a difference between two epochs, to be reviewed.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { epochMid, formatNumber, localNumber, mjdIso } from '../../lib/format';
import type { Candidate, CandidateStatus, EpochInfo, Lang } from '../../lib/types';
import {
  GROUP_STATUSES,
  STATUS_DASH,
  brighterEpoch,
  coordsText,
  formatDeg,
  formatDetectors,
  groupCandidates,
  unavailableCatalogs,
  type EpochPair,
} from './candidateModel';
import type { CandidatesModel } from './useCandidates';

/** Ring glyph with the same line pattern as the marker on the frame. */
export function StatusGlyph({ status, pair = false }: { status: CandidateStatus; pair?: boolean }) {
  const stroke = status === 'unchecked' ? 'var(--warning)' : 'var(--text)';
  const dash = STATUS_DASH[status].join(' ') || undefined;
  if (pair)
    return (
      <svg
        width="28"
        height="16"
        viewBox="0 0 28 16"
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        aria-hidden
      >
        <circle cx="6" cy="8" r="4.5" />
        <circle cx="22" cy="8" r="4.5" />
        <path d="M10.5 8h7" />
      </svg>
    );
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke={stroke}
      strokeWidth="1.5"
      className="flex-none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" strokeDasharray={dash} />
      {status === 'not_measurable' && <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />}
    </svg>
  );
}

export function CandidatesToggle({
  on,
  onChange,
  count,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Entries listed for the pair on screen, once known. */
  count?: number | null;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={t('cand.toggleHint')}
      onClick={() => onChange(!on)}
      className={cn(
        'flex min-h-[var(--hit-min)] items-center gap-2 self-start rounded-lg border px-2.5 text-label-13 font-medium transition-colors duration-(--duration-fast)',
        on
          ? 'border-glint bg-glint-soft text-text'
          : 'border-border-strong bg-surface-2 text-text hover:bg-border',
      )}
      data-testid="cand-toggle"
    >
      <StatusGlyph status="unmatched" />
      {t('cand.toggle')}
      {on && typeof count === 'number' && (
        <span className="tnum text-caption-12 font-normal text-muted" data-testid="cand-toggle-count">
          {count}
        </span>
      )}
    </button>
  );
}

function epochDate(e: EpochInfo | undefined): string {
  const mid = e ? epochMid(e) : undefined;
  return mid !== undefined ? mjdIso(mid) : '';
}

function Row({
  c,
  pair,
  lang,
  selected,
  onSelect,
  onReport,
  reportReason,
}: {
  c: Candidate;
  pair: EpochPair;
  lang: Lang;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onReport?: (c: Candidate) => void;
  reportReason: string | null;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    // A marker picked on the frame brings its row into view; no animated scroll.
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  const n1 = (v: number) => localNumber(lang, v, 1);
  const be = brighterEpoch(c, pair);
  const kind = be === null ? t('cand.kind.moved') : t('cand.kind.brighter', { epoch: be });
  const catalog =
    c.match && (c.match.catalog === 'gaia_dr3' || c.match.catalog === 'catwise2020')
      ? t(`cand.catalog.${c.match.catalog}`)
      : (c.match?.catalog ?? '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(coordsText(c));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <li
      ref={ref}
      className={cn('rounded-lg border', selected ? 'border-cyan bg-surface-2' : 'border-border')}
      data-testid="cand-row"
      data-id={c.id}
      data-status={c.status}
      data-x={c.x}
      data-y={c.y}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : c.id)}
        className="flex w-full min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
        data-testid="cand-select"
      >
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="tnum font-mono text-label-13 font-semibold text-text">{c.id}</span>
          <span className="inline-flex items-center gap-1 text-caption-12 font-semibold text-text">
            <StatusGlyph status={c.status} />
            {t(`cand.status.${c.status}`)}
          </span>
          <span className="text-caption-12 text-text-2">{kind}</span>
        </span>
        <span className="tnum flex flex-wrap gap-x-3 font-mono text-caption-12 text-text-2">
          <span>{t('cand.snr', { value: n1(c.snr) })}</span>
          <span>{formatDetectors(c.detectors)}</span>
        </span>
        <span className="tnum font-mono text-caption-12 text-text-2">
          {t('cand.coords', {
            ra: formatDeg(c.ra_deg),
            dec: `${c.dec_deg >= 0 ? '+' : ''}${formatDeg(c.dec_deg)}`,
          })}
        </span>
        {c.separation_arcsec !== null && (
          <span className="tnum text-caption-12 text-text-2">
            {t('cand.separation', { value: n1(c.separation_arcsec) })}
          </span>
        )}
        {c.match && (
          <span className="tnum break-all text-caption-12 text-muted" data-testid="cand-match">
            {t('cand.match', { catalog, id: c.match.source_id, sep: n1(c.match.sep_arcsec) })}
            {c.match.mag !== null
              ? ` · ${t('cand.matchMag', { band: c.match.mag_band ?? '', mag: n1(c.match.mag) }).trim()}`
              : ''}
          </span>
        )}
      </button>
      <div className="flex flex-wrap gap-1 px-2 pb-2">
        <Button size="sm" variant="ghost" onClick={copy} data-testid="cand-copy">
          {copied ? t('cand.copied') : t('cand.copy')}
        </Button>
        {onReport &&
          (reportReason ? (
            <Button
              size="sm"
              variant="ghost"
              aria-disabled
              aria-describedby="cand-report-reason"
              title={reportReason}
              className="text-disabled hover:bg-transparent hover:text-disabled"
              data-testid="cand-report"
            >
              {t('cand.report')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              title={t('cand.reportHint')}
              onClick={() => onReport(c)}
              data-testid="cand-report"
            >
              {t('cand.report')}
            </Button>
          ))}
      </div>
    </li>
  );
}

export function CandidatesPanel({
  cand,
  epochs,
  lang,
  onReport,
  reportReason = null,
  hideTitle = false,
  className,
}: {
  cand: CandidatesModel;
  epochs: EpochInfo[];
  lang: Lang;
  /** F-22: opens the report flow with the candidate position marked in both epochs. */
  onReport?: (c: Candidate) => void;
  /** Why reporting is off (demo mode, unfinished build), or null. */
  reportReason?: string | null;
  /** The mobile dialog already carries the title. */
  hideTitle?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const { pair, data } = cand;
  const groups = data ? groupCandidates(data.candidates) : null;
  const missing = data ? unavailableCatalogs(data) : [];
  const int = (v: number) => formatNumber(lang, v, { maximumFractionDigits: 0 });
  const rowProps = {
    lang,
    onSelect: cand.setSelected,
    onReport,
    reportReason,
  };

  return (
    <section
      className={cn('flex min-w-0 flex-col gap-3', className)}
      aria-label={hideTitle ? t('cand.title') : undefined}
      aria-labelledby={hideTitle ? undefined : 'cand-heading'}
      data-testid="cand-panel"
    >
      <header className="flex flex-col gap-1">
        {!hideTitle && (
          <h2 id="cand-heading" className="text-body-15 font-semibold">
            {t('cand.title')}
          </h2>
        )}
        {pair && (
          <p className="tnum text-caption-12 text-muted" data-testid="cand-pair">
            {t('cand.pair', {
              a: pair.posA + 1,
              dateA: epochDate(epochs[pair.posA]),
              b: pair.posB + 1,
              dateB: epochDate(epochs[pair.posB]),
            })}
          </p>
        )}
      </header>
      <p
        className="rounded-lg border border-border-strong px-3 py-2 text-caption-12 text-text"
        data-testid="cand-disclaimer"
      >
        {t('cand.disclaimer')}
      </p>
      {reportReason && (
        <span id="cand-report-reason" className="sr-only">
          {reportReason}
        </span>
      )}

      {cand.waiting ? (
        <p className="text-body-14 text-text-2" role="status" data-testid="cand-waiting">
          {t('cand.waiting')}
        </p>
      ) : !pair ? (
        <p className="text-body-14 text-text-2" role="status" data-testid="cand-need-pair">
          {t('cand.needPair')}
        </p>
      ) : cand.lowPair ? (
        <p className="text-body-14 text-text-2" role="status" data-testid="cand-low">
          {t('cand.lowPair')}
        </p>
      ) : cand.errorKey ? (
        <div
          className="flex flex-col items-start gap-2 rounded-lg border border-danger p-3"
          role="alert"
          data-testid="cand-error"
        >
          <p className="text-body-14 text-text">{t(`cand.err.${cand.errorKey}`)}</p>
          {cand.errorKey !== 'DEMO_UNAVAILABLE' && cand.errorKey !== 'LOW_COVERAGE_EPOCH' && (
            <Button size="sm" onClick={cand.refetch}>
              {t('states.retry')}
            </Button>
          )}
        </div>
      ) : !data || !groups ? (
        <p className="text-body-14 text-text-2" role="status" data-testid="cand-loading">
          {t('cand.loading')}
        </p>
      ) : (
        <>
          <dl
            className="flex flex-wrap gap-x-4 gap-y-1 text-caption-12"
            aria-label={t('cand.countsLabel')}
            data-testid="cand-counts"
          >
            {(
              [
                ['listed', t('cand.count.listed'), data.counts.listed],
                ['unmatched', t('cand.status.unmatched'), data.counts.unmatched],
                ['unchecked', t('cand.status.unchecked'), data.counts.unchecked],
                ['target', t('cand.status.target'), data.counts.target],
                ['known_source', t('cand.status.known_source'), data.counts.known_source],
                ['not_measurable', t('cand.status.not_measurable'), data.counts.not_measurable],
              ] as const
            ).map(([k, label, v]) => (
              <div key={k} className="flex items-baseline gap-1" data-count={k}>
                <dt className="text-muted">{label}</dt>
                <dd className="tnum font-mono font-semibold text-text">{int(v)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-caption-12 text-text-2" data-testid="cand-method">
            {t('cand.method', {
              sigma: formatNumber(lang, data.threshold_sigma, { maximumFractionDigits: 1 }),
              n: data.min_detectors_unpaired,
              radius: formatNumber(lang, data.match_radius_arcsec, { maximumFractionDigits: 1 }),
            })}
          </p>
          {missing.length > 0 && (
            <p
              className="rounded-lg border border-warning px-3 py-2 text-caption-12 text-text"
              role="status"
              data-testid="cand-unchecked-notice"
            >
              {t('cand.uncheckedNotice', {
                catalogs: missing.map((k) => t(`cand.catalog.${k}`)).join(` ${t('cand.and')} `),
              })}
            </p>
          )}
          {data.truncated && (
            <p
              className="rounded-lg border border-warning px-3 py-2 text-caption-12 text-text"
              role="status"
              data-testid="cand-truncated"
            >
              {t('cand.truncated')}
            </p>
          )}

          {data.candidates.length === 0 ? (
            <p className="text-body-14 font-medium text-text" data-testid="cand-empty">
              {t('cand.empty')}
            </p>
          ) : (
            <>
              {data.counts.unmatched > 0 && (
                <p className="text-caption-12 text-text-2" data-testid="cand-causes">
                  {t('cand.causes')}
                </p>
              )}
              <ul
                className="flex flex-wrap gap-x-4 gap-y-1 text-caption-12 text-text-2"
                aria-label={t('cand.legend.title')}
                data-testid="cand-legend"
              >
                <li className="flex items-center gap-1.5">
                  <StatusGlyph status="unmatched" />
                  {t('cand.status.unmatched')}
                </li>
                <li className="flex items-center gap-1.5">
                  <StatusGlyph status="unchecked" />
                  {t('cand.status.unchecked')}
                </li>
                <li className="flex items-center gap-1.5">
                  <StatusGlyph status="known_source" />
                  {t('cand.legend.known')}
                </li>
                <li className="flex items-center gap-1.5">
                  <StatusGlyph status="not_measurable" />
                  {t('cand.status.not_measurable')}
                </li>
                <li className="flex items-center gap-1.5">
                  <StatusGlyph status="unmatched" pair />
                  {t('cand.legend.moved', { a: pair.posA + 1, b: pair.posB + 1 })}
                </li>
              </ul>
              {groups.primary.length === 0 ? (
                <p className="text-body-14 text-text-2" data-testid="cand-empty-primary">
                  {t('cand.emptyPrimary')}
                </p>
              ) : (
                <ul
                  className="flex flex-col gap-1.5"
                  aria-label={t('cand.listLabel')}
                  data-testid="cand-list"
                >
                  {groups.primary.map((c) => (
                    <Row key={c.id} c={c} pair={pair} selected={cand.selected === c.id} {...rowProps} />
                  ))}
                </ul>
              )}
              {GROUP_STATUSES.map((s) => {
                const list = groups.groups[s as keyof typeof groups.groups];
                if (list.length === 0) return null;
                const open = !!cand.open[s];
                return (
                  <div key={s} className="flex flex-col gap-1.5" data-testid={`cand-group-${s}`}>
                    <button
                      type="button"
                      aria-expanded={open}
                      aria-controls={`cand-group-list-${s}`}
                      onClick={() => cand.toggleGroup(s)}
                      className="flex min-h-[var(--hit-min)] items-center gap-2 rounded-lg border border-border px-3 text-left text-label-13 font-medium text-text hover:bg-surface-2"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className={cn('flex-none text-muted', open && 'rotate-90')}
                        aria-hidden="true"
                      >
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                      <StatusGlyph status={s} />
                      <span className="min-w-0">
                        {t('cand.group', { label: t(`cand.status.${s}`), count: int(list.length) })}
                      </span>
                    </button>
                    {open && (
                      <>
                        <p className="text-caption-12 text-muted">
                          {t(`cand.statusHelp.${s}`, {
                            radius: formatNumber(lang, data.match_radius_arcsec, {
                              maximumFractionDigits: 1,
                            }),
                          })}
                        </p>
                        <ul id={`cand-group-list-${s}`} className="flex flex-col gap-1.5">
                          {list.map((c) => (
                            <Row
                              key={c.id}
                              c={c}
                              pair={pair}
                              selected={cand.selected === c.id}
                              {...rowProps}
                            />
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                );
              })}
            </>
          )}
          <p className="text-caption-12 text-muted" data-testid="cand-dropped">
            {t('cand.dropped', {
              single: int(data.counts.single_detector_dropped),
              extended: int(data.counts.extended_dropped),
            })}
          </p>
        </>
      )}
    </section>
  );
}
