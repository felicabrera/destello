import { describe, expect, it } from 'vitest';
import type { AstrometryResponse } from '../../lib/types';
import { embedSizeFor } from '../explorer/EmbedPage';
import { uniqueDois } from './InfoPanel';
import { residualsOf, verdictOf } from './MeasurePanel';

describe('verdictOf', () => {
  it('maps sigma to verdict bands', () => {
    expect(verdictOf(0)).toBe('agrees');
    expect(verdictOf(1.99)).toBe('agrees');
    expect(verdictOf(2)).toBe('marginal');
    expect(verdictOf(3)).toBe('differs');
  });
});

describe('embedSizeFor', () => {
  it('classifies by iframe width', () => {
    expect(embedSizeFor(360)).toBe('compact');
    expect(embedSizeFor(480)).toBe('standard');
    expect(embedSizeFor(720)).toBe('large');
  });
});

describe('residualsOf', () => {
  const base: AstrometryResponse = {
    detector_used: 6,
    epochs: [
      {
        index: 0,
        t_mid_mjd: 60000,
        measured: true,
        ra_deg: 10,
        dec_deg: 0,
        err_arcsec: 1,
        recalibration_stars: 10,
      },
      {
        index: 1,
        t_mid_mjd: 60365.25,
        measured: true,
        ra_deg: 10,
        dec_deg: 1 / 3600,
        err_arcsec: 1,
        recalibration_stars: 10,
      },
    ],
    fit: { pmra_masyr: 0, pmdec_masyr: 1000, pmra_err_masyr: 1, pmdec_err_masyr: 1 },
  };
  it('is zero when the data follow the fitted motion', () => {
    const r = residualsOf(base);
    expect(r).toHaveLength(2);
    for (const p of r) {
      expect(Math.abs(p.ra)).toBeLessThan(1e-9);
      expect(Math.abs(p.dec)).toBeLessThan(1e-9);
    }
  });
  it('uses API residuals when provided', () => {
    const r = residualsOf({
      ...base,
      fit: {
        ...(base.fit as NonNullable<AstrometryResponse['fit']>),
        residuals: [{ index: 0, dra_arcsec: 0.3, ddec_arcsec: -0.2 }],
      },
    });
    expect(r[0]).toMatchObject({ index: 0, ra: 0.3, dec: -0.2, t: 60000 });
  });
});

describe('not measurable response', () => {
  it('has no residuals when fit is null', () => {
    const r: AstrometryResponse = {
      status: 'not_measurable',
      detector_used: 1,
      epochs_measured: 0,
      epochs_total: 4,
      suggested_detector: 3,
      epochs: [{ index: 0, t_mid_mjd: 60000, measured: false }],
      fit: null,
    };
    expect(residualsOf(r)).toEqual([]);
  });
});

describe('uniqueDois', () => {
  it('keeps order and drops repeats and blanks', () => {
    expect(uniqueDois(['10.26131/a', '10.26131/b', '10.26131/a', ' '])).toEqual(['10.26131/a', '10.26131/b']);
  });
  it('returns an empty list when there is no manifest', () => {
    expect(uniqueDois(undefined)).toEqual([]);
  });
});
