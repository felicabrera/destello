import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  afterVote,
  classifyVoteError,
  clampContrast,
  nextZoom,
} from './huntModel';

describe('vote errors', () => {
  it('maps the API codes', () => {
    expect(classifyVoteError(new ApiError(403, 'TURNSTILE_FAILED', 'x'))).toEqual({ kind: 'turnstile' });
    expect(classifyVoteError(new ApiError(503, 'TURNSTILE_UNAVAILABLE', 'x'))).toEqual({ kind: 'turnstile' });
    expect(classifyVoteError(new ApiError(403, 'VOTE_TOKEN_EXPIRED', 'x'))).toEqual({ kind: 'gone' });
    expect(classifyVoteError(new ApiError(429, 'RATE_LIMITED', 'x', 12))).toEqual({
      kind: 'rate',
      retryAfter: 12,
    });
    expect(classifyVoteError(new ApiError(429, 'RATE_LIMITED', 'x'))).toEqual({
      kind: 'rate',
      retryAfter: 30,
    });
    expect(classifyVoteError(new ApiError(409, 'ALREADY_VOTED', 'x'))).toEqual({ kind: 'gone' });
    expect(classifyVoteError(new ApiError(404, 'NOT_FOUND', 'x'))).toEqual({ kind: 'gone' });
    expect(classifyVoteError(new ApiError(500, 'UNKNOWN', 'x'))).toEqual({ kind: 'other', code: 'UNKNOWN' });
    expect(classifyVoteError(new Error('boom'))).toEqual({ kind: 'other', code: 'NETWORK' });
  });
});

describe('after a vote', () => {
  it('pauses on the answer of a gold field only', () => {
    expect(afterVote({ accepted: true, gold: { answer: 'mover', correct: true } })).toBe('reveal');
    expect(afterVote({ accepted: true, gold: null })).toBe('next');
  });
});

describe('view helpers', () => {
  it('cycles the zoom and clamps the contrast', () => {
    expect([1, 2, 3, 4].map(nextZoom)).toEqual([2, 3, 4, 1]);
    expect(nextZoom(7)).toBe(1);
    expect(clampContrast(0)).toBe(CONTRAST_MIN);
    expect(clampContrast(99)).toBe(CONTRAST_MAX);
    expect(clampContrast(NaN)).toBe(1);
    expect(clampContrast(1.5)).toBe(1.5);
  });
});
