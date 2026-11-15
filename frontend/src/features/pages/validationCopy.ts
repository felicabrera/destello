// Localized copy for the validation table. The backend report carries English text plus machine-readable
// fields (tolerance_code, reason_code and their params). These pure functions build the Spanish or English
// sentence from those fields. Every number comes from the row at runtime. When a code is missing, unknown or
// its params are not in the expected shape, the backend text is returned instead of a broken sentence.
import type { TFunction } from 'i18next';
import { localNumber, localPercent } from '../../lib/format';
import type { Lang, ValidationTest } from '../../lib/types';

type Params = Record<string, unknown>;

const MISSING = '\u0000missing';

/** Translates `key`; null when the key has no entry or an interpolation variable stayed unresolved. */
function tr(t: TFunction, key: string, vars: Record<string, string | number> = {}): string | null {
  const s = String(t(key, { ...vars, defaultValue: MISSING }));
  return s === MISSING || s.includes('{{') || s.includes(MISSING) ? null : s;
}

function rec(v: unknown): Params | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Params) : null;
}
function fin(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function finArr(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(fin);
  return out.every((n): n is number => n !== null) ? out : null;
}
function recArr(v: unknown): Params[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map(rec);
  return out.every((r): r is Params => r !== null) ? out : null;
}

const fmt = (lang: Lang, v: number, digits = 2) => localNumber(lang, v, digits);
const list = (lang: Lang, a: number[], digits = 2) => a.map((v) => fmt(lang, v, digits)).join('; ');
/** Threshold values: no trailing zero decimals (3 sigma, 6.2 arcsec). */
const fmtVal = (lang: Lang, v: number) => (Number.isInteger(v) ? fmt(lang, v, 0) : fmt(lang, v, 1));
const epochLabel = (index: number) => `E${index + 1}`;

function unitLabel(t: TFunction, unit: string | null | undefined): string {
  if (!unit) return '';
  return tr(t, `val.units.${unit}`) ?? unit;
}

function catalogLabel(t: TFunction, name: string): string {
  return tr(t, `val.catalogs.${name}`) ?? name;
}

/** Short name of a measurement warning code, reusing the translations of the measurement panel. */
function warningLabel(t: TFunction, code: string): string {
  const own = tr(t, `sciWarn.codes.${code}.t`);
  if (own) return own.replace(/\.$/, '');
  return tr(t, `val.warnNames.${code}`) ?? code;
}

function warningsPart(t: TFunction, v: unknown): string | null {
  const codes = Array.isArray(v) ? v.map(str) : [];
  if (codes.length === 0 || !codes.every((c): c is string => c !== null)) return null;
  return tr(t, 'val.r.warnings', { list: codes.map((c) => warningLabel(t, c)).join(', ') });
}

function detectorLabel(d: unknown): string | null {
  if (typeof d === 'number' && Number.isFinite(d)) return `D${d}`;
  return str(d);
}

// ---------------------------------------------------------------------------------------------- test name
export function localizedTestName(t: TFunction, _lang: Lang, x: ValidationTest): string {
  return tr(t, `val.testNames.${x.id}`) ?? x.name;
}

// ---------------------------------------------------------------------------------------------- criterion
export function localizedCriterion(t: TFunction, lang: Lang, x: ValidationTest): string {
  const fallback = x.tolerance ?? '';
  const code = str(x.tolerance_code);
  if (!code) return fallback;
  const value = fin(x.tolerance_value);
  const p = rec(x.tolerance_params);
  const key = `val.tol.${code}`;
  let out: string | null = null;
  switch (code) {
    case 'median_offset_below':
    case 'max_separation_below':
      if (value !== null)
        out = tr(t, key, { value: fmtVal(lang, value), unit: unitLabel(t, x.tolerance_unit) });
      break;
    case 'within_sigma':
    case 'change_above_sigma_consistent_sign':
    case 'change_above_sigma_or_no_change':
    case 'within_percent_per_band':
      if (value !== null) out = tr(t, key, { value: fmtVal(lang, value) });
      break;
    case 'within_sigma_and_relative_error': {
      const rel = fin(p?.relative_error_max);
      if (value !== null && rel !== null)
        out = tr(t, key, { value: fmtVal(lang, value), rel: fmt(lang, rel * 100, 0) });
      break;
    }
    case 'methane_index_below_field': {
      const n = fin(p?.min_stars);
      if (value !== null && n !== null) out = tr(t, key, { value: fmtVal(lang, value), n: fmt(lang, n, 0) });
      break;
    }
    case 'blind_search_within_sigma': {
      const n = fin(p?.min_detectors);
      if (value !== null && n !== null) out = tr(t, key, { value: fmtVal(lang, value), n: fmt(lang, n, 0) });
      break;
    }
    case 'no_unexplained_dipoles': {
      const sigma = fin(p?.lobe_sigma);
      const sep = fin(p?.lobe_separation_pix);
      if (sigma !== null && sep !== null)
        out = tr(t, key, { sigma: fmtVal(lang, sigma), sep: fmtVal(lang, sep) });
      break;
    }
    default:
      break;
  }
  return out ?? fallback;
}

// ---------------------------------------------------------------------------------------------- reason
function join(parts: (string | null)[]): string | null {
  return parts.every((s): s is string => s !== null) ? parts.filter((s) => s !== '').join(' ') : null;
}

/** Cross-check sentence of V-03, which the backend only supplies as text. Null when it has another shape. */
function crossCheck(t: TFunction, lang: Lang, text: string): string | null {
  const n = '(-?\\d+(?:\\.\\d+)?)';
  const fit = new RegExp(
    `^Cross-check on D(\\d+): pmra\\* ${n} \\+/- ${n}, pmdec ${n} \\+/- ${n} mas/yr, ${n} sigma\\.$`,
  ).exec(text.trim());
  if (fit) {
    const v = fit.slice(2).map(Number);
    if (v.every(Number.isFinite)) {
      return tr(t, 'val.r.crossFit', {
        detector: `D${fit[1]}`,
        pmra: fmt(lang, v[0], 0),
        pmraErr: fmt(lang, v[1], 0),
        pmdec: fmt(lang, v[2], 0),
        pmdecErr: fmt(lang, v[3], 0),
        unit: unitLabel(t, 'masyr'),
        sigma: fmt(lang, v[4], 2),
      });
    }
  }
  const none = /^Cross-check on D(\d+): measured in (\d+) of (\d+) epochs, not fitted\.$/.exec(text.trim());
  if (none) {
    return tr(t, 'val.r.crossNone', {
      detector: `D${none[1]}`,
      measured: fmt(lang, Number(none[2]), 0),
      total: fmt(lang, Number(none[3]), 0),
    });
  }
  return null;
}

function motionFit(t: TFunction, lang: Lang, x: ValidationTest, p: Params): string | null {
  const pmra = fin(p.pmra_masyr);
  const pmraErr = fin(p.pmra_err_masyr);
  const pmdec = fin(p.pmdec_masyr);
  const pmdecErr = fin(p.pmdec_err_masyr);
  const rpmra = fin(p.reference_pmra_masyr);
  const rpmdec = fin(p.reference_pmdec_masyr);
  const relErr = fin(p.relative_error);
  const parallax = fin(p.parallax_mas);
  const catalog = str(p.recalibration_catalog);
  const stars = finArr(p.recalibration_stars);
  if (
    pmra === null ||
    pmraErr === null ||
    pmdec === null ||
    pmdecErr === null ||
    rpmra === null ||
    rpmdec === null ||
    relErr === null ||
    parallax === null ||
    catalog === null ||
    stars === null
  ) {
    return null;
  }
  const unit = unitLabel(t, 'masyr');
  const detector = detectorLabel(x.detector);
  const nEpochs = fin(x.epochs_used);
  const chi2 = fin(p.chi2_red);
  const parts: (string | null)[] = [
    tr(t, 'val.r.motionFit', {
      pmra: fmt(lang, pmra, 0),
      pmraErr: fmt(lang, pmraErr, 0),
      pmdec: fmt(lang, pmdec, 0),
      pmdecErr: fmt(lang, pmdecErr, 0),
      unit,
    }),
  ];
  if (detector && nEpochs !== null) {
    parts.push(tr(t, 'val.r.onDetector', { detector, n: fmt(lang, nEpochs, 0) }));
  }
  if (chi2 !== null) parts.push(tr(t, 'val.r.chi2', { chi2: fmt(lang, chi2, 2) }));
  parts.push(
    tr(t, 'val.r.motionRef', { pmra: fmt(lang, rpmra, 0), pmdec: fmt(lang, rpmdec, 0), unit }),
    tr(t, 'val.r.relErr', { rel: localPercent(lang, relErr) }),
    tr(t, 'val.r.parallaxFixed', { plx: fmt(lang, parallax, 1) }),
    tr(t, 'val.r.recalStars', {
      catalog: catalogLabel(t, catalog),
      stars: stars.map((n) => fmt(lang, n, 0)).join('; '),
    }),
  );
  const raw = x.reason ?? '';
  if (raw.includes('unverified literature')) {
    const m = /The unverified literature value \((-?\d+), (-?\d+)\) is not used as reference\./.exec(raw);
    if (!m) return null;
    parts.push(
      tr(t, 'val.r.unverified', { pmra: fmt(lang, Number(m[1]), 0), pmdec: fmt(lang, Number(m[2]), 0) }),
    );
  }
  const warn = warningsPart(t, p.warnings);
  if (Array.isArray(p.warnings) && p.warnings.length > 0) parts.push(warn);
  const cc = str(p.cross_check);
  if (cc) parts.push(crossCheck(t, lang, cc));
  return join(parts);
}

function recalibration(t: TFunction, lang: Lang, p: Params): string | null {
  const before = finArr(p.before_arcsec);
  const after = finArr(p.after_arcsec);
  const scatter = finArr(p.scatter_arcsec);
  const stars = finArr(p.stars_used);
  const catalog = str(p.catalog);
  if (!before || !after || !scatter || !stars || !catalog) return null;
  return tr(t, 'val.r.recalibration_residuals', {
    before: list(lang, before),
    after: list(lang, after),
    scatter: list(lang, scatter),
    stars: stars.map((n) => fmt(lang, n, 0)).join('; '),
    catalog: catalogLabel(t, catalog),
  });
}

function separations(t: TFunction, lang: Lang, x: ValidationTest, p: Params): string | null {
  const seps = finArr(p.separations_arcsec);
  const missing = finArr(p.missing_epochs);
  const detector = detectorLabel(x.detector);
  if (!seps || !missing || !detector) return null;
  const parts = [tr(t, 'val.r.position_separations', { seps: list(lang, seps), detector })];
  if (missing.length > 0)
    parts.push(tr(t, 'val.r.missingEpochs', { epochs: missing.map(epochLabel).join(', ') }));
  return join(parts);
}

function notDetected(t: TFunction, p: Params | null): string | null {
  const parts = [tr(t, 'val.r.not_detected_any_epoch')];
  if (Array.isArray(p?.warnings) && p.warnings.length > 0) parts.push(warningsPart(t, p.warnings));
  return join(parts);
}

function tooFew(t: TFunction, lang: Lang, p: Params): string | null {
  const measured = fin(p.epochs_measured);
  const total = fin(p.epochs_total);
  const detector = detectorLabel(p.detector_used);
  if (measured === null || total === null || !detector) return null;
  const parts = [
    tr(t, 'val.r.too_few_epochs', { measured: fmt(lang, measured, 0), total: fmt(lang, total, 0), detector }),
  ];
  if (Array.isArray(p.warnings) && p.warnings.length > 0) parts.push(warningsPart(t, p.warnings));
  return join(parts);
}

function nullTest(t: TFunction, lang: Lang, x: ValidationTest, p: Params): string | null {
  const n = fin(p.n_stars);
  const stars = recArr(p.stars);
  const detector = detectorLabel(x.detector);
  const worst = fin(x.sigma);
  const first = stars?.[0];
  if (n === null || !first || !detector || worst === null) return null;
  const id = str(first.source_id);
  const g = fin(first.g_mag);
  const pmra = fin(first.pmra_masyr);
  const pmraErr = fin(first.pmra_err_masyr);
  const pmdec = fin(first.pmdec_masyr);
  const pmdecErr = fin(first.pmdec_err_masyr);
  const sigma = fin(first.sigma);
  if (
    !id ||
    g === null ||
    pmra === null ||
    pmraErr === null ||
    pmdec === null ||
    pmdecErr === null ||
    sigma === null
  ) {
    return null;
  }
  return join([
    tr(t, 'val.r.null_test_stars', { count: n, n: fmt(lang, n, 0), detector }),
    tr(t, 'val.r.nullFirst', {
      id,
      g: fmt(lang, g, 1),
      pmra: fmt(lang, pmra, 0),
      pmraErr: fmt(lang, pmraErr, 0),
      pmdec: fmt(lang, pmdec, 0),
      pmdecErr: fmt(lang, pmdecErr, 0),
      unit: unitLabel(t, 'masyr'),
      sigma: fmt(lang, sigma, 2),
    }),
    tr(t, 'val.r.nullWorst', { sigma: fmt(lang, worst, 2) }),
  ]);
}

function variability(t: TFunction, lang: Lang, code: string, p: Params): string | null {
  const a = fin(p.epoch_a);
  const b = fin(p.epoch_b);
  const consistent = typeof p.consistent_sign === 'boolean' ? p.consistent_sign : null;
  const nPairs = fin(p.n_pairs);
  const dets = recArr(p.per_detector);
  const pairs = recArr(p.pairs);
  if (a === null || b === null || consistent === null || nPairs === null || !dets || !pairs) return null;
  const detTxt: string[] = [];
  for (const d of dets) {
    const det = fin(d.detector);
    const dm = fin(d.dmag);
    const err = fin(d.err);
    if (det === null || dm === null || err === null) return null;
    detTxt.push(`D${det} ${fmt(lang, dm, 3)} ± ${fmt(lang, err, 3)}`);
  }
  const pairTxt: string[] = [];
  for (const q of pairs) {
    const ea = fin(q.epoch_a);
    const eb = fin(q.epoch_b);
    const dm = fin(q.dmag);
    const err = fin(q.err);
    if (ea === null || eb === null || dm === null || err === null) return null;
    pairTxt.push(
      tr(t, 'val.r.pairItem', {
        a: epochLabel(ea),
        b: epochLabel(eb),
        dmag: fmt(lang, dm, 3),
        err: fmt(lang, err, 3),
      }) ?? '',
    );
  }
  const wingMode = p.method === 'psf_wing_ring';
  const wingTxt = wingMode ? wingMethod(t, lang, p) : '';
  if (wingTxt === null) return null;
  return (
    join([
      code === 'no_significant_change' ? tr(t, 'val.r.noSignificant') : '',
      wingTxt,
      tr(t, 'val.r.changeLargest', { a: epochLabel(a), b: epochLabel(b), dets: detTxt.join('; ') }),
      tr(t, consistent ? 'val.r.signYes' : 'val.r.signNo'),
      tr(t, wingMode ? 'val.r.pairsAllWing' : 'val.r.pairsAll', { pairs: pairTxt.join('; ') }),
      tr(t, 'val.r.pairsNote', { n: fmt(lang, nPairs, 0) }),
    ])?.trim() ?? null
  );
}

/** Sentence for the PSF wing ring method (saturated variable star), or null when params are malformed. */
function wingMethod(t: TFunction, lang: Lang, p: Params): string | null {
  const w = rec(p.wing);
  const ring = finArr(w?.annulus_arcsec);
  const used = fin(w?.n_points);
  const total = fin(w?.n_aperture);
  const control = str(w?.control_target);
  const sys = rec(w?.systematic_mag);
  if (!w || !ring || ring.length !== 2 || used === null || total === null || !control || !sys) return null;
  const sysTxt: string[] = [];
  for (const [det, v] of Object.entries(sys).sort(([x], [y]) => Number(x) - Number(y))) {
    const n = fin(v);
    if (n === null) return null;
    sysTxt.push(`D${det} ${fmt(lang, n, 3)}`);
  }
  const name = tr(t, `presetCopy.${control}.name`) ?? control;
  return tr(t, 'val.r.wingMethod', {
    total: fmt(lang, total, 0),
    r0: fmt(lang, ring[0] ?? 0, 0),
    r1: fmt(lang, ring[1] ?? 0, 0),
    used: fmt(lang, used, 0),
    control: name,
    sys: sysTxt.join('; '),
  });
}

/** V-08: median SPHEREx to 2MASS flux ratio per band over field stars. */
function fluxCheck(t: TFunction, lang: Lang, p: Params): string | null {
  const bands = recArr(p.bands);
  const perPreset = rec(p.per_preset);
  const ap = fin(p.aperture_arcsec);
  if (!bands || !perPreset || ap === null) return null;
  const bandTxt: string[] = [];
  for (const b of bands) {
    const band = str(b.band);
    const n = fin(b.n_stars);
    const ratio = fin(b.median_ratio);
    const err = fin(b.err);
    if (band === null || n === null) return null;
    bandTxt.push(
      ratio === null
        ? (tr(t, 'val.r.fluxBandNone', { band }) ?? '')
        : (tr(t, 'val.r.fluxBand', {
            band,
            ratio: fmt(lang, ratio, 3),
            err: err === null ? '-' : fmt(lang, err, 3),
            n: fmt(lang, n, 0),
          }) ?? ''),
    );
  }
  const presetTxt: string[] = [];
  for (const [id, v] of Object.entries(perPreset)) {
    const n = fin(v);
    if (n === null) return null;
    presetTxt.push(`${tr(t, `presetCopy.${id}.name`) ?? id} ${fmt(lang, n, 0)}`);
  }
  return join([
    tr(t, 'val.r.fluxMethod', { aperture: fmt(lang, ap, 0) }),
    tr(t, 'val.r.fluxBands', { bands: bandTxt.join('; ') }),
    tr(t, 'val.r.fluxPresets', { list: presetTxt.join(', ') }),
    fin(perPreset.rdra) === 0 ? tr(t, 'val.r.fluxRdra') : '',
    tr(t, 'val.r.fluxReference'),
  ]);
}

function dipoles(t: TFunction, lang: Lang, x: ValidationTest, p: Params): string | null {
  const nImages = fin(p.n_images);
  const nTarget = fin(p.n_at_target);
  const nUnexplained = fin(p.n_unexplained);
  const regMeasured = fin(p.registration_measured);
  const regApplied = fin(p.registration_applied);
  const resMeasured = fin(p.residual_fraction_measured);
  if (
    nImages === null ||
    nTarget === null ||
    nUnexplained === null ||
    regMeasured === null ||
    regApplied === null ||
    resMeasured === null
  ) {
    return null;
  }
  const tp = rec(x.tolerance_params);
  const sigma = fin(tp?.lobe_sigma);
  const sep = fin(tp?.lobe_separation_pix);
  const n0 = fmt(lang, nImages, 0);
  const parts: (string | null)[] = [tr(t, 'val.r.dipole_count', { n: n0 })];
  if (sigma !== null && sep !== null) {
    parts.push(tr(t, 'val.r.dipoleLobes', { sigma: fmtVal(lang, sigma), sep: fmtVal(lang, sep) }));
  }
  const shiftMed = fin(p.shift_median_arcsec);
  const shiftMax = fin(p.shift_max_arcsec);
  if (regMeasured > 0) {
    if (shiftMed === null || shiftMax === null) return null;
    parts.push(
      tr(t, 'val.r.regShift', {
        median: fmt(lang, shiftMed, 2),
        max: fmt(lang, shiftMax, 2),
        applied: fmt(lang, regApplied, 0),
        n: n0,
      }),
    );
  } else {
    parts.push(tr(t, 'val.r.regNone', { applied: fmt(lang, regApplied, 0), n: n0 }));
  }
  const resMin = fin(p.residual_fraction_min);
  const resMax = fin(p.residual_fraction_max);
  if (resMeasured > 0) {
    if (resMin === null || resMax === null) return null;
    parts.push(
      tr(t, 'val.r.resFraction', {
        min: fmt(lang, resMin, 3),
        max: fmt(lang, resMax, 3),
        measured: fmt(lang, resMeasured, 0),
        n: n0,
      }),
    );
  } else {
    parts.push(tr(t, 'val.r.resNone'));
  }
  const nBlank = fin(p.n_not_measurable);
  if (nBlank !== null) parts.push(tr(t, 'val.r.dipoleBlank', { n: fmt(lang, nBlank, 0) }));
  parts.push(
    tr(t, 'val.r.dipoleCounts', { target: fmt(lang, nTarget, 0), unexplained: fmt(lang, nUnexplained, 0) }),
  );
  return join(parts);
}

/** V-11: the F-32 motion search recovered (or did not list) the preset target. */
function motionSearch(t: TFunction, lang: Lang, x: ValidationTest, code: string, p: Params): string | null {
  const nListed = fin(p.n_listed);
  const nEpochs = fin(p.n_epochs) ?? fin(x.epochs_used);
  const baseline = fin(p.baseline_years);
  if (nListed === null || nEpochs === null || baseline === null) return null;
  if (code === 'motion_search_not_found') {
    return tr(t, 'val.r.motion_search_not_found', {
      n: fmt(lang, nListed, 0),
      epochs: fmt(lang, nEpochs, 0),
      baseline: fmt(lang, baseline, 2),
    });
  }
  const dets = finArr(p.detectors);
  const sep = fin(p.sep_arcsec);
  const pmra = fin(p.pmra_masyr);
  const pmraErr = fin(p.pmra_err_masyr);
  const pmdec = fin(p.pmdec_masyr);
  const pmdecErr = fin(p.pmdec_err_masyr);
  const rpmra = fin(p.reference_pmra_masyr);
  const rpmdec = fin(p.reference_pmdec_masyr);
  if (
    dets === null ||
    dets.length === 0 ||
    sep === null ||
    pmra === null ||
    pmraErr === null ||
    pmdec === null ||
    pmdecErr === null ||
    rpmra === null ||
    rpmdec === null
  ) {
    return null;
  }
  const unit = unitLabel(t, 'masyr');
  return join([
    tr(t, 'val.r.motion_search_recovery', {
      count: dets.length,
      detectors: dets.map((d) => `D${d}`).join(', '),
      n: fmt(lang, nEpochs, 0),
      baseline: fmt(lang, baseline, 2),
      sep: fmt(lang, sep, 1),
    }),
    tr(t, 'val.r.motionFit', {
      pmra: fmt(lang, pmra, 0),
      pmraErr: fmt(lang, pmraErr, 0),
      pmdec: fmt(lang, pmdec, 0),
      pmdecErr: fmt(lang, pmdecErr, 0),
      unit,
    }),
    tr(t, 'val.r.motionRef', { pmra: fmt(lang, rpmra, 0), pmdec: fmt(lang, rpmdec, 0), unit }),
    tr(t, 'val.r.motion_search_listed', { n: fmt(lang, nListed, 0) }),
  ]);
}

/** V-12: methane index of the target against the field stars. */
function methane(t: TFunction, lang: Lang, code: string, p: Params): string | null {
  const target = rec(p.target);
  const n = fin(p.n_stars);
  if (n === null) return null;
  if (code === 'methane_not_measurable') {
    const min = fin(p.min_stars);
    if (min !== null && n < min)
      return tr(t, 'val.r.methane_not_measurable_stars', { n: fmt(lang, n, 0), min: fmt(lang, min, 0) });
    return tr(t, 'val.r.methane_not_measurable_target');
  }
  const index = fin(target?.index);
  const err = fin(target?.index_err);
  const med = fin(p.field_median);
  const scatter = fin(p.field_scatter);
  if (index === null || err === null || med === null || scatter === null) return null;
  const sig = Math.hypot(err, scatter);
  const depth = sig > 0 ? (med - index) / sig : null;
  if (depth === null) return null;
  return tr(t, 'val.r.methane_index_vs_field', {
    index: fmt(lang, index, 3),
    err: fmt(lang, err, 3),
    n: fmt(lang, n, 0),
    median: fmt(lang, med, 3),
    scatter: fmt(lang, scatter, 3),
    depth: fmt(lang, depth, 1),
  });
}

function moverWindow(t: TFunction, lang: Lang, p: Params): string | null {
  const co2 = rec(p.co2);
  const np = rec(co2?.n_points);
  const blue = fin(np?.blue);
  const band = fin(np?.band);
  const red = fin(np?.red);
  if (blue === null || band === null || red === null) return null;
  return tr(t, 'val.r.window_not_measurable', {
    blue: fmt(lang, blue, 0),
    band: fmt(lang, band, 0),
    red: fmt(lang, red, 0),
  });
}

function moverWindowSnr(t: TFunction, lang: Lang, p: Params): string | null {
  const win = rec(rec(p.co2)?.windows);
  const get = (k: string) => {
    const w = rec(win?.[k]);
    return { n: fin(w?.n_points), snr: fin(w?.snr) };
  };
  const blue = get('blue');
  const band = get('band');
  const red = get('red');
  if ([blue, band, red].some((w) => w.n === null || w.snr === null)) return null;
  return tr(t, 'val.r.window_below_snr', {
    nBlue: fmt(lang, blue.n as number, 0),
    nBand: fmt(lang, band.n as number, 0),
    nRed: fmt(lang, red.n as number, 0),
    snrBlue: fmt(lang, blue.snr as number, 1),
    snrBand: fmt(lang, band.snr as number, 1),
    snrRed: fmt(lang, red.snr as number, 1),
  });
}

function moverBand(t: TFunction, lang: Lang, p: Params): string | null {
  const co2 = rec(p.co2);
  const np = rec(co2?.n_points);
  const bandFlux = fin(co2?.band_flux_jy);
  const cont = fin(co2?.continuum_flux_jy);
  const excess = fin(co2?.excess);
  const err = fin(co2?.excess_err);
  const sig = fin(co2?.significance);
  const blue = fin(np?.blue);
  const band = fin(np?.band);
  const red = fin(np?.red);
  if ([bandFlux, cont, excess, err, sig, blue, band, red].some((v) => v === null)) return null;
  return tr(t, 'val.r.band_excess', {
    bandFlux: fmt(lang, bandFlux as number, 4),
    cont: fmt(lang, cont as number, 4),
    excess: fmt(lang, excess as number, 3),
    err: fmt(lang, err as number, 3),
    sig: fmt(lang, sig as number, 1),
    blue: fmt(lang, blue as number, 0),
    band: fmt(lang, band as number, 0),
    red: fmt(lang, red as number, 0),
  });
}

function moverBandUndetected(t: TFunction, lang: Lang, p: Params): string | null {
  const co2 = rec(p.co2);
  const np = rec(co2?.n_points);
  const win = rec(co2?.windows);
  const v = [
    fin(co2?.band_flux_jy),
    fin(co2?.band_flux_err_jy),
    fin(co2?.continuum_flux_jy),
    fin(co2?.continuum_flux_err_jy),
    fin(co2?.significance),
    fin(co2?.continuum_upper_limit_jy),
    fin(co2?.significance_vs_upper_limit),
    fin(rec(win?.blue)?.snr),
    fin(rec(win?.red)?.snr),
    fin(np?.blue),
    fin(np?.band),
    fin(np?.red),
  ];
  if (v.some((x) => x === null)) return null;
  const n = v as number[];
  return tr(t, 'val.r.band_excess_continuum_undetected', {
    bandFlux: fmt(lang, n[0], 4),
    bandErr: fmt(lang, n[1], 4),
    cont: fmt(lang, n[2], 4),
    contErr: fmt(lang, n[3], 4),
    sig: fmt(lang, n[4], 1),
    upper: fmt(lang, n[5], 4),
    sigUpper: fmt(lang, n[6], 1),
    snrBlue: fmt(lang, n[7], 1),
    snrRed: fmt(lang, n[8], 1),
    blue: fmt(lang, n[9], 0),
    band: fmt(lang, n[10], 0),
    red: fmt(lang, n[11], 0),
  });
}

function moverEphemeris(t: TFunction, lang: Lang, p: Params): string | null {
  const within = fin(p.n_within);
  const measured = fin(p.n_measured);
  const total = fin(p.n_exposures);
  const med = fin(p.median_offset_arcsec);
  const max = fin(p.max_offset_arcsec);
  if (within === null || measured === null || total === null || med === null || max === null) return null;
  return tr(t, 'val.r.ephemeris_check', {
    within: fmt(lang, within, 0),
    measured: fmt(lang, measured, 0),
    total: fmt(lang, total, 0),
    median: fmt(lang, med, 2),
    max: fmt(lang, max, 2),
  });
}

function moverEphemerisNeighbours(t: TFunction, lang: Lang, p: Params): string | null {
  const now = moverEphemeris(t, lang, p);
  const prev = rec(p.method_version_2);
  if (now === null || !prev) return null;
  const within = fin(prev.n_within);
  const measured = fin(prev.n_measured);
  if (within === null || measured === null) return null;
  return tr(t, 'val.r.ephemeris_check_neighbours', {
    current: now,
    within: fmt(lang, within, 0),
    measured: fmt(lang, measured, 0),
  });
}

function perMission(p: Params): { wise: number; spherex: number } | null {
  const src = rec(p.epochs_per_mission) ?? p;
  const wise = fin(src.WISE);
  const spherex = fin(src.SPHEREx);
  return wise === null || spherex === null ? null : { wise, spherex };
}

function tooFewPerMission(t: TFunction, lang: Lang, p: Params): string | null {
  const n = perMission(p);
  if (!n) return null;
  return tr(t, 'val.r.too_few_epochs_per_mission', {
    wise: fmt(lang, n.wise, 0),
    spherex: fmt(lang, n.spherex, 0),
  });
}

function longBaseline(t: TFunction, lang: Lang, p: Params): string | null {
  const n = perMission(p);
  const pmra = fin(p.pmra_masyr);
  const pmraErr = fin(p.pmra_err_masyr);
  const pmdec = fin(p.pmdec_masyr);
  const pmdecErr = fin(p.pmdec_err_masyr);
  const epoch = fin(p.ref_epoch_jyear);
  const total = fin(p.n_epochs);
  if (!n || [pmra, pmraErr, pmdec, pmdecErr, epoch, total].some((v) => v === null)) return null;
  const chi2 = fin(p.chi2_red);
  const parts = [
    tr(t, 'val.r.long_baseline_fit', {
      pmra: fmt(lang, pmra as number, 1),
      pmraErr: fmt(lang, pmraErr as number, 1),
      pmdec: fmt(lang, pmdec as number, 1),
      pmdecErr: fmt(lang, pmdecErr as number, 1),
      epoch: fmt(lang, epoch as number, 2),
      total: fmt(lang, total as number, 0),
      wise: fmt(lang, n.wise, 0),
      spherex: fmt(lang, n.spherex, 0),
    }),
  ];
  if (chi2 !== null) parts.push(tr(t, 'val.r.long_baseline_chi2', { chi2: fmt(lang, chi2, 2) }) ?? '');
  return join(parts);
}

export function localizedReason(t: TFunction, lang: Lang, x: ValidationTest): string {
  const fallback = x.reason ?? '';
  const code = str(x.reason_code);
  if (!code) return fallback;
  const p = rec(x.reason_params);
  let out: string | null = null;
  switch (code) {
    case 'recalibration_residuals':
      out = p ? recalibration(t, lang, p) : null;
      break;
    case 'motion_fit':
      out = p ? motionFit(t, lang, x, p) : null;
      break;
    case 'position_separations':
      out = p ? separations(t, lang, x, p) : null;
      break;
    case 'not_detected_any_epoch':
      out = notDetected(t, p);
      break;
    case 'too_few_epochs':
      out = p ? tooFew(t, lang, p) : null;
      break;
    case 'null_test_stars':
      out = p ? nullTest(t, lang, x, p) : null;
      break;
    case 'change_detected':
    case 'no_significant_change':
      out = p ? variability(t, lang, code, p) : null;
      break;
    case 'dipole_count':
      out = p ? dipoles(t, lang, x, p) : null;
      break;
    case 'flux_crosscheck_2mass':
      out = p ? fluxCheck(t, lang, p) : null;
      break;
    case 'motion_search_recovery':
    case 'motion_search_not_found':
      out = p ? motionSearch(t, lang, x, code, p) : null;
      break;
    case 'methane_index_vs_field':
    case 'methane_not_measurable':
      out = p ? methane(t, lang, code, p) : null;
      break;
    case 'window_not_measurable':
      out = p ? moverWindow(t, lang, p) : null;
      break;
    case 'window_below_snr':
      out = p ? moverWindowSnr(t, lang, p) : null;
      break;
    case 'band_excess':
      out = p ? moverBand(t, lang, p) : null;
      break;
    case 'band_excess_continuum_undetected':
      out = p ? moverBandUndetected(t, lang, p) : null;
      break;
    case 'ephemeris_check':
      out = p ? moverEphemeris(t, lang, p) : null;
      break;
    case 'ephemeris_check_neighbours':
      out = p ? moverEphemerisNeighbours(t, lang, p) : null;
      break;
    case 'too_few_epochs_per_mission':
      out = p ? tooFewPerMission(t, lang, p) : null;
      break;
    case 'long_baseline_fit':
      out = p ? longBaseline(t, lang, p) : null;
      break;
    case 'science_error': {
      const c = str(p?.error_code);
      out = c ? tr(t, 'val.r.science_error', { code: c }) : null;
      break;
    }
    case 'measurement_error': {
      const e = str(p?.exception);
      out = e ? tr(t, 'val.r.measurement_error', { exception: e }) : null;
      break;
    }
    case 'no_suitable_star': {
      const stars = Array.isArray(p?.stars) ? p.stars.length : null;
      out =
        stars !== null && stars > 0
          ? tr(t, 'val.r.no_suitable_star_n', { count: stars, n: fmt(lang, stars, 0) })
          : tr(t, 'val.r.no_suitable_star');
      break;
    }
    case 'no_reference_motion':
    case 'no_reference_stars':
    case 'gaia_unavailable':
    case 'fewer_than_two_epochs':
    case 'no_shared_wavelengths':
    case 'no_coadd_pair':
    case 'irsa_tool_interactive':
    case 'too_few_flux_stars':
    case 'recalibration_catalog_not_gaia':
    case 'no_wise_companion':
      out = tr(t, `val.r.${code}`);
      break;
    default:
      break;
  }
  return out ?? fallback;
}

// ---------------------------------------------------------------------------------------------- source
/** Stable identifiers (gaia_dr3) and the fixed forced-photometry label are translated; other text is shown as sent. */
export function localizedSource(t: TFunction, _lang: Lang, x: ValidationTest): string {
  const s = x.source ?? '';
  if (!s) return '';
  const known = tr(t, `val.catalogs.${s}`);
  if (known) return known;
  if (s === 'SPHEREx forced photometry (this work)') return tr(t, 'val.sourceForced') ?? s;
  if (s === 'SPHEREx PSF wing photometry (this work)') return tr(t, 'val.sourceWing') ?? s;
  return s;
}
