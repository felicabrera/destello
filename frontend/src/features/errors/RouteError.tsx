import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { UnexpectedError } from './UnexpectedError';

/** Router-level `defaultErrorComponent`: errors thrown while loading or rendering a route. */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <UnexpectedError
      error={error}
      onRetry={() => {
        void router.invalidate();
        reset();
      }}
    />
  );
}
