// F-31: visible text label of a low coverage epoch (a short revisit). The text carries the meaning, so it is
// readable without color; the border only draws attention to it.
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

export function LowCoverageBadge({
  className,
  testId = 'low-badge',
}: {
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-xs border border-warning px-1 text-caption-12 font-semibold leading-tight',
        className,
      )}
      data-testid={testId}
    >
      {t('coverage.low')}
    </span>
  );
}
