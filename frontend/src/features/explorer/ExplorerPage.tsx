import { type ComponentType, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { cn } from '../../lib/cn';
import { localPercent, mjdIso } from '../../lib/format';
import { PRESETS } from '../../lib/presets';
import { TABS, type TabKey } from '../../lib/types';
import { useBackend } from '../../lib/backend';
import { useBuilds } from '../../store/builds';
import { useSequence } from '../../store/sequence';
import { useUi } from '../../store/ui';
import { BottomSheet, type SheetState } from '../layout/BottomSheet';
import { BuildProgress } from '../build/BuildProgress';
import { DetectorPicker } from '../controls/DetectorPicker';
import { DataOptions } from '../controls/DataOptions';
import { FovSelect } from '../controls/FovSelect';
import { ModeSwitch } from '../controls/ModeSwitch';
import { OverlayToggles } from '../controls/OverlayToggles';
import { ContextPanel } from '../panels/ContextPanel';
import { InfoPanel } from '../panels/InfoPanel';
import { MeasurePanel } from '../panels/MeasurePanel';
import { LightCurve } from '../panels/LightCurve';
import { SpectrumPanel } from '../panels/SpectrumPanel';
import { EpochTimeline } from '../player/EpochTimeline';
import { MiniPlayer, MobileTransport } from '../player/MobileTransport';
import { PlaybackControls } from '../player/PlaybackControls';
import { PlayerCanvas } from '../player/PlayerCanvas';
import { PresetChips } from '../presets/PresetChips';
import { ResultCard } from '../presets/ResultCard';
import { SurpriseCard } from '../presets/SurpriseCard';
import { pickSurprise } from '../../lib/surprise';
import { ShareDialog } from '../share/ShareDialog';
import { ExportDialog } from '../export/ExportDialog';
import { ResultsSheetDialog } from '../sheet/ResultsSheetDialog';
import { DemoBanner, IrsaBanner, PropagationNotice, RefreshBanner } from './Banners';
import { EmptyCard, ErrorCard, NoDataCard, RateLimitedCard, SingleEpochCard } from './StateCards';
import { MobileTools } from './MobileTools';
import { ActionsMenu } from './ActionsMenu';
import { TourOverlay } from '../tour/TourOverlay';
import { useTour } from '../tour/useTour';
import { ShortcutsDialog } from './ShortcutsDialog';
import { useExplorer } from './useExplorer';
import { useReleases } from './useView';
import { ReleaseSelect } from '../controls/ReleaseSelect';
import { PartialToggle } from '../controls/PartialToggle';
import { useShortcuts } from './useShortcuts';
import { refEpochLabel, refEpochToMjd } from '../../lib/astrometry';
import { HuntCounters } from '../hunt/HuntCounters';
import { ReportFlow } from '../report/ReportFlow';
import { MAX_MARKS } from '../report/reportModel';
import { CandidatesPanel, CandidatesToggle } from '../candidates/CandidatesPanel';
import { hitMarker, reportMarksFor } from '../candidates/candidateModel';
import { hitTrack } from '../motion/motionModel';
import { MotionSearchPanel } from '../motion/MotionSearchPanel';
import { useWiseCompanion, WiseTimeline } from '../wise/WiseTimeline';
import { buildTimeline } from '../../lib/wise';
import { useSeo } from '../../lib/seo';
import type { Candidate } from '../../lib/types';

/** Space kept above the player and between the transport row and the half-open sheet. */
const SHEET_GAP_PX = 8;

function useMedia(query: string): boolean {
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

type Model = ReturnType<typeof useExplorer>;

function PanelTabs({
  x,
  releaseLabel,
  dataAsOf,
  mobile = false,
  onTabClick,
}: {
  x: Model;
  releaseLabel?: string;
  dataAsOf?: string;
  mobile?: boolean;
  /** Fires on every tab press, including the active tab (opens the collapsed mobile sheet). */
  onTabClick?: () => void;
}) {
  const { t } = useTranslation();
  const tab: TabKey = x.view.tab;
  const epoch = x.epochs[x.frameIdx] ?? null;
  const labels: Record<TabKey, string> = {
    info: t('panel.info'),
    spectrum: t('panel.spectrum'),
    measure: t('panel.measure'),
    context: t('panel.context'),
  };
  return (
    <Tabs value={tab} onValueChange={(v) => x.v.update({ tab: v as TabKey })} data-testid="panel-tabs">
      <TabsList aria-label={t('sheet.label')} className={mobile ? 'gap-0' : 'overflow-x-auto scroll-x-hide'}>
        {TABS.map((k) => (
          <TabsTrigger
            key={k}
            value={k}
            onClick={onTabClick}
            className={mobile ? 'min-h-11 flex-auto px-2 text-center' : undefined}
            data-testid={`tab-${k}`}
          >
            {labels[k]}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="info">
        <InfoPanel
          manifest={x.seq.manifest}
          epoch={epoch}
          epochIdx={x.frameIdx}
          totalEpochs={x.nEpochs}
          frame={x.currentFrame}
          det={x.det}
          lang={x.lang}
          releaseLabel={releaseLabel}
          dataAsOf={dataAsOf}
        />
      </TabsContent>
      <TabsContent value="spectrum">
        <div className="flex flex-col gap-6">
          <LightCurve x={x} />
          <SpectrumPanel x={x} />
        </div>
      </TabsContent>
      <TabsContent value="measure">
        <MeasurePanel x={x} />
      </TabsContent>
      <TabsContent value="context">
        {x.grid && <ContextPanel ra={x.grid.ra0} dec={x.grid.dec0} fovArcmin={x.view.fov} />}
      </TabsContent>
    </Tabs>
  );
}

let FixtureBadge: ComponentType | null = null;
if (import.meta.env.DEV) {
  FixtureBadge = lazy(() => import('../../dev-fixtures/FixtureBadge'));
}

export function ExplorerPage() {
  const { t } = useTranslation();
  const { t: tw } = useTranslation('wise');
  const x = useExplorer();
  const { view, v, seq, ui } = x;
  const releases = useReleases().data;
  const probeMode = useBackend((s) => s.mode);
  const isMobile = useMedia('(max-width: 767px)');
  const [measureHint, setMeasureHint] = useState(0);
  // The 16 years entry exists only when the timeline will render (a companion with at least one entry).
  const wiseCompanion = useWiseCompanion(seq.sequenceId ?? undefined).data ?? null;
  const hasWise = !!wiseCompanion && buildTimeline(seq.manifest ?? null, wiseCompanion).length > 0;
  const goWise = () => {
    const el = document.getElementById('wise-timeline');
    if (!el) return;
    el.scrollIntoView({ block: 'start', behavior: x.reduced ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  };
  const [exportOpen, setExportOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // "M" measures at the cursor (docs/07 section 6): the pixel under the pointer becomes the mark that
  // Measure works on; with the pointer outside the image it measures the current selection.
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const onCursor = useCallback((p: { x: number; y: number } | null) => {
    cursorRef.current = p;
  }, []);
  useShortcuts(x, () => {
    if (cursorRef.current) ui.setMark(cursorRef.current);
    v.update({ tab: 'measure' });
    setMeasureHint((n) => n + 1);
  });

  const presetId = x.src.status === 'ready' ? x.src.presetId : undefined;
  const firstVisit = x.src.status === 'ready' && x.src.firstVisit;
  // The hero is part of the first paint on the bare home address, so that it does not appear later and push the
  // player down when the target list and the backend probe have answered.
  const showHero = firstVisit || (x.src.status === 'loading' && x.src.landing === true);
  const target = presetId ? x.targets?.find((tg) => tg.id === presetId) : undefined;
  const targetName = x.astro?.name ?? null;
  // A sequence can draw on several collections (release "all"): name every release it used.
  const used = [
    ...new Set(
      (seq.manifest?.provenance.collections.length
        ? seq.manifest.provenance.collections
        : [releases?.default ?? '']
      ).map((c) => c.replace(/_deep$/, '')),
    ),
  ].filter(Boolean);
  const usedReleases = used.map((c) => releases?.releases.find((r) => r.collection === c));
  const release = usedReleases.find(Boolean);
  const releaseLabel =
    used.map((c, i) => usedReleases[i]?.label ?? (c === 'all' ? t('release.all') : c)).join(' + ') ||
    'SPHEREx';
  const latestAsOf = usedReleases
    .map((r) => r?.data_as_of ?? '')
    .filter(Boolean)
    .sort()
    .pop();
  const dataAsOf = seq.manifest?.data_as_of ?? latestAsOf;

  useSeo({
    title: targetName ?? undefined,
    description: targetName ? t('seo.target.description', { name: targetName }) : undefined,
  });

  // A build that is finished and on screen no longer needs its entry in the header list.
  const untrackBuild = useBuilds((s) => s.remove);
  const shownId = seq.phase === 'ready' || seq.phase === 'error' ? seq.sequenceId : null;
  useEffect(() => {
    if (shownId) untrackBuild(shownId);
  }, [shownId, untrackBuild]);

  const canvasLoading =
    x.display.required > 0 && !x.display.ready ? { done: x.display.loaded, total: x.display.required } : null;
  const showCanvas = x.src.status === 'loading' || (x.src.status === 'ready' && seq.phase !== 'error');
  const seqErr = seq.phase === 'error' ? seq.error : null;

  const rmIdle = x.reduced && x.canPlay && !ui.playing && x.view.mode === 'blink';
  const rmDismissed = ui.frame !== 0 || ui.playing;
  const showRmOverlay = rmIdle && !rmDismissed && x.nEpochs >= 2;

  // Propagation notice: epoch-correct positions are stated, never silent.
  const propDate = x.meanMid !== undefined && x.isMover ? mjdIso(x.meanMid) : null;
  const refEpoch = x.astro?.ref_epoch ?? null;
  const showNotice = !!propDate && !ui.noticeDismissed && refEpochToMjd(refEpoch) !== undefined && x.complete;

  // Playback continues behind the half-open sheet and pauses when it covers the frame (S-20).
  // The half-open sheet starts right under the transport row: its height is measured from the player section, and
  // the page scrolls so that the section sits at the top of the viewport.
  const [sheet, setSheet] = useState<SheetState>('peek');
  const [halfPx, setHalfPx] = useState<number | undefined>(undefined);
  const playerRef = useRef<HTMLElement>(null);
  const transportRef = useRef<HTMLDivElement>(null);
  const onSheetState = useCallback(
    (st: SheetState) => {
      if (st === 'half' && playerRef.current && transportRef.current) {
        const top = playerRef.current.getBoundingClientRect().top;
        const bottom = transportRef.current.getBoundingClientRect().bottom;
        setHalfPx(Math.round(window.innerHeight - (bottom - top) - 2 * SHEET_GAP_PX));
      }
      setSheet(st);
      if (st === 'full' && useUi.getState().playing) x.setPlaying(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [x.setPlaying],
  );
  useEffect(() => {
    if (!isMobile || sheet !== 'half' || !playerRef.current) return;
    const y = playerRef.current.getBoundingClientRect().top + window.scrollY - SHEET_GAP_PX;
    window.scrollTo({ top: Math.max(0, y), behavior: x.reduced ? 'auto' : 'smooth' });
  }, [isMobile, sheet, x.reduced]);

  const caption = useMemo(() => {
    if (presetId && view.mode === 'blink') return t(`presetCopy.${presetId}.caption`);
    if (view.mode === 'diff' || view.mode === 'diffseq') return t('caption.diff');
    if (view.mode === 'stack') return t('mode.stackNote');
    return t('caption.blink');
  }, [presetId, view.mode, t]);

  // F-22: reporting needs the live server and a finished sequence with two or more epochs.
  const reportReason = x.demo
    ? t('report.err.demo')
    : !x.complete || x.nEpochs < 2 || !seq.sequenceId || !x.grid
      ? t('report.needTwoEpochs')
      : null;
  const openReport = () => {
    if (view.mode !== 'blink') x.setMode('blink');
    x.setPlaying(false);
    ui.setReportOpen(true);
  };
  const reportSeq = useRef<string | null>(null);
  useEffect(() => {
    // Marks belong to one sequence: a different sequence closes the flow and drops them.
    if (reportSeq.current !== null && reportSeq.current !== (seq.sequenceId ?? null)) {
      ui.setReportOpen(false);
      ui.clearReportMarks();
    }
    reportSeq.current = seq.sequenceId ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seq.sequenceId]);
  useEffect(() => {
    if (reportReason && ui.reportOpen) ui.setReportOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportReason]);
  const reportOpen = ui.reportOpen && !reportReason;
  const curEpochIndex = x.epochs[x.frameIdx]?.index;
  const reportMark = curEpochIndex !== undefined ? (ui.reportMarks[curEpochIndex] ?? null) : null;
  // F-29: a candidate opens the report flow with its position already marked in the two epochs of the pair.
  const candPair = x.cand.pair;
  const reportCandidate = (c: Candidate) => {
    if (reportReason || !candPair) return;
    ui.clearReportMarks();
    for (const [epoch, m] of Object.entries(reportMarksFor(c, candPair))) ui.setReportMark(Number(epoch), m);
    openReport();
  };
  const onCanvasMark = (p: { x: number; y: number }) => {
    // F-29: a click on a candidate marker selects it in the list.
    if (!reportOpen && x.cand.active && x.cand.markers) {
      const hit = hitMarker(x.cand.markers, p);
      if (hit) return x.cand.setSelected(hit.id);
    }
    // F-32: a click on a motion track selects its source in the list.
    if (!reportOpen && !x.trackStack && x.motion.tracks) {
      const hit = hitTrack(x.motion.tracks, p);
      if (hit) return x.motion.setSelected(hit.id);
    }
    if (!reportOpen) return ui.setMark(p);
    const e = x.epochs[x.frameIdx];
    if (!e || e.frames.length === 0) return;
    if (!ui.reportMarks[e.index] && Object.keys(ui.reportMarks).length >= MAX_MARKS) return;
    ui.setReportMark(e.index, p);
  };

  const share = (
    <div className="flex flex-wrap items-end gap-2" data-tour="share">
      <Button variant="secondary" onClick={() => ui.setShareOpen(true)} data-testid="share-btn">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
        </svg>
        {t('share.button')}
      </Button>
      <Button variant="secondary" onClick={() => setExportOpen(true)} data-testid="export-btn">
        {t('export.button')}
      </Button>
      <ActionsMenu
        onSheet={() => setSheetOpen(true)}
        report={{
          reason: reportReason,
          open: ui.reportOpen,
          onToggle: () => (ui.reportOpen ? ui.setReportOpen(false) : openReport()),
        }}
      />
    </div>
  );

  const onOpenPreset = (id: string) => v.openPreset(id);
  // F-28: a curated field never repeats the one on screen. Demo mode serves only the cached presets.
  const pickId = x.src.status === 'ready' ? x.src.pickId : undefined;
  const onSurprise = () => v.openPick(pickSurprise(pickId).id);
  const surpriseOff = x.demo ? t('surprise.demoOff') : null;
  const noEpochs = x.nEpochs === 0;
  // Sky context while a server build has no frame yet. `seq.status` is set only once the server has accepted a
  // build, so cached presets and cache hits never mount Aladin here. The player replaces it with the first frame.
  const skyPreview =
    x.src.status === 'ready' &&
    seq.phase === 'building' &&
    seq.status !== null &&
    !x.epochs.some((e) => e.frames.length > 0);

  // Left column main content
  let stage: React.ReactNode;
  if (x.src.status === 'empty')
    stage = (
      <EmptyCard
        onOpen={onOpenPreset}
        onTour={() => {
          // The tour talks about a live sequence: open the first preset, then start it.
          onOpenPreset('barnard');
          useTour.getState().start();
        }}
      />
    );
  else if (x.src.status === 'error') {
    stage = <ErrorCard code={x.src.code} onRetry={() => window.location.reload()} onOpen={onOpenPreset} />;
  } else if (seqErr) {
    if (seqErr.code === 'NO_COVERAGE') {
      stage = (
        <NoDataCard releaseLabel={releaseLabel} fov={view.fov} dataAsOf={dataAsOf} onOpen={onOpenPreset} />
      );
    } else if (seqErr.code === 'RATE_LIMITED' || seqErr.status === 429) {
      stage = (
        <RateLimitedCard
          retryAfter={seqErr.retryAfter ?? 60}
          onRetry={() => useSequence.getState().retry()}
          onOpen={onOpenPreset}
        />
      );
    } else {
      stage = (
        <ErrorCard code={seqErr.code} onRetry={() => useSequence.getState().retry()} onOpen={onOpenPreset} />
      );
    }
  } else if (skyPreview && x.grid) {
    stage = <ContextPanel preview ra={x.grid.ra0} dec={x.grid.dec0} fovArcmin={view.fov} />;
  } else if (showCanvas) {
    stage = (
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
        candidates={x.cand.active ? x.cand.markers : null}
        motionTracks={x.motion.tracks}
        track={x.track}
        ring={x.ring}
        targetName={targetName}
        targetMotion={x.motionLabel}
        labelOffset={labelOffsetFor(presetId)}
        mark={reportOpen ? reportMark : ui.mark}
        refEpoch={x.refIdx}
        totalEpochs={x.nEpochs}
        loading={canvasLoading}
        waitingForEpochs={noEpochs}
        rmIdle={showRmOverlay}
        onPlay={() => x.setPlaying(true)}
        onMark={onCanvasMark}
        onCursor={onCursor}
        onStep={(d) => x.step(d)}
        announce={x.announce}
        stretch={x.stretch}
      />
    );
  }

  const inDiff = view.mode === 'diff' || view.mode === 'diffseq';
  const playerReady = showCanvas && !seqErr;

  // F-24: the guided tour opens by itself once, on the first visit, when a finished sequence is on screen. It never
  // starts playback; playback that started on its own keeps running inside the spotlight of the first step.
  const tourReady =
    playerReady &&
    x.src.status === 'ready' &&
    seq.phase === 'ready' &&
    x.nEpochs > 0 &&
    !ui.reportOpen &&
    !ui.helpOpen &&
    !ui.shareOpen;
  const maybeAutoStartTour = useTour((s) => s.maybeAutoStart);
  useEffect(() => {
    if (tourReady) maybeAutoStartTour();
  }, [tourReady, maybeAutoStartTour]);
  const frameSummary = x.currentFrame
    ? t('mobile.frameSummary', {
        epoch: x.frameIdx + 1,
        total: x.nEpochs,
        images: x.currentFrame.n_images,
        flagged: localPercent(x.lang, x.currentFrame.flagged_fraction),
      })
    : null;
  const tabLabel = t(`panel.${view.tab}`);
  const sheetSummary =
    (sheet === 'peek' || view.tab === 'info') && frameSummary
      ? frameSummary
      : targetName
        ? `${tabLabel} · ${targetName}`
        : tabLabel;

  // Status banners are known only after the health probe answers. They sit under the player rather than above the
  // hero, so that their arrival does not push the page down.
  const noticeNode = (
    <>
      {x.demo && !ui.demoBannerDismissed && <DemoBanner onDismiss={ui.dismissDemoBanner} />}
      {x.health && x.health.irsa !== 'ok' && ui.irsaDismissed !== x.health.irsa && (
        <IrsaBanner health={x.health} onDismiss={() => ui.dismissIrsa(x.health?.irsa ?? 'degraded')} />
      )}
      {seq.refreshing && seq.phase === 'ready' && <RefreshBanner />}
      {showNotice && propDate && (
        <PropagationNotice date={propDate} epoch={refEpochLabel(refEpoch)} onDismiss={ui.dismissNotice} />
      )}
    </>
  );

  const left = (
    <section
      ref={playerRef}
      className="flex min-w-0 flex-col gap-4 max-md:gap-3"
      aria-label={t('mobile.player')}
    >
      {isMobile && playerReady && (
        <div>
          <MobileTools
            x={x}
            onShare={() => ui.setShareOpen(true)}
            onExport={() => setExportOpen(true)}
            onSheet={() => setSheetOpen(true)}
            report={{
              reason: reportReason,
              open: ui.reportOpen,
              onToggle: () => (ui.reportOpen ? ui.setReportOpen(false) : openReport()),
            }}
            onReportCandidate={reportCandidate}
          />
        </div>
      )}
      <div className="relative" data-tour="player">
        {stage}
        {FixtureBadge && probeMode === 'fixture' && showCanvas && (
          <Suspense fallback={null}>
            <FixtureBadge />
          </Suspense>
        )}
      </div>
      {isMobile && playerReady && (
        <>
          <div ref={transportRef} data-tour="transport">
            <MobileTransport
              playing={ui.playing}
              canPlay={x.canPlay}
              atFirst={x.playable.indexOf(x.frameIdx) <= 0}
              atLast={x.playable.indexOf(x.frameIdx) === x.playable.length - 1}
              loop={ui.loop}
              reducedMotion={x.reduced}
              epochs={x.epochs}
              index={x.frameIdx}
              missing={x.missingEpochs}
              refIndex={inDiff ? x.refIdx : null}
              lang={x.lang}
              onPlayPause={() => x.setPlaying(!ui.playing)}
              onStep={(d) => x.step(d)}
              onJump={x.setFrameFromUser}
            />
          </div>
          <p className="text-body-14 text-text-2" data-testid="caption">
            {caption}
          </p>
          <p className="tnum font-mono text-caption-12 text-muted" data-testid="provenance-line">
            {releaseLabel}
            {dataAsOf ? ` · ${t('info.dataAsOf')} ${dataAsOf}` : ''}
          </p>
        </>
      )}
      {!isMobile && playerReady && (
        <>
          <div data-tour="transport" className="flex flex-col gap-4">
            <PlaybackControls
              playing={ui.playing}
              fps={x.fps}
              loop={ui.loop}
              canPlay={x.canPlay}
              atFirst={x.playable.indexOf(x.frameIdx) <= 0}
              atLast={x.playable.indexOf(x.frameIdx) === x.playable.length - 1}
              reducedMotion={x.reduced}
              onPlayPause={() => x.setPlaying(!ui.playing)}
              onStep={(d) => x.step(d)}
              onFirst={() => x.playable.length && x.setFrameFromUser(x.playable[0])}
              onLast={() => x.playable.length && x.setFrameFromUser(x.playable[x.playable.length - 1])}
              onFps={x.setFps}
              onLoop={ui.setLoop}
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
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-4" aria-disabled={noEpochs || undefined}>
              <div data-tour="mode">
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
              </div>
              {inDiff && (
                <CandidatesToggle
                  on={view.cand}
                  onChange={x.setCand}
                  count={x.cand.data?.counts.listed ?? null}
                />
              )}
              <div data-tour="detector">
                <DetectorPicker
                  value={x.det}
                  ranges={x.ranges}
                  coverage={x.coverage}
                  disabled={noEpochs}
                  onChange={x.setDet}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
              <div className="contents" aria-disabled={noEpochs || undefined}>
                <DataOptions
                  fov={view.fov}
                  release={view.release}
                  partial={view.partial}
                  nonDefault={x.v.search.fov !== undefined || view.release !== undefined || view.partial}
                >
                  <FovSelect
                    value={view.fov}
                    center={x.src.status === 'ready' ? x.src.center : null}
                    release={view.release}
                    partial={view.partial}
                    fastMoverNext={x.fastMoverNext}
                    onChange={x.setFov}
                  />
                  <ReleaseSelect value={view.release} onChange={x.setRelease} />
                  <PartialToggle on={view.partial} onChange={x.setPartial} />
                </DataOptions>
                <div data-tour="overlays">
                  <OverlayToggles
                    active={new Set(view.ov)}
                    disabledInDiff={view.mode === 'diff' || view.mode === 'diffseq'}
                    counts={x.overlayCounts}
                    onToggle={x.toggleOverlay}
                    onRetry={x.retryOverlay}
                    flagLegend={x.flagLegend}
                    path={{ reason: x.pathReason, data: x.pathData }}
                    lang={x.lang}
                  />
                </div>
              </div>
              {/* Sharing stays available during a build: the link is the one the finished view will have. */}
              <div className="flex flex-col gap-1.5 self-end">{share}</div>
            </div>
          </div>
          <p className="max-w-[640px] text-body-14 text-text-2" data-testid="caption">
            {caption}
          </p>
        </>
      )}
      {noticeNode}
    </section>
  );

  const panelTabs = (
    <PanelTabs
      x={x}
      releaseLabel={releaseLabel}
      dataAsOf={dataAsOf}
      mobile={isMobile}
      onTabClick={isMobile && sheet === 'peek' ? () => onSheetState('half') : undefined}
      key={measureHint}
    />
  );
  const right = (
    <aside className="flex min-w-0 flex-col gap-4" aria-label={t('sheet.label')}>
      {reportOpen ? (
        <ReportFlow x={x} onClose={() => ui.setReportOpen(false)} />
      ) : (
        <>
          {x.src.status === 'ready' && seq.phase === 'building' && (
            <BuildProgress
              status={seq.status}
              position={seq.position}
              progress={seq.progress}
              epochs={seq.epochs}
              expectedEpochs={0}
              detectorsReady={seq.detectorsReady}
              detectorsPending={seq.detectorsPending}
              shownDetector={x.fallbackDetector}
              estimateSeconds={seq.estimate?.seconds ?? null}
              startedAt={seq.startedAt}
            />
          )}
          {x.single && (
            <SingleEpochCard releaseLabel={releaseLabel} targets={x.targets} onOpen={onOpenPreset} />
          )}
          {presetId && !seqErr && (
            <div data-tour="results">
              <ResultCard id={presetId} target={target} lang={x.lang} />
            </div>
          )}
          {hasWise && !seqErr && x.src.status === 'ready' && (
            <Button variant="secondary" className="self-start" onClick={goWise} data-testid="wise-entry">
              {tw('entry')}
            </Button>
          )}
          {pickId && <SurpriseCard id={pickId} lang={x.lang} onAnother={onSurprise} />}
          {!isMobile && !seqErr && x.src.status === 'ready' && x.cand.active && (
            <CandidatesPanel
              cand={x.cand}
              epochs={x.epochs}
              lang={x.lang}
              onReport={reportCandidate}
              reportReason={reportReason}
              className="rounded-xl border border-border bg-surface p-4"
            />
          )}
          {!isMobile && !seqErr && x.src.status === 'ready' && (
            <div className="rounded-xl border border-border bg-surface p-4" data-tour="results">
              {panelTabs}
            </div>
          )}
          {!isMobile && !seqErr && x.src.status === 'ready' && (
            <div data-tour="motion">
              <MotionSearchPanel
                motion={x.motion}
                lang={x.lang}
                complete={x.complete}
                className="rounded-xl border border-border bg-surface p-4"
              />
            </div>
          )}
          {!seqErr && x.src.status === 'ready' && (
            <WiseTimeline sequenceId={seq.sequenceId ?? undefined} manifest={seq.manifest} lang={x.lang} />
          )}
        </>
      )}
    </aside>
  );

  return (
    <main id="main" tabIndex={-1} data-testid="explorer">
      {showHero ? (
        <div className="border-b border-border" data-testid="hero">
          <div className="mx-auto grid max-w-[1440px] gap-4 px-4 py-5 md:px-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start xl:gap-10 xl:px-8">
            <div className="flex min-w-0 flex-col gap-3">
              <div>
                <h1 className="text-heading-24 font-medium md:text-display-32">{t('hero.title')}</h1>
                <p className="mt-1 text-body-15 text-muted">{t('hero.subtitle')}</p>
              </div>
              <PresetChips
                selectedId={presetId}
                building={seq.phase === 'building'}
                onSelect={onOpenPreset}
                label={t('hero.pick')}
                onSurprise={onSurprise}
                surpriseOff={surpriseOff}
              />
              <Link
                to="/story"
                search={{ lang: view.lang }}
                className="inline-flex min-h-[var(--hit-min)] items-center self-start text-label-13 text-cyan underline underline-offset-2"
                data-testid="hero-story"
              >
                {t('story:hero')}
              </Link>
            </div>
            <div className="min-w-0 xl:rounded-xl xl:border xl:border-border xl:bg-surface xl:p-4">
              <HuntCounters compact lang={view.lang} />
            </div>
          </div>
        </div>
      ) : (
        <div className="md:border-b md:border-border">
          <div className="mx-auto max-w-[1440px] px-4 md:px-6 md:py-2 xl:px-8">
            <h1 className="sr-only">{targetName ?? 'Destello'}</h1>
            {!isMobile && (
              <PresetChips
                selectedId={presetId}
                building={seq.phase === 'building'}
                onSelect={onOpenPreset}
                label={t('presets.label')}
                onSurprise={onSurprise}
                surpriseOff={surpriseOff}
              />
            )}
          </div>
        </div>
      )}

      <div
        className={cn(
          'mx-auto grid max-w-[1440px] gap-6 px-4 py-4 md:px-6 xl:px-8',
          'lg:grid-cols-[minmax(480px,7fr)_minmax(360px,5fr)] xl:grid-cols-[520px_minmax(0,1fr)] 2xl:grid-cols-[600px_minmax(0,1fr)]',
          isMobile && !reportOpen && (sheet === 'peek' ? 'pb-28' : 'pb-[75dvh]'),
        )}
      >
        {left}
        {right}
      </div>

      {/* On phones the report flow replaces the sheet: it sits under the player, where marks are placed. */}
      {isMobile && !reportOpen && !seqErr && x.src.status === 'ready' && (
        <BottomSheet
          state={sheet}
          halfPx={halfPx}
          onStateChange={onSheetState}
          summary={sheetSummary}
          mini={
            <MiniPlayer
              bitmap={x.items[x.frameIdx]?.bitmap ?? null}
              title={targetName ?? 'Destello'}
              line={frameSummary ?? tabLabel}
              playing={ui.playing}
              canPlay={x.canPlay}
              reducedMotion={x.reduced}
              onPlayPause={() => x.setPlaying(!ui.playing)}
            />
          }
        >
          {panelTabs}
        </BottomSheet>
      )}

      <ShareDialog
        open={ui.shareOpen}
        onOpenChange={ui.setShareOpen}
        pagePath={v.pagePath}
        view={v.search}
        targetId={presetId && !firstVisit ? presetId : undefined}
        targetName={targetName ?? 'Destello'}
        lang={x.lang}
        building={x.src.status === 'ready' && seq.phase === 'building'}
      />
      <ExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        x={x}
        targetName={targetName}
        releaseLabel={releaseLabel}
        doi={seq.manifest?.provenance.dois[0] ?? release?.doi ?? null}
      />
      <ResultsSheetDialog
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        x={x}
        targetName={targetName}
        viewUrl={`${window.location.origin}${v.pagePath}`}
        presetId={presetId}
        target={target}
      />
      <ShortcutsDialog
        open={ui.helpOpen}
        onOpenChange={ui.setHelpOpen}
        onTour={() => {
          ui.setHelpOpen(false);
          useTour.getState().start();
        }}
      />
      <TourOverlay />
    </main>
  );
}

function labelOffsetFor(id: string | undefined): { dx: number; dy: number } {
  return PRESET_LABELS[id ?? ''] ?? { dx: 7, dy: 0 };
}

const PRESET_LABELS: Record<string, { dx: number; dy: number }> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p.label]),
);
