import { describe, expect, it } from 'vitest';
import { astrometryCsv, lightCurveCsv, toCsv } from './csv';
import type { AstrometryResponse } from './types';

describe('csv exports', () => {
  it('quotes cells with commas or quotes and leaves missing values empty', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', null],
          ['say "hi"', 0],
        ],
      ),
    ).toBe('a,b\n"x,y",\n"say ""hi""",0\n');
  });

  it('light curve keeps unmeasured epochs with their reason and no invented flux', () => {
    const csv = lightCurveCsv('abc', 'Jy', [
      {
        p: { epoch: 0, detector: 5, flux: 0.0123, flux_err: 0.0004, n_images: 18, wavelength_um: [3.8, 4.4] },
        mid: 60913.1,
      },
      { p: { epoch: 1, detector: 5, flux: null, n_images: 20, reason: 'saturated_core' }, mid: undefined },
    ]);
    expect(csv.split('\n')).toEqual([
      'sequence_id,epoch,detector,t_mid_mjd,wavelength_min_um,wavelength_max_um,flux_Jy,flux_err_Jy,n_images,reason',
      'abc,1,5,60913.1,3.8,4.4,0.0123,0.0004,18,',
      'abc,2,5,,,,,,20,saturated_core',
      '',
    ]);
  });

  it('astrometry lists every epoch with its fit residual when there is one', () => {
    const r: AstrometryResponse = {
      detector_used: 6,
      epochs: [
        {
          index: 0,
          t_mid_mjd: 60913.1,
          measured: true,
          ra_deg: 269.45,
          dec_deg: 4.74,
          err_arcsec: 0.2,
          snr: 80,
        },
        { index: 1, t_mid_mjd: 61116.2, measured: false, reason: 'low_snr' },
      ],
      fit: {
        pmra_masyr: -800,
        pmdec_masyr: 10300,
        pmra_err_masyr: 400,
        pmdec_err_masyr: 400,
        residuals: [{ index: 0, dra_arcsec: 0.01, ddec_arcsec: -0.02 }],
      },
    };
    expect(astrometryCsv('abc', r).split('\n').slice(1, 3)).toEqual([
      'abc,1,6,60913.1,1,269.45,4.74,0.2,80,,0.01,-0.02,',
      'abc,2,6,61116.2,0,,,,,,,,low_snr',
    ]);
  });
});
