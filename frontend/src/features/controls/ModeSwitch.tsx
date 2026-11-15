import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { DETECTORS, MODES, type DetectorNum, type Mode, type RgbTriple } from '../../lib/types';

interface Props {
  mode: Mode;
  /** 1-based reference epoch for diff. */
  refEpoch: number;
  nEpochs: number;
  /** F-31: positions (0-based) of the low coverage epochs, labelled in the reference list. */
  lowEpochs?: ReadonlySet<number>;
  /** Epochs still arriving: derived modes wait for the finished sequence. */
  complete: boolean;
  onChange: (m: Mode) => void;
  onRef: (n: number) => void;
  /** F-20: at least three detectors have data. */
  rgbAvailable: boolean;
  /** Detectors mapped to red, green and blue. */
  rgb: RgbTriple;
  onRgb: (t: RgbTriple) => void;
  /** F-23: the target has a known proper motion, so track mode can be offered. */
  trackAvailable?: boolean;
  track?: boolean;
  onTrack?: (on: boolean) => void;
}

const CHANNELS = ['r', 'g', 'b'] as const;

export function ModeSwitch({
  mode,
  refEpoch,
  nEpochs,
  lowEpochs,
  complete,
  onChange,
  onRef,
  rgbAvailable,
  rgb,
  onRgb,
  trackAvailable = false,
  track = false,
  onTrack,
}: Props) {
  const { t } = useTranslation();
  const enough = nEpochs >= 2;

  const disabledReason = (m: Mode): string | null => {
    if (m === 'rgb') return rgbAvailable ? null : t('mode.rgbWhy');
    if (m === 'blink') return null;
    if (!enough) return t('mode.needsTwo');
    if (!complete && m !== 'stack') return t('build.locked');
    return null;
  };

  const isDiff = mode === 'diff' || mode === 'diffseq';

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="mode-switch">
      <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted" id="mode-label">
        {t('mode.label')}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="mode-label"
        className="flex flex-wrap gap-0.5 rounded-lg border border-border bg-bg p-0.5"
      >
        {MODES.map((m) => {
          const reason = disabledReason(m);
          const on = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={reason ? true : undefined}
              title={reason ?? undefined}
              onClick={() => {
                if (!reason) onChange(m);
              }}
              className={cn(
                'min-h-[calc(var(--hit-min)-6px)] rounded-md px-3 text-label-13 font-medium transition-colors duration-(--duration-fast)',
                on ? 'bg-glint-soft text-glint' : 'text-text hover:bg-surface-2',
                reason && 'text-disabled hover:bg-transparent',
              )}
              data-testid={`mode-${m}`}
            >
              {t(`mode.${m}`)}
            </button>
          );
        })}
      </div>
      {trackAvailable && onTrack && (
        <button
          type="button"
          role="switch"
          aria-checked={track && !isDiff}
          aria-disabled={isDiff || undefined}
          title={isDiff ? t('mode.trackDiff') : t('mode.trackHint')}
          onClick={() => {
            if (!isDiff) onTrack(!track);
          }}
          className={cn(
            'flex min-h-[var(--hit-min)] items-center gap-2 rounded-lg border px-2.5 text-label-13 font-medium transition-colors duration-(--duration-fast)',
            track && !isDiff
              ? 'border-glint bg-glint-soft text-text'
              : 'border-border-strong bg-surface-2 text-text hover:bg-border',
            isDiff && 'border-border text-disabled hover:bg-surface-2',
          )}
          data-testid="track-toggle"
        >
          {t('mode.track')}
          <kbd className="tnum rounded-sm border border-border-strong px-1 text-caption-12 text-muted">T</kbd>
        </button>
      )}
      {mode === 'diff' && (
        <label className="flex items-center gap-2 text-label-13 text-muted">
          {t('mode.reference')}
          <select
            value={refEpoch}
            onChange={(e) => onRef(Number(e.target.value))}
            className="min-h-[var(--hit-min)] rounded-lg border border-border-strong bg-surface-2 px-2 text-label-13 text-text"
            data-testid="ref-select"
          >
            {Array.from({ length: nEpochs }, (_, i) => (
              <option key={i} value={i + 1}>
                {lowEpochs?.has(i) ? t('mode.refOptionLow', { n: i + 1 }) : t('mode.refOption', { n: i + 1 })}
              </option>
            ))}
          </select>
        </label>
      )}
      {mode === 'rgb' && (
        <div className="flex flex-wrap items-center gap-2" data-testid="rgb-channels">
          {CHANNELS.map((c, i) => (
            <label key={c} className="flex items-center gap-1.5 text-label-13 text-muted">
              {t(`mode.channel.${c}`)}
              <select
                value={rgb[i]}
                onChange={(e) => {
                  const next: [DetectorNum, DetectorNum, DetectorNum] = [rgb[0], rgb[1], rgb[2]];
                  const d = Number(e.target.value) as DetectorNum;
                  // Channels stay distinct: picking a detector already in use swaps the two channels.
                  const j = next.indexOf(d);
                  if (j !== -1) next[j] = next[i];
                  next[i] = d;
                  onRgb(next);
                }}
                className="min-h-[var(--hit-min)] rounded-lg border border-border-strong bg-surface-2 px-2 text-label-13 text-text"
                data-testid={`rgb-${c}`}
              >
                {DETECTORS.map((d) => (
                  <option key={d} value={d}>
                    D{d}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
