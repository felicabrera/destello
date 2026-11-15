// Query keys of the measurements of a view. The panels fetch with them; the results sheet (F-30) reads the same
// cache entries without fetching, so it shows only what the view has already loaded.
import type { BackendMode } from '../../lib/api';

export const astrometryKey = (
  sequenceId: string | null,
  selectionKey: string | undefined,
  detector: number | null,
  mode: BackendMode,
) => ['astrometry', sequenceId, selectionKey, detector, mode] as const;

export const spectrumKey = (sequenceId: string | null, selectionKey: string | undefined, mode: BackendMode) =>
  ['spectrum', sequenceId, selectionKey, mode] as const;

export const photometryKey = (url: string | null, mode: BackendMode) => ['photometry', url, mode] as const;
