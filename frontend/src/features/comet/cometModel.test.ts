import { describe, expect, it } from 'vitest';
import type { FrameInfo, Manifest, MoverSpectrum, ValidationReport } from '../../lib/types';
import {
  bandStatus,
  checkFor,
  choices,
  exposureDetectors,
  exposuresFor,
  plotPoints,
  reticleFor,
  skyToFramePixel,
  stacksFor,
  stepKey,
  stretchKey,
  validationRow,
} from './cometModel';

function frame(det: number, kind: string, t: number, obs: string, extra: Partial<FrameInfo> = {}): FrameInfo {
  return {
    detector: det,
    kind,
    url: `/frames/${obs}.webp`,
    n_images: 1,
    flagged_fraction: 0,
    obs_ids: [obs],
    t_mid_mjd: t,
    ...extra,
  };
}

const manifest = {
  sequence_id: 'a'.repeat(16),
  grid: { projection: 'TAN', crval_deg: [10, 20], pixel_scale_arcsec: 3.1, naxis: [100, 100] },
  epochs: [
    { index: 0, t_mid_mjd: 5, frames: [frame(2, 'exposure', 5.2, 'b'), frame(1, 'exposure', 5.1, 'a')] },
    {
      index: 1,
      t_mid_mjd: 4,
      frames: [
        frame(1, 'exposure', 4.1, 'c', {
          center_deg: [10, 20],
          ephemeris: { ra_deg: 10, dec_deg: 20 },
        }),
        frame(1, 'coadd', 4.1, 'x'),
      ],
    },
  ],
  moving_target: { stacks: [frame(1, 'stack', 0, 's1'), frame(2, 'stack', 0, 's2')] },
} as unknown as Manifest;

describe('exposure ordering', () => {
  it('orders single exposures of one detector by time and ignores other kinds', () => {
    const e = exposuresFor(manifest, 1);
    expect(e.map((x) => x.obsId)).toEqual(['c', 'a']);
    expect(e.map((x) => x.index)).toEqual([0, 1]);
  });
  it('lists detectors with exposures and the stack of a detector', () => {
    expect(exposureDetectors(manifest)).toEqual([1, 2]);
    expect(stacksFor(manifest, 2)[0].obs_ids).toEqual(['s2']);
  });
  it('uses separate stretch keys for exposures and stacks', () => {
    expect(stretchKey('exposure', 3)).toBe('3');
    expect(stretchKey('stack', 3)).toBe('stack3');
  });
});

describe('reticle', () => {
  it('sits at the frame center when the ephemeris equals the frame center', () => {
    const e = exposuresFor(manifest, 1)[0];
    const r = reticleFor(e, manifest);
    expect(r?.x).toBeCloseTo(50);
    expect(r?.y).toBeCloseTo(50);
  });
  it('is absent without center_deg', () => {
    expect(reticleFor(exposuresFor(manifest, 1)[1], manifest)).toBeNull();
  });
  it('puts a source east of the center to the left and north up', () => {
    const p = skyToFramePixel(10.001, 20.001, [10, 20], 3.1, [100, 100]);
    expect(p.x).toBeLessThan(50);
    expect(p.y).toBeLessThan(50);
  });
});

const spec = {
  points: [
    {
      obs_id: 'a',
      detector: 1,
      t_mid_mjd: 1,
      wavelength_um: 2,
      flux: 1,
      flux_err: 0.1,
      flagged: false,
      campaign: 0,
    },
    {
      obs_id: 'b',
      detector: 1,
      t_mid_mjd: 1,
      wavelength_um: 1,
      flux: 2,
      flux_err: 0.1,
      flagged: true,
      campaign: 0,
    },
    {
      obs_id: 'c',
      detector: 1,
      t_mid_mjd: 1,
      wavelength_um: 3,
      flux: null,
      flux_err: null,
      flagged: true,
      campaign: 0,
    },
    {
      obs_id: 'd',
      detector: 1,
      t_mid_mjd: 1,
      wavelength_um: 4,
      flux: 3,
      flux_err: 0.1,
      flagged: false,
      campaign: 1,
    },
  ],
  bands: {
    '0': {
      co2: { band: 'co2', n_points: { band: 1, blue: 4, red: 3 }, excess: null, significance: null },
      h2o: {
        band: 'h2o',
        n_points: { band: 2, blue: 2, red: 2 },
        excess: 0.1,
        excess_err: 0.05,
        significance: 2,
      },
    },
  },
} as unknown as MoverSpectrum;

describe('spectrum model', () => {
  it('keeps flagged points, drops points without flux and sorts by wavelength', () => {
    const p = plotPoints(spec, 0);
    expect(p.map((x) => x.x)).toEqual([1, 2]);
    expect(p[0].flagged).toBe(true);
  });
  it('reports a band without enough points as not measurable and never invents a value', () => {
    expect(bandStatus(spec, 0, 'co2').state).toBe('not_measurable');
    expect(bandStatus(spec, 0, 'h2o').state).toBe('measured');
    expect(bandStatus(spec, 5, 'co2').state).toBe('absent');
    expect(bandStatus(undefined, 0, 'co2').state).toBe('absent');
  });
  it('finds the validation row of a sequence and campaign', () => {
    const rep = {
      tests: [
        { id: 'V-13', target: 's', status: 'not_measurable', reason_params: { campaign: 0 } },
        { id: 'V-13', target: 's', status: 'pass', reason_params: { campaign: 1 } },
      ],
    } as unknown as ValidationReport;
    expect(validationRow(rep, 'V-13', 's', 0)?.status).toBe('not_measurable');
    expect(validationRow(rep, 'V-13', 's', 1)?.status).toBe('pass');
    expect(validationRow(rep, 'V-13', 'other', 0)).toBeNull();
    expect(validationRow(null, 'V-13', 's', 0)).toBeNull();
  });
  it('reads the ephemeris check by campaign', () => {
    expect(checkFor({ sequence_id: 's', solution: 'x', campaigns: {} }, 0)).toBeNull();
  });
});

describe('listing and keys', () => {
  it('takes the sequences of the first moving target', () => {
    const c = choices([
      {
        designation: 'x',
        name: 'x',
        kind: {},
        horizons_record: 1,
        sequences: [{ sequence_id: 's1', solution: 'j', campaigns: [] }],
      },
    ]);
    expect(c).toEqual([{ sequenceId: 's1', campaign: null }]);
    expect(choices(undefined)).toEqual([]);
  });
  it('steps with arrows, Home and End within bounds', () => {
    expect(stepKey('ArrowRight', 0, 3)).toBe(1);
    expect(stepKey('ArrowRight', 2, 3)).toBe(2);
    expect(stepKey('ArrowLeft', 0, 3)).toBe(0);
    expect(stepKey('End', 0, 3)).toBe(2);
    expect(stepKey('Home', 2, 3)).toBe(0);
    expect(stepKey('a', 0, 3)).toBeNull();
    expect(stepKey('End', 0, 0)).toBeNull();
  });
});
