// F-30 results sheet: the content of the sheet, assembled from what the view already holds (manifest, view state,
// measurements already loaded). The same object feeds the print view and the JSON download. Nothing is computed
// from new requests and nothing is filled in: a block whose input is absent is left out, and a value that the
// source did not give stays null. Key names are stable and carry the unit (or sit next to a unit field).
import { epochMid, mjdToDate } from '../../lib/format';
import {
  frameDetector,
  isLowCoverage,
  type ApiWarning,
  type AstrometryResponse,
  type CandidatesResult,
  type DetectorSel,
  type EpochInfo,
  type EpochPhotometry,
  type Lang,
  type Manifest,
  type Mode,
  type MotionSearchResult,
  type PhotometryDoc,
  type RgbTriple,
  type SpectrumResponse,
  type TargetResult,
} from '../../lib/types';
import { KNOWN_UNITS } from '../presets/ResultCard';

export const SHEET_SCHEMA_VERSION = 1;

export interface SheetInput {
  /** Generation time. */
  now: Date;
  language: Lang;
  /** Shareable URL of the view. */
  viewUrl: string;
  targetName: string | null;
  manifest: Manifest;
  /** Epochs of the view, as shown by the player. */
  epochs: EpochInfo[];
  view: {
    mode: Mode;
    detector: DetectorSel;
    /** 0-based position of the epoch on screen. */
    frameIdx: number;
    /** 0-based position of the reference epoch of the difference mode. */
    refIdx: number;
    /**
     * Manifest index of the epoch actually subtracted from the shown one in a difference mode, or null when none
     * has a frame in the detector. Absent: the reference (diff) or the previous epoch (diffseq).
     */
    pairIndex?: number | null;
    rgb: RgbTriple;
  };
  /** Position that Spectrum and Measure work on. */
  selection?: { ra_deg: number; dec_deg: number; kind: 'target' | 'mark' } | null;
  /** Astrometry already loaded for the selection, or the error code of the request that was made. */
  astrometry?: { data: AstrometryResponse | null; errorCode: string | null } | null;
  spectrum?: SpectrumResponse | null;
  /** Photometry file of the sequence (light curve). */
  photometry?: PhotometryDoc | null;
  /** Present when the candidates toggle is on in a difference mode. */
  candidates?: { data: CandidatesResult | null } | null;
  /** F-32: the motion search, only once the user ran it and it answered. */
  motionSearch?: MotionSearchResult | null;
  /** Result published by the server for a preset target. */
  presetResult?: { result: TargetResult | null; notMeasurable: boolean } | null;
  /** Localized lines of the manifest warnings, exactly as the Info panel states them. */
  warningLines: { warnings: string[]; notes: string[] };
  /** Acknowledgement texts of the About page that apply to this view. */
  acknowledgements: { id: string; title: string; text: string }[];
}

export interface SheetEpochRow {
  /** 1-based epoch number, as labeled in the player (E1, E2, ...). */
  epoch: number;
  t_start_utc: string | null;
  t_end_utc: string | null;
  t_mid_mjd: number | null;
  t_mid_utc: string | null;
  n_images: number | null;
  detectors_with_coadds: number[];
  broadband_coadd: boolean;
  /** Low: a short revisit shown in the player and never used in measurements. */
  coverage: 'full' | 'low';
}

export interface SheetStretch {
  detector: DetectorSel;
  method: string;
  vmin: number;
  vmax: number;
  softening: number | null;
  unit: string;
  shared_across_epochs: true;
}

export interface SheetPhotometryRow {
  epoch: number;
  t_mid_mjd: number | null;
  wavelength_min_um: number | null;
  wavelength_max_um: number | null;
  flux: number | null;
  flux_err: number | null;
  n_images: number;
  /** Why the flux is withheld; null when measured or when the source gave no reason. */
  reason: string | null;
}

export interface SheetFluxChange {
  from_epoch: number;
  to_epoch: number;
  flux_change: number;
  percent: number | null;
  sigma: number | null;
}

export interface SheetPhotometry {
  detector: number;
  flux_unit: string;
  rows: SheetPhotometryRow[];
  /** Change between the first and the last measured epoch; null with fewer than two measured epochs. */
  change: SheetFluxChange | null;
}

export interface SheetProperMotion {
  status: 'ok' | 'not_measurable';
  detector_used: number | null;
  epochs_measured: number | null;
  epochs_total: number | null;
  fit: {
    pmra_masyr: number;
    pmra_err_masyr: number;
    pmdec_masyr: number;
    pmdec_err_masyr: number;
    pm_total_masyr: number;
    parallax_mas: number | null;
    parallax_fixed: boolean | null;
    chi2_red: number | null;
  } | null;
  reference: {
    pmra_masyr: number;
    pmra_err_masyr: number | null;
    pmdec_masyr: number;
    pmdec_err_masyr: number | null;
    source: string;
    ref_epoch: string | null;
  } | null;
  agreement_sigma: number | null;
  /** Only when not measurable: the error code of the request, or null when the API answered. */
  reason_code: string | null;
  /** Only when not measurable: epochs without a centroid and the reason the API gave for each. */
  unmeasured_epochs: { epoch: number; reason: string | null }[];
  suggested_detector: number | null;
  recalibration_catalog: string | null;
  warnings: { code: string; detail: string | null }[];
}

export interface SheetSpectrum {
  flux_unit: string;
  aperture_radius_arcsec: number | null;
  n_points: number;
  n_usable: number;
  n_epochs: number;
  wavelength_min_um: number | null;
  wavelength_max_um: number | null;
  photometry: SheetPhotometry | null;
  warnings: { code: string; detail: string | null }[];
}

export interface SheetLightCurve {
  aperture_radius_arcsec: number | null;
  photometry: SheetPhotometry;
}

export interface SheetCandidates {
  status: 'loaded' | 'not_loaded';
  epoch_a: number | null;
  epoch_b: number | null;
  threshold_sigma: number | null;
  method_version: string | null;
  truncated: boolean | null;
  counts: CandidatesResult['counts'] | null;
  catalogs: CandidatesResult['catalogs'] | null;
}

export interface SheetMotionSource {
  id: string;
  status: MotionSearchResult['sources'][number]['status'];
  pmra_masyr: number;
  pmra_err_masyr: number;
  pmdec_masyr: number;
  pmdec_err_masyr: number;
  pm_total_masyr: number;
  ref_epoch_jyear: number;
  ra_deg: number;
  dec_deg: number;
  snr: number;
  detectors: number[];
  match: {
    catalog: string;
    source_id: string;
    sep_arcsec: number;
    pm_total_masyr: number | null;
    agreement_sigma: number | null;
  } | null;
}

/** F-32: sources that move consistently, each a candidate to review. Epoch numbers are 1-based. */
export interface SheetMotionSearch {
  method_version: string;
  epochs: number[];
  baseline_years: number;
  mu_max_arcsec_yr: number;
  threshold_sigma: number;
  min_detectors: number;
  truncated: boolean;
  counts: MotionSearchResult['counts'];
  catalogs: MotionSearchResult['catalogs'];
  sources: SheetMotionSource[];
}

export interface SheetPresetResult {
  status: 'ok' | 'not_measurable';
  kind: TargetResult['kind'] | null;
  value: number | null;
  err: number | null;
  unit: string | null;
  reference_value: number | null;
  reference_source: string | null;
  agreement_sigma: number | null;
  significance_sigma: number | null;
}

export interface SheetModel {
  schema_version: number;
  generated_at_utc: string;
  language: Lang;
  view_url: string;
  target: {
    name: string | null;
    ra_deg: number;
    dec_deg: number;
    fov_arcmin: number;
  };
  data: {
    collections: string[];
    dois: string[];
    services: string[];
    data_as_of: string | null;
    pipeline_version: string;
    sequence_id: string;
    manifest_created_at_utc: string;
    build_status: 'partial' | 'complete';
    epochs: SheetEpochRow[];
  };
  frames: {
    mode: Mode;
    detector: DetectorSel;
    /** Detectors of the color composite (red, green, blue); null outside the color mode. */
    rgb_detectors: number[] | null;
    epoch_shown: number | null;
    /** Reference epoch of the difference; null outside the difference modes. */
    reference_epoch: number | null;
    wavelength_min_um: number | null;
    wavelength_max_um: number | null;
    /** Empty in the difference modes (the difference is not drawn with the stretch of the coadds). */
    stretch: SheetStretch[];
  };
  measurements: {
    position?: { ra_deg: number; dec_deg: number; kind: 'target' | 'mark' };
    proper_motion?: SheetProperMotion;
    spectrum?: SheetSpectrum;
    light_curve?: SheetLightCurve;
    candidates?: SheetCandidates;
    motion_search?: SheetMotionSearch;
    preset_result?: SheetPresetResult;
  };
  warnings: {
    items: { code: string; detail: string }[];
    warning_lines: string[];
    note_lines: string[];
  };
  traceability: {
    obs_ids: { epoch: number; detector: DetectorSel; n_images: number; obs_ids: string[] }[];
    acknowledgements: { id: string; title: string; text: string }[];
  };
}

const epochNumber = (index: number) => index + 1;
const orNull = <T>(v: T | null | undefined): T | null => v ?? null;

function warningsOf(list: ApiWarning[] | undefined): { code: string; detail: string | null }[] {
  return (list ?? []).map((w) => ({ code: w.code, detail: orNull(w.detail) }));
}

/** Detector of a photometry table: the shown one when it has rows, else the one with most measured epochs. */
function photometryDetector(rows: EpochPhotometry[], shown: DetectorSel): number | null {
  const dets = [...new Set(rows.map((r) => r.detector))].sort((a, b) => a - b);
  if (typeof shown === 'number' && dets.includes(shown)) return shown;
  let best: number | null = null;
  let bestN = -1;
  for (const d of dets) {
    const n = rows.filter((r) => r.detector === d && r.flux != null).length;
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

/** Per-epoch photometry of one detector and the change between its first and last measured epochs. */
export function sheetPhotometry(
  rows: EpochPhotometry[],
  unit: string,
  shown: DetectorSel,
  epochs: EpochInfo[],
): SheetPhotometry | null {
  const detector = photometryDetector(rows, shown);
  if (detector === null) return null;
  const list = rows.filter((r) => r.detector === detector).sort((a, b) => a.epoch - b.epoch);
  const measured = list.filter(
    (p): p is EpochPhotometry & { flux: number } => p.flux != null && Number.isFinite(p.flux),
  );
  let change: SheetFluxChange | null = null;
  if (measured.length >= 2) {
    const a = measured[0];
    const b = measured[measured.length - 1];
    const diff = b.flux - a.flux;
    // The uncertainty of the change needs both errors; without them no significance is stated.
    const err = a.flux_err != null && b.flux_err != null ? Math.hypot(a.flux_err, b.flux_err) : 0;
    change = {
      from_epoch: epochNumber(a.epoch),
      to_epoch: epochNumber(b.epoch),
      flux_change: diff,
      percent: a.flux !== 0 ? (diff / Math.abs(a.flux)) * 100 : null,
      sigma: err > 0 ? diff / err : null,
    };
  }
  return {
    detector,
    flux_unit: unit,
    rows: list.map((p) => {
      const ep = epochs.find((e) => e.index === p.epoch);
      return {
        epoch: epochNumber(p.epoch),
        t_mid_mjd: orNull(ep ? epochMid(ep) : undefined),
        wavelength_min_um: orNull(p.wavelength_um?.[0]),
        wavelength_max_um: orNull(p.wavelength_um?.[1]),
        flux: orNull(p.flux),
        flux_err: orNull(p.flux_err),
        n_images: p.n_images,
        reason: orNull(p.reason),
      };
    }),
    change,
  };
}

function properMotion(a: NonNullable<SheetInput['astrometry']>): SheetProperMotion | null {
  const r = a.data;
  if (!r) {
    // A request that failed for another cause (network, rate limit) says nothing about the source.
    if (a.errorCode !== 'TOO_FEW_EPOCHS' && a.errorCode !== 'POSITION_OUTSIDE_FIELD') return null;
    return {
      status: 'not_measurable',
      detector_used: null,
      epochs_measured: null,
      epochs_total: null,
      fit: null,
      reference: null,
      agreement_sigma: null,
      reason_code: a.errorCode,
      unmeasured_epochs: [],
      suggested_detector: null,
      recalibration_catalog: null,
      warnings: [],
    };
  }
  const fit = r.fit;
  const measurable = fit != null && r.status !== 'not_measurable';
  const ref = r.reference ?? null;
  return {
    status: measurable ? 'ok' : 'not_measurable',
    detector_used: r.detector_used,
    epochs_measured: r.epochs_measured ?? r.epochs.filter((e) => e.measured).length,
    epochs_total: r.epochs_total ?? r.epochs.length,
    fit:
      measurable && fit
        ? {
            pmra_masyr: fit.pmra_masyr,
            pmra_err_masyr: fit.pmra_err_masyr,
            pmdec_masyr: fit.pmdec_masyr,
            pmdec_err_masyr: fit.pmdec_err_masyr,
            pm_total_masyr: fit.pm_total_masyr ?? Math.hypot(fit.pmra_masyr, fit.pmdec_masyr),
            parallax_mas: orNull(fit.parallax_mas),
            parallax_fixed: orNull(fit.parallax_fixed),
            chi2_red: orNull(fit.chi2_red),
          }
        : null,
    reference: ref
      ? {
          pmra_masyr: ref.pmra_masyr,
          pmra_err_masyr: orNull(ref.pmra_err_masyr),
          pmdec_masyr: ref.pmdec_masyr,
          pmdec_err_masyr: orNull(ref.pmdec_err_masyr),
          source: ref.source,
          ref_epoch: orNull(ref.ref_epoch),
        }
      : null,
    agreement_sigma: measurable ? orNull(r.agreement_sigma) : null,
    reason_code: null,
    unmeasured_epochs: measurable
      ? []
      : r.epochs
          .filter((e) => !e.measured)
          .map((e) => ({ epoch: epochNumber(e.index), reason: orNull(e.reason) })),
    suggested_detector: measurable ? null : orNull(r.suggested_detector),
    recalibration_catalog: orNull(r.recalibration_catalog),
    warnings: warningsOf(r.warnings),
  };
}

function spectrum(d: SpectrumResponse, shown: DetectorSel, epochs: EpochInfo[]): SheetSpectrum {
  const usable = d.points.filter(
    (p) => !p.flagged && p.flux != null && Number.isFinite(p.flux) && p.wavelength_um != null,
  );
  const waves = usable.map((p) => p.wavelength_um as number);
  return {
    flux_unit: d.unit,
    aperture_radius_arcsec: orNull(d.aperture_arcsec),
    n_points: d.points.length,
    n_usable: usable.length,
    n_epochs: new Set(d.points.map((p) => p.epoch)).size,
    wavelength_min_um: waves.length ? Math.min(...waves) : null,
    wavelength_max_um: waves.length ? Math.max(...waves) : null,
    photometry: sheetPhotometry(d.epoch_photometry, d.unit, shown, epochs),
    warnings: warningsOf(d.warnings),
  };
}

function candidates(c: NonNullable<SheetInput['candidates']>): SheetCandidates {
  const d = c.data;
  if (!d)
    return {
      status: 'not_loaded',
      epoch_a: null,
      epoch_b: null,
      threshold_sigma: null,
      method_version: null,
      truncated: null,
      counts: null,
      catalogs: null,
    };
  return {
    status: 'loaded',
    epoch_a: epochNumber(d.epoch_a),
    epoch_b: epochNumber(d.epoch_b),
    threshold_sigma: d.threshold_sigma,
    method_version: d.method_version,
    truncated: d.truncated,
    counts: { ...d.counts },
    catalogs: { ...d.catalogs },
  };
}

function motionSearch(d: MotionSearchResult): SheetMotionSearch {
  return {
    method_version: d.method_version,
    epochs: d.epochs.map(epochNumber),
    baseline_years: d.baseline_years,
    mu_max_arcsec_yr: d.mu_max_arcsec_yr,
    threshold_sigma: d.threshold_sigma,
    min_detectors: d.min_detectors,
    truncated: d.truncated,
    counts: { ...d.counts },
    catalogs: { ...d.catalogs },
    sources: d.sources.map((s) => ({
      id: s.id,
      status: s.status,
      pmra_masyr: s.pmra_masyr,
      pmra_err_masyr: s.pmra_err_masyr,
      pmdec_masyr: s.pmdec_masyr,
      pmdec_err_masyr: s.pmdec_err_masyr,
      pm_total_masyr: s.pm_total_masyr,
      ref_epoch_jyear: s.ref_epoch_jyear,
      ra_deg: s.ra_deg,
      dec_deg: s.dec_deg,
      snr: s.snr,
      detectors: [...s.detectors],
      match: s.match
        ? {
            catalog: s.match.catalog,
            source_id: s.match.source_id,
            sep_arcsec: s.match.sep_arcsec,
            pm_total_masyr: orNull(s.match.pm_total_masyr),
            agreement_sigma: orNull(s.match.agreement_sigma),
          }
        : null,
    })),
  };
}

function presetResult(p: NonNullable<SheetInput['presetResult']>): SheetPresetResult | null {
  const r = p.result && KNOWN_UNITS.has(p.result.unit) ? p.result : null;
  if (!r && !p.notMeasurable) return null;
  return {
    status: r ? 'ok' : 'not_measurable',
    kind: r?.kind ?? null,
    value: r?.value ?? null,
    err: orNull(r?.err),
    unit: r?.unit ?? null,
    reference_value: orNull(r?.reference_value),
    reference_source: orNull(r?.reference_source),
    agreement_sigma: orNull(r?.agreement_sigma),
    significance_sigma: orNull(r?.significance_sigma),
  };
}

function stretchOf(manifest: Manifest, det: DetectorSel): SheetStretch | null {
  // Exact key only, as the player does: a detector never borrows the limits of another one.
  const s =
    manifest.stretch[det === 'all' ? '0' : String(det)] ??
    (det === 'all' ? manifest.stretch['all'] : undefined);
  if (!s) return null;
  return {
    detector: det,
    method: s.method,
    vmin: s.vmin,
    vmax: s.vmax,
    softening: orNull(s.softening),
    unit: s.unit,
    shared_across_epochs: true,
  };
}

export function buildSheet(i: SheetInput): SheetModel {
  const m = i.manifest;
  const { mode, detector, rgb } = i.view;
  const inDiff = mode === 'diff' || mode === 'diffseq';
  // The stack shows the mean of all epochs, so no single epoch is on screen.
  const shown = mode === 'stack' ? undefined : i.epochs[i.view.frameIdx];
  const pairIndex = i.view.pairIndex;
  const refEpoch =
    inDiff && pairIndex !== undefined
      ? pairIndex === null
        ? undefined
        : i.epochs.find((e) => e.index === pairIndex)
      : mode === 'diff'
        ? i.epochs[i.view.refIdx]
        : mode === 'diffseq'
          ? i.epochs[i.view.frameIdx - 1]
          : undefined;
  const shownDets: DetectorSel[] = mode === 'rgb' ? [...rgb] : [detector];
  const frame =
    mode === 'rgb' ? undefined : (shown ?? i.epochs[0])?.frames.find((f) => frameDetector(f) === detector);

  const measurements: SheetModel['measurements'] = {};
  const pm = i.astrometry ? properMotion(i.astrometry) : null;
  if (pm) measurements.proper_motion = pm;
  if (i.spectrum) measurements.spectrum = spectrum(i.spectrum, detector, i.epochs);
  if (i.photometry) {
    const phot = sheetPhotometry(i.photometry.epoch_photometry, i.photometry.unit, detector, i.epochs);
    if (phot)
      measurements.light_curve = {
        aperture_radius_arcsec: orNull(i.photometry.aperture_radius_arcsec),
        photometry: phot,
      };
  }
  if (i.candidates) measurements.candidates = candidates(i.candidates);
  if (i.motionSearch) measurements.motion_search = motionSearch(i.motionSearch);
  const preset = i.presetResult ? presetResult(i.presetResult) : null;
  if (preset) measurements.preset_result = preset;
  // The measured position is stated only next to a measurement made at it.
  if (i.selection && (measurements.proper_motion || measurements.spectrum))
    measurements.position = {
      ra_deg: i.selection.ra_deg,
      dec_deg: i.selection.dec_deg,
      kind: i.selection.kind,
    };

  return {
    schema_version: SHEET_SCHEMA_VERSION,
    generated_at_utc: i.now.toISOString(),
    language: i.language,
    view_url: i.viewUrl,
    target: {
      name: i.targetName,
      ra_deg: m.request.ra_deg,
      dec_deg: m.request.dec_deg,
      fov_arcmin: m.request.fov_arcmin,
    },
    data: {
      collections: [...m.provenance.collections],
      dois: [...m.provenance.dois],
      services: [...m.provenance.services],
      data_as_of: orNull(m.data_as_of),
      pipeline_version: m.pipeline_version,
      sequence_id: m.sequence_id,
      manifest_created_at_utc: m.created_at,
      build_status: m.build?.status === 'partial' ? 'partial' : 'complete',
      epochs: i.epochs.map((e) => {
        const mid = epochMid(e);
        const dets = e.frames.map(frameDetector);
        return {
          epoch: epochNumber(e.index),
          t_start_utc: orNull(e.t_start),
          t_end_utc: orNull(e.t_end),
          t_mid_mjd: orNull(mid),
          t_mid_utc: mid !== undefined ? mjdToDate(mid).toISOString() : null,
          n_images: orNull(e.n_images),
          detectors_with_coadds: dets
            .filter((d): d is Exclude<DetectorSel, 'all'> => d !== 'all')
            .sort((a, b) => a - b),
          broadband_coadd: dets.includes('all'),
          coverage: isLowCoverage(e) ? 'low' : 'full',
        };
      }),
    },
    frames: {
      mode,
      detector: mode === 'rgb' ? 'all' : detector,
      rgb_detectors: mode === 'rgb' ? [...rgb] : null,
      epoch_shown: shown ? epochNumber(shown.index) : null,
      reference_epoch: refEpoch ? epochNumber(refEpoch.index) : null,
      wavelength_min_um: orNull(frame?.wavelength_um?.[0]),
      wavelength_max_um: orNull(frame?.wavelength_um?.[1]),
      stretch: inDiff
        ? []
        : shownDets.map((d) => stretchOf(m, d)).filter((s): s is SheetStretch => s !== null),
    },
    measurements,
    warnings: {
      items: m.warnings.map((w) => ({ code: w.code, detail: w.detail })),
      warning_lines: [...i.warningLines.warnings],
      note_lines: [...i.warningLines.notes],
    },
    traceability: {
      obs_ids: i.epochs.flatMap((e) =>
        e.frames.map((f) => ({
          epoch: epochNumber(e.index),
          detector: frameDetector(f),
          n_images: f.n_images,
          obs_ids: [...f.obs_ids],
        })),
      ),
      acknowledgements: i.acknowledgements.map((a) => ({ ...a })),
    },
  };
}

/** The sheet as a JSON document (two-space indent, trailing newline). */
export function sheetJson(model: SheetModel): string {
  return JSON.stringify(model, null, 2) + '\n';
}

/** File name of the JSON download: the target name when there is one, else the sequence id. */
export function sheetFileName(model: Pick<SheetModel, 'target' | 'data'>): string {
  const slug = (model.target.name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `destello-results-${slug || model.data.sequence_id}.json`;
}
