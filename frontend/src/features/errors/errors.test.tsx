// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import i18n from '../../i18n';
import { AppErrorBoundary } from './AppErrorBoundary';
import { ErrorState } from './ErrorState';
import { isChunkLoadError, truncatePath } from './errorInfo';

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

describe('ErrorState', () => {
  it('renders one h1, the status and the actions, and focuses the heading', () => {
    render(
      <ErrorState status="404" title="Missing" description="Nothing here." actions={<a href="/">Home</a>} />,
    );
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(document.activeElement).toBe(h1[0]);
    expect(screen.getByTestId('error-status').textContent).toBe('404');
    expect(screen.getByRole('link', { name: 'Home' })).toBeTruthy();
  });
});

describe('AppErrorBoundary', () => {
  it('shows the fallback on a render error and Try again recovers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let crash = true;
    function Bomb() {
      const [n] = useState(0);
      if (crash) throw new Error('secret internal detail');
      return <p>child ok {n}</p>;
    }
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('unexpected-error')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Something went wrong');
    crash = false;
    fireEvent.click(screen.getByTestId('error-retry'));
    expect(screen.getByText(/child ok/)).toBeTruthy();
  });

  it('offers a reload for failed chunks', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    function Bomb(): never {
      throw new TypeError('Failed to fetch dynamically imported module: /assets/x.js');
    }
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('chunk-error')).toBeTruthy();
    expect(screen.getByTestId('error-reload')).toBeTruthy();
  });
});

describe('errorInfo', () => {
  it('detects chunk errors and truncates paths', () => {
    expect(isChunkLoadError(new Error('Loading chunk 4 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(truncatePath('a'.repeat(300)).length).toBeLessThan(130);
  });
});
