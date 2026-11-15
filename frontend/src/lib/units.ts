import type { TFunction } from 'i18next';

/** Unit strings as the API sends them, mapped to their i18n key under `val.units`. */
const UNIT_KEYS: Record<string, string> = {
  'mas/yr': 'masyr',
  'arcsec/yr': 'arcsecyr',
  arcsec: 'arcsec',
  percent: 'percent',
};

/**
 * Localized label for a unit string from the API (for example "mas/yr" reads "mas/año" in Spanish).
 * Units without a translation (mag, Jy) are returned unchanged.
 */
export function localUnit(t: TFunction, unit: string): string {
  const key = UNIT_KEYS[unit];
  if (!key) return unit;
  const full = `val.units.${key}`;
  const out = t(full);
  return out === full ? unit : out;
}
