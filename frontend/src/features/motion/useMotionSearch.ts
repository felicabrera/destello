// F-32: the motion search of the sequence on screen, for the panel and for the tracks on the frame.
// It runs only when the user asks for it: the search is costly on the server and counts against the rate limit.
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getMotionSearch } from '../../lib/api';
import type { BackendMode } from '../../lib/api';
import { useUi } from '../../store/ui';
import { motionErrorKey, motionTracks, type MotionTrack } from './motionModel';

interface Args {
  sequenceId: string | null;
  complete: boolean;
  backendMode: BackendMode;
  /** 0-based manifest index of the epoch on screen, or null when no single epoch is shown (Stack, RGB). */
  epochIndex: number | null;
  /** Tracks are drawn on sky frames only, never on difference images. */
  showTracks: boolean;
}

export function useMotionSearch({ sequenceId, complete, backendMode, epochIndex, showTracks }: Args) {
  const runFor = useUi((s) => s.motionRun);
  const setRunFor = useUi((s) => s.setMotionRun);
  const selected = useUi((s) => s.motionSel);
  const setSelected = useUi((s) => s.setMotionSel);

  const requested = !!sequenceId && runFor === sequenceId;
  const enabled = requested && complete;
  const query = useQuery({
    queryKey: ['motion-search', sequenceId, backendMode],
    queryFn: ({ signal }) => getMotionSearch(sequenceId as string, signal),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const data = enabled ? (query.data ?? null) : null;

  // Source ids (m1, m2, ...) are per sequence: a selection never carries over to another sequence.
  useEffect(() => {
    setSelected(null);
  }, [sequenceId, setSelected]);

  const tracks: MotionTrack[] | null = useMemo(
    () =>
      data && showTracks && data.sources.length ? motionTracks(data.sources, selected, epochIndex) : null,
    [data, showTracks, selected, epochIndex],
  );

  return {
    /** The user started the search for this sequence. */
    requested,
    data,
    loading: enabled && query.isFetching && !data,
    errorKey: enabled && query.isError ? motionErrorKey(query.error) : null,
    /** The build has not finished: the search needs every epoch coadd. */
    waiting: requested && !complete,
    run: () => {
      if (!sequenceId) return;
      if (requested && query.isError) void query.refetch();
      else setRunFor(sequenceId);
    },
    refetch: () => void query.refetch(),
    tracks,
    selected,
    setSelected,
  };
}

export type MotionSearchModel = ReturnType<typeof useMotionSearch>;
