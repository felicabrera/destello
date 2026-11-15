// Mobile tools row (S-20): one horizontally scrolling row of two-line buttons above the frame. Each button opens
// a bottom dialog holding the same control component the desktop layout shows inline.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { DetectorPicker } from '../controls/DetectorPicker';
import { FovSelect } from '../controls/FovSelect';
import { ReleaseSelect } from '../controls/ReleaseSelect';
import { PartialToggle } from '../controls/PartialToggle';
import { ModeSwitch } from '../controls/ModeSwitch';
import { OverlayToggles } from '../controls/OverlayToggles';
import { PlaybackControls } from '../player/PlaybackControls';
import { CandidatesPanel, CandidatesToggle } from '../candidates/CandidatesPanel';
import { MotionSearchPanel } from '../motion/MotionSearchPanel';
import type { Candidate } from '../../lib/types';
import { ActionsMenu } from './ActionsMenu';
import type { useExplorer } from './useExplorer';

type Model = ReturnType<typeof useExplorer>;
type Tool = 'mode' | 'det' | 'ov' | 'fov' | 'speed' | 'cand' | 'motion';

/** F-24: guided tour anchors of the tool buttons (the desktop layout anchors the inline controls). */
const TOUR_ANCHOR: Partial<Record<Tool, string>> = {
  mode: 'mode',
  det: 'detector',
  ov: 'overlays',
  motion: 'motion',
};

const toolBtn =
  'flex min-h-11 flex-none items-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-1 text-left text-text hover:bg-border';

function Chevron() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="flex-none text-muted"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function MobileTools({
  x,
  onShare,
  onExport,
  onSheet,
  report,
  onReportCandidate,
}: {
  x: Model;
  onShare: () => void;
  onExport?: () => void;
  /** F-30: opens the results sheet. */
  onSheet?: () => void;
  /** F-22 report flow: `reason` disables the button and says why. */
  report?: { reason: string | null; open: boolean; onToggle: () => void };
  /** F-29: opens the report flow prefilled with a candidate position. */
  onReportCandidate?: (c: Candidate) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Tool | null>(null);
  const { view, v, ui } = x;
  const noEpochs = x.nEpochs === 0;
  const inDiff = view.mode === 'diff' || view.mode === 'diffseq';

  const tools: { key: Tool; label: string; value: string }[] = [
    { key: 'mode', label: t('sheet.modeBtn'), value: t(`mode.${view.mode}`) },
    {
      key: 'det',
      label: t('detector.label'),
      value: x.det === 'all' ? t('detector.all') : `D${x.det}`,
    },
    {
      key: 'ov',
      label: t('sheet.overlaysBtn'),
      value: view.ov.length ? view.ov.map((k) => t(`overlays.${k}`)).join(', ') : t('mobile.none'),
    },
    { key: 'fov', label: t('fov.label'), value: t('fov.arcmin', { value: view.fov }) },
    { key: 'speed', label: t('player.speed'), value: t('player.fps', { fps: x.fps }) },
    {
      key: 'motion',
      label: t('motion.tool'),
      value: !x.motion.requested
        ? t('motion.notRun')
        : x.motion.data
          ? String(x.motion.data.counts.listed ?? x.motion.data.sources.length)
          : t('motion.running'),
    },
  ];
  // F-29: candidates belong to the difference modes; the tool sits right after the mode.
  if (inDiff)
    tools.splice(1, 0, {
      key: 'cand',
      label: t('cand.toggle'),
      value: !view.cand ? t('cand.off') : x.cand.data ? String(x.cand.data.counts.listed) : t('cand.on'),
    });
  const current = tools.find((tool) => tool.key === open);

  return (
    <>
      <div
        role="group"
        aria-label={t('mobile.tools')}
        className="scroll-x-hide relative -mx-4 flex gap-2 overflow-x-auto px-4"
        data-testid="mobile-tools"
      >
        {tools.map((tool) => (
          <button
            key={tool.key}
            type="button"
            className={toolBtn}
            aria-haspopup="dialog"
            aria-label={`${tool.label} ${tool.value}`}
            onClick={() => setOpen(tool.key)}
            data-testid={`tool-${tool.key}`}
            data-tour={TOUR_ANCHOR[tool.key]}
          >
            <span className="flex flex-col" aria-hidden="true">
              <span className="whitespace-nowrap text-caption-12 text-muted">{tool.label}</span>
              {/* A space between the two lines keeps the visible text and the accessible name equal. */}{' '}
              <span className="tnum whitespace-nowrap text-body-14 font-semibold">{tool.value}</span>
            </span>
            <Chevron />
          </button>
        ))}
        <button type="button" className={toolBtn} onClick={onShare} data-testid="share-btn" data-tour="share">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-none"
            aria-hidden="true"
          >
            <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
          </svg>
          <span className="whitespace-nowrap text-body-14 font-semibold">{t('share.button')}</span>
        </button>
        {onExport && (
          <button
            type="button"
            className={toolBtn}
            onClick={onExport}
            data-testid="export-btn"
            data-tour="share"
          >
            <span className="whitespace-nowrap text-body-14 font-semibold">{t('export.button')}</span>
          </button>
        )}
        <ActionsMenu onSheet={onSheet} report={report} />
      </div>

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent
          aria-describedby={undefined}
          className="bottom-0 left-0 top-auto max-h-[80dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl p-4 pb-6"
          data-testid="tool-dialog"
        >
          <div className="mb-3 flex items-center justify-between gap-4">
            <DialogTitle className="text-title-20 font-medium">{current?.label}</DialogTitle>
            <DialogClose
              aria-label={t('app.close')}
              className="-mr-2 grid size-11 flex-none place-items-center rounded-lg text-text hover:bg-surface-2"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </DialogClose>
          </div>
          {open === 'mode' && (
            <ModeSwitch
              mode={view.mode}
              refEpoch={view.ref}
              nEpochs={x.nEpochs}
              lowEpochs={x.lowEpochs}
              complete={x.complete}
              onChange={x.setMode}
              onRef={(n) => v.update({ ref: n })}
              rgbAvailable={x.rgbAvailable}
              rgb={x.rgb}
              onRgb={x.setRgb}
              trackAvailable={x.trackAvailable}
              track={x.view.track}
              onTrack={x.setTrack}
            />
          )}
          {open === 'cand' && (
            <div className="flex flex-col gap-3">
              <CandidatesToggle on={view.cand} onChange={x.setCand} />
              {x.cand.active && (
                <CandidatesPanel
                  cand={x.cand}
                  epochs={x.epochs}
                  lang={x.lang}
                  hideTitle
                  reportReason={report?.reason ?? null}
                  onReport={
                    onReportCandidate
                      ? (c) => {
                          setOpen(null);
                          onReportCandidate(c);
                        }
                      : undefined
                  }
                />
              )}
            </div>
          )}
          {open === 'motion' && (
            <MotionSearchPanel motion={x.motion} lang={x.lang} complete={x.complete} hideTitle />
          )}
          {open === 'det' && (
            <DetectorPicker
              value={x.det}
              ranges={x.ranges}
              coverage={x.coverage}
              disabled={noEpochs}
              onChange={x.setDet}
            />
          )}
          {open === 'ov' && (
            <OverlayToggles
              active={new Set(view.ov)}
              disabledInDiff={inDiff}
              counts={x.overlayCounts}
              onToggle={x.toggleOverlay}
              onRetry={x.retryOverlay}
              flagLegend={x.flagLegend}
              path={{ reason: x.pathReason, data: x.pathData }}
              lang={x.lang}
            />
          )}
          {open === 'fov' && (
            <FovSelect
              inline
              value={view.fov}
              center={x.src.status === 'ready' ? x.src.center : null}
              release={view.release}
              partial={view.partial}
              fastMoverNext={x.fastMoverNext}
              onChange={(n) => {
                setOpen(null);
                if (n !== view.fov) x.setFov(n);
              }}
            />
          )}
          {open === 'fov' && (
            <div className="mt-3">
              <ReleaseSelect inline value={view.release} onChange={x.setRelease} />
            </div>
          )}
          {open === 'fov' && (
            <div className="mt-3">
              <PartialToggle inline on={view.partial} onChange={x.setPartial} />
            </div>
          )}
          {open === 'speed' && (
            <PlaybackControls
              hideTransport
              playing={ui.playing}
              fps={x.fps}
              loop={ui.loop}
              canPlay={x.canPlay}
              atFirst={false}
              atLast={false}
              reducedMotion={x.reduced}
              onPlayPause={() => undefined}
              onStep={() => undefined}
              onFirst={() => undefined}
              onLast={() => undefined}
              onFps={x.setFps}
              onLoop={ui.setLoop}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
