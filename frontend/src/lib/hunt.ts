// F-35 Hunt: types of /api/v1/hunt, the anonymous session token and small pure helpers.
// The token is random (crypto.getRandomValues), lives in localStorage and is sent only in JSON bodies.
// Nothing about the person is stored or shown: no account, no address, no name.
import type { EpochInfo } from './types';

export const HUNT_LABELS = ['mover', 'brightness_change', 'artifact', 'nothing', 'not_sure'] as const;
export type HuntLabel = (typeof HUNT_LABELS)[number];

/** Number key of each label, in the order of HUNT_LABELS. */
export const HUNT_KEYS: Record<HuntLabel, string> = {
  mover: '1',
  brightness_change: '2',
  artifact: '3',
  nothing: '4',
  not_sure: '5',
};

export function labelForKey(key: string): HuntLabel | null {
  return HUNT_LABELS.find((l) => HUNT_KEYS[l] === key) ?? null;
}

export interface HuntField {
  /** Opaque id; carries no meaning and is never shown. */
  field_id: string;
  /** Signed token that authorizes one vote of this session on this field. */
  vote_token: string;
  sequence_id: string;
  epochs: number;
  center_deg: { ra: number; dec: number };
  fov_arcmin: number;
  manifest_url: string;
}

export interface HuntNext {
  field: HuntField | null;
  remaining: number;
  reviewed: number;
}

export interface HuntGold {
  answer: HuntLabel;
  correct: boolean;
}

export interface HuntVoteResult {
  accepted: boolean;
  /** Present only for a gold field, and only in the answer to the vote. */
  gold: HuntGold | null;
}

export interface HuntVoteRequest {
  session: string;
  field_id: string;
  vote_token: string;
  label: HuntLabel;
  mark?: { ra_deg: number; dec_deg: number };
  turnstile_token?: string;
}

export interface HuntCounters {
  fields_reviewed: number;
  classifications: number;
  gold_votes: number;
  /** Fraction in [0, 1], or null while no gold field was answered. */
  gold_accuracy: number | null;
  /** Countries with at least one vote; votes without a known country are not counted. */
  countries: number;
}

export const SESSION_KEY = 'destello.huntSession';
const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;
const BYTES = 18; // 24 characters of base64url

export function isSessionToken(s: unknown): s is string {
  return typeof s === 'string' && SESSION_RE.test(s);
}

/** Random token: 18 bytes from crypto.getRandomValues as base64url (24 characters). */
export function newSessionToken(
  rand: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a),
): string {
  const bytes = rand(new Uint8Array(BYTES));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let memoryToken: string | null = null;

/** The stored token, created on first use. Falls back to memory when storage is refused. Never throws. */
export function getSessionToken(storage?: Pick<Storage, 'getItem' | 'setItem'> | null): string {
  let st: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  try {
    st = storage === undefined ? window.localStorage : storage;
  } catch {
    st = null;
  }
  try {
    const cur = st?.getItem(SESSION_KEY);
    if (isSessionToken(cur)) return cur;
  } catch {
    /* storage blocked: use memory */
  }
  const tok = memoryToken ?? newSessionToken();
  memoryToken = tok;
  try {
    st?.setItem(SESSION_KEY, tok);
  } catch {
    /* kept in memory for this page load */
  }
  return tok;
}

/** True when a frame of the epoch reports pixels flagged STREAK (satellite or other streaks). */
export function epochHasStreak(epoch: EpochInfo | undefined): boolean {
  return !!epoch?.frames.some(
    (f) => f.flagged_fraction > 0 && (f.mask_flags ?? []).some((n) => n.toUpperCase() === 'STREAK'),
  );
}

export function sequenceHasStreak(epochs: readonly EpochInfo[]): boolean {
  return epochs.some(epochHasStreak);
}

/** Percentage text of gold accuracy, or null when there is none yet. */
export function goldAccuracyPercent(c: HuntCounters): number | null {
  return c.gold_accuracy === null || c.gold_votes === 0 ? null : Math.round(c.gold_accuracy * 100);
}

/** One row of GET /hunt/candidates (docs/06 section 3.5.2): a volunteer agreement, not a detection. */
export interface HuntCandidate {
  field_id: string;
  status: string;
  label: HuntLabel;
  share: number;
  n_votes: number;
  sequence_id: string;
  center_deg: { ra: number; dec: number };
  mark: { ra_deg: number; dec_deg: number; rms_arcsec: number | null; n_marks: number } | null;
}
export interface HuntCandidates {
  status: string;
  candidates: HuntCandidate[];
}
