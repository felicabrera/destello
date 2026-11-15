// Chromeless embed (docs/06 section 6). Same parameters as the Explorer plus controls and theme.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { EpochTimeline } from '../player/EpochTimeline';
import { PlaybackControls } from '../player/PlaybackControls';
import { PlayerCanvas } from '../player/PlayerCanvas';
import { PRESETS } from '../../lib/presets';
import { buildPath } from '../../lib/url-state';
import { useExplorer } from './useExplorer';

const LABELS: Record<string, { dx: number; dy: number }> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p.label]),
);

export type EmbedSize = 'compact' | 'standard' | 'large';
/** Size class by iframe width (S-13): compact under 420 px, large from 620 px. */
export function embedSizeFor(width: number): EmbedSize {
  return width < 420 ? 'compact' : width >= 620 ? 'large' : 'standard';
}
// Vertical space reserved for chrome under the sky frame, per control level (px).
const RESERVE: Record<string, number> = { full: 168, minimal: 104, none: 50 };

function useWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 480 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

export function EmbedPage() {
  const { t } = useTranslation();
  const x = useExplorer();
  const { view, ui } = x;
  const controls = view.controls ?? 'minimal';
  const width = useWidth();
  const size = embedSizeFor(width);
  const frameRef = useRef<HTMLDivElement>(null);
  const presetId = x.src.status === 'ready' ? x.src.presetId : undefined;

  useEffect(() => {
    document.documentElement.dataset.theme = view.theme === 'light' ? 'light' : 'dark';
    return () => {
      delete document.documentElement.dataset.theme;
    };
  }, [view.theme]);

  // Optional postMessage events for embedders: destello:ready and destello:frame.
  useEffect(() => {
    if (x.complete) window.parent?.postMessage({ type: 'destello:ready' }, '*');
  }, [x.complete]);
  useEffect(() => {
    const e = x.epochs[x.frameIdx];
    if (e)
      window.parent?.postMessage({ type: 'destello:frame', index: x.frameIdx, date: e.t_start ?? null }, '*');
  }, [x.frameIdx, x.epochs]);

  // "Open in Destello" leads to the full Explorer on the same view, without embed-only parameters.
  const { controls: _c, theme: _t, target: _g, ...rest } = x.v.search;
  void [_c, _t, _g];
  const openUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}${buildPath(presetId, { ...rest, play: undefined }, x.v.defaults)}`
      : '/';

  return (
    <main
      id="main"
      tabIndex={-1}
      className="flex min-h-dvh flex-col bg-bg text-text"
      data-testid="embed"
      data-size={size}
      data-controls={controls}
      data-theme-name={view.theme === 'light' ? 'light' : 'dark'}
    >
      <h1 className="sr-only">{x.astro?.name ?? 'Destello'}</h1>
      <div
        className={`flex flex-1 flex-col ${size === 'compact' ? 'gap-2 p-2' : 'gap-3 p-3'}`}
        ref={frameRef}
      >
        <div
          className="mx-auto w-full"
          style={{ maxWidth: `max(160px, calc(100dvh - ${RESERVE[controls] ?? 104}px))` }}
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
            showGaia={view.ov.includes('gaia')}
            showCatwise={view.ov.includes('catwise')}
            showFlags={view.ov.includes('flags')}
            gaia={x.gaiaNow}
            catwise={x.catwiseNow}
            mask={x.mask}
            rgb={x.rgb}
            shift={x.shift}
            alignedStack={x.trackStack}
            path={x.pathScene}
            // F-29: markers only, and only when the URL carries the toggle; the embed has no list.
            candidates={x.cand.active ? x.cand.markers : null}
            track={x.track}
            ring={x.ring}
            targetName={x.astro?.name ?? null}
            targetMotion={x.motionLabel}
            labelOffset={LABELS[presetId ?? ''] ?? { dx: 7, dy: 0 }}
            mark={null}
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
            onMark={() => undefined}
            onStep={x.step}
            announce={x.announce}
            stretch={x.stretch}
          />
        </div>
        {controls !== 'none' && (
          <>
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
              compact={controls === 'minimal' || size === 'compact'}
            />
            <EpochTimeline
              epochs={x.epochs}
              expected={0}
              index={x.frameIdx}
              missing={x.missingEpochs}
              lang={x.lang}
              onJump={x.setFrameFromUser}
            />
          </>
        )}
      </div>
      <footer className="flex h-[30px] flex-none items-center justify-between gap-2 border-t border-border bg-surface px-3 text-caption-12 text-muted">
        <span className="truncate">{t('embed2.attribution')}</span>
        <a
          className="flex-none text-cyan underline underline-offset-2"
          href={openUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="embed-open"
        >
          {t('embed.open')}
        </a>
      </footer>
    </main>
  );
}
