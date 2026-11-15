// F-35 Hunt: the pure rules of the vote flow (what happens after an answer from the API), kept apart from React.
import { ApiError } from '../../lib/api';
import type { HuntVoteResult } from '../../lib/hunt';

export type VoteProblem =
  | { kind: 'turnstile' }
  | { kind: 'rate'; retryAfter: number }
  | { kind: 'gone' }
  | { kind: 'other'; code: string };

/** Classifies a failed vote. A repeated vote and an unknown field both mean "move on to another field". */
export function classifyVoteError(e: unknown): VoteProblem {
  if (e instanceof ApiError) {
    if (e.code === 'TURNSTILE_FAILED' || e.code === 'TURNSTILE_UNAVAILABLE') return { kind: 'turnstile' };
    if (e.status === 429 || e.code === 'RATE_LIMITED')
      return { kind: 'rate', retryAfter: e.retryAfter ?? 30 };
    if (e.status === 409 || e.status === 404 || e.code.startsWith('VOTE_TOKEN_')) return { kind: 'gone' };
    return { kind: 'other', code: e.code };
  }
  return { kind: 'other', code: 'NETWORK' };
}

/** After an accepted vote: a gold field pauses on its answer; any other field goes straight to the next one. */
export function afterVote(res: HuntVoteResult): 'reveal' | 'next' {
  return res.gold ? 'reveal' : 'next';
}

/** Zoom steps of the Z key, in order; the cycle wraps. */
export const ZOOMS = [1, 2, 3, 4] as const;
export function nextZoom(z: number): number {
  const i = ZOOMS.indexOf(z as (typeof ZOOMS)[number]);
  return ZOOMS[(i + 1) % ZOOMS.length];
}

export const CONTRAST_MIN = 0.5;
export const CONTRAST_MAX = 3;
export function clampContrast(c: number): number {
  return Math.max(CONTRAST_MIN, Math.min(CONTRAST_MAX, Number.isFinite(c) ? c : 1));
}
