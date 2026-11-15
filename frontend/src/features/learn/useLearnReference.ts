// F-38: the values the student's result is compared with. All of them come from the API at runtime: the catalog
// motion from GET /targets, Destello's own fit from the astrometry endpoint of the sequence, and the validation
// row V-02 when the fit is not available. A value the API does not give is left out (null).
import { useQuery } from '@tanstack/react-query';
import { ApiError, getManifest, getSequence, getValidation, postAstrometry } from '../../lib/api';
import { isDemo, useBackend } from '../../lib/backend';
import type { Manifest, TargetItem, ValidationReport } from '../../lib/types';
import { useTargets } from '../explorer/useView';
import { catalogMotion, motionFromMas, type MotionValue } from './learnModel';

export const LEARN_TARGET = 'barnard';

export interface DestelloValue extends MotionValue {
  source: 'fit' | 'validation';
  detector: number | null;
  /** Total motion uncertainty in arcsec per year, when the fit gives one. */
  err: number | null;
}

/** The V-02 validation row as a total motion, only when its unit is known and it is not a single component. */
export function validationMotion(report: ValidationReport | null | undefined): DestelloValue | null {
  const t = report?.tests.find((x) => x.id === 'V-02' && x.target === LEARN_TARGET);
  if (!t || t.status !== 'pass' || t.measured == null || !Number.isFinite(t.measured)) return null;
  if (/\b(RA|Dec|AR)\b/i.test(t.name)) return null;
  const scale = t.unit === 'arcsec/yr' ? 1 : t.unit === 'mas/yr' ? 0.001 : null;
  if (scale === null) return null;
  const total = t.measured * scale;
  return {
    pmRa: NaN,
    pmDec: NaN,
    total,
    angleDeg: NaN,
    source: 'validation',
    detector: null,
    err: t.err != null ? t.err * scale : null,
  };
}

export function useLearnReference(sequenceId: string | null | undefined, det: number | null) {
  const tq = useTargets();
  const mode = useBackend((s) => s.mode);
  const gen = useBackend((s) => s.generation);
  const targets: TargetItem[] | undefined = tq.data;
  const target = targets?.find((x) => x.id === LEARN_TARGET);
  const gaia = catalogMotion(targets, LEARN_TARGET);
  const live = !isDemo(mode);

  const fitQ = useQuery({
    queryKey: ['learn', 'astrometry', sequenceId, det, gen, mode],
    queryFn: ({ signal }) =>
      postAstrometry(
        sequenceId as string,
        {
          ra_deg: (target as TargetItem).ra_deg,
          dec_deg: (target as TargetItem).dec_deg,
          detector: det,
          fit_parallax: false,
          reference: 'literature',
        },
        signal,
      ),
    enabled: live && !!sequenceId && !!target,
    staleTime: Infinity,
    retry: false,
  });
  const fit = fitQ.data?.status !== 'not_measurable' ? (fitQ.data?.fit ?? null) : null;
  const fitMotion = fit ? motionFromMas(fit.pmra_masyr, fit.pmdec_masyr) : null;
  const needValidation = fitQ.isSuccess || fitQ.isError ? fitMotion === null : false;
  const valQ = useQuery({
    queryKey: ['validation', gen, mode],
    queryFn: getValidation,
    enabled: needValidation,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  let destello: DestelloValue | null = null;
  if (fitMotion) {
    const err =
      fit && fit.pmra_err_masyr != null && fit.pmdec_err_masyr != null
        ? Math.hypot(fit.pmra_err_masyr, fit.pmdec_err_masyr) / 1000
        : null;
    destello = { ...fitMotion, source: 'fit', detector: fitQ.data?.detector_used ?? det, err };
  } else if (valQ.data) {
    destello = validationMotion(valQ.data);
  }
  const rateLimited = fitQ.error instanceof ApiError && fitQ.error.status === 429;
  const pending = tq.isPending || (live && !!sequenceId && fitQ.isPending && fitQ.fetchStatus !== 'idle');
  return { target, gaia, destello, pending, rateLimited };
}

/** The manifest of a sequence (for the guide, which has no player): status then manifest URL. */
export function useSequenceManifest(sequenceId: string | null | undefined) {
  const mode = useBackend((s) => s.mode);
  const gen = useBackend((s) => s.generation);
  return useQuery<Manifest>({
    queryKey: ['learn', 'manifest', sequenceId, gen, mode],
    queryFn: async () => {
      const st = await getSequence(sequenceId as string);
      if (!st.manifest_url) throw new Error('NO_MANIFEST');
      return getManifest(st.manifest_url);
    },
    enabled: !!sequenceId,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
