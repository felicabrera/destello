// Header indicator for builds started in this browser. A build keeps running on the server after
// its view is left; this lists it and leads back to its progress with one click.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouterState } from '@tanstack/react-router';
import { ApiError, getSequence } from '../../lib/api';
import { cn } from '../../lib/cn';
import { useBuilds, type TrackedBuild } from '../../store/builds';
import { useSequence } from '../../store/sequence';

const POLL_MS = 6000;

interface Props {
  onOpenPath: (path: string) => void;
}

export function BuildsIndicator({ onOpenPath }: Props) {
  const { t } = useTranslation();
  const builds = useBuilds((s) => s.builds);
  const update = useBuilds((s) => s.update);
  const remove = useBuilds((s) => s.remove);
  const seq = useSequence();
  const location = useRouterState({ select: (s) => s.location });
  const here = location.pathname + location.searchStr;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The build on screen follows its own event stream; the others are polled.
  const onScreen = (b: TrackedBuild) => seq.sequenceId === b.id && seq.phase === 'building';
  const polled = builds
    .filter((b) => b.state === 'building' && !onScreen(b))
    .map((b) => b.id)
    .join(',');
  useEffect(() => {
    if (!polled) return;
    const ids = polled.split(',');
    let stop = false;
    const tick = () => {
      for (const id of ids) {
        void getSequence(id)
          .then((s) => {
            if (stop) return;
            if (s.status === 'ready') update(id, { state: 'ready' });
            else if (s.status === 'failed') remove(id);
            else update(id, { detectorsReady: s.detectors_ready?.length ?? 0 });
          })
          .catch((e: unknown) => {
            // Unknown to the server (expired or never queued): nothing to come back to.
            if (!stop && e instanceof ApiError && e.status === 404) remove(id);
          });
      }
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [polled, update, remove]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The view of a build already shows its progress: list it only from elsewhere.
  const explorer = location.pathname === '/' || location.pathname.startsWith('/t/');
  const listed = builds.filter((b) => b.href !== here && !(explorer && onScreen(b)));
  if (listed.length === 0) return null;
  const running = listed.filter((b) => b.state === 'building').length;
  const label =
    running > 0 ? t('builds.button', { count: running }) : t('builds.buttonReady', { count: listed.length });

  const detail = (b: TrackedBuild): string => {
    if (b.state === 'ready') return t('builds.ready');
    if (onScreen(b)) {
      const c = seq.progress.cutouts;
      if (seq.status === 'queued') return t('builds.queued');
      if (seq.detectorsReady.length > 0) return t('builds.detectors', { n: seq.detectorsReady.length });
      if (c && c.total > 0) return t('builds.downloading', { done: c.done, total: c.total });
      return t('builds.building');
    }
    return b.detectorsReady ? t('builds.detectors', { n: b.detectorsReady }) : t('builds.building');
  };

  return (
    <div ref={root} className="relative flex-none">
      <button
        type="button"
        className="flex min-h-[var(--hit-min)] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-label-13 font-semibold text-text hover:bg-surface-2"
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        data-testid="builds-indicator"
        data-running={running}
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-2 rounded-full',
            running > 0 ? 'bg-glint motion-safe:animate-pulse' : 'bg-success',
          )}
        />
        <span className="tnum">{listed.length}</span>
        <span className="hidden xl:inline">{running > 0 ? t('builds.short') : t('builds.shortReady')}</span>
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-40 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-3 shadow-lg"
          data-testid="builds-panel"
        >
          <h2 className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('builds.heading')}
          </h2>
          <ul className="mt-2 flex flex-col gap-2">
            {listed.map((b) => (
              <li
                key={b.id}
                className="flex items-center gap-2 rounded-md border border-border p-2"
                data-testid="builds-item"
                data-state={b.state}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-14 font-medium text-text">{b.label}</p>
                  <p className="tnum text-caption-12 text-text-2">
                    {t('builds.fov', { fov: b.fov })} · {detail(b)}
                  </p>
                </div>
                <button
                  type="button"
                  className="min-h-[var(--hit-min)] flex-none rounded-md border border-border px-3 text-label-13 font-semibold text-text hover:bg-surface-2"
                  onClick={() => {
                    setOpen(false);
                    onOpenPath(b.href);
                  }}
                  data-testid="builds-open"
                >
                  {b.state === 'ready' ? t('builds.openReady') : t('builds.open')}
                </button>
                {b.state === 'ready' && (
                  <button
                    type="button"
                    className="grid min-h-[var(--hit-min)] min-w-8 flex-none place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-text"
                    aria-label={t('builds.dismiss')}
                    title={t('builds.dismiss')}
                    onClick={() => remove(b.id)}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      aria-hidden="true"
                    >
                      <path d="M6 6l12 12M18 6 6 18" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-caption-12 text-muted">{t('builds.hint')}</p>
        </div>
      )}
    </div>
  );
}
