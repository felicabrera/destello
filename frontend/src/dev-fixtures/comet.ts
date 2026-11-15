/* DEV FIXTURE for the moving-target page (F-33). Synthetic images and numbers generated here for development
   and tests only; never bundled into production (lib/api.ts imports dev-fixtures only behind import.meta.env.DEV).
   Nothing here is SPHEREx or NEOSSat data. */
import type { Manifest, MoverListing, MoverSpectrum, NeossatDoc } from '../lib/types';

interface Reply {
  status: number;
  body: unknown;
}

export const COMET_SEQ = 'c0e7c0e7c0e7c0e7';
const N = 96;
const MID0 = 61017.0;
const BANDS: [number, number][] = [
  [0.74, 1.11],
  [1.11, 1.64],
  [1.64, 2.42],
  [2.42, 3.82],
  [3.82, 4.42],
  [4.42, 5.0],
];
const PER_DET = 8;

function img(draw: (d: Uint8ClampedArray) => void): string {
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const im = ctx.createImageData(N, N);
  draw(im.data);
  ctx.putImageData(im, 0, 0);
  return c.toDataURL('image/png');
}

function exposureImage(seed: number, stack: boolean): string {
  return img((d) => {
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        let v = 28 + ((x * 7 + y * 13 + seed * 5) % 9);
        // The comet stays at the center; the stars drift between frames (or trail in the stack).
        const cc = Math.exp(-((x - N / 2) ** 2 + (y - N / 2) ** 2) / 30) * 200;
        v += cc;
        for (let s = 0; s < 5; s++) {
          const sx = (s * 19 + 11 + (stack ? 0 : seed * 3)) % N;
          const sy = (s * 29 + 7 + (stack ? 0 : seed * 2)) % N;
          if (stack) {
            for (let k = 0; k < 10; k++) {
              const tx = sx + k * 3;
              const ty = sy + k * 2;
              v += 60 * Math.exp(-((x - tx) ** 2 + (y - ty) ** 2) / 3);
            }
          } else v += 140 * Math.exp(-((x - sx) ** 2 + (y - sy) ** 2) / 3);
        }
        const g = Math.max(0, Math.min(255, v));
        d[i] = d[i + 1] = d[i + 2] = g;
        d[i + 3] = 255;
      }
  });
}

function obsId(det: number, k: number): string {
  return `DEV-FIXTURE-COMET-D${det}-${String(k + 1).padStart(2, '0')}`;
}

function manifest(): Manifest {
  const epochs: Manifest['epochs'] = [];
  const stacks: NonNullable<Manifest['moving_target']>['stacks'] = [];
  const stretch: Manifest['stretch'] = {};
  for (let k = 0; k < PER_DET; k++) {
    const mid = MID0 + k * 0.4;
    epochs.push({
      index: k,
      t_mid_mjd: mid,
      n_images: 6,
      coverage: 'full',
      frames: [1, 2, 3, 4, 5, 6].map((det) => {
        const ra = 173.8 + k * 0.002;
        const dec = 2.8 - k * 0.0005;
        return {
          detector: det,
          kind: 'exposure',
          url: exposureImage(k + det * 11, false),
          wavelength_um: BANDS[det - 1],
          n_images: 1,
          flagged_fraction: 0.03,
          obs_ids: [obsId(det, k)],
          t_mid_mjd: mid,
          center_deg: [ra, dec] as [number, number],
          target_wavelength_um:
            BANDS[det - 1][0] + ((BANDS[det - 1][1] - BANDS[det - 1][0]) * (k + 1)) / (PER_DET + 1),
          campaign: 0,
          ephemeris: { ra_deg: ra, dec_deg: dec, solution: 'DEV-FIXTURE' },
        };
      }),
    });
  }
  for (let det = 1; det <= 6; det++) {
    stretch[String(det)] = { method: 'asinh', vmin: 0, vmax: 1, softening: 0.1, unit: 'MJy/sr' };
    stretch[`stack${det}`] = { method: 'asinh', vmin: 0, vmax: 1, softening: 0.1, unit: 'MJy/sr' };
    stacks.push({
      detector: det,
      kind: 'stack',
      url: exposureImage(det, true),
      wavelength_um: BANDS[det - 1],
      n_images: PER_DET,
      flagged_fraction: 0.03,
      obs_ids: Array.from({ length: PER_DET }, (_, k) => obsId(det, k)),
      campaign: 0,
    });
  }
  return {
    schema_version: 1,
    sequence_id: COMET_SEQ,
    pipeline_version: 'dev-fixture',
    created_at: '2026-11-14T00:00:00Z',
    request: { ra_deg: 173.8, dec_deg: 2.8, fov_arcmin: 5, detectors: [1, 2, 3, 4, 5, 6] },
    grid: { projection: 'TAN', crval_deg: [173.8, 2.8], pixel_scale_arcsec: 3.1, naxis: [N, N] },
    epochs,
    stretch,
    provenance: { collections: ['spherex_dr1'], dois: ['10.26131/IRSA678'], services: ['DEV FIXTURE'] },
    warnings: [
      { code: 'MOVING_TARGET', detail: 'x' },
      { code: 'NO_APERTURE_CORRECTION', detail: 'x' },
    ],
    moving_target: {
      designation: '3I/ATLAS',
      name: 'DEV FIXTURE comet',
      horizons_record: 0,
      solution: 'DEV-FIXTURE',
      aperture_arcsec: 24.8,
      annulus_arcsec: [240, 360],
      campaigns: [
        {
          index: 0,
          t_start: '2025-12-08T00:00:00Z',
          t_end: '2025-12-15T00:00:00Z',
          t_mid_mjd: MID0,
          n_images: PER_DET * 6,
          parallax_bound_arcsec: 5.4,
        },
      ],
      stacks,
      spectrum_url: `/api/v1/movers/${COMET_SEQ}/spectrum`,
      ephemeris_check_url: `/api/v1/movers/${COMET_SEQ}/ephemeris-check`,
    },
  };
}

function spectrum(): MoverSpectrum {
  const points: MoverSpectrum['points'] = [];
  for (let det = 1; det <= 6; det++)
    for (let k = 0; k < PER_DET; k++) {
      const wl = BANDS[det - 1][0] + ((BANDS[det - 1][1] - BANDS[det - 1][0]) * (k + 1)) / (PER_DET + 1);
      points.push({
        obs_id: obsId(det, k),
        detector: det,
        t_mid_mjd: MID0 + k * 0.4,
        wavelength_um: wl,
        flux: 0.1 + 0.02 * det + 0.005 * k,
        flux_err: 0.01,
        flagged: (det + k) % 7 === 0,
        reason: (det + k) % 7 === 0 ? 'aperture_masked' : null,
        campaign: 0,
      });
    }
  const win = (b: [number, number], bl: [number, number], rd: [number, number]) => ({
    band: b,
    blue: bl,
    red: rd,
  });
  return {
    sequence_id: COMET_SEQ,
    designation: '3I/ATLAS',
    solution: 'DEV-FIXTURE',
    aperture_arcsec: 24.8,
    annulus_arcsec: [240, 360],
    unit: 'Jy',
    points,
    bands: {
      '0': {
        co2: {
          band: 'co2',
          windows_um: win([4.23, 4.27], [4.0, 4.17], [4.33, 4.5]),
          n_points: { band: 1, blue: 4, red: 3 },
          excess: null,
          excess_err: null,
          significance: null,
          reason: 'window_not_measurable:band',
        },
        h2o: {
          band: 'h2o',
          windows_um: win([2.7, 2.8], [2.5, 2.65], [2.85, 3.0]),
          n_points: { band: 2, blue: 2, red: 2 },
          excess: null,
          excess_err: null,
          significance: null,
          reason: 'window_not_measurable:blue,band',
        },
      },
    },
  };
}

function neossat(): NeossatDoc {
  const items: NeossatDoc['items'] = [];
  for (let det = 1; det <= 6; det++)
    for (let k = 0; k < PER_DET; k++) {
      // A match exists only for the first three exposures of each detector; the rest show the empty state.
      const has = k < 3;
      items.push({
        obs_id: obsId(det, k),
        t_mid_mjd: MID0 + k * 0.4,
        neossat: has
          ? {
              observation_id: `DEV-FIXTURE-NEOSSAT-${k}`,
              t_mid_mjd: MID0 + k * 0.4 + 0.25,
              dt_hours: 6,
              exposure_s: 100,
              fov_arcmin: [6, 6],
              cutout_url: exposureImage(k + 50, false),
              access_url: 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/',
            }
          : null,
      });
    }
  return {
    sequence_id: COMET_SEQ,
    window_hours: 24,
    credit: 'NEOSSat, Canadian Space Agency; Canadian Astronomy Data Centre',
    position_accuracy_arcsec: 30,
    items,
  };
}

export function cometFixture(method: string, p: string): Reply | null {
  if (method !== 'GET') return null;
  if (p === '/movers') {
    const body: MoverListing[] = [
      {
        designation: '3I/ATLAS',
        name: 'DEV FIXTURE comet',
        kind: { en: 'Moving target', es: 'Objeto en movimiento' },
        horizons_record: 0,
        sequences: [
          {
            sequence_id: COMET_SEQ,
            solution: 'DEV-FIXTURE',
            campaigns: manifest().moving_target?.campaigns ?? [],
          },
        ],
      },
    ];
    return { status: 200, body };
  }
  if (p === `/manifests/${COMET_SEQ}.json`) return { status: 200, body: manifest() };
  if (p === `/movers/${COMET_SEQ}/spectrum`) return { status: 200, body: spectrum() };
  if (p === `/movers/${COMET_SEQ}/ephemeris-check`)
    return {
      status: 200,
      body: {
        sequence_id: COMET_SEQ,
        solution: 'DEV-FIXTURE',
        campaigns: {
          '0': {
            status: 'pass',
            n_exposures: 48,
            n_measured: 48,
            n_within: 48,
            fraction_within: 1,
            median_offset_arcsec: 0.9,
            max_offset_arcsec: 2.5,
          },
        },
      },
    };
  if (p === `/movers/${COMET_SEQ}/neossat`) return { status: 200, body: neossat() };
  return null;
}
