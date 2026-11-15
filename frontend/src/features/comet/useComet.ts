import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  getManifest,
  getMoverEphemerisCheck,
  getMoverNeossat,
  getMovers,
  getMoverSpectrum,
  getValidation,
} from '../../lib/api';
import { useBackend } from '../../lib/backend';

/** Built moving-target sequences; the preset opens the newest campaign. */
export function useMovers() {
  const gen = useBackend((s) => s.generation);
  const probed = useBackend((s) => s.probed);
  return useQuery({
    queryKey: ['movers', gen],
    queryFn: getMovers,
    enabled: probed,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useMoverManifest(seq: string | undefined) {
  const gen = useBackend((s) => s.generation);
  return useQuery({
    queryKey: ['mover-manifest', seq, gen],
    queryFn: () => getManifest(`/manifests/${seq}.json`),
    enabled: !!seq,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useMoverSpectrum(seq: string | undefined) {
  const gen = useBackend((s) => s.generation);
  return useQuery({
    queryKey: ['mover-spectrum', seq, gen],
    queryFn: () => getMoverSpectrum(seq as string),
    enabled: !!seq,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useMoverCheck(seq: string | undefined) {
  const gen = useBackend((s) => s.generation);
  return useQuery({
    queryKey: ['mover-check', seq, gen],
    queryFn: () => getMoverEphemerisCheck(seq as string),
    enabled: !!seq,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** NEOSSat matches; a 404 means none were stored for this sequence, an expected state. */
export function useMoverNeossat(seq: string | undefined) {
  const gen = useBackend((s) => s.generation);
  return useQuery({
    queryKey: ['mover-neossat', seq, gen],
    queryFn: async () => {
      try {
        return await getMoverNeossat(seq as string);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: !!seq,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useValidationReport() {
  const gen = useBackend((s) => s.generation);
  return useQuery({
    queryKey: ['validation', gen],
    queryFn: getValidation,
    staleTime: 5 * 60_000,
    retry: 0,
  });
}
