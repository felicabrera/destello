// F-25: export of the current blink as an animated GIF, made in the browser from the frames already loaded.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';
import { API_BASE } from '../../lib/api';
import { encodeGif, exportFileName, exportOrder, exportScale, grayLevelsFor } from '../../lib/exportGif';
import { epochMid, fmtMjd, hudBand, localNumber, mjdIso } from '../../lib/format';
import { OVERLAYS } from '../../lib/types';
import type { useExplorer } from '../explorer/useExplorer';
import { renderExportFrames, type ExportCaption } from './renderExport';

type Model = ReturnType<typeof useExplorer>;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  x: Model;
  targetName: string | null;
  releaseLabel: string;
  doi: string | null;
}

type State =
  | { s: 'idle' }
  | { s: 'drawing'; done: number; total: number }
  | { s: 'encoding' }
  | { s: 'done'; url: string; still: string; bytes: number; name: string }
  | { s: 'error' };

export function ExportDialog({ open, onOpenChange, x, targetName, releaseLabel, doi }: Props) {
  const { t } = useTranslation();
  const [st, setSt] = useState<State>({ s: 'idle' });
  const urlRef = useRef<string | null>(null);
  const run = useRef(0);
  const { view, lang } = x;

  const drop = () => {
    run.current++;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setSt({ s: 'idle' });
  };
  useEffect(() => () => void (urlRef.current && URL.revokeObjectURL(urlRef.current)), []);

  const order = exportOrder(view.mode, x.playable);
  const ready = x.display.ready && x.complete;
  const scenes = ready ? order.map((i) => ({ i, sc: x.sceneAt(i) })).filter((f) => f.sc.bitmap) : [];
  const isRgb = view.mode === 'rgb';
  const detLabel = isRgb
    ? t('mode.rgbLegend', { r: `D${x.rgb[0]}`, g: `D${x.rgb[1]}`, b: `D${x.rgb[2]}` })
    : x.det === 'all'
      ? t('detector.allDet')
      : `D${x.det}`;
  const shownOverlays = OVERLAYS.filter(
    (o) => view.ov.includes(o) && (o !== 'path' || x.pathScene !== null),
  ).map((o) => t(`overlays.${o}`));
  const mids = x.epochs.map((e) => epochMid(e)).filter((m): m is number => m !== undefined);
  const scale = localNumber(lang, x.scaleArcsec, 1);

  const captionFor = (i: number): ExportCaption => {
    const sc = x.sceneAt(i);
    const band = !isRgb && sc.frame ? hudBand(sc.frame) : undefined;
    const e = x.epochs[i];
    const mid = e ? epochMid(e) : undefined;
    const epochLine =
      view.mode === 'stack'
        ? t('export.capStack', { total: x.nEpochs })
        : t('export.capEpoch', {
            epoch: i + 1,
            total: x.nEpochs,
            date: mid !== undefined ? mjdIso(mid) : '',
            mjd: mid !== undefined ? fmtMjd(mid) : '',
          });
    const diff =
      view.mode === 'diff'
        ? t('player.diffEq', { a: i + 1, b: x.refIdx + 1 })
        : view.mode === 'diffseq'
          ? t('player.diffEq', { a: i + 1, b: i })
          : null;
    return {
      title: [targetName ?? t('export.field'), detLabel, band].filter(Boolean).join(' · '),
      lines: [
        diff ? `${epochLine} · ${diff}` : epochLine,
        t('export.capSpan', {
          mode: t(`mode.${view.mode}`),
          first: mids.length ? mjdIso(Math.min(...mids)) : '',
          last: mids.length ? mjdIso(Math.max(...mids)) : '',
        }),
        doi ? t('export.capRelease', { release: releaseLabel, doi }) : releaseLabel,
        t('export.capScale', { scale }),
        t('export.capCredit'),
      ],
    };
  };

  const create = async () => {
    drop();
    const id = run.current;
    const list = scenes;
    if (list.length === 0) return;
    try {
      setSt({ s: 'drawing', done: 0, total: list.length });
      const { frames, still } = await renderExportFrames(
        list.map((f) => f.sc),
        list.map((f) => captionFor(f.i)),
        exportScale(x.n),
        (done) => run.current === id && setSt({ s: 'drawing', done, total: list.length }),
      );
      if (run.current !== id) return;
      setSt({ s: 'encoding' });
      await new Promise((r) => setTimeout(r, 0));
      const bytes = encodeGif(frames, Math.round(1000 / x.fps), grayLevelsFor(view.mode));
      if (run.current !== id) return;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/gif' }));
      urlRef.current = url;
      const name = exportFileName([
        targetName ?? 'field',
        isRgb ? `rgb-${x.rgb.join('')}` : x.det === 'all' ? 'all' : `d${x.det}`,
        view.mode,
      ]);
      setSt({ s: 'done', url, still, bytes: bytes.length, name });
    } catch {
      if (run.current === id) setSt({ s: 'error' });
    }
  };

  const pythonReason = x.demo
    ? t('export.pythonDemo')
    : !x.seq.sequenceId || !x.complete
      ? t('export.pythonNotReady')
      : null;
  const busy = st.s === 'drawing' || st.s === 'encoding';
  const reason = !ready ? t('export.notReady') : scenes.length === 0 ? t('export.noFrames') : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) drop();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-w-[560px]" data-testid="export-dialog">
        <DialogTitle className="text-title-20 font-semibold">{t('export.title')}</DialogTitle>
        <DialogDescription className="mt-1 text-body-14 text-text-2">{t('export.desc')}</DialogDescription>

        <dl
          className="tnum mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body-14"
          data-testid="export-summary"
        >
          <dt className="text-muted">{t('export.frames')}</dt>
          <dd data-testid="export-frames">{scenes.length}</dd>
          <dt className="text-muted">{t('export.detector')}</dt>
          <dd>{detLabel}</dd>
          <dt className="text-muted">{t('mode.label')}</dt>
          <dd>{t(`mode.${view.mode}`)}</dd>
          <dt className="text-muted">{t('export.speed')}</dt>
          <dd>{t('export.speedValue', { fps: x.fps })}</dd>
          <dt className="text-muted">{t('export.overlays')}</dt>
          <dd>{shownOverlays.length ? shownOverlays.join(', ') : t('export.none')}</dd>
        </dl>

        {reason && (
          <p className="mt-4 text-body-14 text-text-2" role="note" data-testid="export-reason">
            {reason}
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={() => void create()}
            disabled={!!reason || busy}
            data-testid="export-create"
          >
            {t('export.create')}
          </Button>
          {st.s === 'done' && (
            <Button asChild variant="secondary">
              <a href={st.url} download={st.name} data-testid="export-download">
                {t('export.download')}
              </a>
            </Button>
          )}
        </div>

        <p className="mt-3 min-h-5 text-label-13 text-text-2" role="status" data-testid="export-status">
          {st.s === 'drawing'
            ? t('export.drawing', { done: st.done, total: st.total })
            : st.s === 'encoding'
              ? t('export.encoding')
              : st.s === 'done'
                ? t('export.done', { size: localNumber(lang, st.bytes / 1024, 0) })
                : ''}
        </p>
        {st.s === 'error' && (
          <p className="text-label-13 text-text" role="alert" data-testid="export-error">
            {t('export.failed')}
          </p>
        )}

        {st.s === 'done' && (
          <figure className="mt-3 flex flex-col gap-2">
            {x.reduced ? (
              <>
                <img
                  src={st.still}
                  alt={t('export.stillAlt')}
                  className="w-full rounded-xs bg-frame [image-rendering:pixelated]"
                  data-testid="export-preview"
                  data-animated="false"
                />
                <figcaption className="text-caption-12 text-muted">{t('export.stillNote')}</figcaption>
              </>
            ) : (
              <img
                src={st.url}
                alt={t('export.previewAlt')}
                className="w-full rounded-xs bg-frame [image-rendering:pixelated]"
                data-testid="export-preview"
                data-animated="true"
              />
            )}
          </figure>
        )}

        <section className="mt-5 border-t border-border pt-4" aria-labelledby="export-python-title">
          <h3 id="export-python-title" className="text-label-13 font-semibold">
            {t('export.pythonTitle')}
          </h3>
          <p className="mt-1 text-body-14 text-text-2">{t('export.pythonDesc')}</p>
          {pythonReason ? (
            <p className="mt-2 text-label-13 text-text-2" role="note" data-testid="export-python-reason">
              {pythonReason}
            </p>
          ) : (
            <div className="mt-2">
              <Button asChild variant="secondary">
                <a
                  href={`${API_BASE}/sequences/${x.seq.sequenceId}/notebook`}
                  download={`destello-${x.seq.sequenceId}.ipynb`}
                  data-testid="export-python"
                >
                  {t('export.python')}
                </a>
              </Button>
            </div>
          )}
        </section>

        <div className="mt-4 flex justify-end">
          <DialogClose asChild>
            <Button variant="secondary">{t('app.close')}</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
