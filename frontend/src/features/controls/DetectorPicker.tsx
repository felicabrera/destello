import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { DETECTORS, type DetectorNum, type DetectorSel } from '../../lib/types';

interface Props {
  value: DetectorSel;
  ranges: Partial<Record<DetectorNum, [number, number]>>;
  /** false when the detector has no frame in any epoch; undefined while unknown. */
  coverage: Partial<Record<DetectorNum, boolean>>;
  disabled: boolean;
  onChange: (d: DetectorSel) => void;
}

export function DetectorPicker({ value, ranges, coverage, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const opts: DetectorSel[] = [...DETECTORS, 'all'];
  return (
    <div className="flex flex-col gap-1.5" data-testid="detector-picker">
      <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted" id="det-label">
        {t('detector.label')}
      </span>
      <div role="radiogroup" aria-labelledby="det-label" className="grid grid-cols-4 gap-1.5">
        {opts.map((d) => {
          const r = d === 'all' ? undefined : ranges[d];
          const none = d !== 'all' && coverage[d] === false;
          const on = value === d;
          const sub =
            d === 'all'
              ? t('detector.broadband')
              : r
                ? `${r[0].toFixed(2)}-${r[1].toFixed(2)}`
                : t('detector.unknownRange');
          const full =
            d === 'all'
              ? t('detector.allDet')
              : r
                ? t('detector.range', { min: r[0].toFixed(2), max: r[1].toFixed(2) })
                : '';
          return (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={disabled || undefined}
              title={none ? `${full}. ${t('detector.noData')}. ${t('detector.noDataWhy')}` : full}
              onClick={() => {
                if (!disabled) onChange(d);
              }}
              className={cn(
                'flex min-h-[var(--hit-min)] flex-col items-center justify-center rounded-lg border px-1 py-1 text-center transition-colors duration-(--duration-fast)',
                on
                  ? 'border-glint bg-glint-soft text-text'
                  : 'border-border-strong bg-surface-2 text-text hover:bg-border',
                none && 'border-dashed',
                disabled && 'text-disabled hover:bg-surface-2',
              )}
              data-testid={`det-${d}`}
            >
              <span className={cn('tnum text-label-13 font-semibold', on && 'text-glint')}>
                {d === 'all' ? t('detector.all') : `D${d}`}
              </span>
              <span className="whitespace-nowrap text-caption-12 leading-4 text-muted">
                {none ? t('detector.noDataShort') : sub}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
