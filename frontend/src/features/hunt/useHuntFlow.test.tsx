// Vote flow and counters of Hunt, with the API calls replaced.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from '@tanstack/react-router';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../i18n';
import { ApiError } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import type { HuntField } from '../../lib/hunt';

const api = vi.hoisted(() => ({
  postHuntNext: vi.fn(),
  postHuntVote: vi.fn(),
  getHuntCounters: vi.fn(),
}));
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<typeof import('../../lib/api')>()), ...api }));

import { HuntCounters } from './HuntCounters';
import { useHuntFlow } from './useHuntFlow';

const field = (id: string): HuntField => ({
  field_id: id,
  vote_token: `token-${id}`,
  sequence_id: '0123456789abcdef',
  epochs: 3,
  center_deg: { ra: 10, dec: 20 },
  fov_arcmin: 6,
  manifest_url: '/manifests/0123456789abcdef.json',
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  useBackend.setState({ probed: true, mode: 'live' });
});

describe('useHuntFlow', () => {
  it('loads a field, sends the session in the body and moves on after a plain vote', async () => {
    api.postHuntNext
      .mockResolvedValueOnce({ field: field('rnd-01'), remaining: 2, reviewed: 0 })
      .mockResolvedValueOnce({ field: field('rnd-02'), remaining: 1, reviewed: 1 });
    api.postHuntVote.mockResolvedValue({ accepted: true, gold: null });
    const { result } = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase.kind).toBe('field'));
    expect(api.postHuntNext).toHaveBeenCalledWith(result.current.session);
    await act(async () => {
      await result.current.vote({ label: 'nothing', mark: { ra_deg: 1, dec_deg: 2 } });
    });
    expect(api.postHuntVote).toHaveBeenCalledWith({
      session: result.current.session,
      field_id: 'rnd-01',
      vote_token: 'token-rnd-01',
      label: 'nothing',
      mark: { ra_deg: 1, dec_deg: 2 },
    });
    await waitFor(() =>
      expect(result.current.phase).toMatchObject({ kind: 'field', field: { field_id: 'rnd-02' } }),
    );
    expect(result.current.reveal).toBeNull();
  });

  it('keeps the gold answer hidden until the vote, then pauses on it', async () => {
    api.postHuntNext.mockResolvedValue({ field: field('gold-01'), remaining: 1, reviewed: 2 });
    api.postHuntVote.mockResolvedValue({ accepted: true, gold: { answer: 'mover', correct: false } });
    const { result } = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase.kind).toBe('field'));
    expect(JSON.stringify(result.current.phase)).not.toContain('mover');
    expect(result.current.reveal).toBeNull();
    await act(async () => {
      await result.current.vote({ label: 'artifact' });
    });
    expect(result.current.reveal).toEqual({ gold: { answer: 'mover', correct: false }, label: 'artifact' });
    expect(api.postHuntNext).toHaveBeenCalledTimes(1);
    // A second vote on the same field is ignored while the answer is shown.
    await act(async () => {
      await result.current.vote({ label: 'mover' });
    });
    expect(api.postHuntVote).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no field exists and nothing was reviewed', async () => {
    api.postHuntNext.mockResolvedValue({ field: null, remaining: 0, reviewed: 0 });
    const { result } = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase.kind).toBe('empty'));
  });

  it('reports done after the last field and an error when the server fails', async () => {
    api.postHuntNext.mockResolvedValueOnce({ field: null, remaining: 0, reviewed: 5 });
    const a = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(a.result.current.phase.kind).toBe('done'));
    api.postHuntNext.mockRejectedValueOnce(new ApiError(503, 'HUNT_UNAVAILABLE', 'down'));
    const b = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(b.result.current.phase).toEqual({ kind: 'error', code: 'HUNT_UNAVAILABLE' }));
  });

  it('keeps the field and asks for verification or a wait on 403 and 429', async () => {
    api.postHuntNext.mockResolvedValue({ field: field('rnd-01'), remaining: 1, reviewed: 0 });
    const { result } = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase.kind).toBe('field'));
    api.postHuntVote.mockRejectedValueOnce(new ApiError(403, 'TURNSTILE_FAILED', 'x'));
    await act(async () => {
      await result.current.vote({ label: 'nothing' });
    });
    expect(result.current.problem).toEqual({ kind: 'turnstile' });
    api.postHuntVote.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'x', 20));
    await act(async () => {
      await result.current.vote({ label: 'nothing', turnstileToken: 'tok' });
    });
    expect(api.postHuntVote).toHaveBeenLastCalledWith(expect.objectContaining({ turnstile_token: 'tok' }));
    expect(result.current.problem).toEqual({ kind: 'rate', retryAfter: 20 });
    expect(result.current.phase).toMatchObject({ kind: 'field', field: { field_id: 'rnd-01' } });
  });

  it('moves on when the session already voted on the field', async () => {
    api.postHuntNext
      .mockResolvedValueOnce({ field: field('rnd-01'), remaining: 2, reviewed: 0 })
      .mockResolvedValueOnce({ field: field('rnd-02'), remaining: 1, reviewed: 1 });
    const { result } = renderHook(() => useHuntFlow(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.phase.kind).toBe('field'));
    api.postHuntVote.mockRejectedValueOnce(new ApiError(409, 'ALREADY_VOTED', 'x'));
    await act(async () => {
      await result.current.vote({ label: 'nothing' });
    });
    await waitFor(() => expect(result.current.phase).toMatchObject({ field: { field_id: 'rnd-02' } }));
  });
});

// The compact block holds a router Link, so it needs a router around it.
function inRouter(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return <RouterProvider router={router} />;
}

describe('HuntCounters', () => {
  it('shows the totals, and a placeholder before any check field was answered', async () => {
    api.getHuntCounters.mockResolvedValue({
      fields_reviewed: 12,
      classifications: 40,
      gold_votes: 0,
      gold_accuracy: null,
      countries: 3,
    });
    render(<HuntCounters lang="en" />, { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('hunt-counters')).toBeTruthy());
    expect(screen.getByTestId('counter-fields').textContent).toContain('12');
    expect(screen.getByTestId('counter-votes').textContent).toContain('40');
    expect(screen.getByTestId('counter-countries').textContent).toContain('3');
    expect(screen.getByTestId('counter-gold').textContent).toContain('none yet');
  });

  it('formats gold accuracy and renders nothing when the API does not answer', async () => {
    api.getHuntCounters.mockResolvedValueOnce({
      fields_reviewed: 1,
      classifications: 4,
      gold_votes: 4,
      gold_accuracy: 0.75,
      countries: 0,
    });
    const a = render(inRouter(<HuntCounters lang="en" compact />), { wrapper: wrapper() });
    await waitFor(() => expect(screen.getByTestId('counter-gold').textContent).toMatch(/75(\.\d)?\s?%/));
    a.unmount();
    api.getHuntCounters.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'x'));
    render(inRouter(<HuntCounters lang="en" compact />), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByTestId('hunt-counters-compact')).toBeNull();
  });
});
