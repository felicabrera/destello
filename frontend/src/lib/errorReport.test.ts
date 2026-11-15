import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBackendMode } from './api';
import { buildPayload, MAX_REPORTS, reportError, resetErrorReports, stripQueries } from './errorReport';

describe('error reporting', () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));

  beforeEach(() => {
    resetErrorReports();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DEV', false);
    setBackendMode('live');
    window.history.replaceState(null, '', '/explore?ra=269.4&dec=4.7#frame');
  });

  afterEach(() => {
    fetchMock.mockClear();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    setBackendMode('unknown');
  });

  it('removes query strings and fragments but keeps line and column', () => {
    expect(stripQueries('at f (https://h/a.js?v=2:10:5)')).toBe('at f (https://h/a.js:10:5)');
    expect(stripQueries('/explore?ra=1#x')).toBe('/explore');
  });

  it('builds a payload without the address query', () => {
    const p = buildPayload('error', new TypeError('bad ?q=secret'));
    expect(p.route).toBe('/explore');
    expect(p.message).toBe('TypeError: bad ');
    expect(p.kind).toBe('error');
  });

  it('sends each distinct error once and at most MAX_REPORTS per page', () => {
    expect(reportError('error', new Error('a'))).toBe(true);
    expect(reportError('error', new Error('a'))).toBe(false);
    for (let i = 0; i < MAX_REPORTS + 3; i += 1) reportError('error', new Error(`e${i}`));
    expect(fetchMock).toHaveBeenCalledTimes(MAX_REPORTS);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/client-errors$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: 'error', route: '/explore' });
  });

  it('sends nothing in demo mode', () => {
    setBackendMode('demo');
    expect(reportError('unhandledrejection', 'x')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
