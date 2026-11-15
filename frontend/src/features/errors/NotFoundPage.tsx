import { Link, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { useTargets } from '../explorer/useView';
import type { Lang } from '../../lib/types';
import { ErrorState } from './ErrorState';
import { truncatePath } from './errorInfo';

export function NotFoundPage() {
  const { t, i18n } = useTranslation('errors');
  const lang: Lang = i18n.language === 'es' ? 'es' : 'en';
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const targets = useTargets().data;

  return (
    <ErrorState
      testId="not-found"
      status={t('notFound.status')}
      title={t('notFound.title')}
      description={t('notFound.body')}
      docTitle={t('notFound.docTitle')}
      actions={
        <Button asChild variant="primary">
          <Link to="/" data-testid="error-home">
            {t('home')}
          </Link>
        </Button>
      }
    >
      <p className="text-label-13 text-muted">
        {t('notFound.requested')}:{' '}
        <code
          className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-text"
          data-testid="not-found-path"
        >
          {truncatePath(pathname)}
        </code>
      </p>
      {targets && targets.length > 0 ? (
        <nav
          aria-label={t('notFound.presets')}
          className="flex flex-col gap-2"
          data-testid="not-found-presets"
        >
          <p className="text-label-13 text-muted">{t('notFound.presets')}</p>
          <ul className="flex flex-wrap gap-2">
            {targets.map((target) => (
              <li key={target.id}>
                <Button asChild variant="secondary" size="sm">
                  <Link to="/t/$target" params={{ target: target.id }}>
                    {target.names[lang]}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </ErrorState>
  );
}
