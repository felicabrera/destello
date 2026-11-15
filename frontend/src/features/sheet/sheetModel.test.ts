import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import es from '../../i18n/es.json';
import type {
  AstrometryResponse,
  CandidatesResult,
  EpochPhotometry,
  Manifest,
  MotionSearchResult,
  PhotometryDoc,
  SpectrumResponse,
} from '../../lib/types';
import { buildSheet, sheetFileName, sheetJson, sheetPhotometry, type SheetInput } from './sheetModel';

// Synthetic test inputs: they exercise the assembly, they are not SPHEREx measurements.
const frame = (detector: number, epoch: number) => ({
  detector,
  kind: 'coadd',
  url: `/frames/${epoch}-${detector}.png`,
  wavelength_um: (detector === 0 ? null : [detector, detector + 0.5]) as [number, number] | null,
  n_images: detector === 0 ? 4 : 2,
  flagged_fraction: 0.01,
  obs_ids: detector === 0 ? [`T-${epoch}-a`, `T-${epoch}-b`] : [`T-${epoch}-${detector}`],
});

const manifest: Manifest = {
  schema_version: 1,
  sequence_id: 'abc123',
  pipeline_version: '9.9.9-test',
  created_at: '2026-01-02T03:04:05Z',
  request: { ra_deg: 10.5, dec_deg: -20.25, fov_arcmin: 6, detectors: [1, 2, 3, 4, 5, 6] },
  grid: { projection: 'TAN', crval_deg: [10.5, -20.25], pixel_scale_arcsec: 3.1, naxis: [116, 116] },
  epochs: [
    {
      index: 0,
      t_start: '2025-05-01T00:00:00Z',
      t_end: '2025-05-11T00:00:00Z',
      t_mid_mjd: 60801.5,
      n_images: 4,
      frames: [frame(0, 0), frame(3, 0), frame(6, 0)],
    },
    { index: 1, t_start: '2025-11-01T00:00:00Z', t_end: '2025-11-09T00:00:00Z', frames: [frame(6, 1)] },
  ],
  stretch: {
    '0': { method: 'asinh', vmin: -0.5, vmax: 12.25, unit: 'MJy/sr' },
    '6': { method: 'asinh', vmin: -0.1, vmax: 3.5, softening: 0.2, unit: 'MJy/sr' },
  },
  provenance: { collections: ['test_release'], dois: ['10.0000/TEST'], services: ['TEST SIA'] },
  warnings: [{ code: 'SINGLE_EPOCH', detail: 'raw detail' }],
};

const base = (over: Partial<SheetInput> = {}): SheetInput => ({
  now: new Date('2026-11-11T10:20:30.000Z'),
  language: 'en',
  viewUrl: 'http://localhost/t/x?det=6',
  targetName: 'Test Star',
  manifest,
  epochs: manifest.epochs,
  view: { mode: 'blink', detector: 6, frameIdx: 1, refIdx: 0, rgb: [6, 3, 1] },
  warningLines: { warnings: ['a warning line'], notes: ['a note line'] },
  acknowledgements: [{ id: 'spherex', title: 'SPHEREx', text: 'Ack text' }],
  ...over,
});

const astrometry: AstrometryResponse = {
  detector_used: 6,
  epochs: [
    { index: 0, t_mid_mjd: 60801.5, measured: true, ra_deg: 10.5, dec_deg: -20.25 },
    { index: 1, t_mid_mjd: 60985.5, measured: true, ra_deg: 10.5, dec_deg: -20.24 },
  ],
  fit: { pmra_masyr: 300, pmdec_masyr: -400, pmra_err_masyr: 30, pmdec_err_masyr: 40 },
  reference: { pmra_masyr: 310, pmdec_masyr: -390, source: 'Test catalog' },
  agreement_sigma: 0.75,
};

const phot = (
  epoch: number,
  detector: number,
  flux: number | null,
  err: number | null = null,
): EpochPhotometry => ({
  epoch,
  detector,
  flux,
  flux_err: err,
  n_images: 2,
  reason: flux == null ? 'saturated_core' : null,
});

/** Every key of a JSON value, recursively. */
function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      keysOf(x, out);
    }
  return out;
}

describe('buildSheet', () => {
  it('copies the header, the data and the traceability from the manifest and the view', () => {
    const s = buildSheet(base());
    expect(s.generated_at_utc).toBe('2026-11-11T10:20:30.000Z');
    expect(s.view_url).toBe('http://localhost/t/x?det=6');
    expect(s.target).toEqual({ name: 'Test Star', ra_deg: 10.5, dec_deg: -20.25, fov_arcmin: 6 });
    expect(s.data.collections).toEqual(['test_release']);
    expect(s.data.dois).toEqual(['10.0000/TEST']);
    expect(s.data.services).toEqual(['TEST SIA']);
    expect(s.data.pipeline_version).toBe('9.9.9-test');
    expect(s.data.sequence_id).toBe('abc123');
    expect(s.data.build_status).toBe('complete');
    expect(s.data.epochs[0]).toEqual({
      epoch: 1,
      t_start_utc: '2025-05-01T00:00:00Z',
      t_end_utc: '2025-05-11T00:00:00Z',
      t_mid_mjd: 60801.5,
      t_mid_utc: '2025-05-06T12:00:00.000Z',
      n_images: 4,
      detectors_with_coadds: [3, 6],
      broadband_coadd: true,
      coverage: 'full',
    });
    expect(s.traceability.obs_ids).toEqual([
      { epoch: 1, detector: 'all', n_images: 4, obs_ids: ['T-0-a', 'T-0-b'] },
      { epoch: 1, detector: 3, n_images: 2, obs_ids: ['T-0-3'] },
      { epoch: 1, detector: 6, n_images: 2, obs_ids: ['T-0-6'] },
      { epoch: 2, detector: 6, n_images: 2, obs_ids: ['T-1-6'] },
    ]);
    expect(s.traceability.acknowledgements).toEqual([{ id: 'spherex', title: 'SPHEREx', text: 'Ack text' }]);
    expect(s.warnings).toEqual({
      items: [{ code: 'SINGLE_EPOCH', detail: 'raw detail' }],
      warning_lines: ['a warning line'],
      note_lines: ['a note line'],
    });
  });

  it('states absent values as null and never fills them in', () => {
    const s = buildSheet(base({ targetName: null }));
    expect(s.target.name).toBeNull();
    expect(s.data.data_as_of).toBeNull();
    // The second epoch has no image count; its mid time is the midpoint of the stated start and end.
    expect(s.data.epochs[1].n_images).toBeNull();
    expect(s.data.epochs[1].t_mid_mjd).toBe(60984);
    const noTimes = buildSheet(base({ epochs: [{ index: 0, frames: [] }] }));
    expect(noTimes.data.epochs[0]).toMatchObject({
      t_start_utc: null,
      t_end_utc: null,
      t_mid_mjd: null,
      t_mid_utc: null,
      detectors_with_coadds: [],
      broadband_coadd: false,
    });
  });

  it('describes the frames shown and the shared stretch of the exact detector', () => {
    const s = buildSheet(base());
    expect(s.frames).toEqual({
      mode: 'blink',
      detector: 6,
      rgb_detectors: null,
      epoch_shown: 2,
      reference_epoch: null,
      wavelength_min_um: 6,
      wavelength_max_um: 6.5,
      stretch: [
        {
          detector: 6,
          method: 'asinh',
          vmin: -0.1,
          vmax: 3.5,
          softening: 0.2,
          unit: 'MJy/sr',
          shared_across_epochs: true,
        },
      ],
    });
    // A detector without a stretch entry never borrows another one.
    const d3 = buildSheet(base({ view: { ...base().view, detector: 3 } }));
    expect(d3.frames.stretch).toEqual([]);
    const all = buildSheet(base({ view: { ...base().view, detector: 'all' } }));
    expect(all.frames.stretch.map((x) => [x.detector, x.vmax, x.softening])).toEqual([['all', 12.25, null]]);
  });

  it('labels a low coverage epoch and names the epoch actually subtracted', () => {
    const low = buildSheet(
      base({ epochs: [manifest.epochs[0], { ...manifest.epochs[1], coverage: 'low' }] }),
    );
    expect(low.data.epochs.map((e) => e.coverage)).toEqual(['full', 'low']);
    const v = base().view;
    const paired = buildSheet(base({ view: { ...v, mode: 'diffseq', frameIdx: 1, pairIndex: 0 } }));
    expect(paired.frames.reference_epoch).toBe(1);
    const none = buildSheet(base({ view: { ...v, mode: 'diff', frameIdx: 1, pairIndex: null } }));
    expect(none.frames.reference_epoch).toBeNull();
  });

  it('gives the reference epoch and no stretch in the difference modes', () => {
    const diff = buildSheet(base({ view: { ...base().view, mode: 'diff' } }));
    expect(diff.frames.reference_epoch).toBe(1);
    expect(diff.frames.stretch).toEqual([]);
    const stack = buildSheet(base({ view: { ...base().view, mode: 'stack' } }));
    expect(stack.frames.epoch_shown).toBeNull();
    const rgb = buildSheet(base({ view: { ...base().view, mode: 'rgb' } }));
    expect(rgb.frames.rgb_detectors).toEqual([6, 3, 1]);
    expect(rgb.frames.stretch.map((x) => x.detector)).toEqual([6]);
  });

  it('omits every measurement block that is not loaded', () => {
    const s = buildSheet(base({ selection: { ra_deg: 1, dec_deg: 2, kind: 'target' } }));
    expect(s.measurements).toEqual({});
    expect(Object.keys(JSON.parse(sheetJson(s)).measurements)).toEqual([]);
    const nulls = buildSheet(
      base({ astrometry: null, spectrum: null, photometry: null, candidates: null, presetResult: null }),
    );
    expect(nulls.measurements).toEqual({});
  });

  it('reports the proper motion fit with its reference and agreement, numbers as numbers', () => {
    const s = buildSheet(
      base({
        selection: { ra_deg: 10.5, dec_deg: -20.25, kind: 'target' },
        astrometry: { data: astrometry, errorCode: null },
      }),
    );
    expect(s.measurements.position).toEqual({ ra_deg: 10.5, dec_deg: -20.25, kind: 'target' });
    const pm = s.measurements.proper_motion;
    expect(pm?.status).toBe('ok');
    expect(pm?.fit).toEqual({
      pmra_masyr: 300,
      pmra_err_masyr: 30,
      pmdec_masyr: -400,
      pmdec_err_masyr: 40,
      pm_total_masyr: 500,
      parallax_mas: null,
      parallax_fixed: null,
      chi2_red: null,
    });
    expect(pm?.reference).toEqual({
      pmra_masyr: 310,
      pmra_err_masyr: null,
      pmdec_masyr: -390,
      pmdec_err_masyr: null,
      source: 'Test catalog',
      ref_epoch: null,
    });
    expect(pm?.agreement_sigma).toBe(0.75);
    expect(pm?.epochs_measured).toBe(2);
    expect(pm?.epochs_total).toBe(2);
    expect(pm?.unmeasured_epochs).toEqual([]);
  });

  it('says when the motion is not measurable, with the reason the source gave', () => {
    const r: AstrometryResponse = {
      status: 'not_measurable',
      detector_used: 6,
      suggested_detector: 2,
      epochs: [
        { index: 0, t_mid_mjd: 60801.5, measured: false, reason: 'saturated' },
        { index: 1, t_mid_mjd: 60985.5, measured: true, ra_deg: 1, dec_deg: 2 },
      ],
      fit: null,
      agreement_sigma: 0.2,
    };
    const pm = buildSheet(base({ astrometry: { data: r, errorCode: null } })).measurements.proper_motion;
    expect(pm).toMatchObject({
      status: 'not_measurable',
      fit: null,
      agreement_sigma: null,
      epochs_measured: 1,
      epochs_total: 2,
      suggested_detector: 2,
      reason_code: null,
      unmeasured_epochs: [{ epoch: 1, reason: 'saturated' }],
    });
    const few = buildSheet(base({ astrometry: { data: null, errorCode: 'TOO_FEW_EPOCHS' } }));
    expect(few.measurements.proper_motion).toMatchObject({
      status: 'not_measurable',
      reason_code: 'TOO_FEW_EPOCHS',
      fit: null,
    });
    // A failed request for another cause says nothing about the source: no block.
    const net = buildSheet(base({ astrometry: { data: null, errorCode: 'NETWORK' } }));
    expect(net.measurements.proper_motion).toBeUndefined();
  });

  it('summarizes the spectrum from its points only', () => {
    const spectrum: SpectrumResponse = {
      unit: 'Jy',
      aperture_arcsec: 9.3,
      points: [
        { epoch: 0, obs_id: 'a', detector: 6, wavelength_um: 4.5, flux: 1, flagged: false },
        { epoch: 0, obs_id: 'b', detector: 6, wavelength_um: 4.9, flux: null, flagged: false },
        { epoch: 1, obs_id: 'c', detector: 6, wavelength_um: 4.7, flux: 2, flagged: true },
        { epoch: 1, obs_id: 'd', detector: 6, wavelength_um: 4.6, flux: 3, flagged: false },
      ],
      epoch_photometry: [phot(0, 6, 2, 0.3), phot(1, 6, 3, 0.4)],
    };
    const sp = buildSheet(base({ spectrum })).measurements.spectrum;
    expect(sp).toMatchObject({
      flux_unit: 'Jy',
      aperture_radius_arcsec: 9.3,
      n_points: 4,
      n_usable: 2,
      n_epochs: 2,
      wavelength_min_um: 4.5,
      wavelength_max_um: 4.6,
      warnings: [],
    });
    expect(sp?.photometry?.change).toEqual({
      from_epoch: 1,
      to_epoch: 2,
      flux_change: 1,
      percent: 50,
      sigma: 2,
    });
  });

  it('builds the light curve of the shown detector and keeps unmeasured epochs with their reason', () => {
    const photometry: PhotometryDoc = {
      unit: 'Jy',
      sequence_id: 'abc123',
      aperture_radius_arcsec: 12,
      epoch_photometry: [phot(1, 6, null), phot(0, 6, 0.5, 0.05), phot(0, 3, 9, 1), phot(1, 3, 8, 1)],
    };
    const lc = buildSheet(base({ photometry })).measurements.light_curve;
    expect(lc?.aperture_radius_arcsec).toBe(12);
    expect(lc?.photometry.detector).toBe(6);
    expect(lc?.photometry.rows).toEqual([
      {
        epoch: 1,
        t_mid_mjd: 60801.5,
        wavelength_min_um: null,
        wavelength_max_um: null,
        flux: 0.5,
        flux_err: 0.05,
        n_images: 2,
        reason: null,
      },
      {
        epoch: 2,
        t_mid_mjd: 60984,
        wavelength_min_um: null,
        wavelength_max_um: null,
        flux: null,
        flux_err: null,
        n_images: 2,
        reason: 'saturated_core',
      },
    ]);
    // One measured epoch: no change is stated.
    expect(lc?.photometry.change).toBeNull();
    const empty = buildSheet(base({ photometry: { ...photometry, epoch_photometry: [] } }));
    expect(empty.measurements.light_curve).toBeUndefined();
  });

  it('includes the candidates counts only when the toggle is on', () => {
    const counts = {
      listed: 7,
      single_detector_dropped: 3,
      extended_dropped: 1,
      unmatched: 2,
      unchecked: 0,
      target: 1,
      known_source: 4,
      not_measurable: 0,
    };
    const data = {
      sequence_id: 'abc123',
      epoch_a: 1,
      epoch_b: 0,
      threshold_sigma: 5,
      method_version: 'm1',
      truncated: false,
      counts,
      catalogs: { gaia_dr3: 'ok', catwise2020: 'unavailable' },
      candidates: [],
    } as unknown as CandidatesResult;
    expect(buildSheet(base()).measurements.candidates).toBeUndefined();
    const on = buildSheet(base({ candidates: { data } })).measurements.candidates;
    expect(on).toEqual({
      status: 'loaded',
      epoch_a: 2,
      epoch_b: 1,
      threshold_sigma: 5,
      method_version: 'm1',
      truncated: false,
      counts,
      catalogs: { gaia_dr3: 'ok', catwise2020: 'unavailable' },
    });
    const pending = buildSheet(base({ candidates: { data: null } })).measurements.candidates;
    expect(pending).toMatchObject({ status: 'not_loaded', counts: null });
  });

  it('includes the motion search only once it has answered, with 1-based epoch numbers', () => {
    expect(buildSheet(base()).measurements.motion_search).toBeUndefined();
    expect(buildSheet(base({ motionSearch: null })).measurements.motion_search).toBeUndefined();
    const data = {
      sequence_id: 'abc123',
      method_version: 'm1',
      epochs: [0, 1, 2],
      baseline_years: 1.01,
      ref_epoch_jyear: 2025.9,
      mu_max_arcsec_yr: 10,
      step_arcsec_yr: 0.5,
      threshold_sigma: 5,
      epoch_min_sigma: 3,
      min_motion_sigma: 3,
      min_detectors: 2,
      match_radius_arcsec: 6.2,
      target_radius_arcsec: 15,
      detectors: [],
      catalogs: { gaia_dr3: 'ok', catwise2020: 'ok' },
      counts: {
        listed: 1,
        single_detector_dropped: 0,
        unmatched: 0,
        unchecked: 0,
        target: 1,
        known_source: 0,
      },
      truncated: false,
      sources: [
        {
          id: 'm1',
          status: 'target',
          snr: 38,
          detectors: [2, 3, 4],
          snr_by_detector: [38, 30, 20],
          pmra_masyr: 3748,
          pmdec_masyr: -2567,
          pmra_err_masyr: 165,
          pmdec_err_masyr: 165,
          pm_total_masyr: 4543,
          ref_epoch_jyear: 2025.9,
          ra_deg: 331.05,
          dec_deg: -56.8,
          x: 10,
          y: 12,
          track: [],
          match: null,
        },
      ],
    } as MotionSearchResult;
    const ms = buildSheet(base({ motionSearch: data })).measurements.motion_search;
    expect(ms?.epochs).toEqual([1, 2, 3]);
    expect(ms?.counts.target).toBe(1);
    expect(ms?.sources).toEqual([
      {
        id: 'm1',
        status: 'target',
        pmra_masyr: 3748,
        pmra_err_masyr: 165,
        pmdec_masyr: -2567,
        pmdec_err_masyr: 165,
        pm_total_masyr: 4543,
        ref_epoch_jyear: 2025.9,
        ra_deg: 331.05,
        dec_deg: -56.8,
        snr: 38,
        detectors: [2, 3, 4],
        match: null,
      },
    ]);
  });

  it('takes the preset result as published, or states that it is not measurable', () => {
    const ok = buildSheet(
      base({
        presetResult: {
          result: { kind: 'motion', value: 10.4, err: 0.2, unit: 'arcsec/yr', agreement_sigma: 0.5 },
          notMeasurable: false,
        },
      }),
    ).measurements.preset_result;
    expect(ok).toEqual({
      status: 'ok',
      kind: 'motion',
      value: 10.4,
      err: 0.2,
      unit: 'arcsec/yr',
      reference_value: null,
      reference_source: null,
      agreement_sigma: 0.5,
      significance_sigma: null,
    });
    const no = buildSheet(base({ presetResult: { result: null, notMeasurable: true } }));
    expect(no.measurements.preset_result).toMatchObject({ status: 'not_measurable', value: null });
    // A result whose unit is not a physical quantity is not a measurement and is left out.
    const count = buildSheet(
      base({
        presetResult: { result: { kind: 'motion', value: 3, unit: 'count' }, notMeasurable: false },
      }),
    );
    expect(count.measurements.preset_result).toBeUndefined();
  });
});

describe('sheetPhotometry', () => {
  it('states no significance when an uncertainty is missing and no percent from a zero flux', () => {
    const noErr = sheetPhotometry([phot(0, 2, 4, 0.1), phot(1, 2, 5)], 'Jy', 2, manifest.epochs);
    expect(noErr?.change).toEqual({ from_epoch: 1, to_epoch: 2, flux_change: 1, percent: 25, sigma: null });
    const zero = sheetPhotometry([phot(0, 2, 0, 0.1), phot(1, 2, 5, 0.1)], 'Jy', 2, manifest.epochs);
    expect(zero?.change?.percent).toBeNull();
  });

  it('falls back to the detector with most measured epochs when the shown one has no rows', () => {
    const rows = [phot(0, 2, null), phot(1, 2, 1), phot(0, 4, 1), phot(1, 4, 2)];
    expect(sheetPhotometry(rows, 'Jy', 'all', manifest.epochs)?.detector).toBe(4);
    expect(sheetPhotometry(rows, 'Jy', 6, manifest.epochs)?.detector).toBe(4);
    expect(sheetPhotometry([], 'Jy', 6, manifest.epochs)).toBeNull();
  });
});

describe('sheet JSON', () => {
  const full = (language: 'en' | 'es', labels: typeof en): SheetInput =>
    base({
      language,
      selection: { ra_deg: 10.5, dec_deg: -20.25, kind: 'target' },
      astrometry: { data: astrometry, errorCode: null },
      photometry: { unit: 'Jy', sequence_id: 'abc123', epoch_photometry: [phot(0, 6, 1, 0.1)] },
      warningLines: { warnings: [labels.info.warn.SINGLE_EPOCH], notes: [] },
      acknowledgements: [
        { id: 'spherex', title: labels.pages.ack.spherex.t, text: labels.pages.ack.spherex.d },
      ],
    });

  it('keeps numbers as numbers and carries units in key names or unit fields', () => {
    const j = JSON.parse(sheetJson(buildSheet(full('en', en))));
    expect(Object.keys(j)).toEqual([
      'schema_version',
      'generated_at_utc',
      'language',
      'view_url',
      'target',
      'data',
      'frames',
      'measurements',
      'warnings',
      'traceability',
    ]);
    expect(typeof j.target.ra_deg).toBe('number');
    expect(typeof j.target.fov_arcmin).toBe('number');
    expect(typeof j.data.epochs[0].t_mid_mjd).toBe('number');
    expect(typeof j.measurements.proper_motion.fit.pmra_masyr).toBe('number');
    expect(typeof j.frames.stretch[0].vmax).toBe('number');
    expect(j.frames.stretch[0].unit).toBe('MJy/sr');
    expect(j.measurements.light_curve.photometry.flux_unit).toBe('Jy');
    expect(typeof j.measurements.light_curve.photometry.rows[0].flux).toBe('number');
  });

  it('has the same language-independent keys in English and Spanish', () => {
    const a = JSON.parse(sheetJson(buildSheet(full('en', en))));
    const b = JSON.parse(sheetJson(buildSheet(full('es', es as typeof en))));
    const ka = [...keysOf(a)].sort();
    expect([...keysOf(b)].sort()).toEqual(ka);
    for (const k of ka) expect(k, k).toMatch(/^[a-z][a-z0-9_]*$/);
    // Localized text sits in values only.
    expect(b.language).toBe('es');
    expect(b.traceability.acknowledgements[0].title).toBe(es.pages.ack.spherex.t);
    expect(b.warnings.warning_lines).toEqual([es.info.warn.SINGLE_EPOCH]);
    expect(a.warnings.items).toEqual(b.warnings.items);
  });

  it('names the file after the target, or after the sequence when there is no name', () => {
    expect(sheetFileName(buildSheet(base({ targetName: "Barnard's Star" })))).toBe(
      'destello-results-barnard-s-star.json',
    );
    expect(sheetFileName(buildSheet(base({ targetName: 'Épsilon Indi B' })))).toBe(
      'destello-results-epsilon-indi-b.json',
    );
    expect(sheetFileName(buildSheet(base({ targetName: null })))).toBe('destello-results-abc123.json');
  });
});
