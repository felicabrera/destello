// Types for the API contract in docs/06. Fields beyond docs/06 are marked ASSUMED.

export const DETECTORS = [1, 2, 3, 4, 5, 6] as const;
export type DetectorNum = (typeof DETECTORS)[number];
export type DetectorSel = 'all' | DetectorNum;
/** Detectors of the color composite, in the order red, green, blue. */
export type RgbTriple = readonly [DetectorNum, DetectorNum, DetectorNum];
/** F-20 default: D1, D3 and D6, the longest wavelength in red. */
export const DEFAULT_RGB: RgbTriple = [6, 3, 1];

export const FOVS = [2, 4, 6, 10, 15, 20, 30] as const;
export type Fov = (typeof FOVS)[number];
export const FPS_VALUES = [0.5, 1, 2, 4] as const;
export type Fps = (typeof FPS_VALUES)[number];
export const MODES = ['blink', 'diff', 'diffseq', 'stack', 'rgb'] as const;
export type Mode = (typeof MODES)[number];
/** `path` is the F-27 predicted path and parallax ellipse of the target. */
export const OVERLAYS = ['gaia', 'catwise', 'flags', 'path'] as const;
export type OverlayKey = (typeof OVERLAYS)[number];
/** Status of an overlay layer: a source count for catalogs, 'ready' for the flag mask. */
export type OverlayCount = number | 'ready' | 'loading' | 'failed' | 'unavailable' | 'none';
export const TABS = ['info', 'spectrum', 'measure', 'context'] as const;
export type TabKey = (typeof TABS)[number];
export type Lang = 'en' | 'es';

export interface Health {
  status: string;
  version: string;
  pipeline_version: string;
  irsa: 'ok' | 'degraded' | 'down';
}

export interface ReleaseInfo {
  collection: string;
  label: string;
  doi: string;
  data_as_of: string;
}
export interface Releases {
  default: string;
  releases: ReleaseInfo[];
}

/** Item of GET /targets. Shape ASSUMED from docs/06 3.2 and docs/08 targets.yaml. */
export interface TargetItem {
  id: string;
  names: { en: string; es: string };
  /** Sequence centre in ICRS degrees (propagated to the mean data epoch when known). */
  ra_deg: number;
  dec_deg: number;
  astrometry?: {
    source?: string;
    ref_epoch?: string | null;
    ra_deg?: number | null;
    dec_deg?: number | null;
    pmra_masyr?: number | null;
    pmdec_masyr?: number | null;
    parallax_mas?: number | null;
  };
  default_view?: {
    fov_arcmin?: number;
    detectors?: number[];
    det?: string | number;
    mode?: string;
    panel?: string;
  };
  notes?: { en?: string; es?: string };
  sequence_id?: string | null;
  /** ASSUMED: server-computed result shown on the result card. Absent means nothing is shown. */
  result?: TargetResult | null;
  /** Every measurement was attempted and none was possible (for example saturation). */
  not_measurable?: boolean;
}

export interface TargetResult {
  kind: 'motion' | 'variability';
  value: number;
  err?: number | null;
  unit: string;
  reference_value?: number | null;
  reference_source?: string | null;
  agreement_sigma?: number | null;
  significance_sigma?: number | null;
}

export interface Resolved {
  query: string;
  main_id: string;
  ra_deg: number;
  dec_deg: number;
  ref_epoch: string | null;
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  parallax_mas: number | null;
  propagated?: { epoch: string; ra_deg: number; dec_deg: number } | null;
}

export interface SequenceRequest {
  ra_deg: number;
  dec_deg: number;
  fov_arcmin: number;
  detectors: number[];
  release?: string | null;
  track?: null;
  /** Detector on screen, built first. Only changes the build order (docs/06 section 3.3). */
  priority_detector?: number | null;
  /** F-31: also build short revisits as low coverage epochs. Part of the sequence id. */
  include_partial?: boolean;
}

export interface Estimate {
  images: number;
  megabytes: number;
  seconds: number;
}

export interface FrameInfo {
  /** 1 to 6; 0, null or "all" means the broadband coadd (ASSUMED encoding). */
  detector: number | string | null;
  /** F-33 adds "exposure" (one image, co-moving grid) and "stack" (object-aligned stack of a detector and campaign). */
  kind: string;
  url: string;
  fits_url?: string | null;
  /** PNG on the frame grid whose alpha channel marks the pixels counted in flagged_fraction (docs/06 s.3.4). */
  flags_url?: string | null;
  /** Masking flag names read from the FLAGS headers of the frame's inputs; absent in older manifests. */
  mask_flags?: string[] | null;
  wavelength_um?: [number, number] | null;
  /** ASSUMED (F-38): mission that produced the frame, for epochs of other missions added to a preset later. Absent means SPHEREx. */
  mission?: string | null;
  n_images: number;
  flagged_fraction: number;
  obs_ids: string[];
  t_start?: string;
  t_end?: string;
  t_mid_mjd?: number;
  /** F-33: sky position of the frame center (the Horizons position of the target at the frame time), degrees. */
  center_deg?: [number, number] | null;
  /** F-33: wavelength at the target pixel, micrometers. */
  target_wavelength_um?: number | null;
  campaign?: number | null;
  ephemeris?: FrameEphemeris | null;
}

export interface FrameEphemeris {
  ra_deg: number;
  dec_deg: number;
  geocentric_ra_deg?: number | null;
  geocentric_dec_deg?: number | null;
  parallax_shift_arcsec?: number | null;
  delta_au?: number | null;
  ra_3sigma_arcsec?: number | null;
  dec_3sigma_arcsec?: number | null;
  solution?: string | null;
}

export interface MoverCampaign {
  index: number;
  t_start: string;
  t_end: string;
  t_mid_mjd: number;
  n_images: number;
  parallax_bound_arcsec: number | null;
}

/** F-33 manifest block of a moving-target sequence. */
export interface MovingTargetInfo {
  designation: string;
  name: string;
  horizons_record: number;
  solution: string;
  ephemeris_service?: string;
  discovery_path?: string;
  aperture_arcsec: number;
  annulus_arcsec: [number, number];
  campaigns: MoverCampaign[];
  stacks: FrameInfo[];
  spectrum_url?: string | null;
  ephemeris_check_url?: string | null;
}

export interface MoverPoint {
  obs_id: string;
  detector: number;
  t_mid_mjd: number;
  wavelength_um: number;
  bandwidth_um?: number | null;
  /** Jy. */
  flux: number | null;
  flux_err: number | null;
  flagged: boolean;
  reason?: string | null;
  campaign: number | null;
}

export interface MoverBand {
  band: string;
  windows_um: { band: [number, number]; blue: [number, number]; red: [number, number] };
  n_points: { band: number; blue: number; red: number };
  windows?: Record<'band' | 'blue' | 'red', { n_points: number; mean_jy: number | null; snr: number | null }>;
  excess: number | null;
  excess_err: number | null;
  significance: number | null;
  /** Band and interpolated continuum fluxes; the ratio (excess) exists only with a detected continuum. */
  band_flux_jy?: number | null;
  continuum_flux_jy?: number | null;
  continuum_detected?: boolean | null;
  continuum_upper_limit_jy?: number | null;
  significance_vs_upper_limit?: number | null;
  reason: string | null;
}

export interface MoverSpectrum {
  sequence_id: string;
  designation: string;
  solution: string;
  aperture_arcsec: number;
  annulus_arcsec: [number, number];
  unit: string;
  points: MoverPoint[];
  bands: Record<string, { co2?: MoverBand; h2o?: MoverBand }>;
}

export interface MoverCampaignCheck {
  status: string;
  n_exposures: number;
  n_measured: number;
  n_within: number;
  fraction_within: number | null;
  median_offset_arcsec: number | null;
  max_offset_arcsec: number | null;
}

export interface MoverEphemerisCheck {
  sequence_id: string;
  solution: string;
  campaigns: Record<string, MoverCampaignCheck>;
}

export interface MoverListing {
  designation: string;
  name: string;
  kind: Record<string, string>;
  horizons_record: number;
  sequences: {
    sequence_id: string;
    solution: string;
    campaigns: MoverCampaign[];
    spectrum_url?: string | null;
    ephemeris_check_url?: string | null;
  }[];
}

export interface EpochInfo {
  index: number;
  t_start?: string;
  t_end?: string;
  t_mid_mjd?: number;
  n_images?: number;
  /** F-31: "low" marks a short revisit, shown but never used in measurements. Absent means full. */
  coverage?: 'full' | 'low';
  frames: FrameInfo[];
}

export interface StretchInfo {
  method: string;
  vmin: number;
  vmax: number;
  /** asinh softening (backend ManifestStretch). Needed to invert the 8-bit frame to a physical value. */
  softening?: number;
  unit: string;
}

export interface Manifest {
  schema_version: number;
  sequence_id: string;
  pipeline_version: string;
  created_at: string;
  request: {
    ra_deg: number;
    dec_deg: number;
    fov_arcmin: number;
    detectors: number[];
    release?: string;
  };
  grid: {
    projection: string;
    crval_deg: [number, number];
    pixel_scale_arcsec: number;
    naxis: [number, number];
  };
  epochs: EpochInfo[];
  stretch: Record<string, StretchInfo>;
  photometry_url?: string | null;
  provenance: { collections: string[]; dois: string[]; services: string[] };
  warnings: { code: string; detail: string }[];
  /** F-33: present on moving-target sequences. */
  moving_target?: MovingTargetInfo | null;
  /** ASSUMED: manifest-level data date, used for "data as of". */
  data_as_of?: string;
  /** Build state: a partial manifest lists only the detectors published so far. */
  build?: BuildInfo;
}

export interface BuildInfo {
  status: 'partial' | 'complete';
  priority_detector: number | null;
  detectors_ready: number[];
  detectors_pending: number[];
}

export interface SequenceStatus {
  sequence_id: string;
  status: string;
  manifest_url?: string;
  /** Present while a build runs and at least one detector is viewable. */
  detectors_ready?: number[];
  partial_manifest_url?: string;
}

export interface DifferenceResult {
  /** ASSUMED: a ready-to-draw diverging RGBA image (negative to zero to positive). */
  url: string;
  scale: number;
  n_stars_used: number;
}

export interface OverlaySource {
  id: string;
  x: number;
  y: number;
  mag?: number | null;
  pmra_masyr?: number | null;
  pmdec_masyr?: number | null;
}
export interface OverlayData {
  catalog: string;
  epochs: { index: number; sources: OverlaySource[] }[];
}

/** F-27: GET /sequences/{id}/path. Pixel coordinates are frame EDGE coordinates, like the overlays. */
export interface PathPoint {
  t_mjd: number;
  x: number;
  y: number;
  ra_deg: number;
  dec_deg: number;
}
export interface PathData {
  sequence_id: string;
  ref_epoch: string;
  pmra_masyr: number;
  pmdec_masyr: number;
  parallax_mas: number;
  observer: 'geocentric';
  t_start_mjd: number;
  t_end_mjd: number;
  pixel_scale_arcsec: number;
  path: PathPoint[];
  epochs: (PathPoint & { index: number })[];
  ellipse: {
    center_t_mjd: number;
    center_x: number;
    center_y: number;
    semi_major_arcsec: number;
    semi_minor_arcsec: number;
    points: [number, number][];
  } | null;
}

/** F-29: GET /sequences/{id}/candidates. Places where two epochs differ (D = A - scaled B), to be reviewed. */
export type CandidateKind = 'moved' | 'brighter_in_a' | 'brighter_in_b';
export const CANDIDATE_STATUSES = [
  'unmatched',
  'unchecked',
  'target',
  'known_source',
  'not_measurable',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];
export type CandidateCatalog = 'gaia_dr3' | 'catwise2020';
/** Pixel coordinates are frame EDGE coordinates, like the overlays. */
export interface CandidatePosition {
  ra_deg: number;
  dec_deg: number;
  x: number;
  y: number;
}
export interface CandidateMatch {
  catalog: string;
  source_id: string;
  sep_arcsec: number;
  mag: number | null;
  mag_band: string | null;
  pm_total_masyr: number | null;
}
export interface Candidate extends CandidatePosition {
  id: string;
  kind: CandidateKind;
  status: CandidateStatus;
  snr: number;
  snr_local: number | null;
  detectors: number[];
  snr_by_detector: number[];
  /** Only for `moved`: the position in epoch A and in epoch B. */
  a: CandidatePosition | null;
  b: CandidatePosition | null;
  separation_arcsec: number | null;
  match: CandidateMatch | null;
}
export interface CandidatesResult {
  sequence_id: string;
  epoch_a: number;
  epoch_b: number;
  threshold_sigma: number;
  pair_max_arcsec: number;
  match_radius_arcsec: number;
  min_detectors_unpaired: number;
  target_radius_arcsec: number;
  target_wing_radius_arcsec: number;
  method_version: string;
  detectors: {
    detector: number;
    usable: boolean;
    n_features: number;
    n_extended: number;
    residual_fraction: number | null;
    registration_applied: boolean;
    n_stars_used: number;
  }[];
  catalogs: Record<CandidateCatalog, 'ok' | 'unavailable'>;
  counts: {
    listed: number;
    single_detector_dropped: number;
    extended_dropped: number;
    unmatched: number;
    unchecked: number;
    target: number;
    known_source: number;
    not_measurable: number;
  };
  truncated: boolean;
  candidates: Candidate[];
}

/**
 * F-32: GET /sequences/{id}/motion-search. Sources whose motion is consistent across the full coverage epochs
 * in two or more detectors, to be reviewed. Pixel coordinates are frame EDGE coordinates, like the overlays.
 */
export const MOTION_STATUSES = ['unmatched', 'unchecked', 'target', 'known_source'] as const;
export type MotionStatus = (typeof MOTION_STATUSES)[number];
export interface MotionTrackPoint {
  /** 0-based manifest epoch index. */
  epoch: number;
  ra_deg: number;
  dec_deg: number;
  x: number;
  y: number;
}
export interface MotionMatch {
  catalog: string;
  source_id: string;
  sep_arcsec: number;
  mag: number | null;
  mag_band: string | null;
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  pm_total_masyr: number | null;
  /** Difference between the measured and the catalog motion, in combined standard deviations. */
  agreement_sigma: number | null;
  parallax_mas?: number | null;
  parallax_err_mas?: number | null;
  /** Difference between the fitted and the catalog parallax, in combined standard deviations. */
  parallax_agreement_sigma?: number | null;
}
export interface MotionSource {
  id: string;
  status: MotionStatus;
  snr: number;
  detectors: number[];
  snr_by_detector: number[];
  /** mu_alpha* = mu_alpha cos(dec). */
  pmra_masyr: number;
  pmdec_masyr: number;
  pmra_err_masyr: number;
  pmdec_err_masyr: number;
  pm_total_masyr: number;
  /** Fitted with the motion only when the epochs allow it (4 or more over at least a year). */
  parallax_mas?: number | null;
  parallax_err_mas?: number | null;
  parallax_sigma?: number | null;
  /** Given only when the parallax is significant (min_parallax_sigma). */
  distance_pc?: number | null;
  distance_err_pc?: number | null;
  ref_epoch_jyear: number;
  ra_deg: number;
  dec_deg: number;
  x: number;
  y: number;
  track: MotionTrackPoint[];
  match: MotionMatch | null;
}
export interface MotionSearchResult {
  sequence_id: string;
  method_version: string;
  /** 0-based manifest epoch indices searched (full coverage epochs only). */
  epochs: number[];
  baseline_years: number;
  ref_epoch_jyear: number;
  mu_max_arcsec_yr: number;
  step_arcsec_yr: number | null;
  threshold_sigma: number;
  epoch_min_sigma: number;
  min_motion_sigma: number;
  min_detectors: number;
  parallax_fitted?: boolean;
  min_parallax_sigma?: number | null;
  match_radius_arcsec: number;
  target_radius_arcsec: number;
  detectors: {
    detector: number;
    usable: boolean;
    n_epochs: number;
    n_trials: number;
    step_arcsec_yr: number | null;
    n_peaks: number;
    n_fitted: number;
    n_moving: number;
    residual_fraction: number | null;
  }[];
  catalogs: Partial<Record<CandidateCatalog, 'ok' | 'unavailable'>>;
  counts: {
    listed: number;
    single_detector_dropped: number;
    unmatched: number;
    unchecked: number;
    target: number;
    known_source: number;
  };
  truncated: boolean;
  sources: MotionSource[];
}

export type SeqEvent =
  | { type: 'status'; data: { status: 'queued' | 'running' | 'ready' | 'failed'; position?: number } }
  | { type: 'progress'; data: { stage: string; done: number; total: number } }
  | {
      type: 'epoch_ready';
      data: { epoch: number; frames: FrameInfo[] } & Partial<Omit<EpochInfo, 'index' | 'frames'>>;
    }
  | {
      type: 'detector_ready';
      data: {
        detector: number;
        manifest_url: string;
        detectors_ready: number[];
        detectors_pending?: number[];
        stretch?: StretchInfo;
        frames?: (FrameInfo & { epoch: number })[];
      };
    }
  | { type: 'completed'; data: { manifest_url: string } }
  | { type: 'failed'; data: { code: string; retry_after_s?: number } };

export type CreateSequenceResult =
  | { kind: 'ready'; sequence_id: string; manifest_url: string; refreshing: boolean }
  | { kind: 'queued'; sequence_id: string; events_url: string; estimate?: Estimate };

/** F-31: a short revisit shown as a low coverage epoch. Measurements and candidates never use it. */
export function isLowCoverage(epoch: Pick<EpochInfo, 'coverage'> | null | undefined): boolean {
  return epoch?.coverage === 'low';
}

export function frameDetector(f: FrameInfo): DetectorSel {
  const d = f.detector;
  if (typeof d === 'number' && d >= 1 && d <= 6) return d as DetectorNum;
  if (typeof d === 'string') {
    const n = Number(d.replace(/^d/i, ''));
    if (n >= 1 && n <= 6) return n as DetectorNum;
  }
  return 'all';
}

// ---- Derived products (docs/06 section 3.5). Shapes follow backend/src/destello/api/science.py. ----

export interface ApiWarning {
  code: string;
  detail?: string;
}

export interface SpectrumPoint {
  epoch: number;
  obs_id: string;
  detector: number;
  t_mid_mjd?: number | null;
  /** Null only when the point has no usable wavelength. */
  wavelength_um: number | null;
  bandwidth_um?: number | null;
  /** Null when the aperture is saturated or flagged: the backend withholds the flux. */
  flux: number | null;
  flux_err?: number | null;
  flagged: boolean;
  saturated?: boolean;
  flagged_fraction?: number | null;
}
export interface EpochPhotometry {
  epoch: number;
  detector: number;
  /** Null when no exposure of this epoch and detector is usable. */
  flux: number | null;
  flux_err?: number | null;
  n_images: number;
  n_total?: number;
  saturated?: boolean;
  wavelength_um?: [number, number] | null;
  /** Why the flux is withheld (docs/03 section 4.6), e.g. "saturated_core"; null when measured. */
  reason?: string | null;
}
/** The sequence photometry sidecar (<id>.photometry.json) written by the build (F-26). */
export interface PhotometryDoc {
  unit: string;
  sequence_id: string;
  aperture_radius_arcsec?: number | null;
  note?: string;
  epoch_photometry: EpochPhotometry[];
}
export interface SpectrumResponse {
  unit: string;
  sequence_id?: string;
  aperture_arcsec?: number | null;
  annulus_arcsec?: [number, number] | null;
  points: SpectrumPoint[];
  epoch_photometry: EpochPhotometry[];
  /** Methane 3.3 um band index (docs/03 section 4.8); absent in older cached responses. */
  methane_index?: MethaneIndex | null;
  warnings?: ApiWarning[];
}
export interface MethaneIndex {
  version: string;
  windows_um: { blue: [number, number]; band: [number, number]; red: [number, number] };
  /** Null when no survey pass has all three windows measured. */
  index: number | null;
  index_err: number | null;
  /** (1 - index) / index_err: depth below a featureless continuum, in standard errors. */
  depth_sigma: number | null;
  epochs: { epoch: number; index: number; index_err: number }[];
}

export interface AstrometryRequest {
  ra_deg: number;
  dec_deg: number;
  detector: number | null;
  fit_parallax: boolean;
  reference: 'literature' | 'gaia' | 'none';
  /** Sent only for a position that is not a preset target; presets are matched by the server. */
  pmra_masyr?: number | null;
  pmdec_masyr?: number | null;
  ref_epoch?: string | null;
}
export interface AstrometryEpoch {
  index: number;
  t_mid_mjd: number;
  n_images?: number;
  saturated_fraction?: number | null;
  measured: boolean;
  /** Present when measured is false. */
  reason?: string;
  ra_deg?: number;
  dec_deg?: number;
  err_arcsec?: number;
  snr?: number;
  fwhm_arcsec?: number;
  blend_shift_arcsec?: number;
  recalibration_stars?: number;
}
export interface AstrometryResponse {
  sequence_id?: string;
  target_id?: string | null;
  /** "not_measurable" is an outcome (HTTP 200): fit is null and suggested_detector may be set. */
  status?: 'ok' | 'not_measurable';
  detector_used: number;
  detector_stats?: Record<
    string,
    { n_epochs: number; n_measured: number; min_snr: number; saturated_fraction: number | null }
  >;
  /** Least saturated other detector with at least two measured epochs; only when not measurable. */
  suggested_detector?: number | null;
  epochs_measured?: number;
  epochs_total?: number;
  recalibration_catalog?: string;
  epochs: AstrometryEpoch[];
  fit: {
    pmra_masyr: number;
    pmdec_masyr: number;
    pmra_err_masyr: number;
    pmdec_err_masyr: number;
    pm_total_masyr?: number;
    pm_total_err_masyr?: number;
    parallax_mas?: number | null;
    parallax_fixed?: boolean;
    chi2_red?: number | null;
    dof?: number;
    n_epochs?: number;
    residuals?: { index: number; t_mid_mjd?: number; dra_arcsec: number; ddec_arcsec: number }[];
  } | null;
  reference?: {
    pmra_masyr: number;
    pmdec_masyr: number;
    pmra_err_masyr?: number | null;
    pmdec_err_masyr?: number | null;
    source: string;
    ref_epoch?: string;
    verified?: boolean;
  } | null;
  agreement_sigma?: number | null;
  warnings?: ApiWarning[];
}

/** GET /api/v1/validation (served from data/validation.json). */
export interface ValidationTest {
  id: string;
  name: string;
  target: string;
  status: 'pass' | 'fail' | 'not_measurable';
  measured?: number | null;
  err?: number | null;
  reference?: number | null;
  source?: string | null;
  sigma?: number | null;
  /** Human readable acceptance criterion (text, from the backend). */
  tolerance?: string | null;
  reason?: string | null;
  /** Machine-readable fields used to localize the criterion and the note. Absent in older reports. */
  tolerance_code?: string | null;
  tolerance_value?: number | null;
  tolerance_unit?: string | null;
  tolerance_params?: Record<string, unknown> | null;
  reason_code?: string | null;
  reason_params?: Record<string, unknown> | null;
  epochs_used?: number | null;
  detector?: number | string | null;
  unit?: string | null;
}
export interface ValidationReport {
  generated_at: string;
  pipeline_version: string;
  release?: string | null;
  tests: ValidationTest[];
  residuals?: {
    target: string;
    epochs: { index: number; t_mid_mjd: number; dra_arcsec: number; ddec_arcsec: number }[];
  }[];
}

// ------------------------------------------------------------------ F-22 candidate reports (docs/06 section 3.6)
export type ReportCatalog = 'gaia_dr3' | 'catwise2020' | 'simbad' | 'sbident';
export type CheckStatus = 'match' | 'partial' | 'no_match' | 'unavailable';
export type ReportVerdict = 'match' | 'partial' | 'incomplete' | 'no_match';

export interface ReportMarkIn {
  /** Manifest epoch index (EpochInfo.index). */
  epoch: number;
  ra_deg: number;
  dec_deg: number;
}
export interface ReportMark extends ReportMarkIn {
  index: number;
  t_mid_mjd: number;
  t_mid: string;
  frame?: {
    detector?: number | string | null;
    url?: string;
    t_start?: string;
    t_end?: string;
    wavelength_um?: [number, number] | null;
    obs_ids?: string[];
  };
}
export interface CatalogHit {
  source_id: string;
  mag: number | null;
  mag_band: string | null;
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  parallax_mas: number | null;
  marks: { mark: number; sep_arcsec: number }[];
  min_sep_arcsec: number;
}
export interface SmallBodyHit {
  mark: number;
  name: string;
  sep_arcsec: number | null;
  vmag: number | null;
}
export interface CheckSummary {
  status: CheckStatus;
  reason?: string;
  radius_arcsec?: number;
  half_width_arcsec?: number;
  searched?: number;
  n_matches?: number;
  complete?: boolean;
  observer?: string;
  nearest:
    | { source_id: string; sep_arcsec: number; mark: number; mag: number | null; mag_band: string | null }
    | SmallBodyHit
    | null;
}
export interface ReportMotion {
  n_marks: number;
  pmra_cosdec_arcsec_yr: number;
  pmdec_arcsec_yr: number;
  total_arcsec_yr: number;
  sigma_arcsec_yr: number;
  significance: number | null;
  position_angle_deg: number;
  baseline_days: number;
  rms_residual_arcsec: number | null;
  mark_sigma_arcsec?: number;
  parallax_fitted?: boolean;
}
export interface ReportChecks {
  version: number;
  gaia_dr3: CatalogHit[];
  catwise2020: CatalogHit[];
  simbad: CatalogHit[];
  sbident: SmallBodyHit[];
  estimated_motion_arcsec_yr: number;
  motion: ReportMotion;
  summary: Record<ReportCatalog, CheckSummary>;
  verdict: ReportVerdict;
}
export interface ReportCheckRequest {
  sequence_id: string;
  marks: ReportMarkIn[];
  detector?: DetectorSel | null;
}
export interface ReportCheckResult {
  sequence_id: string;
  marks: ReportMark[];
  checks: ReportChecks;
}
export interface ReportRequest extends ReportCheckRequest {
  notes: string;
  contact?: string | null;
  turnstile_token?: string | null;
}
export interface ReportCreated {
  report_id: string;
  url: string;
  checks: ReportChecks;
}
export interface ReportNextStep {
  id: string;
  name: string;
  url: string;
  text: string;
}
export interface ReportDocument {
  schema_version: number;
  report_id: string;
  url: string;
  created_at: string;
  status: 'unconfirmed';
  sequence: {
    sequence_id: string;
    manifest_url: string;
    pipeline_version: string | null;
    manifest_created_at: string | null;
    center_deg: [number, number] | null;
    fov_arcmin: number | null;
    target_id: string | null;
    n_epochs: number;
    collections: string[];
    dois: string[];
  };
  detector: DetectorSel | null;
  marks: ReportMark[];
  checks: ReportChecks;
  notes: string;
  disclaimer: string;
  next_steps: ReportNextStep[];
}

/** F-33 NEOSSat optical view: one entry per SPHEREx exposure with the nearest NEOSSat frame, when any exists. */
export interface NeossatFrame {
  observation_id: string;
  t_mid_mjd: number;
  /** Signed hours: NEOSSat time minus SPHEREx time. */
  dt_hours: number;
  exposure_s: number | null;
  fov_arcmin: [number, number] | null;
  cutout_url: string;
  access_url: string;
}

export interface NeossatDoc {
  sequence_id: string;
  window_hours: number;
  credit: string;
  /** NEOSSat header positions can be off the ephemeris by tens of arcseconds; no precise marker is drawn. */
  position_accuracy_arcsec: number | null;
  items: { obs_id: string; t_mid_mjd: number; neossat: NeossatFrame | null }[];
}
