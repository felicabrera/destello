import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import es from '../../i18n/es.json';
import type { Lang, ValidationTest } from '../../lib/types';
import { localizedCriterion, localizedReason, localizedSource, localizedTestName } from './validationCopy';

const TOLERANCE_CODES = [
  'median_offset_below',
  'within_sigma_and_relative_error',
  'within_sigma',
  'max_separation_below',
  'change_above_sigma_consistent_sign',
  'change_above_sigma_or_no_change',
  'within_percent_per_band',
  'no_unexplained_dipoles',
  'blind_search_within_sigma',
  'methane_index_below_field',
];
const REASON_CODES = [
  'recalibration_residuals',
  'motion_fit',
  'no_reference_motion',
  'position_separations',
  'not_detected_any_epoch',
  'too_few_epochs',
  'science_error',
  'no_reference_stars',
  'gaia_unavailable',
  'no_suitable_star',
  'null_test_stars',
  'fewer_than_two_epochs',
  'no_shared_wavelengths',
  'change_detected',
  'no_significant_change',
  'no_coadd_pair',
  'dipole_count',
  'measurement_error',
  'irsa_tool_interactive',
  'flux_crosscheck_2mass',
  'too_few_flux_stars',
  'motion_search_recovery',
  'motion_search_not_found',
  'methane_index_vs_field',
  'methane_not_measurable',
  'window_not_measurable',
  'window_below_snr',
  'band_excess_continuum_undetected',
  'band_excess',
  'ephemeris_check',
  'ephemeris_check_neighbours',
  'recalibration_catalog_not_gaia',
  'no_wise_companion',
  'too_few_epochs_per_mission',
  'long_baseline_fit',
];

function makeT(lang: Lang) {
  const i = createInstance();
  void i.init({
    resources: { en: { translation: en }, es: { translation: es } },
    lng: lang,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    returnNull: false,
    initAsync: false,
  });
  return i.t.bind(i);
}

const base = { target: 'barnard', status: 'pass' as const };
const warnList = ['SATURATION', 'QUICK_RELEASE_CALIBRATION', 'TOO_FEW_EPOCHS'];
const motionParams = {
  pmra_masyr: -560.47,
  pmra_err_masyr: 464.04,
  pmdec_masyr: 10383.36,
  pmdec_err_masyr: 557.19,
  chi2_red: 4.912,
  relative_error: 0.0536,
  parallax_mas: 546.976,
  reference_pmra_masyr: -801.551,
  reference_pmdec_masyr: 10362.3942,
  recalibration_catalog: 'gaia_dr3',
  recalibration_stars: [17, 13, 14],
  warnings: warnList,
  cross_check: 'Cross-check on D6: pmra* -5895 +/- 1138, pmdec 1579 +/- 1135 mas/yr, 1.863 sigma.',
};
const dipoleParams = {
  n_images: 12,
  n_at_target: 0,
  n_unexplained: 1,
  n_not_measurable: 2,
  registration_measured: 12,
  registration_applied: 11,
  shift_median_arcsec: 0.2748,
  shift_max_arcsec: 0.3982,
  residual_fraction_measured: 12,
  residual_fraction_min: 0.0654,
  residual_fraction_max: 0.1868,
  unexplained: [{ detector: 2, epoch_a: 0, epoch_b: 1, ra_deg: 269.3988, dec_deg: 4.7805 }],
};
const epochParams = {
  epochs_measured: 0,
  epochs_total: 3,
  detector_used: 1,
  suggested_detector: null,
  saturated_fraction: [1, 1, 1],
  warnings: ['TOO_FEW_EPOCHS', 'SATURATION'],
};
const changeParams = {
  epoch_a: 1,
  epoch_b: 2,
  consistent_sign: true,
  n_pairs: 3,
  per_detector: [{ detector: 1, dmag: -0.4045, err: 0.0289, n_bins: 2 }],
  pairs: [
    { epoch_a: 0, epoch_b: 1, dmag: -0.1373, err: 0.1375 },
    { epoch_a: 1, epoch_b: 2, dmag: -0.4045, err: 0.0289 },
  ],
};

const wingParams = {
  ...changeParams,
  method: 'psf_wing_ring',
  wing: {
    annulus_arcsec: [50, 80],
    background_arcsec: [110, 145],
    n_points: 559,
    n_aperture: 588,
    rejected: { wing_masked: 29 },
    control_target: 'barnard',
    systematic_mag: { '1': 0.1369, '2': 0.242, '3': 0 },
  },
};

const fluxParams = {
  aperture_arcsec: 12,
  per_preset: { barnard: 1, epsindib: 1, rdra: 0 },
  bands: [
    { band: 'J', n_stars: 3, median_ratio: 0.9473, err: 0.0264 },
    { band: 'H', n_stars: 3, median_ratio: 0.9863, err: 0.0114 },
    { band: 'Ks', n_stars: 0, median_ratio: null, err: null },
  ],
};

const REASON_ROWS: Record<string, ValidationTest> = {
  recalibration_residuals: {
    ...base,
    id: 'V-01',
    name: 'N',
    reason: 'EN text',
    reason_code: 'recalibration_residuals',
    reason_params: {
      before_arcsec: [0.1597, 0.3065],
      after_arcsec: [0.1264, 0.1526],
      scatter_arcsec: [0.1102, 0.1259],
      stars_used: [17, 13],
      catalog: 'gaia_dr3',
    },
  },
  motion_fit: {
    ...base,
    id: 'V-03',
    name: 'N',
    detector: 5,
    epochs_used: 2,
    reason:
      'x The unverified literature value (-8118, 673) is not used as reference. Warnings: SATURATION. Cross-check',
    reason_code: 'motion_fit',
    reason_params: motionParams,
  },
  no_reference_motion: {
    ...base,
    id: 'V-02',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_reference_motion',
  },
  position_separations: {
    ...base,
    id: 'V-05',
    name: 'N',
    detector: 6,
    reason: 'EN text',
    reason_code: 'position_separations',
    reason_params: { separations_arcsec: [0.4793, 0.1802], missing_epochs: [1] },
  },
  not_detected_any_epoch: {
    ...base,
    id: 'V-05',
    name: 'N',
    reason: 'EN text',
    reason_code: 'not_detected_any_epoch',
    reason_params: epochParams,
  },
  too_few_epochs: {
    ...base,
    id: 'V-01',
    name: 'N',
    reason: 'EN text',
    reason_code: 'too_few_epochs',
    reason_params: { ...epochParams, epochs_measured: 1 },
  },
  science_error: {
    ...base,
    id: 'V-01',
    name: 'N',
    reason: 'EN text',
    reason_code: 'science_error',
    reason_params: { error_code: 'SOME_CODE', detail: 'free backend detail' },
  },
  no_reference_stars: {
    ...base,
    id: 'V-01',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_reference_stars',
  },
  gaia_unavailable: { ...base, id: 'V-09', name: 'N', reason: 'EN text', reason_code: 'gaia_unavailable' },
  no_suitable_star: {
    ...base,
    id: 'V-09',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_suitable_star',
    reason_params: { stars: [{ source_id: '1', error_code: 'X' }] },
  },
  null_test_stars: {
    ...base,
    id: 'V-09',
    name: 'N',
    detector: 6,
    sigma: 0.7,
    reason: 'EN text',
    reason_code: 'null_test_stars',
    reason_params: {
      n_stars: 1,
      stars: [
        {
          source_id: '4472832513187484544',
          g_mag: 14.4879,
          pmra_masyr: 86.51,
          pmra_err_masyr: 132.29,
          pmdec_masyr: 57.26,
          pmdec_err_masyr: 140.49,
          sigma: 0.6857,
        },
      ],
    },
  },
  fewer_than_two_epochs: {
    ...base,
    id: 'V-06',
    name: 'N',
    reason: 'EN text',
    reason_code: 'fewer_than_two_epochs',
    reason_params: { epochs_with_photometry: [] },
  },
  no_shared_wavelengths: {
    ...base,
    id: 'V-07',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_shared_wavelengths',
  },
  change_detected: {
    ...base,
    id: 'V-07',
    name: 'N',
    reason: 'EN text',
    reason_code: 'change_detected',
    reason_params: changeParams,
  },
  no_significant_change: {
    ...base,
    id: 'V-07',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_significant_change',
    reason_params: { ...changeParams, consistent_sign: false },
  },
  no_coadd_pair: { ...base, id: 'V-10', name: 'N', reason: 'EN text', reason_code: 'no_coadd_pair' },
  dipole_count: {
    ...base,
    id: 'V-10',
    name: 'N',
    reason: 'EN text',
    reason_code: 'dipole_count',
    reason_params: dipoleParams,
    tolerance_params: { lobe_sigma: 5, lobe_separation_pix: 4, known_exclusion_arcsec: 15 },
  },
  measurement_error: {
    ...base,
    id: 'V-06',
    name: 'N',
    reason: 'EN text',
    reason_code: 'measurement_error',
    reason_params: { exception: 'ValueError' },
  },
  irsa_tool_interactive: {
    ...base,
    id: 'V-08',
    name: 'N',
    reason: 'EN text',
    reason_code: 'irsa_tool_interactive',
  },
  flux_crosscheck_2mass: {
    ...base,
    target: 'field_stars',
    id: 'V-08',
    name: 'N',
    reason: 'EN text',
    reason_code: 'flux_crosscheck_2mass',
    reason_params: fluxParams,
  },
  too_few_flux_stars: {
    ...base,
    target: 'field_stars',
    id: 'V-08',
    name: 'N',
    reason: 'EN text',
    reason_code: 'too_few_flux_stars',
  },
  motion_search_recovery: {
    ...base,
    target: 'epsindib',
    id: 'V-11',
    name: 'N',
    reason: 'EN text',
    reason_code: 'motion_search_recovery',
    epochs_used: 4,
    reason_params: {
      n_listed: 1,
      n_epochs: 4,
      baseline_years: 1.386,
      detectors: [2, 3, 4, 5, 6],
      sep_arcsec: 0.8,
      pmra_masyr: 3748.2,
      pmra_err_masyr: 165.1,
      pmdec_masyr: -2566.6,
      pmdec_err_masyr: 164.6,
      reference_pmra_masyr: 3982.0,
      reference_pmdec_masyr: -2466.8,
    },
  },
  methane_index_vs_field: {
    ...base,
    target: 'epsindib',
    id: 'V-12',
    name: 'N',
    reason: 'EN text',
    reason_code: 'methane_index_vs_field',
    reason_params: {
      target: { index: 0.424, index_err: 0.041 },
      n_stars: 11,
      min_stars: 5,
      field_median: 1.001,
      field_scatter: 0.015,
    },
  },
  window_not_measurable: {
    ...base,
    id: 'V-13',
    name: 'N',
    reason: 'EN text',
    reason_code: 'window_not_measurable',
    reason_params: { co2: { n_points: { blue: 4, band: 1, red: 3 } } },
  },
  window_below_snr: {
    ...base,
    id: 'V-13',
    name: 'N',
    reason: 'EN text',
    reason_code: 'window_below_snr',
    reason_params: {
      co2: {
        windows: {
          blue: { n_points: 7, snr: 40.2 },
          band: { n_points: 2, snr: 1.4 },
          red: { n_points: 7, snr: 35.0 },
        },
      },
    },
  },
  band_excess_continuum_undetected: {
    ...base,
    id: 'V-13',
    name: 'N',
    reason: 'EN text',
    reason_code: 'band_excess_continuum_undetected',
    reason_params: {
      co2: {
        band_flux_jy: 0.0884,
        band_flux_err_jy: 0.0135,
        continuum_flux_jy: 0.00103,
        continuum_flux_err_jy: 0.00042,
        excess: null,
        significance: 6.5,
        continuum_upper_limit_jy: 0.0023,
        significance_vs_upper_limit: 6.4,
        n_points: { blue: 4, band: 2, red: 3 },
        windows: {
          blue: { n_points: 4, snr: 1.8 },
          band: { n_points: 2, snr: 6.5 },
          red: { n_points: 3, snr: 2.1 },
        },
      },
    },
  },
  band_excess: {
    ...base,
    id: 'V-13',
    name: 'N',
    reason: 'EN text',
    reason_code: 'band_excess',
    reason_params: {
      co2: {
        band_flux_jy: 1.25,
        continuum_flux_jy: 1.1,
        excess: 0.136,
        excess_err: 0.02,
        significance: 6.8,
        n_points: { blue: 4, band: 2, red: 3 },
      },
    },
  },
  ephemeris_check: {
    ...base,
    id: 'V-14',
    name: 'N',
    reason: 'EN text',
    reason_code: 'ephemeris_check',
    reason_params: {
      n_within: 103,
      n_measured: 103,
      n_exposures: 104,
      median_offset_arcsec: 0.88,
      max_offset_arcsec: 2.54,
    },
  },
  ephemeris_check_neighbours: {
    ...base,
    id: 'V-14',
    name: 'N',
    reason: 'EN text',
    reason_code: 'ephemeris_check_neighbours',
    reason_params: {
      n_within: 78,
      n_measured: 79,
      n_exposures: 160,
      median_offset_arcsec: 1.43,
      max_offset_arcsec: 6.09,
      method_version: '3',
      method_version_2: { n_within: 43, n_measured: 63, status: 'fail' },
    },
  },
  recalibration_catalog_not_gaia: {
    ...base,
    id: 'V-15',
    name: 'N',
    reason: 'EN text',
    reason_code: 'recalibration_catalog_not_gaia',
  },
  no_wise_companion: {
    ...base,
    id: 'V-15',
    name: 'N',
    reason: 'EN text',
    reason_code: 'no_wise_companion',
  },
  too_few_epochs_per_mission: {
    ...base,
    id: 'V-15',
    name: 'N',
    reason: 'EN text',
    reason_code: 'too_few_epochs_per_mission',
    reason_params: { WISE: 1, SPHEREx: 2 },
  },
  long_baseline_fit: {
    ...base,
    id: 'V-15',
    name: 'N',
    reason: 'EN text',
    reason_code: 'long_baseline_fit',
    reason_params: {
      pmra_masyr: -8135.7,
      pmdec_masyr: 667.7,
      pmra_err_masyr: 17.6,
      pmdec_err_masyr: 18.1,
      chi2_red: 0.65,
      n_epochs: 23,
      ref_epoch_jyear: 2019.92,
      epochs_per_mission: { WISE: 21, SPHEREx: 2 },
    },
  },
  methane_not_measurable: {
    ...base,
    target: 'epsindib',
    id: 'V-12',
    name: 'N',
    reason: 'EN text',
    reason_code: 'methane_not_measurable',
    reason_params: { target: { index: null }, n_stars: 3, min_stars: 5 },
  },
  motion_search_not_found: {
    ...base,
    target: 'epsindib',
    id: 'V-11',
    name: 'N',
    reason: 'EN text',
    reason_code: 'motion_search_not_found',
    reason_params: { n_listed: 3, n_epochs: 4, baseline_years: 1.386 },
  },
};

const TOL_ROWS: Record<string, ValidationTest> = Object.fromEntries(
  TOLERANCE_CODES.map((code) => [
    code,
    {
      ...base,
      id: 'V-02',
      name: 'N',
      tolerance: 'EN criterion',
      tolerance_code: code,
      tolerance_value: 3,
      tolerance_unit: code.includes('percent') ? 'percent' : 'sigma',
      tolerance_params:
        code === 'within_sigma_and_relative_error'
          ? { relative_error_max: 0.2 }
          : code === 'no_unexplained_dipoles'
            ? { lobe_sigma: 5, lobe_separation_pix: 4 }
            : code === 'blind_search_within_sigma'
              ? { min_detectors: 2 }
              : code === 'methane_index_below_field'
                ? { min_stars: 5 }
                : null,
    },
  ]),
);

const BAD = /\{\{|undefined|NaN|null|missing/;

describe('validation copy', () => {
  for (const lang of ['en', 'es'] as const) {
    const t = makeT(lang);
    describe(lang, () => {
      it('has a name for every test id', () => {
        for (let n = 1; n <= 11; n++) {
          const id = `V-${String(n).padStart(2, '0')}`;
          const out = localizedTestName(t, lang, { ...base, id, name: 'BACKEND NAME' });
          expect(out, id).not.toBe('BACKEND NAME');
        }
        expect(localizedTestName(t, lang, { ...base, id: 'V-99', name: 'BACKEND NAME' })).toBe(
          'BACKEND NAME',
        );
      });

      it('localizes every tolerance code without leftovers', () => {
        for (const code of TOLERANCE_CODES) {
          const out = localizedCriterion(t, lang, TOL_ROWS[code]);
          expect(out, code).not.toBe('EN criterion');
          expect(out, code).not.toMatch(BAD);
        }
      });

      it('localizes every reason code without leftovers', () => {
        expect(Object.keys(REASON_ROWS).sort()).toEqual([...REASON_CODES].sort());
        for (const code of REASON_CODES) {
          const out = localizedReason(t, lang, REASON_ROWS[code]);
          expect(out, code).not.toBe('EN text');
          expect(out, code).not.toMatch(BAD);
          expect(out.trim(), code).not.toBe('');
        }
      });

      it('describes the PSF wing method and the 2MASS cross-check', () => {
        const wing = localizedReason(t, lang, {
          ...REASON_ROWS.change_detected,
          reason_params: wingParams,
        });
        expect(wing).not.toBe('EN text');
        expect(wing).toContain('559');
        expect(wing).toContain(lang === 'es' ? '0,137' : '0.137');
        const flux = localizedReason(t, lang, REASON_ROWS.flux_crosscheck_2mass);
        expect(flux).toContain(lang === 'es' ? '0,947' : '0.947');
        expect(flux).toContain('R Draconis');
        const broken = localizedReason(t, lang, {
          ...REASON_ROWS.change_detected,
          reason_params: { ...wingParams, wing: { ...wingParams.wing, n_points: 'x' } },
        });
        expect(broken).toBe('EN text');
      });

      it('formats numbers for the active language', () => {
        const out = localizedCriterion(t, lang, {
          ...TOL_ROWS.median_offset_below,
          tolerance_value: 1.5,
          tolerance_unit: 'arcsec',
        });
        expect(out).toContain(lang === 'es' ? '1,5' : '1.5');
      });

      it('falls back to the backend text for unknown codes', () => {
        const row: ValidationTest = {
          ...base,
          id: 'V-01',
          name: 'N',
          tolerance: 'EN criterion',
          tolerance_code: 'made_up_code',
          tolerance_value: 1,
          reason: 'EN text',
          reason_code: 'made_up_code',
          reason_params: { a: 1 },
        };
        expect(localizedCriterion(t, lang, row)).toBe('EN criterion');
        expect(localizedReason(t, lang, row)).toBe('EN text');
      });

      it('falls back when params are not in the expected shape', () => {
        const bad = {
          ...REASON_ROWS.motion_fit,
          reason_params: { ...motionParams, pmra_masyr: 'x', recalibration_stars: 'none' },
        };
        expect(localizedReason(t, lang, bad)).toBe(bad.reason);
        const noParams = { ...REASON_ROWS.dipole_count, reason_params: null };
        expect(localizedReason(t, lang, noParams)).toBe('EN text');
        const noValue = { ...TOL_ROWS.within_sigma, tolerance_value: null };
        expect(localizedCriterion(t, lang, noValue)).toBe('EN criterion');
        const unparsed = {
          ...REASON_ROWS.motion_fit,
          reason_params: { ...motionParams, cross_check: 'Cross-check on D5: CODE: detail.' },
        };
        expect(localizedReason(t, lang, unparsed)).toBe(unparsed.reason);
      });

      it('renders the backend text for rows without the new fields', () => {
        const old: ValidationTest = {
          ...base,
          id: 'V-99',
          name: 'Old name',
          tolerance: 'Old criterion',
          reason: 'Old reason',
          source: 'Some free text',
        };
        expect(localizedTestName(t, lang, old)).toBe('Old name');
        expect(localizedCriterion(t, lang, old)).toBe('Old criterion');
        expect(localizedReason(t, lang, old)).toBe('Old reason');
        expect(localizedSource(t, lang, old)).toBe('Some free text');
        expect(localizedCriterion(t, lang, { ...base, id: 'V-99', name: 'x' })).toBe('');
      });

      it('translates stable source identifiers only', () => {
        expect(localizedSource(t, lang, { ...base, id: 'V-01', name: 'N', source: 'gaia_dr3' })).toBe(
          'Gaia DR3',
        );
        expect(localizedSource(t, lang, { ...base, id: 'V-01', name: 'N', source: null })).toBe('');
        expect(
          localizedSource(t, lang, {
            ...base,
            id: 'V-01',
            name: 'N',
            source: 'CatWISE2020 J085507.96-071439.3',
          }),
        ).toBe('CatWISE2020 J085507.96-071439.3');
      });
    });
  }

  it('covers every code used by the validation script', () => {
    const script = resolve(__dirname, '../../../../scripts/run_validation.py');
    if (!existsSync(script)) return;
    const src = readFileSync(script, 'utf8');
    const reasons = new Set([...src.matchAll(/reason_code="([a-z_]+)"/g)].map((m) => m[1]));
    for (const m of src.matchAll(/reason_code="motion_fit" if ref else "([a-z_]+)"/g)) reasons.add(m[1]);
    const tols = new Set(
      [...src.matchAll(/^\s+"V-\d\d": Tol\([^"]*(?:"[^"]*")*?\s*"([a-z_]+)"/gm)].map((m) => m[1]),
    );
    for (const code of reasons) expect(REASON_CODES, code).toContain(code);
    for (const code of tols) expect(TOLERANCE_CODES, code).toContain(code);
    expect(reasons.size).toBeGreaterThan(10);
  });

  it('has an English and a Spanish entry for every code', () => {
    for (const lang of ['en', 'es'] as const) {
      const val = (lang === 'en' ? en : es).val as unknown as {
        tol: Record<string, string>;
        r: Record<string, string>;
      };
      for (const code of TOLERANCE_CODES) expect(val.tol[code], `${lang} ${code}`).toBeTruthy();
      for (const code of [
        'no_reference_motion',
        'no_reference_stars',
        'gaia_unavailable',
        'fewer_than_two_epochs',
        'no_shared_wavelengths',
        'no_coadd_pair',
        'irsa_tool_interactive',
        'too_few_flux_stars',
        'fluxMethod',
        'fluxBands',
        'fluxBand',
        'fluxBandNone',
        'fluxPresets',
        'fluxRdra',
        'fluxReference',
        'wingMethod',
        'pairsAllWing',
        'science_error',
        'measurement_error',
        'no_suitable_star',
        'not_detected_any_epoch',
        'too_few_epochs',
        'position_separations',
        'recalibration_residuals',
        'null_test_stars_other',
        'dipole_count',
      ]) {
        expect(val.r[code], `${lang} ${code}`).toBeTruthy();
      }
    }
  });
});
