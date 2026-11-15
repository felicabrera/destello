// F-35 Hunt: one field in the Explorer's player (Blink and Difference), the five answers and the optional mark.
// The Explorer model (useExplorer) is driven by the `seq` URL parameter, so the field is the same sequence the
// Explorer would show: same shared stretch, same provenance, nothing re-rendered for this page.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { formatDec, formatRa } from '../../lib/coords';
import { pixelToSky } from '../../lib/astrometry';
import { HUNT_KEYS, HUNT_LABELS, sequenceHasStreak, type HuntField, type HuntLabel } from '../../lib/hunt';
import { DetectorPicker } from '../controls/DetectorPicker';
import { useExplorer } from '../explorer/useExplorer';
import { EpochTimeline } from '../player/EpochTimeline';
import { PlaybackControls } from '../player/PlaybackControls';
import { PlayerCanvas } from '../player/PlayerCanvas';
import type { Pt } from '../player/draw';
import { TurnstileWidget, TURNSTILE_SITEKEY } from '../report/Turnstile';
import { CONTRAST_MAX, CONTRAST_MIN, ZOOMS, clampContrast, nextZoom, type VoteProblem } from './huntModel';
import { useHuntShortcuts } from './useHuntShortcuts';
import type { VoteInput } from './useHuntFlow';

interface Props {
  field: HuntField;
  busy: boolean;
  problem: VoteProblem | null;
  locked: boolean;
  onVote: (v: VoteInput) => void;
}

const MODES = ['blink', 'diff'] as const;
const btn =
  'inline-flex min-h-[var(--hit-min)] items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 text-label-13 font-medium text-text hover:bg-border disabled:text-disabled';

export function HuntReview({ field, busy, problem, locked, onVote }: Props) {
  const { t } = useTranslation('hunt');
  const { t: tr } = useTranslation();
  const x = useExplorer();
  const [mark, setMark] = useState<Pt | null>(null);
  const [zoom, setZoom] = useState(1);
  const [contrast, setContrast] = useState(1);
  const [token, setToken] = useState<string | null>(null);
  const [tokenGen, setTokenGen] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const needToken = problem?.kind === 'turnstile';

  const markSky = useMemo(() => (mark && x.grid ? pixelToSky(x.grid, mark.x, mark.y) : null), [mark, x.grid]);

  const vote = useCallback(
    (label: HuntLabel) => {
      if (busy || locked || !x.complete) return;
      onVote({
        label,
        mark: markSky ? { ra_deg: markSky.ra, dec_deg: markSky.dec } : undefined,
        turnstileToken: token,
      });
      // A Turnstile token works once: ask the widget for a new one after every attempt.
      setToken(null);
      setTokenGen((g) => g + 1);
    },
    [busy, locked, x.complete, onVote, markSky, token],
  );
  const cycleZoom = useCallback(() => setZoom((z) => nextZoom(z)), []);
  const clearMark = useCallback(() => setMark(null), []);
  useHuntShortcuts(x, { vote, cycleZoom, clearMark });

  // Keep the middle of the image in view when the zoom changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [zoom]);

  const streak = useMemo(() => sequenceHasStreak(x.epochs), [x.epochs]);
  const mode = x.view.mode === 'diff' ? 'diff' : 'blink';
  const canDiff = x.nEpochs >= 2 && x.complete;
  const { view, ui } = x;

  return (
    <div
      className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]"
      data-testid="hunt-review"
      data-field={field.field_id}
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div
          className="mx-auto w-full"
          style={{ maxWidth: 'max(280px, calc(100dvh - 300px))' }}
          data-tour="player"
        >
          <div
            ref={scrollRef}
            className="aspect-square w-full overflow-auto rounded-xs"
            data-testid="hunt-zoom"
            data-zoom={zoom}
          >
            <div
              style={{
                width: `${zoom * 100}%`,
                filter: contrast === 1 ? undefined : `contrast(${contrast})`,
              }}
            >
              <PlayerCanvas
                epochs={x.epochs}
                items={x.items}
                frameIdx={x.frameIdx}
                mode={view.mode}
                det={x.det}
                n={x.n}
                scaleArcsec={x.scaleArcsec}
                grid={x.grid}
                showGaia={false}
                showCatwise={false}
                showFlags={view.ov.includes('flags')}
                gaia={null}
                catwise={null}
                mask={x.mask}
                rgb={x.rgb}
                shift={null}
                alignedStack={false}
                path={null}
                candidates={null}
                track={null}
                ring={null}
                targetName={null}
                targetMotion={null}
                labelOffset={{ dx: 7, dy: 0 }}
                mark={mark}
                refEpoch={x.refIdx}
                totalEpochs={x.nEpochs}
                loading={
                  x.display.required > 0 && !x.display.ready
                    ? { done: x.display.loaded, total: x.display.required }
                    : null
                }
                waitingForEpochs={x.nEpochs === 0}
                rmIdle={x.reduced && x.canPlay && !ui.playing && ui.frame === 0}
                onPlay={() => x.setPlaying(true)}
                onMark={setMark}
                onStep={x.step}
                announce={x.announce}
                stretch={x.stretch}
              />
            </div>
          </div>
        </div>
        <div data-tour="transport" className="flex flex-col gap-2">
          <PlaybackControls
            playing={ui.playing}
            fps={x.fps}
            loop={ui.loop}
            canPlay={x.canPlay}
            atFirst={x.playable.indexOf(x.frameIdx) <= 0}
            atLast={x.playable.indexOf(x.frameIdx) === x.playable.length - 1}
            reducedMotion={x.reduced}
            onPlayPause={() => x.setPlaying(!ui.playing)}
            onStep={x.step}
            onFirst={() => x.playable.length && x.setFrameFromUser(x.playable[0])}
            onLast={() => x.playable.length && x.setFrameFromUser(x.playable[x.playable.length - 1])}
            onFps={x.setFps}
            onLoop={ui.setLoop}
            compact
          />
          <EpochTimeline
            epochs={x.epochs}
            expected={0}
            index={x.frameIdx}
            missing={x.missingEpochs}
            lang={x.lang}
            onJump={x.setFrameFromUser}
          />
        </div>
        <p className="text-caption-12 text-muted">{t('tools.keys')}</p>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <section aria-labelledby="hunt-classify" className="flex flex-col gap-2" data-testid="hunt-classify">
          <h2 id="hunt-classify" className="text-label-13 font-semibold text-text">
            {t('classify.label')}
          </h2>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {HUNT_LABELS.map((l) => (
              <li key={l}>
                <button
                  type="button"
                  className={cn(
                    'flex min-h-[var(--hit-min)] w-full items-center gap-3 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-left hover:bg-border disabled:text-disabled',
                    l === 'mover' && 'border-glint',
                  )}
                  disabled={busy || locked || !x.complete}
                  aria-keyshortcuts={HUNT_KEYS[l]}
                  onClick={() => vote(l)}
                  data-testid={`vote-${l}`}
                >
                  <kbd className="tnum min-w-7 rounded-sm border border-b-2 border-border-strong bg-surface px-1.5 py-0.5 text-center font-mono text-caption-12 font-medium text-text">
                    {HUNT_KEYS[l]}
                  </kbd>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-label-13 font-semibold text-text">{t(`labels.${l}.name`)}</span>
                    <span className="text-caption-12 text-text-2">{t(`labels.${l}.hint`)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="text-caption-12 text-muted">{busy ? t('classify.pending') : t('classify.keys')}</p>
        </section>

        {needToken && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg border border-warning p-3"
            data-testid="hunt-turnstile"
          >
            <p className="text-body-14 text-text-2">{t('turnstile.needed')}</p>
            {TURNSTILE_SITEKEY && <TurnstileWidget key={tokenGen} lang={x.lang} onToken={setToken} />}
          </div>
        )}

        <section className="flex flex-col gap-1.5" data-testid="hunt-mark">
          <p className="text-caption-12 text-muted">{t('mark.hint')}</p>
          {markSky && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="tnum text-label-13 text-text" data-testid="hunt-mark-pos">
                {t('mark.set', { ra: formatRa(markSky.ra, 1), dec: formatDec(markSky.dec, 0) })}
              </span>
              <Button size="sm" variant="secondary" onClick={clearMark} data-testid="hunt-mark-clear">
                {t('mark.clear')}
              </Button>
            </div>
          )}
        </section>

        <section aria-labelledby="hunt-view" className="flex flex-col gap-3" data-testid="hunt-tools">
          <h2 id="hunt-view" className="text-label-13 font-semibold text-text">
            {t('tools.label')}
          </h2>
          <div role="radiogroup" aria-label={t('tools.label')} className="flex gap-2" data-tour="mode">
            {MODES.map((m) => {
              const off = m === 'diff' && !canDiff;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={off}
                  title={off ? t('tools.diffNeedsTwo') : undefined}
                  className={cn(btn, mode === m && 'border-glint bg-glint-soft')}
                  onClick={() => x.setMode(m)}
                  data-testid={`mode-${m}`}
                >
                  {m === 'blink' ? t('tools.blink') : t('tools.diff')}
                  <kbd className="font-mono text-caption-12 text-muted">{m === 'blink' ? 'B' : 'D'}</kbd>
                </button>
              );
            })}
          </div>
          <label className="flex flex-col gap-1 text-caption-12 text-muted">
            <span>
              {t('tools.zoom')}: <span className="tnum">{t('tools.zoomValue', { z: zoom })}</span>
              <kbd className="ml-1 font-mono">Z</kbd>
            </span>
            <input
              type="range"
              min={ZOOMS[0]}
              max={ZOOMS[ZOOMS.length - 1]}
              step={1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="min-h-[var(--hit-min)] w-full"
              data-testid="hunt-zoom-range"
            />
          </label>
          <label className="flex flex-col gap-1 text-caption-12 text-muted">
            <span>
              {t('tools.contrast')}: <span className="tnum">{contrast.toFixed(1)}</span>
            </span>
            <input
              type="range"
              min={CONTRAST_MIN}
              max={CONTRAST_MAX}
              step={0.1}
              value={contrast}
              onChange={(e) => setContrast(clampContrast(Number(e.target.value)))}
              className="min-h-[var(--hit-min)] w-full"
              data-testid="hunt-contrast-range"
            />
          </label>
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() => {
              setZoom(1);
              setContrast(1);
            }}
            data-testid="hunt-reset-view"
          >
            {t('tools.reset')}
          </Button>
          <details className="text-caption-12 text-muted">
            <summary className="min-h-[var(--hit-min)] cursor-pointer py-2">{tr('detector.label')}</summary>
            <DetectorPicker
              value={x.det}
              ranges={x.ranges}
              coverage={x.coverage}
              disabled={!x.complete}
              onChange={x.setDet}
            />
          </details>
        </section>

        {streak && (
          <aside className="rounded-lg border border-warning p-3" data-testid="hunt-streak">
            <h2 className="text-label-13 font-semibold text-warning">{t('streak.title')}</h2>
            <p className="mt-1 text-body-14 text-text-2">{t('streak.body')}</p>
          </aside>
        )}
      </div>
    </div>
  );
}
