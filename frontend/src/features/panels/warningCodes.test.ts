// Every warning code the science endpoints can send has a localized title and body in both languages,
// so the interface never shows a raw code.
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import es from '../../i18n/es.json';

// Codes emitted by backend/src/destello/api/science.py (warnings, not errors).
const CODES = [
  'BLENDED_SOURCE',
  'EPSILON_INDI_UNRESOLVED',
  'NO_APERTURE_CORRECTION',
  'NO_REDUNDANCY',
  'OVERFLOW_PIXELS_USED',
  'PARALLAX_FIXED',
  'PARALLAX_UNKNOWN',
  'POSITION_NOT_PROPAGATED',
  'PRESET_ASTROMETRY_USED',
  'PSF_WINGS_CENTROID',
  'QUICK_RELEASE_CALIBRATION',
  'RECALIBRATION_UNAVAILABLE',
  'SATURATION',
  'TOO_FEW_EPOCHS',
];

describe('science warning codes', () => {
  for (const [lang, dict] of [
    ['en', en],
    ['es', es],
  ] as const) {
    it(`are all localized in ${lang}`, () => {
      const codes = dict.sciWarn.codes as Record<string, { t: string; b: string }>;
      for (const c of CODES) {
        expect(codes[c]?.t, `${lang} ${c}`).toBeTruthy();
        expect(codes[c]?.b, `${lang} ${c}`).toBeTruthy();
      }
    });
  }
});
