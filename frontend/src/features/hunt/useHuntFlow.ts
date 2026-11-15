// F-35 Hunt: loading fields and sending votes for one anonymous session.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, postHuntNext, postHuntVote } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import {
  getSessionToken,
  type HuntField,
  type HuntGold,
  type HuntLabel,
  type HuntVoteRequest,
} from '../../lib/hunt';
import { afterVote, classifyVoteError, type VoteProblem } from './huntModel';

export type HuntPhase =
  | { kind: 'loading' }
  | { kind: 'field'; field: HuntField }
  | { kind: 'empty' }
  | { kind: 'done' }
  | { kind: 'error'; code: string };

export interface VoteInput {
  label: HuntLabel;
  mark?: { ra_deg: number; dec_deg: number };
  turnstileToken?: string | null;
}

export function useHuntFlow() {
  const [session] = useState(() => getSessionToken());
  const probed = useBackend((s) => s.probed);
  const gen = useBackend((s) => s.generation);
  const qc = useQueryClient();
  const [phase, setPhase] = useState<HuntPhase>({ kind: 'loading' });
  const [reviewed, setReviewed] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<VoteProblem | null>(null);
  /** The answer to the last vote on a gold field; shown until the volunteer continues. */
  const [reveal, setReveal] = useState<{ gold: HuntGold; label: HuntLabel } | null>(null);
  const [recorded, setRecorded] = useState(0);
  const alive = useRef(true);
  const sending = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    setReveal(null);
    setProblem(null);
    try {
      const r = await postHuntNext(session);
      if (!alive.current) return;
      setReviewed(r.reviewed);
      setRemaining(r.remaining);
      if (r.field) setPhase({ kind: 'field', field: r.field });
      else setPhase(r.reviewed > 0 ? { kind: 'done' } : { kind: 'empty' });
    } catch (e) {
      if (!alive.current) return;
      setPhase({ kind: 'error', code: e instanceof ApiError ? e.code : 'NETWORK' });
    }
  }, [session]);

  // The backend mode (live, fixtures, demo) is known after the first probe; fields are requested after it.
  useEffect(() => {
    if (probed) void load();
  }, [load, probed, gen]);

  const vote = useCallback(
    async (input: VoteInput) => {
      if (phase.kind !== 'field' || sending.current || reveal) return;
      sending.current = true;
      setBusy(true);
      setProblem(null);
      const req: HuntVoteRequest = {
        session,
        field_id: phase.field.field_id,
        vote_token: phase.field.vote_token,
        label: input.label,
        ...(input.mark ? { mark: input.mark } : {}),
        ...(input.turnstileToken ? { turnstile_token: input.turnstileToken } : {}),
      };
      try {
        const res = await postHuntVote(req);
        if (!alive.current) return;
        setRecorded((n) => n + 1);
        void qc.invalidateQueries({ queryKey: ['hunt', 'counters'] });
        if (afterVote(res) === 'reveal' && res.gold) setReveal({ gold: res.gold, label: input.label });
        else await load();
      } catch (e) {
        if (!alive.current) return;
        const p = classifyVoteError(e);
        if (p.kind === 'gone') await load();
        else setProblem(p);
      } finally {
        sending.current = false;
        if (alive.current) setBusy(false);
      }
    },
    [phase, reveal, session, load, qc],
  );

  return { session, phase, reviewed, remaining, busy, problem, reveal, recorded, vote, next: load };
}
