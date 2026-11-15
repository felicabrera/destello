// Shared body for the router error component and the top-level boundary. It has no router dependency:
// plain anchors keep it working when the router itself failed.
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { reportError } from '../../lib/errorReport';
import { ErrorState } from './ErrorState';
import { devMessage, errorReference, isChunkLoadError } from './errorInfo';

export function UnexpectedError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation('errors');
  const chunk = isChunkLoadError(error);
  const reference = useMemo(() => errorReference(), []);

  useEffect(() => {
    reportError('boundary', error);
  }, [error]);

  const dev = devMessage(error);
  const kind = chunk ? 'chunk' : 'unexpected';
  return (
    <ErrorState
      testId={chunk ? 'chunk-error' : 'unexpected-error'}
      status={chunk ? undefined : t('unexpected.status')}
      title={t(`${kind}.title`)}
      description={t(`${kind}.body`)}
      docTitle={t(`${kind}.docTitle`)}
      footnote={
        <>
          {t('reference', { ref: reference })}
          {dev ? <span data-testid="error-dev-message">{` | ${dev}`}</span> : null}
        </>
      }
      actions={
        <>
          {chunk ? (
            <Button variant="primary" onClick={() => window.location.reload()} data-testid="error-reload">
              {t('reload')}
            </Button>
          ) : (
            <Button variant="primary" onClick={onRetry} data-testid="error-retry">
              {t('retry')}
            </Button>
          )}
          <Button asChild variant="secondary">
            <a href="/" data-testid="error-home">
              {t('home')}
            </a>
          </Button>
        </>
      }
    />
  );
}
