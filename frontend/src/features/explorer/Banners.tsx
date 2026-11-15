import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { Health } from '../../lib/types';

export function DemoBanner({ onDismiss }: { onDismiss: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-warning bg-surface px-3.5 py-2"
      data-testid="demo-banner"
    >
      <Badge tone="warning">{t('states.demoBadge')}</Badge>
      <span className="min-w-0 flex-1 text-body-14">{t('states.demoBanner')}</span>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t('notice.dismiss')}
      </Button>
    </div>
  );
}

/** Shown when the server is rebuilding this view because IRSA published newer images. */
export function RefreshBanner() {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-border-strong bg-surface px-3.5 py-2"
      data-testid="refresh-banner"
    >
      <Badge tone="neutral">{t('states.refreshBadge')}</Badge>
      <span className="min-w-0 flex-1 text-body-14">{t('states.refreshBanner')}</span>
    </div>
  );
}

export function IrsaBanner({ health, onDismiss }: { health: Health; onDismiss: () => void }) {
  const { t } = useTranslation();
  const down = health.irsa === 'down';
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-warning bg-surface px-3.5 py-2"
      data-testid="irsa-banner"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--warning)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4M12 17h.01" />
      </svg>
      <span className="min-w-0 flex-1 text-body-14">
        <span className="font-semibold">{down ? t('states.irsaDownTitle') : t('states.irsaTitle')}</span>{' '}
        {down ? t('states.irsaDownBody') : t('states.irsaBody')}
      </span>
      <Badge tone="warning">{t('states.irsaBadge')}</Badge>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        {t('notice.dismiss')}
      </Button>
    </div>
  );
}

export function PropagationNotice({
  date,
  epoch,
  onDismiss,
}: {
  date: string;
  epoch: string | null;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-cyan/40 bg-cyan/10 px-3.5 py-2"
      data-testid="propagation-notice"
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--cyan)"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <span className="min-w-0 flex-1 text-body-14">
        <span className="font-semibold">{t('notice.propTitle')}</span> {t('notice.propDate', { date })}{' '}
        {epoch ? t('notice.propSource', { epoch }) : ''}
      </span>
      <Button variant="secondary" size="sm" onClick={onDismiss}>
        {t('notice.dismiss')}
      </Button>
    </div>
  );
}
