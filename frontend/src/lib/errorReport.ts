// Browser error reporting (NFR-OBS-01, docs/09 section 8). Uncaught errors, unhandled promise
// rejections and errors caught by React error boundaries are sent to POST /client-errors on our
// own API, which writes them to the structured log. Nothing goes to a third party. Query strings
// and fragments are removed here as well as on the server, at most MAX_REPORTS distinct errors are
// sent per page load, and nothing is sent in demo or fixture mode or during development.

import { API_BASE, getBackendMode } from './api';

export type ErrorKind = 'error' | 'unhandledrejection' | 'boundary';

export interface ClientErrorPayload {
  kind: ErrorKind;
  message: string;
  stack: string;
  route: string;
  release: string;
}

export const MAX_REPORTS = 5;
export const RELEASE: string = (import.meta.env.VITE_RELEASE as string | undefined) || 'dev';

const sent = new Set<string>();

/** Remove query strings and fragments (search terms, positions) from every URL in `text`. */
export function stripQueries(text: string): string {
  return text.replace(/[?#][^\s:)'"]*/g, '');
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack ?? '' };
  }
  if (typeof error === 'string') return { message: error, stack: '' };
  try {
    return { message: JSON.stringify(error) ?? String(error), stack: '' };
  } catch {
    return { message: String(error), stack: '' };
  }
}

export function buildPayload(kind: ErrorKind, error: unknown, extraStack = ''): ClientErrorPayload {
  const { message, stack } = describe(error);
  return {
    kind,
    message: stripQueries(message).slice(0, 500),
    stack: stripQueries([stack, extraStack].filter(Boolean).join('\n')).slice(0, 4000),
    route: stripQueries(window.location.pathname).slice(0, 300),
    release: RELEASE.slice(0, 64),
  };
}

/** Whether reports may be sent now (live API, production build). */
export function reportingEnabled(): boolean {
  return !import.meta.env.DEV && getBackendMode() === 'live';
}

/** Send one report, deduplicated by kind and message, never throwing. Returns whether it was sent. */
export function reportError(kind: ErrorKind, error: unknown, extraStack = ''): boolean {
  if (!reportingEnabled() || sent.size >= MAX_REPORTS) return false;
  const payload = buildPayload(kind, error, extraStack);
  const key = `${payload.kind}|${payload.message}`;
  if (sent.has(key)) return false;
  sent.add(key);
  try {
    void fetch(`${API_BASE}/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    return false;
  }
  return true;
}

/** Listen for uncaught errors and unhandled rejections. Call once at startup. */
export function installErrorReporting(): void {
  window.addEventListener('error', (event) => {
    reportError('error', event.error ?? event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportError('unhandledrejection', event.reason);
  });
}

/** React root option handlers (React 19), for errors that error boundaries catch or miss. */
export const reactRootErrorOptions = {
  onCaughtError(error: unknown, info: { componentStack?: string }): void {
    console.error(error);
    reportError('boundary', error, info.componentStack ?? '');
  },
  onUncaughtError(error: unknown, info: { componentStack?: string }): void {
    console.error(error);
    reportError('boundary', error, info.componentStack ?? '');
  },
};

/** Test helper: forget what was sent. */
export function resetErrorReports(): void {
  sent.clear();
}
