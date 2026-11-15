import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';
import { useBackend } from '../../lib/backend';
import { SECONDARY } from './Header';

export function Footer() {
  const { t } = useTranslation();
  const mode = useBackend((s) => s.mode);
  const health = useBackend((s) => s.health);
  return (
    <footer className="border-t border-border" data-testid="footer">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-1 px-4 py-4 pb-20 text-caption-12 text-muted md:flex-row md:items-center md:justify-between md:px-6 md:pb-4 xl:px-8">
        <div className="flex max-w-[820px] flex-col gap-1">
          <nav aria-label={t('app.more')} className="flex flex-wrap gap-x-4" data-testid="footer-nav">
            {SECONDARY.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className="flex min-h-[var(--hit-min)] items-center text-muted underline-offset-4 hover:text-text hover:underline"
              >
                {t(n.key)}
              </Link>
            ))}
          </nav>
          <p>{t('app.footer')}</p>
        </div>
        <p className="tnum" data-testid="api-status">
          {t('app.apiStatus')}:{' '}
          {mode === 'live' && health
            ? `${t('app.apiOk')} · ${t('app.version')} ${health.version}`
            : t('app.apiDown')}
        </p>
      </div>
    </footer>
  );
}
