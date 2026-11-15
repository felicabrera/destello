// F-38 "Measure it yourself": the student clicks Barnard's Star in each epoch, the app turns the clicks into sky
// coordinates with the frame grid, computes a proper motion step by step and compares it with Destello's fit and
// the catalog value. The frames are the Explorer's own (same sequence, one detector, one shared stretch).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button';
import { formatDec, formatRa } from '../../lib/coords';
import { hudBand, localDate, mjdToDate } from '../../lib/format';
import { useExplorer } from '../explorer/useExplorer';
import { useTargets, useView } from '../explorer/useView';
import { PlayerCanvas } from '../player/PlayerCanvas';
import type { Pt } from '../player/draw';
import { LearnCompare, compareRows } from './LearnCompare';
import { LearnSteps } from './LearnSteps';
import {
  CROSSHAIR_KEYS,
  clickToSky,
  commonDetector,
  frameOfEpoch,
  learnEpochs,
  measureMotion,
  moveCrosshair,
  type CrosshairKey,
  type EpochPoint,
  type LearnEpoch,
} from './learnModel';
import { LEARN_TARGET, useLearnReference } from './useLearnReference';

const btn =
  'inline-flex min-h-[var(--hit-min)] items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface-2 px-3 text-label-13 font-medium text-text hover:bg-border disabled:text-disabled';
const noop = () => undefined;

function LearnPlayer({ sequenceId }: { sequenceId: string }) {
  const { t } = useTranslation('learn');
  const x = useExplorer();
  const lang = x.lang;
  const detNum = typeof x.det === 'number' ? x.det : null;

  // One detector for the whole activity: the one with a frame in the most epochs.
  const setDet = x.setDet;
  useEffect(() => {
    if (!x.complete || detNum !== null) return;
    const d = commonDetector(x.epochs);
    if (d !== null) setDet(d as 1);
  }, [x.complete, detNum, x.epochs, setDet]);

  const epochs: LearnEpoch[] = useMemo(
    () => (x.complete && detNum !== null ? learnEpochs(x.epochs, detNum) : []),
    [x.complete, detNum, x.epochs],
  );
  const [cur, setCur] = useState(0);
  const [clicks, setClicks] = useState<Record<number, Pt>>({});
  const [pending, setPending] = useState<Pt | null>(null);
  const [live, setLive] = useState('');
  const frameRef = useRef<HTMLDivElement>(null);

  // A different detector starts the activity again.
  useEffect(() => {
    setClicks({});
    setPending(null);
    setCur(0);
  }, [detNum, sequenceId]);

  const here = epochs[Math.min(cur, Math.max(epochs.length - 1, 0))];
  const setFrame = x.setFrameFromUser;
  useEffect(() => {
    if (here) setFrame(here.pos);
  }, [here, setFrame]);

  const grid = x.grid;
  const saved = here ? clicks[here.index] : undefined;
  const shown = pending ?? saved ?? null;

  const place = useCallback(
    (p: Pt) => {
      setPending(p);
      if (grid) {
        const s = clickToSky(grid, p);
        setLive(t('player.placed', { ra: formatRa(s.ra, 1), dec: formatDec(s.dec, 0) }));
      }
    },
    [grid, t],
  );

  const go = useCallback((i: number) => {
    setPending(null);
    setCur(i);
  }, []);

  const confirm = useCallback(() => {
    if (!here || !pending) return;
    const next = { ...clicks, [here.index]: pending };
    setClicks(next);
    setPending(null);
    setLive(t('player.saved', { n: here.index + 1 }));
    const after = epochs.findIndex((e, i) => i > cur && !next[e.index]);
    const any = epochs.findIndex((e) => !next[e.index]);
    const to = after !== -1 ? after : any;
    if (to !== -1) setCur(to);
  }, [here, pending, clicks, epochs, cur, t]);

  const redo = useCallback(() => {
    if (!here) return;
    setClicks((c) => {
      const { [here.index]: _drop, ...rest } = c;
      void _drop;
      return rest;
    });
    setPending(null);
    setLive(t('player.redone', { n: here.index + 1 }));
    frameRef.current?.querySelector<HTMLElement>('[data-testid="player-canvas"]')?.focus();
  }, [here, t]);

  // Keyboard crosshair: the arrows move it (Shift: five pixels), Enter confirms. Captured before the player sees
  // the arrows, which would otherwise step through the epochs.
  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('[data-testid="player-canvas"]') === null) return;
    if (CROSSHAIR_KEYS.includes(e.key) && grid) {
      e.preventDefault();
      e.stopPropagation();
      const start = pending ?? saved ?? { x: x.n / 2, y: x.n / 2 };
      place(moveCrosshair(start, e.key as CrosshairKey, e.shiftKey ? 5 : 1, x.n));
    } else if (e.key === 'Enter') {
      if (pending) {
        e.preventDefault();
        e.stopPropagation();
        confirm();
      }
    }
  };

  const points: EpochPoint[] = useMemo(
    () =>
      grid
        ? epochs.flatMap((e) => (clicks[e.index] ? [{ ...e, sky: clickToSky(grid, clicks[e.index]) }] : []))
        : [],
    [epochs, clicks, grid],
  );
  const outcome = useMemo(() => measureMotion(points), [points]);
  const ref = useLearnReference(sequenceId, detNum);
  const missionName = useCallback((e: LearnEpoch) => e.mission ?? t('mission.spherex'), [t]);

  const frame = here && detNum !== null ? frameOfEpoch(x.epochs[here.pos], detNum) : undefined;
  const prov = x.seq.manifest?.provenance;

  if (!x.complete || detNum === null) {
    return (
      <p role="status" className="text-body-14 text-muted" data-testid="learn-loading">
        {x.seq.phase === 'error' ? t('error') : t('loading')}
      </p>
    );
  }
  if (epochs.length < 2) {
    return (
      <p role="alert" className="text-body-14 text-text-2" data-testid="learn-few">
        {t('fewEpochs')}
      </p>
    );
  }
  const done = epochs.filter((e) => clicks[e.index]).length;

  return (
    <div className="flex flex-col gap-8">
      <div
        className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]"
        data-testid="learn-activity"
      >
        <div className="flex min-w-0 flex-col gap-2">
          <div
            ref={frameRef}
            className="mx-auto w-full"
            style={{ maxWidth: 'max(280px, calc(100dvh - 260px))' }}
            onKeyDownCapture={onKeyDownCapture}
            data-testid="learn-frame"
            data-epoch={here?.index}
          >
            <PlayerCanvas
              epochs={x.epochs}
              items={x.items}
              frameIdx={x.frameIdx}
              mode="blink"
              det={x.det}
              n={x.n}
              scaleArcsec={x.scaleArcsec}
              grid={x.grid}
              showGaia={false}
              showCatwise={false}
              showFlags={false}
              gaia={null}
              catwise={null}
              mask={null}
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
              mark={shown}
              refEpoch={x.refIdx}
              totalEpochs={x.nEpochs}
              loading={null}
              waitingForEpochs={false}
              rmIdle={false}
              onPlay={noop}
              onMark={place}
              onStep={noop}
              announce={x.announce}
              stretch={x.stretch}
            />
          </div>
          <p className="tnum text-caption-12 text-muted" data-testid="learn-provenance">
            {t('player.provenance', {
              mission: here ? missionName(here) : '',
              date: here ? localDate(lang, mjdToDate(here.mjd)) : '',
              det: detNum,
              band: hudBand(frame) ?? t('player.noBand'),
              n: frame?.n_images ?? 0,
            })}
            {prov && prov.dois.length > 0 ? ` ${t('player.doi', { doi: prov.dois.join(', ') })}` : ''}
          </p>
          <p className="text-caption-12 text-muted">{t('player.orientation')}</p>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <section aria-labelledby="learn-how-h" className="flex flex-col gap-2">
            <h2 id="learn-how-h" className="text-label-13 font-semibold text-text">
              {t('player.how')}
            </h2>
            <ol className="list-decimal pl-5 text-body-14 text-text-2">
              <li>{t('player.how1')}</li>
              <li>{t('player.how2')}</li>
              <li>{t('player.how3')}</li>
            </ol>
          </section>
          <p className="text-label-13 text-text" data-testid="learn-progress">
            {t('player.progress', { done, total: epochs.length })}
          </p>
          <ol className="flex flex-col gap-1.5" aria-label={t('player.epochs')} data-testid="learn-epochs">
            {epochs.map((e, i) => {
              const c = clicks[e.index];
              const sky = c && grid ? clickToSky(grid, c) : null;
              return (
                <li key={e.index}>
                  <button
                    type="button"
                    className={`flex min-h-[var(--hit-min)] w-full flex-col items-start rounded-lg border px-3 py-1.5 text-left hover:bg-border ${i === cur ? 'border-glint bg-glint-soft' : 'border-border-strong bg-surface-2'}`}
                    aria-current={i === cur ? 'step' : undefined}
                    onClick={() => go(i)}
                    data-testid={`learn-epoch-${e.index}`}
                    data-clicked={c ? '1' : '0'}
                  >
                    <span className="text-label-13 font-semibold text-text">
                      {t('player.epochName', { n: e.index + 1, mission: missionName(e) })}
                      <span className="ml-2 font-normal text-muted">{localDate(lang, mjdToDate(e.mjd))}</span>
                    </span>
                    <span className="tnum text-caption-12 text-text-2">
                      {sky
                        ? t('player.at', { ra: formatRa(sky.ra, 1), dec: formatDec(sky.dec, 0) })
                        : t('player.notYet')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!pending} onClick={confirm} data-testid="learn-confirm">
              {t('player.confirm')}
            </Button>
            <button
              type="button"
              className={btn}
              disabled={!pending && !saved}
              onClick={redo}
              data-testid="learn-redo"
            >
              {t('player.redo')}
            </button>
            <button
              type="button"
              className={btn}
              disabled={cur <= 0}
              onClick={() => go(cur - 1)}
              data-testid="learn-prev"
            >
              {t('player.prev')}
            </button>
            <button
              type="button"
              className={btn}
              disabled={cur >= epochs.length - 1}
              onClick={() => go(cur + 1)}
              data-testid="learn-next"
            >
              {t('player.next')}
            </button>
          </div>
          <p className="text-caption-12 text-muted" data-testid="learn-status">
            {pending && grid
              ? t('player.pending', {
                  ra: formatRa(clickToSky(grid, pending).ra, 1),
                  dec: formatDec(clickToSky(grid, pending).dec, 0),
                })
              : saved
                ? t('player.savedState')
                : t('player.waiting')}
          </p>
          <span className="sr-live" role="status" aria-live="polite" data-testid="learn-live">
            {live}
          </span>
        </div>
      </div>

      {outcome.kind === 'ok' ? (
        <>
          <LearnSteps steps={outcome.steps} lang={lang} missionName={missionName} />
          <LearnCompare
            steps={outcome.steps}
            rows={compareRows(outcome.steps, ref.destello, ref.gaia)}
            lang={lang}
            pending={ref.pending}
          />
        </>
      ) : (
        <p className="text-body-14 text-text-2" data-testid="learn-need-two" role="status">
          {outcome.kind === 'no-time'
            ? t('steps.noTime')
            : t('steps.needTwo', { n: outcome.nClicked, total: epochs.length })}
        </p>
      )}
    </div>
  );
}

export function LearnPage() {
  const { t } = useTranslation('learn');
  const v = useView();
  const targets = useTargets();
  const item = targets.data?.find((x) => x.id === LEARN_TARGET);
  const seqId = item?.sequence_id ?? null;
  const { update } = v;
  const seqInUrl = v.view.seq;
  const detDefault = typeof item?.default_view?.det === 'number' ? item.default_view.det : undefined;

  // The Explorer model reads the sequence from the URL (as the Hunt page does): the cached sequence of the
  // preset, blink mode, no autoplay, no overlays.
  useEffect(() => {
    if (seqId && seqInUrl !== seqId)
      update({
        seq: seqId,
        play: 0,
        mode: undefined,
        frame: undefined,
        ref: undefined,
        ov: undefined,
        det: detDefault as 1 | undefined,
        track: undefined,
      });
  }, [seqId, seqInUrl, update, detDefault]);

  const ready = seqId !== null && seqInUrl === seqId;
  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-6 md:px-6 xl:px-8"
      data-testid="learn"
    >
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-heading-24 font-medium md:text-display-32">{t('title')}</h1>
        <p className="max-w-[760px] text-body-15 text-muted">{t('subtitle')}</p>
        <Link
          to="/learn/guide"
          search={{ lang: v.view.lang }}
          className="min-h-[var(--hit-min)] self-start rounded-lg py-2 text-label-13 font-medium text-glint underline underline-offset-2"
          data-testid="learn-guide-link"
        >
          {t('guideLink')}
        </Link>
      </header>
      {targets.isError || (targets.isSuccess && !seqId) ? (
        <p role="alert" className="text-body-14 text-text-2" data-testid="learn-unavailable">
          {t('unavailable')}
        </p>
      ) : ready ? (
        <LearnPlayer sequenceId={seqId} />
      ) : (
        <p role="status" className="text-body-14 text-muted">
          {t('loading')}
        </p>
      )}
    </main>
  );
}
