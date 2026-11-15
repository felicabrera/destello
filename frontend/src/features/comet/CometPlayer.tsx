// F-33 player: single exposures of one detector ordered by time (one shared stretch, co-moving frames), or the
// object-aligned stack. The reticle of each exposure comes from that frame's own center_deg and ephemeris.
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { resolveAsset } from '../../lib/api';
import { localDate, localNumber, mjdToDate } from '../../lib/format';
import type { FrameInfo, Lang, Manifest } from '../../lib/types';
import { reticleFor, type ExposureFrame } from './cometModel';

const FRAME_MS = 400;

export function utcTime(lang: Lang, mjd: number): string {
  const d = mjdToDate(mjd);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${localDate(lang, d)} ${hh}:${mm}`;
}

interface Props {
  manifest: Manifest;
  lang: Lang;
  mode: 'exposures' | 'stack';
  exposures: ExposureFrame[];
  stack: FrameInfo | undefined;
  index: number;
  onIndex: (i: number) => void;
  playing: boolean;
  onPlaying: (p: boolean) => void;
  reduced: boolean;
}

export function CometPlayer({
  manifest,
  lang,
  mode,
  exposures,
  stack,
  index,
  onIndex,
  playing,
  onPlaying,
  reduced,
}: Props) {
  const { t } = useTranslation('comet');
  const n = exposures.length;
  const cur = exposures[Math.min(index, n - 1)];
  const [w, h] = manifest.grid.naxis;

  useEffect(() => {
    if (!playing || reduced || mode !== 'exposures' || n < 2) return;
    const id = setInterval(() => onIndex((index + 1) % n), FRAME_MS);
    return () => clearInterval(id);
  }, [playing, reduced, mode, n, index, onIndex]);

  const ret = useMemo(() => (cur ? reticleFor(cur, manifest) : null), [cur, manifest]);
  const frame = mode === 'stack' ? stack : cur?.frame;
  const empty = mode === 'stack' ? !stack : n === 0;
  const ap = manifest.moving_target?.aperture_arcsec ?? null;
  const r = ap !== null ? ap / manifest.grid.pixel_scale_arcsec : 8;

  if (empty)
    return (
      <p
        className="rounded-lg border border-border bg-surface p-4 text-body-14 text-text-2"
        data-testid="comet-empty"
      >
        {mode === 'stack' ? t('noStack') : t('noExposures')}
      </p>
    );

  return (
    <div className="flex flex-col gap-3" data-testid="comet-player">
      <div
        role="group"
        aria-label={t('player.aria')}
        className="relative mx-auto aspect-square w-full max-w-[640px] overflow-hidden rounded-xl border border-border bg-bg "
        data-testid="comet-frame-box"
      >
        {frame && (
          <img
            src={resolveAsset(frame.url)}
            alt=""
            className="absolute inset-0 size-full [image-rendering:pixelated]"
            data-testid="comet-frame"
            data-frame-kind={frame.kind}
            data-index={mode === 'exposures' ? index : undefined}
            draggable={false}
          />
        )}
        {mode === 'exposures' && ret && (
          <svg
            viewBox={`0 0 ${w} ${h}`}
            className="pointer-events-none absolute inset-0 size-full text-glint"
            role="img"
            aria-label={t('player.reticle')}
            data-testid="comet-reticle"
            data-ra={ret.ra.toFixed(5)}
            data-dec={ret.dec.toFixed(5)}
          >
            <circle cx={ret.x} cy={ret.y} r={r} fill="none" stroke="currentColor" strokeWidth={0.6} />
          </svg>
        )}
        <div
          className="absolute left-2 top-2 rounded bg-surface px-2 py-1 text-caption-12 text-text"
          data-testid="comet-hud"
        >
          {mode === 'exposures' && cur ? (
            <>
              <div className="tnum">{t('player.frame', { n: index + 1, total: n })}</div>
              <div className="tnum">{utcTime(lang, cur.t_mid_mjd)}</div>
              <div className="tnum">
                {cur.wavelengthUm !== null
                  ? t('player.wavelengthValue', { value: localNumber(lang, cur.wavelengthUm, 3) })
                  : ''}
              </div>
            </>
          ) : (
            <div className="tnum">{frame ? t('player.nImages', { n: frame.n_images }) : ''}</div>
          )}
        </div>
      </div>
      <p className="text-caption-12 text-muted" data-testid="comet-follows">
        {mode === 'stack' ? t('stackNote') : `${t('follows')} ${t('player.stretch')}`}
      </p>
      {mode === 'exposures' && cur && (
        <div className="flex flex-wrap items-center gap-2" data-testid="comet-transport">
          <Button variant="secondary" onClick={() => onIndex(Math.max(index - 1, 0))} disabled={index <= 0}>
            {t('player.prev')}
          </Button>
          <Button
            variant="primary"
            onClick={() => onPlaying(!playing)}
            aria-pressed={playing}
            data-testid="comet-play"
          >
            {playing ? t('player.pause') : t('player.play')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => onIndex(Math.min(index + 1, n - 1))}
            disabled={index >= n - 1}
          >
            {t('player.next')}
          </Button>
          <input
            type="range"
            min={1}
            max={n}
            value={index + 1}
            onChange={(e) => {
              onPlaying(false);
              onIndex(Number(e.target.value) - 1);
            }}
            aria-label={t('player.slider')}
            aria-valuetext={`${t('player.frame', { n: index + 1, total: n })}, ${utcTime(lang, cur.t_mid_mjd)}`}
            className="min-w-[160px] flex-1 accent-[var(--glint)]"
            data-testid="comet-slider"
          />
        </div>
      )}
      {mode === 'exposures' && cur && (
        <p className="break-all text-caption-12 text-muted" data-testid="comet-obs">
          {t('player.obs')}: {cur.obsId}
        </p>
      )}
    </div>
  );
}
