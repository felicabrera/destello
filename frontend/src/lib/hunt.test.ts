import { describe, expect, it } from 'vitest';
import {
  HUNT_KEYS,
  HUNT_LABELS,
  SESSION_KEY,
  epochHasStreak,
  getSessionToken,
  goldAccuracyPercent,
  isSessionToken,
  labelForKey,
  newSessionToken,
  sequenceHasStreak,
} from './hunt';
import type { EpochInfo, FrameInfo } from './types';

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe('session token', () => {
  it('is random, url safe and accepted by the API pattern', () => {
    const a = newSessionToken();
    const b = newSessionToken();
    expect(a).not.toBe(b);
    expect(isSessionToken(a)).toBe(true);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
  it('comes from crypto.getRandomValues', () => {
    let called = 0;
    const tok = newSessionToken((a) => {
      called++;
      a.fill(7);
      return a;
    });
    expect(called).toBe(1);
    expect(isSessionToken(tok)).toBe(true);
  });
  it('is created once and reused from storage', () => {
    const st = memoryStorage();
    const t1 = getSessionToken(st);
    expect(st.m.get(SESSION_KEY)).toBe(t1);
    expect(getSessionToken(st)).toBe(t1);
  });
  it('replaces a malformed stored value and never throws when storage fails', () => {
    const bad = memoryStorage({ [SESSION_KEY]: 'short' });
    expect(isSessionToken(getSessionToken(bad))).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(isSessionToken(getSessionToken(broken))).toBe(true);
    expect(isSessionToken(getSessionToken(null))).toBe(true);
  });
  it('stores nothing but the token', () => {
    const st = memoryStorage();
    getSessionToken(st);
    expect([...st.m.keys()]).toEqual([SESSION_KEY]);
  });
});

describe('labels and keys', () => {
  it('maps keys 1 to 5 to the five labels, in order', () => {
    expect(HUNT_LABELS.map((l) => HUNT_KEYS[l])).toEqual(['1', '2', '3', '4', '5']);
    expect(labelForKey('1')).toBe('mover');
    expect(labelForKey('3')).toBe('artifact');
    expect(labelForKey('5')).toBe('not_sure');
    expect(labelForKey('6')).toBeNull();
    expect(labelForKey('a')).toBeNull();
  });
});

const frame = (over: Partial<FrameInfo>): FrameInfo => ({
  detector: 1,
  kind: 'coadd',
  url: '/f.png',
  n_images: 3,
  flagged_fraction: 0,
  obs_ids: [],
  ...over,
});
const epoch = (frames: FrameInfo[]): EpochInfo => ({ index: 0, n_images: 3, frames }) as unknown as EpochInfo;

describe('streak note', () => {
  it('needs the STREAK flag with flagged pixels', () => {
    expect(epochHasStreak(epoch([frame({ mask_flags: ['STREAK'], flagged_fraction: 0.01 })]))).toBe(true);
    expect(epochHasStreak(epoch([frame({ mask_flags: ['streak'], flagged_fraction: 0.2 })]))).toBe(true);
    expect(epochHasStreak(epoch([frame({ mask_flags: ['STREAK'], flagged_fraction: 0 })]))).toBe(false);
    expect(epochHasStreak(epoch([frame({ mask_flags: ['HOT'], flagged_fraction: 0.2 })]))).toBe(false);
    expect(epochHasStreak(epoch([frame({ flagged_fraction: 0.2 })]))).toBe(false);
    expect(epochHasStreak(undefined)).toBe(false);
  });
  it('is true for a sequence when any epoch has it', () => {
    const a = epoch([frame({})]);
    const b = epoch([frame({ mask_flags: ['STREAK'], flagged_fraction: 0.05 })]);
    expect(sequenceHasStreak([a, b])).toBe(true);
    expect(sequenceHasStreak([a])).toBe(false);
  });
});

describe('gold accuracy', () => {
  const base = { fields_reviewed: 0, classifications: 0, gold_votes: 0, gold_accuracy: null, countries: 0 };
  it('is absent until a check field was answered', () => {
    expect(goldAccuracyPercent(base)).toBeNull();
    expect(goldAccuracyPercent({ ...base, gold_votes: 4, gold_accuracy: 0.75 })).toBe(75);
  });
});
