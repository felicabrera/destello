// F-29: the candidates of the epoch pair on screen, for the panel and for the markers on the frame.
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCandidates } from '../../lib/api';
import type { BackendMode } from '../../lib/api';
import type { EpochInfo, Mode } from '../../lib/types';
import { useUi } from '../../store/ui';
import {
  candidateErrorKey,
  candidateMarkers,
  pairFor,
  pairHasLowEpoch,
  type CandidateMarker,
} from './candidateModel';

interface Args {
  /** The URL toggle. */
  on: boolean;
  mode: Mode;
  epochs: EpochInfo[];
  frameIdx: number;
  refIdx: number;
  /** Diff seq: position of the epoch subtracted on screen (F-31 skips a revisit without this detector). */
  prevPos?: number;
  sequenceId: string | null;
  complete: boolean;
  backendMode: BackendMode;
}

export function useCandidates({
  on,
  mode,
  epochs,
  frameIdx,
  refIdx,
  prevPos,
  sequenceId,
  complete,
  backendMode,
}: Args) {
  const inDiff = mode === 'diff' || mode === 'diffseq';
  const indices = useMemo(() => epochs.map((e) => e.index), [epochs]);
  const pair = useMemo(
    () => pairFor(mode, indices, frameIdx, refIdx, prevPos),
    [mode, indices, frameIdx, refIdx, prevPos],
  );
  // F-31: a pair with a low coverage epoch is never requested; the panel says why.
  const lowPair = useMemo(() => pairHasLowEpoch(pair, epochs), [pair, epochs]);
  const active = on && inDiff;
  const enabled = active && complete && !!sequenceId && pair !== null && !lowPair;
  const query = useQuery({
    queryKey: ['candidates', sequenceId, pair?.a, pair?.b, backendMode],
    queryFn: ({ signal }) => getCandidates(sequenceId as string, pair?.a ?? 0, pair?.b ?? 0, signal),
    enabled,
    staleTime: Infinity,
    retry: false,
  });
  const data = enabled ? (query.data ?? null) : null;

  const selected = useUi((s) => s.candSel);
  const setSelected = useUi((s) => s.setCandSel);
  const open = useUi((s) => s.candOpen);
  const toggleGroup = useUi((s) => s.toggleCandGroup);

  // Ids are per pair (c1, c2, ...): a selection never carries over to another pair or sequence.
  const pairKey = `${sequenceId ?? ''}|${pair?.a ?? ''}|${pair?.b ?? ''}`;
  useEffect(() => {
    setSelected(null);
  }, [pairKey, setSelected]);

  const markers: CandidateMarker[] | null = useMemo(
    () => (data ? candidateMarkers(data.candidates, selected, open) : null),
    [data, selected, open],
  );

  return {
    /** The toggle is on and a difference mode is shown. */
    active,
    pair,
    data,
    loading: enabled && query.isFetching && !data,
    errorKey: enabled && query.isError ? candidateErrorKey(query.error) : null,
    /** The build has not finished, so differences are not available yet. */
    waiting: active && !complete,
    /** F-31: the pair on screen includes a low coverage epoch, so no candidates are computed. */
    lowPair: active && complete && lowPair,
    refetch: () => void query.refetch(),
    markers,
    selected,
    setSelected,
    open,
    toggleGroup,
  };
}

export type CandidatesModel = ReturnType<typeof useCandidates>;
