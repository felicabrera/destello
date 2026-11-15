/* DEV FIXTURE. Everything in this folder is synthetic development data generated from the docs/06 schema.
   It is NEVER bundled into production: lib/api.ts imports it only behind `import.meta.env.DEV`.
   scripts/check_placeholders.py must flag any import of this folder from production code paths.
   Coordinates are the public catalog values quoted in docs/03; motions are illustrative. Frames are synthetic
   gradients with Gaussian stars and are NOT SPHEREx data. */
import openapi from './openapi.json';
import type {
  AstrometryResponse,
  Candidate,
  CandidatesResult,
  DifferenceResult,
  EpochInfo,
  FrameInfo,
  Manifest,
  MotionSearchResult,
  MotionSource,
  OverlayData,
  PathData,
  CheckSummary,
  DetectorNum,
  ReportCheckResult,
  ReportChecks,
  ReportCreated,
  ReportDocument,
  ReportMark,
  ReportMarkIn,
  ReportRequest,
  SeqEvent,
  SpectrumResponse,
  TargetItem,
  ValidationReport,
} from '../lib/types';
import { cometFixture } from './comet';
import { skyToPixel, frameSize, propagate, refEpochToMjd } from '../lib/astrometry';

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SCALE = 3.1;
const RELEASE = 'spherex_qr3';
const DOI = '10.26131/IRSA662';
const DATA_AS_OF = '2026-11-05';
const EPOCH_MIDS = [60813.4, 60995.1, 61181.0];
// F-31: with include_partial the fixture adds one short revisit after the last full epoch. It observed only D2, D5
// and the broadband coadd, so the player has to handle a detector without a frame in that epoch.
const LOW_MID = 61214.6;
const LOW_DETS = [0, 2, 5];
function midOf(e: number): number {
  return e === EPOCH_MIDS.length ? LOW_MID : (EPOCH_MIDS[e] ?? EPOCH_MIDS[0]);
}
const BANDS: [number, number][] = [
  [0.75, 1.09],
  [1.09, 1.63],
  [1.63, 2.41],
  [2.41, 3.82],
  [3.82, 4.42],
  [4.42, 5.0],
];

interface FxTarget {
  id: string;
  names: { en: string; es: string };
  ra: number;
  dec: number;
  ref: string | null;
  pmra: number;
  pmdec: number;
  fov: number;
  det: string | number;
  flux: number[];
  /** relative brightness per detector D1..D6 */
  sed: number[];
  seed: number;
  panel?: string;
}

const T: FxTarget[] = [
  {
    id: 'barnard',
    names: { en: "Barnard's Star", es: 'Estrella de Barnard' },
    ra: 269.4521,
    dec: 4.6934,
    ref: 'J2000.0',
    pmra: -798.6,
    pmdec: 10328.1,
    fov: 6,
    det: 'all',
    flux: [2.4, 2.4, 2.4],
    sed: [0.45, 1.1, 1, 0.7, 0.55, 0.45],
    seed: 42,
  },
  {
    id: 'wise0855',
    names: { en: 'WISE 0855-0714', es: 'WISE 0855-0714' },
    ra: 133.79513,
    dec: -7.24515,
    ref: 'J2015.4',
    pmra: -8118,
    pmdec: 673,
    fov: 8,
    det: 6,
    flux: [0.95, 0.95, 0.95],
    sed: [0, 0, 0, 0.05, 0.55, 1],
    seed: 17,
  },
  {
    id: 'epsindib',
    names: { en: 'Epsilon Indi B', es: 'Épsilon Indi B' },
    ra: 331.0467,
    dec: -56.7969,
    ref: 'J2016.0',
    pmra: 3980,
    pmdec: -2470,
    fov: 10,
    det: 'all',
    flux: [1.5, 1.5, 1.5],
    sed: [0.3, 0.6, 0.5, 0.4, 0.8, 0.7],
    seed: 7,
  },
  {
    id: 'rwaur',
    names: { en: 'RW Aurigae', es: 'RW Aurigae' },
    ra: 76.9563,
    dec: 30.4014,
    ref: 'J2016.0',
    pmra: 0,
    pmdec: 0,
    fov: 4,
    det: 3,
    flux: [1.6, 0.55, 1.15],
    sed: [1, 0.9, 0.8, 0.7, 0.6, 0.5],
    seed: 23,
  },
  {
    id: 'rdra',
    names: { en: 'R Draconis', es: 'R Draconis' },
    ra: 248.1675,
    dec: 66.755,
    ref: 'J2016.0',
    pmra: 0,
    pmdec: 0,
    fov: 4,
    det: 'all',
    flux: [2.3, 1.45, 2.0],
    sed: [1, 1.1, 1, 0.8, 0.6, 0.5],
    seed: 31,
    panel: 'spectrum',
  },
];

function fx(): string | null {
  return new URLSearchParams(window.location.search).get('fx') ?? sessionStorage.getItem('destello.fx');
}

function hex16(s: string): string {
  let h1 = 0xdeadbeef ^ s.length;
  let h2 = 0x41c6ce57 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, '0');
  const b = (h2 >>> 0).toString(16).padStart(8, '0');
  return a + b;
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Spec {
  id: string;
  target?: FxTarget;
  ra: number;
  dec: number;
  fov: number;
  /** Full epochs; measurements use only these. */
  nEpochs: number;
  /** F-31: one extra low coverage epoch at index nEpochs. */
  low: boolean;
}
const registry = new Map<string, Spec>();

function specFor(ra: number, dec: number, fov: number, target?: FxTarget, partial = false): Spec {
  const id = hex16(
    `${target?.id ?? 'custom'}|${ra.toFixed(5)}|${dec.toFixed(5)}|${fov}${partial ? '|partial' : ''}`,
  );
  const single = Math.abs(ra - 80) < 0.01 && Math.abs(dec - 28.16667) < 0.01;
  const nEpochs = single || fx() === 'single' ? 1 : 3;
  const spec = { id, target, ra, dec, fov, nEpochs, low: partial && nEpochs === 3 };
  registry.set(id, spec);
  return spec;
}

function targetItems(): TargetItem[] {
  return T.map((t) => {
    const spec = specFor(t.ra, t.dec, t.fov, t);
    const item: TargetItem = {
      id: t.id,
      names: t.names,
      ra_deg: t.ra,
      dec_deg: t.dec,
      astrometry: {
        source: 'DEV FIXTURE',
        ref_epoch: t.ref,
        ra_deg: t.ra,
        dec_deg: t.dec,
        pmra_masyr: t.pmra,
        pmdec_masyr: t.pmdec,
      },
      default_view: {
        fov_arcmin: t.fov,
        detectors: [1, 2, 3, 4, 5, 6],
        det: t.det,
        mode: 'blink',
        panel: t.panel,
      },
      sequence_id: spec.id,
      // Mirrors the server: the saturated star is flagged as not measurable by validation.
      not_measurable: t.id === 'rdra',
    };
    if (fx() === 'results') {
      item.result =
        t.pmra || t.pmdec
          ? {
              kind: 'motion',
              value: Math.hypot(t.pmra, t.pmdec) / 1000,
              err: 0.4,
              unit: 'arcsec/yr',
              reference_value: Math.hypot(t.pmra, t.pmdec) / 1000,
              reference_source: 'DEV FIXTURE',
              agreement_sigma: 0.2,
            }
          : { kind: 'variability', value: -31, err: 3, unit: 'percent', significance_sigma: 10 };
    }
    return item;
  });
}

// ---------- synthetic frames ----------
interface Star {
  x: number;
  y: number;
  f: number;
  id: string;
}
function fieldStars(spec: Spec, n: number): Star[] {
  const r = rng((spec.target?.seed ?? 99) * 7919 + Math.round(spec.fov));
  const count = Math.round(n * 0.9);
  const out: Star[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: r() * n,
      y: r() * n,
      f: Math.pow(r(), 3.2) * 1.6 + 0.04,
      id: `${4472800000000000000 + Math.floor(r() * 1e12)}`,
    });
  }
  return out;
}

function targetPixel(spec: Spec, e: number, n: number): { x: number; y: number } | null {
  const t = spec.target;
  if (!t) return null;
  const mid = midOf(e);
  const pos = propagate(
    { ra_deg: t.ra, dec_deg: t.dec, ref_epoch: t.ref, pmra_masyr: t.pmra, pmdec_masyr: t.pmdec },
    mid,
  );
  const meanMid = EPOCH_MIDS.reduce((a, b) => a + b, 0) / EPOCH_MIDS.length;
  const center = propagate(
    { ra_deg: t.ra, dec_deg: t.dec, ref_epoch: t.ref, pmra_masyr: t.pmra, pmdec_masyr: t.pmdec },
    meanMid,
  );
  return skyToPixel({ ra0: center.ra, dec0: center.dec, scaleArcsec: SCALE, n }, pos.ra, pos.dec);
}

const floatCache = new Map<string, Float32Array>();
function render(spec: Spec, e: number, det: number): { n: number; data: Float32Array } {
  const n = frameSize(spec.fov, SCALE);
  const key = `${spec.id}|${e}|${det}`;
  const hit = floatCache.get(key);
  if (hit) return { n, data: hit };
  const data = new Float32Array(n * n);
  const sedK = det === 0 ? 1 : (spec.target?.sed[det - 1] ?? 0.6) * 0 + 1;
  const stars = fieldStars(spec, n);
  const r = rng(spec.id.length * 31 + e * 17 + det * 101);
  // background gradient and noise
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) data[y * n + x] = 0.04 + 0.03 * (x / n) + 0.02 * (y / n) + (r() - 0.5) * 0.03;
  const blob = (cx: number, cy: number, f: number) => {
    const s = 1.15;
    const R = 5;
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(n, Math.ceil(cy + R)); y++) {
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(n, Math.ceil(cx + R)); x++) {
        const d2 = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
        data[y * n + x] += f * Math.exp(-d2 / (2 * s * s));
      }
    }
  };
  for (const s of stars) blob(s.x, s.y, s.f * sedK);
  const tp = targetPixel(spec, e, n);
  if (tp && spec.target) {
    const k = det === 0 ? spec.target.sed.reduce((a, b) => a + b, 0) / 6 : spec.target.sed[det - 1];
    blob(tp.x, tp.y, (spec.target.flux[e] ?? spec.target.flux[0]) * Math.max(k, 0));
  }
  floatCache.set(key, data);
  return { n, data };
}

function canvasUrl(n: number, fill: (img: ImageData) => void): string {
  const c = document.createElement('canvas');
  c.width = n;
  c.height = n;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(n, n);
  fill(img);
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

const urlCache = new Map<string, string>();
function frameUrl(spec: Spec, e: number, det: number): string {
  const key = `f|${spec.id}|${e}|${det}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const { n, data } = render(spec, e, det);
  const url = canvasUrl(n, (img) => {
    for (let i = 0; i < data.length; i++) {
      const v = Math.max(0, Math.min(1, Math.asinh(Math.max(data[i], 0) * 6) / Math.asinh(6 * 1.6)));
      const g = Math.round(v * 255);
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
  });
  urlCache.set(key, url);
  return url;
}
function flagsUrl(spec: Spec, e: number, det: number): string {
  const key = `m|${spec.id}|${e}|${det}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const n = frameSize(spec.fov, SCALE);
  const r = rng(e * 13 + det * 7 + 5);
  const url = canvasUrl(n, (img) => {
    for (let i = 0; i < n * n; i++) {
      const x = i % n;
      const y = Math.floor(i / n);
      const edge = x < 2 || y < 2 || x >= n - 2 || y >= n - 2;
      const flagged = (edge && r() < 0.5) || r() < 0.004;
      img.data[i * 4 + 3] = flagged ? 255 : 0;
      img.data[i * 4] = 242;
    }
  });
  urlCache.set(key, url);
  return url;
}

function diffUrl(spec: Spec, a: number, b: number, det: number): string {
  const key = `d|${spec.id}|${a}|${b}|${det}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const A = render(spec, a, det);
  const B = render(spec, b, det);
  const url = canvasUrl(A.n, (img) => {
    for (let i = 0; i < A.data.length; i++) {
      const d = Math.max(-1, Math.min(1, (A.data[i] - B.data[i]) / 0.9));
      const t = Math.sign(d) * Math.pow(Math.abs(d), 0.8);
      // negative: blue (61,123,255), zero: gray (110,114,128), positive: orange (255,138,61)
      const [r, g, bl] =
        t < 0 ? mix([110, 114, 128], [61, 123, 255], -t) : mix([110, 114, 128], [255, 138, 61], t);
      img.data[i * 4] = r;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = bl;
      img.data[i * 4 + 3] = 255;
    }
  });
  urlCache.set(key, url);
  return url;
}
function mix(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

// ---------- manifests ----------
function epochCount(spec: Spec): number {
  return spec.nEpochs + (spec.low ? 1 : 0);
}

function epochInfo(spec: Spec, e: number): EpochInfo {
  const low = spec.low && e === spec.nEpochs;
  const mid = midOf(e);
  const frames: FrameInfo[] = [];
  const dets = low ? LOW_DETS : [0, 1, 2, 3, 4, 5, 6];
  for (const d of dets) {
    const missing =
      spec.target && d >= 1 && spec.target.sed[d - 1] === 0 && spec.target.id === 'wise0855' && d <= 3;
    if (missing) continue;
    const id = hex16(`${spec.id}|${e}|${d}`);
    frames.push({
      detector: d,
      kind: 'coadd',
      url: frameUrl(spec, e, d),
      fits_url: `/frames/${id}.fits`,
      flags_url: flagsUrl(spec, e, d),
      mask_flags: (e + d) % 2 === 0 ? ['HOT', 'MISSING_DATA', 'PERSIST'] : ['COLD', 'HOT'],
      wavelength_um: d === 0 ? [0.75, 5.0] : BANDS[d - 1],
      n_images: low ? (d === 0 ? 9 : 3 + (d % 2)) : d === 0 ? 68 : 11 + ((e + d) % 4),
      flagged_fraction: 0.02 + 0.004 * ((e + d) % 5),
      obs_ids: Array.from(
        { length: d === 0 ? 6 : 3 },
        (_, i) => `DEV-FIXTURE-${spec.id.slice(0, 6)}-${e + 1}-${d}-${i + 1}`,
      ),
    });
  }
  const half = low ? 1 : 6;
  return {
    index: e,
    t_start: new Date((mid - 40587 - half) * 86400000).toISOString().replace(/\.\d+Z$/, 'Z'),
    t_end: new Date((mid - 40587 + half) * 86400000).toISOString().replace(/\.\d+Z$/, 'Z'),
    t_mid_mjd: mid,
    n_images: low ? 9 : 68,
    frames,
    coverage: low ? 'low' : 'full',
  };
}

function manifest(spec: Spec): Manifest {
  const n = frameSize(spec.fov, SCALE);
  const stretch: Manifest['stretch'] = {};
  for (let d = 0; d <= 6; d++)
    stretch[String(d)] = { method: 'asinh', vmin: -0.02, vmax: 1.8, unit: 'MJy/sr' };
  return {
    schema_version: 1,
    sequence_id: spec.id,
    pipeline_version: 'dev-fixture',
    created_at: '2026-11-09T00:00:00Z',
    request: {
      ra_deg: spec.ra,
      dec_deg: spec.dec,
      fov_arcmin: spec.fov,
      detectors: [1, 2, 3, 4, 5, 6],
      release: RELEASE,
    },
    grid: { projection: 'TAN', crval_deg: [spec.ra, spec.dec], pixel_scale_arcsec: SCALE, naxis: [n, n] },
    epochs: Array.from({ length: epochCount(spec) }, (_, e) => epochInfo(spec, e)),
    stretch,
    provenance: { collections: [RELEASE], dois: [DOI], services: ['DEV FIXTURE'] },
    warnings: spec.low
      ? [
          {
            code: 'EPOCH_LOW_COVERAGE',
            detail: `A partial revisit of 9 images around MJD ${LOW_MID} is shown as a low coverage epoch: it is not used in measurements.`,
          },
        ]
      : [],
    data_as_of: DATA_AS_OF,
    // F-26 tests only: names a photometry sidecar, which the test serves from a real demo sidecar.
    photometry_url: fxPhot() ? `/manifests/${spec.id}.photometry.json` : null,
  };
}

function fxPhot(): boolean {
  try {
    return sessionStorage.getItem('destello.fxPhot') === '1';
  } catch {
    return false;
  }
}

// F-27 path. DEV FIXTURE: linear motion only, and the ellipse is a synthetic loop of the stated parallax so the
// layer can be exercised without the backend. The real endpoint computes both with astropy.
function pathFor(spec: Spec, q: URLSearchParams): PathData {
  const m = manifest(spec);
  const n = frameSize(spec.fov, SCALE);
  const grid = { ra0: spec.ra, dec0: spec.dec, scaleArcsec: SCALE, n };
  const motion = {
    ra_deg: Number(q.get('ra_deg')),
    dec_deg: Number(q.get('dec_deg')),
    ref_epoch: q.get('ref_epoch'),
    pmra_masyr: Number(q.get('pmra_masyr')),
    pmdec_masyr: Number(q.get('pmdec_masyr')),
  };
  const plx = Number(q.get('parallax_mas') ?? 0);
  const at = (t: number) => {
    const pos = propagate(motion, t);
    const xy = skyToPixel(grid, pos.ra, pos.dec);
    return { t_mjd: t, x: xy.x, y: xy.y, ra_deg: pos.ra, dec_deg: pos.dec };
  };
  const mids = m.epochs.map((e) => e.t_mid_mjd ?? 0);
  const t0 = Math.min(...mids) - 6;
  const t1 = Math.max(...mids) + 6;
  const steps = Math.max(2, Math.ceil((t1 - t0) / 2) + 1);
  const path = Array.from({ length: steps }, (_, i) => at(t0 + ((t1 - t0) * i) / (steps - 1)));
  const tc = mids.reduce((a, b) => a + b, 0) / mids.length;
  const c = at(tc);
  const r = plx / 1000 / SCALE;
  return {
    sequence_id: spec.id,
    ref_epoch: motion.ref_epoch ?? 'J2016.0',
    pmra_masyr: motion.pmra_masyr,
    pmdec_masyr: motion.pmdec_masyr,
    parallax_mas: plx,
    observer: 'geocentric',
    t_start_mjd: t0,
    t_end_mjd: t1,
    pixel_scale_arcsec: SCALE,
    path,
    epochs: m.epochs.map((e) => ({ index: e.index, ...at(e.t_mid_mjd ?? 0) })),
    ellipse:
      plx > 0
        ? {
            center_t_mjd: tc,
            center_x: c.x,
            center_y: c.y,
            semi_major_arcsec: plx / 1000,
            semi_minor_arcsec: plx / 2000,
            points: Array.from({ length: 73 }, (_, i): [number, number] => {
              const a = (2 * Math.PI * i) / 72;
              return [c.x + r * Math.cos(a), c.y + 0.5 * r * Math.sin(a)];
            }),
          }
        : null,
  };
}

// F-29 candidates. DEV FIXTURE: positions and significances are synthetic, drawn from a seeded generator, so the
// list, the markers and every status can be exercised without the backend. The real endpoint detects them on
// the difference images. `fx=candempty` returns no entries, `fx=candcat` a catalog outage and a cut list.
function candidatesFor(spec: Spec, a: number, b: number): CandidatesResult {
  const n = frameSize(spec.fov, SCALE);
  const r = rng(spec.id.length * 53 + a * 29 + b * 13 + (spec.target?.seed ?? 5));
  const f = fx();
  const outage = f === 'candcat';
  const at = (x: number, y: number) => {
    // Inverse of skyToPixel on the tangent plane (north up, east left), adequate for a synthetic field.
    const dDec = ((n / 2 - y) * SCALE) / 3600;
    const dRa = ((n / 2 - x) * SCALE) / 3600 / Math.cos((spec.dec * Math.PI) / 180);
    return { ra_deg: spec.ra + dRa, dec_deg: spec.dec + dDec, x, y };
  };
  const cell = () => Math.floor(6 + r() * (n - 12)) + 0.5;
  const list: Candidate[] = [];
  const add = (c: Omit<Candidate, 'id' | 'ra_deg' | 'dec_deg'>) =>
    list.push({ ...c, ...at(c.x, c.y), id: `c${list.length + 1}` });
  const plain = (
    status: Candidate['status'],
    kind: Candidate['kind'],
    snr: number,
    detectors: number[],
    match: Candidate['match'] = null,
    x = cell(),
    y = cell(),
  ) =>
    add({
      kind,
      status,
      snr,
      snr_local: Math.round(snr * 9.5) / 10,
      detectors,
      snr_by_detector: detectors.map((_d, i) => Math.round((snr - i * 0.7) * 100) / 100),
      x,
      y,
      a: null,
      b: null,
      separation_arcsec: null,
      match,
    });
  if (f !== 'candempty') {
    const first = outage ? 'unchecked' : 'unmatched';
    plain(first, 'brighter_in_a', 9.6, [3, 4, 5]);
    plain(first, 'brighter_in_b', 7.4, [3, 4, 5]);
    const mx = cell();
    const my = cell();
    const pa = at(mx + 1.5, my - 0.5);
    const pb = at(mx - 1.5, my + 0.5);
    add({
      kind: 'moved',
      status: first,
      snr: 6.8,
      snr_local: 6.5,
      detectors: [4],
      snr_by_detector: [6.8],
      x: mx,
      y: my,
      a: pa,
      b: pb,
      separation_arcsec: Math.round(Math.hypot(3, 1) * SCALE * 10) / 10,
      match: null,
    });
    const tp = targetPixel(spec, a, n);
    const gaia = (sep: number): Candidate['match'] => ({
      catalog: 'gaia_dr3',
      source_id: `DEV-${4472800000000000000 + Math.floor(r() * 1e12)}`,
      sep_arcsec: sep,
      mag: 16.7,
      mag_band: 'G',
      pm_total_masyr: 3.2,
    });
    plain(
      'target',
      'brighter_in_a',
      174.4,
      [5, 6],
      gaia(3.64),
      Math.floor(tp?.x ?? n / 2) + 0.5,
      Math.floor(tp?.y ?? n / 2) + 0.5,
    );
    plain('target', 'brighter_in_b', 11.5, [2, 3, 4], null, Math.floor(n / 2) + 2.5, Math.floor(n / 2) - 1.5);
    plain('known_source', 'brighter_in_a', 8.1, [1, 2], gaia(1.2));
    plain('not_measurable', 'brighter_in_b', 5.9, [5, 6], null, 4.5, cell());
  }
  const count = (s: Candidate['status']) => list.filter((c) => c.status === s).length;
  return {
    sequence_id: spec.id,
    epoch_a: a,
    epoch_b: b,
    threshold_sigma: 5,
    pair_max_arcsec: 12.4,
    match_radius_arcsec: 6.2,
    min_detectors_unpaired: 2,
    target_radius_arcsec: 15,
    target_wing_radius_arcsec: 30,
    method_version: 'dev-fixture',
    detectors: [1, 2, 3, 4, 5, 6].map((d) => ({
      detector: d,
      usable: true,
      n_features: 3 + d,
      n_extended: d,
      residual_fraction: 0.1,
      registration_applied: d % 2 === 0,
      n_stars_used: 15,
    })),
    catalogs: { gaia_dr3: 'ok', catwise2020: outage ? 'unavailable' : 'ok' },
    counts: {
      listed: list.length,
      single_detector_dropped: 16,
      extended_dropped: 37,
      unmatched: count('unmatched'),
      unchecked: count('unchecked'),
      target: count('target'),
      known_source: count('known_source'),
      not_measurable: count('not_measurable'),
    },
    truncated: outage,
    candidates: list,
  };
}

/**
 * F-32 motion search. WISE 0855 answers TOO_FEW_EPOCHS, as the real sequence does; Epsilon Indi B lists one source
 * at the target with the values the real search measured; the other fixtures list nothing. `fx=motionmany` adds a
 * source without a catalog match and a catalog source, `fx=motioncat` makes CatWISE2020 unavailable.
 */
function motionFor(spec: Spec): MotionSearchResult {
  const n = frameSize(spec.fov, SCALE);
  const f = fx();
  const outage = f === 'motioncat';
  const at = (x: number, y: number) => {
    const dDec = ((n / 2 - y) * SCALE) / 3600;
    const dRa = ((n / 2 - x) * SCALE) / 3600 / Math.cos((spec.dec * Math.PI) / 180);
    return { ra_deg: spec.ra + dRa, dec_deg: spec.dec + dDec, x, y };
  };
  const jyear = (mjd: number) => 2000 + (mjd - 51544.5) / 365.25;
  const epochs = Array.from({ length: spec.nEpochs }, (_v, i) => i);
  const meanMid = epochs.reduce((a, e) => a + midOf(e), 0) / epochs.length;
  const sources: MotionSource[] = [];
  const add = (
    status: MotionSource['status'],
    track: { x: number; y: number }[],
    pm: [number, number, number],
    detectors: number[],
    snr: number,
    match: MotionSource['match'] = null,
  ) => {
    const x = track.reduce((a, q) => a + q.x, 0) / track.length;
    const y = track.reduce((a, q) => a + q.y, 0) / track.length;
    sources.push({
      id: `m${sources.length + 1}`,
      status,
      snr,
      detectors,
      snr_by_detector: detectors.map((_d, i) => Math.round((snr - i * 4.1) * 10) / 10),
      pmra_masyr: pm[0],
      pmdec_masyr: pm[1],
      pmra_err_masyr: pm[2],
      pmdec_err_masyr: pm[2],
      pm_total_masyr: Math.round(Math.hypot(pm[0], pm[1])),
      ref_epoch_jyear: jyear(meanMid),
      ...at(x, y),
      track: track.map((q, i) => ({ epoch: epochs[i], ...at(q.x, q.y) })),
      match,
    });
  };
  if (spec.target?.id === 'epsindib') {
    const track = epochs.map((e) => targetPixel(spec, e, n) ?? { x: n / 2, y: n / 2 });
    add('target', track, [3748, -2567, 165], [2, 3, 4, 5, 6], 38.2);
  }
  if (f === 'motionmany') {
    const line = (x0: number, y0: number, dx: number, dy: number) =>
      epochs.map((e) => ({ x: x0 + dx * e, y: y0 + dy * e }));
    add(
      outage ? 'unchecked' : 'unmatched',
      line(n * 0.25, n * 0.3, 0.9, 0.4),
      [-1420, 610, 240],
      [3, 4],
      7.1,
    );
    add('known_source', line(n * 0.7, n * 0.75, -0.3, -0.6), [480, 1050, 210], [1, 2, 3], 12.6, {
      catalog: 'gaia_dr3',
      source_id: 'DEV-4472832130942575872',
      sep_arcsec: 1.4,
      mag: 13.2,
      mag_band: 'G',
      pmra_masyr: 455.1,
      pmdec_masyr: 1032.4,
      pm_total_masyr: 1128.3,
      agreement_sigma: 0.2,
    });
  }
  const count = (st: MotionSource['status']) => sources.filter((m) => m.status === st).length;
  return {
    sequence_id: spec.id,
    method_version: 'dev-fixture',
    epochs,
    baseline_years: (midOf(spec.nEpochs - 1) - midOf(0)) / 365.25,
    ref_epoch_jyear: jyear(meanMid),
    mu_max_arcsec_yr: 10,
    step_arcsec_yr: 0.5,
    threshold_sigma: 5,
    epoch_min_sigma: 3,
    min_motion_sigma: 3,
    min_detectors: 2,
    match_radius_arcsec: 6.2,
    target_radius_arcsec: 15,
    detectors: [1, 2, 3, 4, 5, 6].map((d) => ({
      detector: d,
      usable: true,
      n_epochs: spec.nEpochs,
      n_trials: 1257,
      step_arcsec_yr: 0.5,
      n_peaks: 4 + d,
      n_fitted: 3 + d,
      n_moving: d >= 2 ? 1 : 0,
      residual_fraction: 0.1,
    })),
    catalogs: { gaia_dr3: 'ok', catwise2020: outage ? 'unavailable' : 'ok' },
    counts: {
      listed: sources.length,
      single_detector_dropped: 2,
      unmatched: count('unmatched'),
      unchecked: count('unchecked'),
      target: count('target'),
      known_source: count('known_source'),
    },
    truncated: false,
    sources,
  };
}

function overlay(spec: Spec, catalog: string): OverlayData {
  const n = frameSize(spec.fov, SCALE);
  const stars = fieldStars(spec, n);
  const pick =
    catalog === 'catwise2020' ? stars.filter((_, i) => i % 5 === 0) : stars.filter((_, i) => i % 3 !== 0);
  return {
    catalog,
    epochs: Array.from({ length: epochCount(spec) }, (_, e) => {
      const sources = pick.map((s) => ({
        id: s.id,
        x: s.x,
        y: s.y,
        mag: Math.round((14 - s.f * 3) * 10) / 10,
        pmra_masyr: 0,
        pmdec_masyr: 0,
      }));
      const tp = targetPixel(spec, e, n);
      if (tp && spec.target && catalog === 'gaia_dr3' && spec.target.id !== 'wise0855') {
        sources.push({
          id: `DEV-${spec.target.id}`,
          x: tp.x,
          y: tp.y,
          mag: 9.5,
          pmra_masyr: spec.target.pmra,
          pmdec_masyr: spec.target.pmdec,
        });
      }
      if (tp && spec.target && catalog === 'catwise2020' && spec.target.id === 'wise0855') {
        sources.push({
          id: 'DEV-CatWISE-wise0855',
          x: tp.x,
          y: tp.y,
          mag: 14.0,
          pmra_masyr: spec.target.pmra,
          pmdec_masyr: spec.target.pmdec,
        });
      }
      return { index: e, sources };
    }),
  };
}

// ---------- spectrum, astrometry, validation (DEV FIXTURE numbers, not SPHEREx measurements) ----------
function spectrumFor(spec: Spec): SpectrumResponse {
  const t = spec.target;
  const r = rng(spec.id.length * 13 + 5);
  const points: SpectrumResponse['points'] = [];
  const phot: SpectrumResponse['epoch_photometry'] = [];
  for (let e = 0; e < spec.nEpochs; e++) {
    for (let d = 1; d <= 6; d++) {
      const k = t ? t.sed[d - 1] : 0.5;
      if (k <= 0) continue;
      const base = (t ? (t.flux[e] ?? t.flux[0]) : 0.12) * k * 4;
      const [lo, hi] = BANDS[d - 1];
      let sum = 0;
      const nPts = 17;
      for (let i = 0; i < nPts; i++) {
        const w = lo + ((i + 0.5) / nPts) * (hi - lo);
        const f = base * (1 + 0.15 * Math.sin(w * 3 + e)) * (0.97 + 0.06 * r());
        const sat = t?.id === 'rdra' && e === 0 && d <= 2;
        sum += f;
        points.push({
          epoch: e,
          obs_id: `DEV-FIXTURE-${spec.id.slice(0, 6)}-${e + 1}-${d}-${i + 1}`,
          wavelength_um: Math.round(w * 1000) / 1000,
          bandwidth_um: Math.round(((hi - lo) / nPts) * 1000) / 1000,
          flux: f,
          flux_err: f * 0.05,
          flagged: i === 3 && d === 4 && e === 1,
          detector: d,
          saturated: sat,
        });
      }
      phot.push({
        epoch: e,
        detector: d,
        flux: sum / nPts,
        flux_err: (sum / nPts) * 0.04,
        n_images: 11 + ((e + d) % 4),
        saturated: t?.id === 'rdra' && e === 0 && d <= 2,
      });
    }
  }
  return { unit: 'Jy', points, epoch_photometry: phot, aperture_arcsec: 9.3 };
}

function astrometryFor(spec: Spec, det: number | null): AstrometryResponse | null {
  if (spec.nEpochs < 2) return null;
  const t = spec.target;
  const r = rng(spec.id.length * 17 + 3);
  const mids = EPOCH_MIDS.slice(0, spec.nEpochs);
  const epochs = mids.map((m, i) => {
    const pos = t
      ? propagate(
          { ra_deg: t.ra, dec_deg: t.dec, ref_epoch: t.ref, pmra_masyr: t.pmra, pmdec_masyr: t.pmdec },
          m,
        )
      : { ra: spec.ra, dec: spec.dec };
    return {
      index: i,
      t_mid_mjd: m,
      measured: true,
      ra_deg: pos.ra + ((r() - 0.5) * 0.8) / 3600,
      dec_deg: pos.dec + ((r() - 0.5) * 0.8) / 3600,
      err_arcsec: 0.6 + r() * 0.5,
      recalibration_stars: 20 + Math.round(r() * 15),
    };
  });
  const pmra = t?.pmra ?? 0;
  const pmdec = t?.pmdec ?? 0;
  const moving = Math.abs(pmra) + Math.abs(pmdec) > 0;
  return {
    detector_used: det ?? 6,
    epochs,
    fit: {
      pmra_masyr: pmra * 1.01,
      pmdec_masyr: pmdec * 0.99,
      pmra_err_masyr: Math.max(40, Math.abs(pmra) * 0.05),
      pmdec_err_masyr: Math.max(40, Math.abs(pmdec) * 0.05),
      parallax_mas: moving ? 400 : null,
      parallax_fixed: true,
      chi2_red: 1.1,
    },
    reference: moving
      ? { pmra_masyr: pmra, pmdec_masyr: pmdec, pmra_err_masyr: 5, pmdec_err_masyr: 5, source: 'DEV FIXTURE' }
      : null,
    agreement_sigma: moving ? 0.3 : null,
    warnings: t?.id === 'epsindib' ? [{ code: 'BLENDED_SOURCE', detail: 'DEV FIXTURE unresolved pair' }] : [],
  };
}

function validationFixture(): ValidationReport {
  const mk = (
    id: string,
    name: string,
    target: string,
    measured: number,
    reference: number,
    sigma: number,
    src: string,
  ) => ({
    id,
    name,
    target,
    status: 'pass' as const,
    measured,
    reference,
    source: src,
    sigma,
    tolerance: 'DEV FIXTURE tolerance',
    tolerance_code: 'within_sigma',
    tolerance_value: 3,
    tolerance_unit: 'sigma',
    tolerance_params: null,
    reason: null,
    reason_code: null,
    reason_params: null,
    epochs_used: 3,
    detector: 6,
    unit: 'arcsec/yr',
  });
  return {
    generated_at: '2026-11-09T00:00:00Z',
    pipeline_version: 'dev-fixture',
    release: RELEASE,
    tests: [
      mk('V-02', 'Proper motion, Dec', 'barnard', 10.33, 10.33, 0.4, 'DEV FIXTURE'),
      mk('V-03', 'Proper motion, RA', 'wise0855', -8.12, -8.12, 0.2, 'DEV FIXTURE'),
      {
        id: 'V-04',
        name: 'Total proper motion',
        target: 'epsindib',
        status: 'not_measurable' as const,
        measured: null,
        reference: null,
        source: null,
        sigma: null,
        tolerance: 'DEV FIXTURE tolerance',
        tolerance_code: 'within_sigma',
        tolerance_value: 3,
        tolerance_unit: 'sigma',
        tolerance_params: null,
        reason: 'DEV FIXTURE: the pair is unresolved at the SPHEREx pixel scale.',
        reason_code: 'too_few_epochs',
        reason_params: {
          epochs_measured: 1,
          epochs_total: 3,
          detector_used: 6,
          warnings: ['EPSILON_INDI_UNRESOLVED'],
        },
        epochs_used: 3,
        detector: null,
        unit: 'arcsec/yr',
      },
    ],
    residuals: [
      {
        target: 'barnard',
        epochs: EPOCH_MIDS.map((m, i) => ({
          index: i,
          t_mid_mjd: m,
          dra_arcsec: [0.3, -0.5, 0.2][i],
          ddec_arcsec: [-0.2, 0.4, -0.2][i],
        })),
      },
    ],
  };
}

// ---------- request handling ----------
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pending = new Map<string, Spec>();
/** Progressive build state of the simulated builds: requested priority and detectors published so far. */
const priorities = new Map<string, number>();
const readyDets = new Map<string, number[]>();
/** Time at which a simulated build finishes: it keeps running after its stream is closed. */
const buildEnds = new Map<string, number>();

function detectorOrder(spec: Spec, priority?: number): number[] {
  const first = epochInfo(spec, 0);
  const have = [6, 5, 4, 3, 2, 1].filter((d) => first.frames.some((f) => f.detector === d));
  return priority && have.includes(priority) ? [priority, ...have.filter((d) => d !== priority)] : have;
}

function partialManifest(spec: Spec, ready: number[]): Manifest {
  const full = manifest(spec);
  const stretch: Manifest['stretch'] = {};
  for (const d of ready) stretch[String(d)] = full.stretch[String(d)];
  const order = detectorOrder(spec, priorities.get(spec.id));
  return {
    ...full,
    epochs: full.epochs.map((e) => ({
      ...e,
      frames: e.frames.filter((f) => typeof f.detector === 'number' && ready.includes(f.detector)),
    })),
    stretch,
    photometry_url: null,
    build: {
      status: 'partial',
      priority_detector: priorities.get(spec.id) ?? null,
      detectors_ready: ready,
      detectors_pending: order.filter((d) => !ready.includes(d)),
    },
  };
}

export async function handle(method: string, path: string, body: unknown): Promise<Reply> {
  await delay(60);
  const [rawPath, qs] = path.split('?');
  const p = rawPath.replace(/^\/api\/v1/, '');
  const q = new URLSearchParams(qs ?? '');
  const cf = cometFixture(method, p);
  if (cf) return cf;
  if (method === 'GET' && p === '/health') {
    const f = fx();
    return {
      status: 200,
      body: {
        status: 'ok',
        version: 'dev-fixture',
        pipeline_version: 'dev-fixture',
        irsa: f === 'irsa' ? 'degraded' : f === 'irsadown' ? 'down' : 'ok',
      },
    };
  }
  if (method === 'GET' && p === '/openapi.json') return { status: 200, body: openapi };
  if (method === 'GET' && p === '/releases') {
    return {
      status: 200,
      body: {
        default: 'all',
        releases: [
          { collection: RELEASE, label: 'Quick Release 3', doi: DOI, data_as_of: DATA_AS_OF },
          {
            collection: 'spherex_dr1',
            label: 'Data Release 1',
            doi: '10.26131/IRSA678',
            data_as_of: DATA_AS_OF,
          },
        ],
      },
    };
  }
  if (method === 'GET' && p === '/targets') return { status: 200, body: { targets: targetItems() } };
  if (method === 'GET' && p === '/resolve') {
    const name = q.get('name') ?? '';
    return {
      status: 404,
      body: { code: 'NOT_FOUND', detail: `DEV FIXTURE resolver has no entry for ${name}` },
    };
  }
  if (method === 'GET' && p === '/sequences/estimate') {
    const fov = Number(q.get('fov_arcmin') ?? 6);
    const images = Math.round(60 + fov * fov * 1.2);
    return {
      status: 200,
      body: { images, megabytes: Math.round(images * 0.09), seconds: Math.round(12 + images * 0.18) },
    };
  }
  if (method === 'POST' && p === '/sequences') {
    const req = body as {
      ra_deg: number;
      dec_deg: number;
      fov_arcmin: number;
      priority_detector?: number;
      include_partial?: boolean;
    };
    const f = fx();
    if (f === 'rate')
      return {
        status: 429,
        headers: { 'retry-after': '252' },
        body: { code: 'RATE_LIMITED', detail: 'rate limited' },
      };
    if (f === 'error')
      return { status: 500, body: { code: 'BUILD_FAILED', detail: 'DEV FIXTURE forced error' } };
    if (Math.abs(req.dec_deg - -63.33333) < 0.02 || f === 'nodata') {
      return { status: 422, body: { code: 'NO_COVERAGE', detail: 'No SPHEREx images cover this position.' } };
    }
    const t = T.find((x) => Math.abs(x.ra - req.ra_deg) < 0.05 && Math.abs(x.dec - req.dec_deg) < 0.05);
    const spec = specFor(req.ra_deg, req.dec_deg, req.fov_arcmin, t, req.include_partial === true);
    if (t && Math.round(req.fov_arcmin) === t.fov) {
      return {
        status: 200,
        body: { sequence_id: spec.id, status: 'ready', manifest_url: `/manifests/${spec.id}.json` },
      };
    }
    pending.set(spec.id, spec);
    const slow = Math.max(1, Number(sessionStorage.getItem('destello.fxSlow')) || 1);
    if (!buildEnds.has(spec.id)) buildEnds.set(spec.id, Date.now() + (3300 + epochCount(spec) * 1500) * slow);
    if (req.priority_detector) priorities.set(spec.id, req.priority_detector);
    else priorities.delete(spec.id);
    const images = Math.round(60 + req.fov_arcmin ** 2 * 1.2);
    return {
      status: 202,
      body: {
        sequence_id: spec.id,
        status: 'queued',
        events_url: `/api/v1/sequences/${spec.id}/events`,
        estimate: { images, megabytes: Math.round(images * 0.09), seconds: 9 },
      },
    };
  }
  if (method === 'GET' && p === '/validation') {
    if (fx() === 'novalidation')
      return { status: 404, body: { code: 'NOT_FOUND', detail: 'no validation run' } };
    return { status: 200, body: validationFixture() };
  }
  const sx = /^\/sequences\/([0-9a-f]{16})\/(spectrum|astrometry)$/.exec(p);
  if (sx) {
    const spec = registry.get(sx[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    await delay(300);
    if (sx[2] === 'spectrum' && method === 'GET') return { status: 200, body: spectrumFor(spec) };
    if (sx[2] === 'astrometry' && method === 'POST') {
      const a = astrometryFor(spec, (body as { detector: number | null }).detector);
      if (!a)
        return { status: 422, body: { code: 'TOO_FEW_EPOCHS', detail: 'at least two epochs are needed' } };
      return { status: 200, body: a };
    }
  }
  const px = /^\/sequences\/([0-9a-f]{16})\/path$/.exec(p);
  if (method === 'GET' && px) {
    const spec = registry.get(px[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    await delay(80);
    return { status: 200, body: pathFor(spec, q) };
  }
  const cx = /^\/sequences\/([0-9a-f]{16})\/candidates$/.exec(p);
  if (method === 'GET' && cx) {
    const spec = registry.get(cx[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    const a = Number(q.get('a'));
    const b = Number(q.get('b'));
    await delay(150);
    if (fx() === 'canderr')
      return {
        status: 429,
        headers: { 'retry-after': '30' },
        body: { code: 'RATE_LIMITED', detail: 'DEV FIXTURE forced rate limit' },
      };
    if (spec.nEpochs < 2)
      return { status: 422, body: { code: 'TOO_FEW_EPOCHS', detail: 'at least two epochs are needed' } };
    if (spec.low && (a === spec.nEpochs || b === spec.nEpochs))
      return {
        status: 422,
        body: { code: 'LOW_COVERAGE_EPOCH', detail: 'Candidates are not computed for a low coverage epoch.' },
      };
    const ok = (v: number) => Number.isInteger(v) && v >= 0 && v < spec.nEpochs;
    if (!ok(a) || !ok(b) || a === b)
      return {
        status: 422,
        body: { code: 'INVALID_EPOCHS', detail: 'a and b must be distinct epoch indices.' },
      };
    return { status: 200, body: candidatesFor(spec, a, b) };
  }
  const mx = /^\/sequences\/([0-9a-f]{16})\/motion-search$/.exec(p);
  if (method === 'GET' && mx) {
    const spec = registry.get(mx[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    await delay(400);
    if (fx() === 'motionerr')
      return {
        status: 429,
        headers: { 'retry-after': '30' },
        body: { code: 'RATE_LIMITED', detail: 'DEV FIXTURE forced rate limit' },
      };
    if (spec.nEpochs < 3 || spec.target?.id === 'wise0855')
      return {
        status: 422,
        body: {
          code: 'TOO_FEW_EPOCHS',
          detail: 'The motion search needs three or more full coverage epochs.',
        },
      };
    return { status: 200, body: motionFor(spec) };
  }
  const pm = /^\/sequences\/([0-9a-f]{16})\/manifest$/.exec(p);
  if (method === 'GET' && pm) {
    const spec = registry.get(pm[1]);
    const ready = readyDets.get(pm[1]);
    if (!spec || (ready && ready.length === 0))
      return { status: 404, body: { code: 'NOT_FOUND', detail: 'no manifest yet' } };
    if (ready) return { status: 200, body: partialManifest(spec, ready) };
    const order = detectorOrder(spec);
    return {
      status: 200,
      body: {
        ...manifest(spec),
        build: { status: 'complete', priority_detector: null, detectors_ready: order, detectors_pending: [] },
      },
    };
  }
  const m = /^\/sequences\/([0-9a-f]{16})(?:\/(difference|overlays\/(\w+)))?$/.exec(p);
  if (method === 'GET' && m) {
    const spec = registry.get(m[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    if (!m[2]) {
      const end = buildEnds.get(spec.id);
      if (end !== undefined && Date.now() < end)
        return {
          status: 200,
          body: {
            sequence_id: spec.id,
            status: 'running',
            events_url: `/api/v1/sequences/${spec.id}/events`,
            detectors_ready: readyDets.get(spec.id) ?? [],
          },
        };
      return {
        status: 200,
        body: { sequence_id: spec.id, status: 'ready', manifest_url: `/manifests/${spec.id}.json` },
      };
    }
    if (m[2] === 'difference') {
      const a = Number(q.get('a'));
      const b = Number(q.get('b'));
      const det = Number(q.get('detector') ?? 0);
      await delay(250);
      const has = (e: number) =>
        Number.isInteger(e) &&
        e >= 0 &&
        e < epochCount(spec) &&
        epochInfo(spec, e).frames.some((f) => f.detector === det);
      if (!has(a) || !has(b))
        return {
          status: 404,
          body: { code: 'NOT_FOUND', detail: 'no frame for this detector in that epoch' },
        };
      const res: DifferenceResult = { url: diffUrl(spec, a, b, det), scale: 0.97, n_stars_used: 23 };
      return { status: 200, body: res };
    }
    await delay(120);
    return { status: 200, body: overlay(spec, m[3]) };
  }
  const mm = /^\/manifests\/([0-9a-f]{16})\.json$/.exec(p);
  if (method === 'GET' && mm) {
    const spec = registry.get(mm[1]);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown manifest' } };
    return { status: 200, body: manifest(spec) };
  }
  if (p === '/reports/check' || p === '/reports' || p.startsWith('/reports/')) {
    return reportRoute(method, p, body);
  }
  if (p.startsWith('/hunt/')) return huntRoute(method, p, body);
  return { status: 404, body: { code: 'NOT_FOUND', detail: `DEV FIXTURE has no route ${method} ${p}` } };
}

// ---------- F-22 candidate reports (docs/06 section 3.6) ----------
const reports = new Map<string, ReportDocument>();
const FX_REPORT_ID = 'fxReport01';
const NO_HITS = (status: CheckSummary['status'], extra: Partial<CheckSummary> = {}): CheckSummary => ({
  status,
  nearest: null,
  ...extra,
});

function reportMarks(spec: Spec, marks: ReportMarkIn[], detector: number): ReportMark[] {
  return marks.map((m, i) => {
    const ep = epochInfo(spec, m.epoch);
    const f = ep.frames.find((x) => x.detector === detector) ?? ep.frames[0];
    const mid = EPOCH_MIDS[m.epoch];
    return {
      ...m,
      index: i,
      t_mid_mjd: mid,
      t_mid: new Date((mid - 40587) * 86400000).toISOString().replace(/\.\d+Z$/, 'Z'),
      frame: {
        detector: f.detector,
        url: f.url,
        t_start: ep.t_start,
        t_end: ep.t_end,
        wavelength_um: f.wavelength_um,
        obs_ids: f.obs_ids,
      },
    };
  });
}

function reportChecks(marks: ReportMark[]): ReportChecks {
  const a = marks[0];
  const b = marks[marks.length - 1];
  const days = b.t_mid_mjd - a.t_mid_mjd;
  const yr = Math.max(days, 1) / 365.25;
  const dra = (b.ra_deg - a.ra_deg) * Math.cos((a.dec_deg * Math.PI) / 180) * 3600;
  const ddec = (b.dec_deg - a.dec_deg) * 3600;
  const pa = ((Math.atan2(dra, ddec) * 180) / Math.PI + 360) % 360;
  const total = Math.hypot(dra, ddec) / yr;
  const sigma = (Math.SQRT2 * 3.1) / yr;
  return {
    version: 1,
    gaia_dr3: [],
    catwise2020: [],
    simbad: [],
    sbident: [],
    estimated_motion_arcsec_yr: total,
    motion: {
      n_marks: marks.length,
      pmra_cosdec_arcsec_yr: dra / yr,
      pmdec_arcsec_yr: ddec / yr,
      total_arcsec_yr: total,
      sigma_arcsec_yr: sigma,
      significance: total / sigma,
      position_angle_deg: pa,
      baseline_days: days,
      rms_residual_arcsec: marks.length > 2 ? 0.9 : null,
      mark_sigma_arcsec: 3.1,
      parallax_fitted: false,
    },
    summary: {
      gaia_dr3: NO_HITS('no_match', { radius_arcsec: 10, searched: 41, n_matches: 0, complete: true }),
      catwise2020: NO_HITS('no_match', { radius_arcsec: 10, searched: 17, n_matches: 0, complete: true }),
      simbad: NO_HITS('no_match', { radius_arcsec: 20, searched: 3, n_matches: 0, complete: true }),
      sbident: NO_HITS('no_match', {
        half_width_arcsec: 60,
        n_matches: 0,
        observer: 'geocentric',
        complete: true,
      }),
    },
    verdict: 'no_match',
  };
}

function reportDoc(
  id: string,
  spec: Spec,
  marks: ReportMark[],
  checks: ReportChecks,
  notes: string,
  det: DetectorNum,
) {
  const doc: ReportDocument = {
    schema_version: 1,
    report_id: id,
    url: `/r/${id}`,
    created_at: '2026-11-10T12:00:00Z',
    status: 'unconfirmed',
    sequence: {
      sequence_id: spec.id,
      manifest_url: `/manifests/${spec.id}.json`,
      pipeline_version: 'dev-fixture',
      manifest_created_at: '2026-11-09T00:00:00Z',
      center_deg: [spec.ra, spec.dec],
      fov_arcmin: spec.fov,
      target_id: spec.target?.id ?? null,
      n_epochs: spec.nEpochs,
      collections: [RELEASE],
      dois: [DOI],
    },
    detector: det,
    marks,
    checks,
    notes,
    disclaimer: 'DEV FIXTURE. Unconfirmed candidate.',
    next_steps: [
      {
        id: 'backyard_worlds',
        name: 'Backyard Worlds: Planet 9',
        url: 'https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9',
        text: '',
      },
      { id: 'mpc', name: 'Minor Planet Center', url: 'https://www.minorplanetcenter.net/', text: '' },
    ],
  };
  return doc;
}

function presetReport(): ReportDocument {
  const t = T[0];
  const spec = specFor(t.ra, t.dec, t.fov, t);
  const marks = reportMarks(
    spec,
    [
      { epoch: 0, ra_deg: t.ra + 0.004, dec_deg: t.dec + 0.003 },
      { epoch: 1, ra_deg: t.ra + 0.0041, dec_deg: t.dec + 0.0032 },
      { epoch: 2, ra_deg: t.ra + 0.0042, dec_deg: t.dec + 0.0034 },
    ],
    1,
  );
  return reportDoc(FX_REPORT_ID, spec, marks, reportChecks(marks), 'DEV FIXTURE notes.', 1);
}

async function reportRoute(method: string, p: string, body: unknown): Promise<Reply> {
  const f = fx();
  if (f === 'reportsdown')
    return { status: 503, body: { code: 'REPORTS_UNAVAILABLE', detail: 'DEV FIXTURE reports down' } };
  if (method === 'POST' && (p === '/reports/check' || p === '/reports')) {
    if (f === 'rate')
      return {
        status: 429,
        headers: { 'retry-after': '60' },
        body: { code: 'RATE_LIMITED', detail: 'rate limited' },
      };
    const req = body as ReportRequest;
    const spec = registry.get(req.sequence_id);
    if (!spec) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown sequence' } };
    const epochs = new Set(req.marks.map((m) => m.epoch));
    if (req.marks.length < 2 || epochs.size !== req.marks.length)
      return { status: 422, body: { code: 'INVALID_MARKS', detail: 'one mark per epoch, two or more' } };
    const det = typeof req.detector === 'number' ? req.detector : 1;
    const marks = reportMarks(spec, req.marks, det);
    const checks = reportChecks(marks);
    await delay(400);
    if (p === '/reports/check') {
      const res: ReportCheckResult = { sequence_id: spec.id, marks, checks };
      return { status: 200, body: res };
    }
    const id = `fx${hex16(`${spec.id}|${JSON.stringify(req.marks)}|${reports.size}`).slice(0, 8)}`;
    reports.set(id, reportDoc(id, spec, marks, checks, req.notes ?? '', det));
    const res: ReportCreated = { report_id: id, url: `/r/${id}`, checks };
    return { status: 201, body: res };
  }
  const g = /^\/reports\/([A-Za-z0-9_-]{10})(\.json|\.txt)?$/.exec(p);
  if (method === 'GET' && g) {
    const doc = reports.get(g[1]) ?? (g[1] === FX_REPORT_ID ? presetReport() : undefined);
    if (!doc) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown report' } };
    return { status: 200, body: doc };
  }
  return { status: 404, body: { code: 'NOT_FOUND', detail: `DEV FIXTURE has no route ${method} ${p}` } };
}

/** Simulated SSE stream: queued, running, progress per stage, detector_ready per detector, epoch_ready per epoch, completed. */
export function openFixtureEvents(id: string, onEvent: (e: SeqEvent) => void): () => void {
  const spec = pending.get(id) ?? registry.get(id);
  const timers: ReturnType<typeof setTimeout>[] = [];
  // sessionStorage destello.fxSlow stretches the simulated build (e.g. "3" makes it three times longer), so
  // tests can act on the building state without racing the timers.
  const slow = Math.max(1, Number(sessionStorage.getItem('destello.fxSlow')) || 1);
  const later = (fn: () => void, ms: number) => setTimeout(fn, ms * slow);
  const at = (ms: number, e: SeqEvent) => timers.push(later(() => onEvent(e), ms));
  if (!spec) {
    at(50, { type: 'failed', data: { code: 'NOT_FOUND' } });
    return () => timers.forEach(clearTimeout);
  }
  const total = 140;
  at(100, { type: 'status', data: { status: 'queued', position: 1 } });
  at(700, { type: 'status', data: { status: 'running' } });
  for (let i = 1; i <= 4; i++)
    at(800 + i * 250, {
      type: 'progress',
      data: { stage: 'query', done: Math.round((total * i) / 4), total },
    });
  for (let i = 1; i <= 10; i++)
    at(1900 + i * 300, {
      type: 'progress',
      data: { stage: 'cutouts', done: Math.round((total * i) / 10), total },
    });
  // Progressive build: one detector at a time, the requested one first, all before the first epoch_ready.
  const order = detectorOrder(spec, priorities.get(id));
  const full = manifest(spec);
  readyDets.set(id, []);
  order.forEach((d, i) => {
    timers.push(
      later(
        () => {
          const ready = [...(readyDets.get(id) ?? []), d];
          readyDets.set(id, ready);
          onEvent({
            type: 'detector_ready',
            data: {
              detector: d,
              stretch: full.stretch[String(d)],
              frames: full.epochs.flatMap((e) =>
                e.frames.filter((f) => f.detector === d).map((f) => ({ ...f, epoch: e.index })),
              ),
              manifest_url: `/api/v1/sequences/${id}/manifest`,
              detectors_ready: ready,
              detectors_pending: order.filter((x) => !ready.includes(x)),
            },
          });
        },
        2200 + i * 140,
      ),
    );
  });
  const count = epochCount(spec);
  for (let e = 0; e < count; e++) {
    const ep = epochInfo(spec, e);
    at(2600 + e * 1500, { type: 'progress', data: { stage: 'coadd', done: e + 1, total: count } });
    at(3000 + e * 1500, { type: 'progress', data: { stage: 'render', done: e + 1, total: count } });
    at(3100 + e * 1500, {
      type: 'epoch_ready',
      data: {
        epoch: e,
        frames: ep.frames,
        t_start: ep.t_start,
        t_end: ep.t_end,
        t_mid_mjd: ep.t_mid_mjd,
        n_images: ep.n_images,
        coverage: ep.coverage,
      },
    });
  }
  const end = 3300 + count * 1500;
  if (fx() === 'failbuild')
    at(end - 1500, { type: 'failed', data: { code: 'IRSA_UNAVAILABLE', retry_after_s: 300 } });
  else at(end, { type: 'completed', data: { manifest_url: `/manifests/${spec.id}.json` } });
  timers.push(later(() => readyDets.delete(id), end - 10));
  return () => {
    timers.forEach(clearTimeout);
    readyDets.delete(id);
  };
}

export { refEpochToMjd };

// ---------- F-35 Hunt (docs/06): a small field bank, votes kept in memory, gold answers revealed after the vote ----------
interface HuntFx {
  id: string;
  ra: number;
  dec: number;
  gold: boolean;
}
const HUNT_FX: HuntFx[] = [
  { id: 'rnd-01', ra: 34.8427, dec: -26.577, gold: false },
  { id: 'ecl-01', ra: 10.1, dec: 4.2, gold: false },
  { id: 'gold-01', ra: 77.95994, dec: -45.0438, gold: true },
  { id: 'rnd-02', ra: 163.1837, dec: 54.751, gold: false },
  { id: 'gold-02', ra: 178.2673, dec: 37.6928, gold: true },
];
/** DEV FIXTURE: opaque id of a fixture field, 16 hex digits like the API. */
const huntPub = (h: HuntFx): string => (HUNT_FX.indexOf(h) + 1).toString(16).padStart(16, '0');
const huntVotes: { session: string; field: string; label: string }[] = [];

/** The Hunt switch lives in its own storage key: the page rewrites its URL for every field. */
function huntRoute(method: string, p: string, body: unknown): Reply {
  const f = sessionStorage.getItem('destello.fxHunt') ?? fx();
  if (f === 'huntdown')
    return { status: 503, body: { code: 'HUNT_UNAVAILABLE', detail: 'DEV FIXTURE hunt down' } };
  if (method === 'GET' && p === '/hunt/counters') {
    const gold = huntVotes.filter((v) => HUNT_FX.find((h) => h.id === v.field)?.gold);
    const ok = gold.filter((v) => v.label === 'mover').length;
    return {
      status: 200,
      body: {
        fields_reviewed: new Set(huntVotes.map((v) => v.field)).size,
        classifications: huntVotes.length,
        gold_votes: gold.length,
        gold_accuracy: gold.length ? ok / gold.length : null,
        countries: 0,
      },
    };
  }
  if (method === 'GET' && p === '/hunt/candidates') {
    const h = HUNT_FX[0];
    const spec = specFor(h.ra, h.dec, 6);
    // DEV FIXTURE: one agreement, only when the spec asks for it; otherwise the honest empty list.
    const list =
      f === 'huntcands'
        ? [
            {
              field_id: huntPub(h),
              status: 'volunteer_consensus_unconfirmed',
              label: 'mover',
              share: 0.8,
              n_votes: 6,
              sequence_id: spec.id,
              center_deg: { ra: h.ra, dec: h.dec },
              mark: null,
            },
          ]
        : [];
    return { status: 200, body: { status: 'volunteer_consensus_unconfirmed', candidates: list } };
  }
  if (method === 'POST' && p === '/hunt/next') {
    const { session } = body as { session: string };
    const seen = new Set(huntVotes.filter((v) => v.session === session).map((v) => v.field));
    if (f === 'huntempty') return { status: 200, body: { field: null, remaining: 0, reviewed: 0 } };
    const left = HUNT_FX.filter((h) => !seen.has(h.id));
    const h = left[0];
    if (!h) return { status: 200, body: { field: null, remaining: 0, reviewed: seen.size } };
    const spec = specFor(h.ra, h.dec, 6);
    return {
      status: 200,
      body: {
        field: {
          field_id: huntPub(h),
          vote_token: `fixture-${huntPub(h)}`,
          sequence_id: spec.id,
          epochs: spec.nEpochs,
          center_deg: { ra: h.ra, dec: h.dec },
          fov_arcmin: 6,
          manifest_url: `/manifests/${spec.id}.json`,
        },
        remaining: left.length,
        reviewed: seen.size,
      },
    };
  }
  if (method === 'POST' && p === '/hunt/votes') {
    const req = body as {
      session: string;
      field_id: string;
      vote_token: string;
      label: string;
      turnstile_token?: string;
    };
    const h = HUNT_FX.find((x) => huntPub(x) === req.field_id);
    if (!h) return { status: 404, body: { code: 'NOT_FOUND', detail: 'unknown field' } };
    if (f === 'huntrate')
      return {
        status: 429,
        headers: { 'retry-after': '20' },
        body: { code: 'RATE_LIMITED', detail: 'rate limited' },
      };
    if (f === 'hunttoken' && huntVotes.length >= 1 && !req.turnstile_token)
      return { status: 403, body: { code: 'TURNSTILE_FAILED', detail: 'Verification required.' } };
    if (huntVotes.some((v) => v.session === req.session && v.field === h.id))
      return { status: 409, body: { code: 'ALREADY_VOTED', detail: 'already voted' } };
    huntVotes.push({ session: req.session, field: h.id, label: req.label });
    return {
      status: 201,
      body: {
        accepted: true,
        gold: h.gold ? { answer: 'mover', correct: req.label === 'mover' } : null,
      },
    };
  }
  return { status: 404, body: { code: 'NOT_FOUND', detail: `DEV FIXTURE has no route ${method} ${p}` } };
}
