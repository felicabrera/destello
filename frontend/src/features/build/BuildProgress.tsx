import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import type { EpochInfo } from '../../lib/types';
import type { StageName, StageProgress } from '../../store/sequence';

interface Props {
  status: 'queued' | 'running' | null;
  position: number | null;
  progress: Partial<Record<StageName, StageProgress>>;
  epochs: EpochInfo[];
  expectedEpochs: number;
  /** Detectors published so far (publication order) and still building. Empty when the build reports none. */
  detectorsReady?: number[];
  detectorsPending?: number[];
  /** Detector shown in place of the selected one while the selection is still building. */
  shownDetector?: number | null;
  estimateSeconds: number | null;
  startedAt: number | null;
}

const STAGES: StageName[] = ['query', 'cutouts', 'coadd', 'render'];

type StageState = 'done' | 'running' | 'waiting';

function Icon({ s }: { s: StageState }) {
  if (s === 'done')
    return (
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--success)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  if (s === 'running')
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="6" fill="var(--glint)" className="motion-safe:animate-pulse" />
      </svg>
    );
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--muted)"
      strokeWidth="1.6"
      strokeDasharray="3 3"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="7" />
    </svg>
  );
}

export function BuildProgress({
  status,
  position,
  progress,
  epochs,
  expectedEpochs,
  detectorsReady = [],
  detectorsPending = [],
  shownDetector = null,
  estimateSeconds,
  startedAt,
}: Props) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const [announce, setAnnounce] = useState('');
  const readyCount = epochs.length;
  useEffect(() => {
    if (readyCount > 0) setAnnounce(t('build.announceEpoch', { n: readyCount }));
  }, [readyCount, t]);
  const lastDetector = detectorsReady.length > 0 ? detectorsReady[detectorsReady.length - 1] : null;
  useEffect(() => {
    if (lastDetector !== null) setAnnounce(t('build.announceDetector', { n: lastDetector }));
  }, [lastDetector, t]);
  const detectors = [...detectorsReady, ...detectorsPending.filter((d) => !detectorsReady.includes(d))];

  const q = progress.query;
  const eta =
    estimateSeconds !== null && startedAt !== null
      ? Math.max(3, Math.round(estimateSeconds - (now - startedAt) / 1000))
      : null;
  const stateOf = (s: StageName): StageState => {
    const p = progress[s];
    // A stage is finished once any later stage has reported progress (the API may not emit every stage).
    const idx = STAGES.indexOf(s);
    if (STAGES.slice(idx + 1).some((later) => progress[later])) return 'done';
    if (!p) return 'waiting';
    return p.done >= p.total && p.total > 0 ? 'done' : 'running';
  };
  const slots = expectedEpochs > 0 ? Math.max(expectedEpochs, readyCount) : readyCount + 1;

  return (
    <section
      className="rounded-xl border border-border bg-surface p-4"
      aria-labelledby="build-title"
      data-testid="build-progress"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="build-title" className="text-title-20 font-medium">
          {t('build.title')}
        </h2>
        {eta !== null && (
          <span className="tnum whitespace-nowrap text-caption-12 text-muted">
            {t('build.eta', { seconds: eta })}
          </span>
        )}
      </div>
      <p className="mt-1 text-label-13 text-text-2">
        {status === 'queued'
          ? position
            ? t('build.queued', { position })
            : t('build.queuedNoPos')
          : progress.coadd || progress.render
            ? t('build.combineDesc')
            : progress.cutouts
              ? t('build.downloadDesc')
              : t('build.queryDesc')}
      </p>
      <ol className="mt-3 space-y-2.5">
        {STAGES.map((s) => {
          const st = stateOf(s);
          const p = progress[s];
          return (
            <li key={s} className="flex items-center gap-2.5" data-testid={`stage-${s}`}>
              <Icon s={st} />
              <span className={cn('text-label-13', st === 'waiting' ? 'text-muted' : 'text-text')}>
                {s === 'query' && q && st === 'done'
                  ? expectedEpochs > 0
                    ? t('build.found', { images: q.total, epochs: expectedEpochs })
                    : t('build.foundImages', { images: q.total })
                  : s === 'cutouts' && p && st === 'running'
                    ? t('build.downloading', { done: p.done, total: p.total })
                    : t(`build.stage.${s}`)}
              </span>
              <span className="tnum ml-auto text-caption-12 text-muted">
                {p ? t('build.count', { done: p.done, total: p.total }) : ''}
                <span className="sr-only">
                  {' '}
                  {st === 'done'
                    ? t('build.statusDone')
                    : st === 'running'
                      ? t('build.statusRunning')
                      : t('build.statusWaiting')}
                </span>
              </span>
            </li>
          );
        })}
      </ol>
      {detectors.length > 0 && (
        <>
          <h3 className="mt-4 text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('build.detectorsHeading')}
          </h3>
          <ul className="mt-2 flex flex-wrap gap-2" data-testid="build-detectors">
            {detectors.map((d) => {
              const ready = detectorsReady.includes(d);
              return (
                <li
                  key={d}
                  className={cn(
                    'tnum flex items-center gap-1.5 rounded-md border px-2 py-1 text-caption-12 font-semibold',
                    ready ? 'border-success text-text' : 'border-dashed border-border-strong text-muted',
                  )}
                  data-testid={`build-detector-${d}`}
                  data-ready={ready ? 'true' : 'false'}
                >
                  D{d}
                  <span className="font-normal text-muted">
                    {ready ? t('build.epochReady') : t('build.epochPending')}
                  </span>
                </li>
              );
            })}
          </ul>
          {shownDetector !== null && (
            <p className="mt-2 text-caption-12 text-text-2" data-testid="build-shown-detector">
              {t('build.showingDetector', { n: shownDetector })}
            </p>
          )}
        </>
      )}
      <h3 className="mt-4 text-caption-12 font-semibold uppercase tracking-wider text-muted">
        {t('build.epochsHeading')}
      </h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {Array.from({ length: slots }, (_, i) => {
          const ready = epochs.some((e) => e.index === i);
          return (
            <li
              key={i}
              className={cn(
                'tnum flex items-center gap-1.5 rounded-md border px-2 py-1 text-caption-12 font-semibold',
                ready ? 'border-success text-text' : 'border-dashed border-border-strong text-muted',
              )}
              data-testid={`build-epoch-${i + 1}`}
            >
              E{i + 1}
              <span className="font-normal text-muted">
                {ready ? t('build.epochReady') : t('build.epochPending')}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-caption-12 text-muted">
        {readyCount < 2 ? t('build.playableAt') : t('build.leaveHint')}
      </p>
      <div className="sr-live" role="status" aria-live="polite" data-testid="build-live">
        {announce}
      </div>
    </section>
  );
}
