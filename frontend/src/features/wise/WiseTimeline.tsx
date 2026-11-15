// F-40: "16 years" view. One time axis from 2010 to 2026 with a marker for every real coadd of the same field:
// WISE, NEOWISE and SPHEREx. Mounted by the explorer for a sequence that has a WISE companion; renders nothing
// when there is none. Frames are shown as stored: no per-frame stretch, no interpolation between epochs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { getWiseAstrometry, getWiseManifest, resolveAsset } from '../../lib/api';
import { cn } from '../../lib/cn';
import { localDate, localNumber, mjdToDate } from '../../lib/format';
import type { Lang, Manifest } from '../../lib/types';
import {
  AXIS_END_YEAR,
  AXIS_START_YEAR,
  axisFraction,
  axisTicks,
  buildTimeline,
  keyAction,
  missionCounts,
  stepIndex,
  wiseWindow,
  type TimelineEntry,
  type TimelineMission,
  type WiseAstrometry,
  type WiseManifest,
} from '../../lib/wise';

const PLAY_INTERVAL_MS = 900;

// Colour and shape both encode the mission (colour-blind safe palette tokens, distinct shapes).
const MARK: Record<TimelineMission, string> = {
  WISE: 'bg-epoch-1 rounded-full',
  NEOWISE: 'bg-epoch-3 rotate-45 rounded-[2px]',
  SPHEREx: 'bg-epoch-6 rounded-[2px]',
};

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function useWiseCompanion(sequenceId: string | undefined) {
  return useQuery<WiseManifest | null>({
    queryKey: ['wise', 'manifest', sequenceId],
    queryFn: ({ signal }) => getWiseManifest(sequenceId ?? '', signal),
    enabled: !!sequenceId,
    staleTime: 60_000,
    retry: false,
  });
}

function pm(lang: Lang, v: number, e: number, t: (k: string, o: Record<string, string>) => string): string {
  return t('astrometry.value', { value: localNumber(lang, v, 0), err: localNumber(lang, e, 0) });
}

function Astrometry({ sequenceId, lang }: { sequenceId: string; lang: Lang }) {
  const { t } = useTranslation('wise');
  const q = useQuery<WiseAstrometry | null>({
    queryKey: ['wise', 'astrometry', sequenceId],
    queryFn: ({ signal }) => getWiseAstrometry(sequenceId, signal),
    staleTime: 60_000,
    retry: false,
  });
  const tt = (k: string, o: Record<string, string>) => t(k, o);
  let body: React.ReactNode;
  const a = q.data;
  if (q.isPending) body = <p className="text-body-14 text-text-2">{t('astrometry.loading')}</p>;
  else if (q.isError) body = <p className="text-body-14 text-text-2">{t('astrometry.failed')}</p>;
  else if (!a) body = <p className="text-body-14 text-text-2">{t('astrometry.unavailable')}</p>;
  else if (a.status === 'not_measurable' || !a.fit)
    body = <p className="text-body-14 text-text-2">{t('astrometry.notMeasurable')}</p>;
  else {
    const f = a.fit;
    const r = a.reference;
    body = (
      <>
        <table className="w-full text-left text-body-14">
          <thead className="text-caption-12 text-muted">
            <tr>
              <th scope="col" className="py-1 pr-2 font-medium" />
              <th scope="col" className="py-1 pr-2 font-medium">
                {t('astrometry.measured')}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('astrometry.reference')}
              </th>
            </tr>
          </thead>
          <tbody className="tnum">
            <tr data-testid="wise-pmra">
              <th scope="row" className="py-1 pr-2 font-normal text-text-2">
                {t('astrometry.pmra')}
              </th>
              <td className="py-1 pr-2">{pm(lang, f.pmra_masyr, f.pmra_err_masyr, tt)}</td>
              <td className="py-1">{r ? pm(lang, r.pmra_masyr, r.pmra_err_masyr, tt) : ''}</td>
            </tr>
            <tr data-testid="wise-pmdec">
              <th scope="row" className="py-1 pr-2 font-normal text-text-2">
                {t('astrometry.pmdec')}
              </th>
              <td className="py-1 pr-2">{pm(lang, f.pmdec_masyr, f.pmdec_err_masyr, tt)}</td>
              <td className="py-1">{r ? pm(lang, r.pmdec_masyr, r.pmdec_err_masyr, tt) : ''}</td>
            </tr>
          </tbody>
        </table>
        <ul className="flex flex-col gap-1 text-label-13 text-text-2">
          <li>
            {t('astrometry.epochs', {
              wise: String(a.epochs_per_mission.WISE),
              spherex: String(a.epochs_per_mission.SPHEREx),
            })}
          </li>
          {a.agreement_sigma !== undefined && (
            <li>
              {t('astrometry.agreement', {
                sigma: localNumber(lang, a.agreement_sigma, 1),
                status: t(`astrometry.status.${a.status === 'pass' ? 'pass' : 'fail'}`),
              })}
            </li>
          )}
          {a.reference_source && <li>{t('astrometry.referenceSource', { source: a.reference_source })}</li>}
          {a.spherex_only && a.error_ratio_spherex_only && (
            <li data-testid="wise-spherex-only">
              {t('astrometry.spherexOnly', {
                ra: localNumber(lang, a.spherex_only.pmra_err_masyr, 0),
                dec: localNumber(lang, a.spherex_only.pmdec_err_masyr, 0),
                rar: localNumber(lang, a.error_ratio_spherex_only[0], 0),
                decr: localNumber(lang, a.error_ratio_spherex_only[1], 0),
              })}
            </li>
          )}
          <li>{t('astrometry.referenceNote')}</li>
        </ul>
      </>
    );
  }
  return (
    <section aria-labelledby="wise-astro-h" className="flex flex-col gap-2" data-testid="wise-astrometry">
      <h4 id="wise-astro-h" className="text-body-15 font-semibold">
        {t('astrometry.title')}
      </h4>
      {body}
    </section>
  );
}

function Details({ e, lang }: { e: TimelineEntry; lang: Lang }) {
  const { t } = useTranslation('wise');
  const rows: [string, string][] = [
    [t('frame.mission'), e.mission],
    [t('frame.date'), localDate(lang, mjdToDate(e.mjd))],
    [t('frame.images'), String(e.nImages)],
  ];
  if (e.wavelengthUm)
    rows.push([
      t('frame.band'),
      `${localNumber(lang, e.wavelengthUm[0], 2)} to ${localNumber(lang, e.wavelengthUm[1], 2)} µm`,
    ]);
  if (e.detector !== undefined) rows.push([t('frame.detector'), `D${e.detector}`]);
  if (e.stretch)
    rows.push([
      t('frame.stretch', { key: e.stretchKey }),
      t('frame.stretchValue', {
        method: e.stretch.method,
        vmin: localNumber(lang, e.stretch.vmin, 1),
        vmax: localNumber(lang, e.stretch.vmax, 1),
        unit: e.stretch.unit,
      }),
    ]);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-label-13" data-testid="wise-details">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="tnum text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface WiseTimelineProps {
  /** SPHEREx sequence id (the companion is found from it). */
  sequenceId: string | undefined;
  /** Manifest of that sequence, for the SPHEREx markers. */
  manifest: Manifest | null | undefined;
  lang: Lang;
}

export function WiseTimeline({ sequenceId, manifest, lang }: WiseTimelineProps) {
  const { t } = useTranslation('wise');
  const q = useWiseCompanion(sequenceId);
  const wise = q.data ?? null;
  const entries = useMemo(() => (wise ? buildTimeline(manifest ?? null, wise) : []), [wise, manifest]);
  const reduced = usePrefersReducedMotion();
  const [sel, setSel] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const n = entries.length;
  // The first view is the latest epoch; the user selects, steps or plays from there. Never autoplays.
  const idx = sel === null ? Math.max(0, n - 1) : Math.min(sel, Math.max(0, n - 1));
  const idxRef = useRef(idx);
  idxRef.current = idx;

  const go = useCallback(
    (delta: number, wrap = false) => setSel(stepIndex(idxRef.current, delta, n, wrap)),
    [n],
  );
  const canPlay = n > 1 && !reduced;
  useEffect(() => {
    if (!playing || !canPlay) return;
    const id = window.setInterval(() => go(1, true), PLAY_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [playing, canPlay, go]);
  const running = playing && canPlay;

  if (!sequenceId || !wise || n === 0) return null;

  const cur = entries[idx];
  const win = wiseWindow(wise);
  const counts = missionCounts(entries);
  const onKey = (ev: React.KeyboardEvent<HTMLDivElement>) => {
    const a = keyAction(ev.key);
    if (!a) return;
    ev.preventDefault();
    if (a === 'next') go(1);
    else if (a === 'prev') go(-1);
    else if (a === 'first') setSel(0);
    else if (a === 'last') setSel(n - 1);
    else if (canPlay) setPlaying((p) => !p);
  };
  const missionName = (m: TimelineMission) => m;
  const warnings = wise.warnings;

  return (
    <section
      id="wise-timeline"
      tabIndex={-1}
      aria-labelledby="wise-h"
      className="flex scroll-mt-20 flex-col gap-4 rounded-lg border border-border bg-surface p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
      data-testid="wise-timeline"
    >
      <div className="flex flex-col gap-1">
        <h3 id="wise-h" className="text-body-15 font-semibold">
          {t('title')}
        </h3>
        <p className="text-body-14 text-text-2">{t('intro')}</p>
      </div>

      <div
        role="toolbar"
        aria-orientation="horizontal"
        tabIndex={0}
        aria-label={t('region')}
        aria-describedby="wise-keys"
        onKeyDown={onKey}
        className="flex flex-col gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        data-testid="wise-view"
      >
        <div
          className="relative mx-3 h-12 border-b border-border-strong"
          role="group"
          aria-label={t('axis', { start: String(AXIS_START_YEAR), end: String(AXIS_END_YEAR) })}
          data-testid="wise-axis"
        >
          {axisTicks().map((y) => (
            <span
              key={y}
              className="tnum absolute -bottom-6 -translate-x-1/2 text-caption-12 text-muted"
              style={{ left: `${axisFraction(y) * 100}%` }}
            >
              {y}
            </span>
          ))}
          {entries.map((e, i) => (
            <button
              key={e.key}
              type="button"
              tabIndex={-1}
              aria-pressed={i === idx}
              aria-label={t('marker', {
                mission: missionName(e.mission),
                date: localDate(lang, mjdToDate(e.mjd)),
              })}
              onClick={() => {
                setSel(i);
                setPlaying(false);
              }}
              className={cn(
                'absolute bottom-2 size-3.5 -translate-x-1/2 border border-bg',
                MARK[e.mission],
                i === idx && 'ring-2 ring-text ring-offset-1 ring-offset-surface',
              )}
              style={{ left: `${axisFraction(e.year) * 100}%` }}
              data-testid={`wise-marker-${e.key}`}
              data-mission={e.mission}
            />
          ))}
        </div>

        <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-caption-12 text-text-2" aria-label="">
          {(['WISE', 'NEOWISE', 'SPHEREx'] as const).map((m) =>
            counts[m] > 0 ? (
              <li key={m} className="flex items-center gap-1.5">
                <span aria-hidden className={cn('inline-block size-3', MARK[m])} />
                {t(`legend.${m}`)} ({counts[m]})
              </li>
            ) : null,
          )}
        </ul>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('controls.label')}>
          <Button size="sm" onClick={() => go(-1)} disabled={idx === 0} data-testid="wise-prev">
            {t('controls.prev')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setPlaying((p) => !p)}
            disabled={!canPlay}
            aria-pressed={running}
            data-testid="wise-play"
          >
            {running ? t('controls.pause') : t('controls.play')}
          </Button>
          <Button size="sm" onClick={() => go(1)} disabled={idx === n - 1} data-testid="wise-next">
            {t('controls.next')}
          </Button>
          <span className="tnum text-label-13 text-text-2" aria-live="polite" data-testid="wise-position">
            {t('controls.position', { n: idx + 1, total: n })}
          </span>
        </div>
        {reduced && (
          <p className="text-caption-12 text-muted" data-testid="wise-reduced">
            {t('controls.reducedMotion')}
          </p>
        )}
        <p id="wise-keys" className="text-caption-12 text-muted">
          {t('keys')}
        </p>

        <div className="flex flex-wrap gap-4">
          <div className="flex size-64 shrink-0 items-center justify-center rounded-lg bg-frame">
            <img
              src={resolveAsset(cur.url)}
              alt={t('frame.alt', { mission: cur.mission, date: localDate(lang, mjdToDate(cur.mjd)) })}
              width={wise.grid.naxis[0]}
              height={wise.grid.naxis[1]}
              className="size-full object-contain [image-rendering:pixelated]"
              data-testid="wise-frame"
              data-mission={cur.mission}
              data-key={cur.key}
            />
          </div>
          <div className="min-w-56 flex-1">
            <Details e={cur} lang={lang} />
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2 text-label-13 text-text-2" data-testid="wise-notices">
        <p>{t('notice.different')}</p>
        {win && (
          <p>
            {t('notice.spherex', {
              band: wise.band,
              lo: localNumber(lang, win[0], 2),
              hi: localNumber(lang, win[1], 2),
            })}
          </p>
        )}
      </div>

      {warnings.length > 0 && (
        <section aria-label={t('warning.title')} className="flex flex-col gap-2" data-testid="wise-warnings">
          <ul className="flex flex-col gap-2">
            {warnings.map((w) => {
              const key = `warning.codes.${w.code}`;
              return (
                <li
                  key={w.code}
                  className="rounded-lg border border-warning p-2.5 text-label-13"
                  data-code={w.code}
                >
                  {t(key, { defaultValue: w.detail })}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Astrometry sequenceId={sequenceId} lang={lang} />

      <section aria-labelledby="wise-credit-h" className="flex flex-col gap-1" data-testid="wise-credit">
        <h4 id="wise-credit-h" className="text-body-15 font-semibold">
          {t('credit.title')}
        </h4>
        <p className="text-caption-12 text-text-2">{t('credit.wise')}</p>
        <p className="text-caption-12 text-text-2">{t('credit.neowise')}</p>
        <p className="text-caption-12 text-text-2">{t('credit.cite')}</p>
        {wise.provenance.dois.map((d) => (
          <p key={d} className="text-caption-12 text-text-2">
            {t('credit.doi', { doi: d })}
          </p>
        ))}
        <p className="text-caption-12 text-text-2">{t('credit.distributor')}</p>
      </section>
    </section>
  );
}
