import { describe, expect, it } from 'vitest';
import { warningLines } from './warnings';

const t = (key: string, o?: Record<string, unknown>) => {
  if (key === 'info.warn.partialItem') return `${o?.n} @ ${o?.date} (${o?.mjd})`;
  if (key === 'info.warn.partialOne') return `one: ${o?.item}`;
  if (key === 'info.warn.partialMany') return `${o?.count}: ${o?.list}`;
  if (key === 'info.warn.lowOne') return `low one: ${o?.item}`;
  if (key === 'info.warn.lowMany') return `low ${o?.count}: ${o?.list}`;
  if (key === 'info.warn.KNOWN') return 'known text';
  if (key === 'info.warn.SATURATED_CORE') return `sat ${o?.n}/${o?.total} ${o?.detectors}`;
  return key;
};
const partial = (n: number, mjd: string) => ({
  code: 'EPOCH_PARTIAL_SKIPPED',
  detail: `A partial revisit of ${n} images around MJD ${mjd} was not used: it is too small to coadd and compare.`,
});

describe('warningLines', () => {
  it('merges skipped partial revisits into one line with the manifest numbers and dates', () => {
    const lines = warningLines(
      t,
      [partial(10, '60948.9'), { code: 'KNOWN', detail: 'x' }, partial(2, '61305.6')],
      'en',
    );
    expect(lines).toEqual({
      warnings: ['known text'],
      notes: ['2: 10 @ Sep 30, 2025 (60948.9); 2 @ Sep 22, 2026 (61305.6)'],
    });
  });
  it('keeps a single partial revisit as one sentence', () => {
    expect(warningLines(t, [partial(8, '61164.7')], 'en')).toEqual({
      warnings: [],
      notes: ['one: 8 @ May 4, 2026 (61164.7)'],
    });
  });
  it('falls back to the API detail for unknown codes and unparsed text', () => {
    expect(
      warningLines(
        t,
        [
          { code: 'NEW', detail: 'd1' },
          { code: 'EPOCH_PARTIAL_SKIPPED', detail: 'odd' },
        ],
        'en',
      ),
    ).toEqual({ warnings: ['d1'], notes: ['odd'] });
  });
});

const low = (n: number, mjd: string) => ({
  code: 'EPOCH_LOW_COVERAGE',
  detail: `A partial revisit of ${n} images around MJD ${mjd} is shown as a low coverage epoch: it is not used in measurements.`,
});

describe('low coverage epochs (F-31)', () => {
  it('merges the low coverage revisits into the first note, before the skipped ones', () => {
    const lines = warningLines(t, [low(10, '60948.9'), low(8, '61164.7'), partial(2, '61305.6')], 'en');
    expect(lines).toEqual({
      warnings: [],
      notes: [
        'low 2: 10 @ Sep 30, 2025 (60948.9); 8 @ May 4, 2026 (61164.7)',
        'one: 2 @ Sep 22, 2026 (61305.6)',
      ],
    });
  });
  it('keeps a single low coverage revisit as one sentence', () => {
    expect(warningLines(t, [low(8, '61164.7')], 'en')).toEqual({
      warnings: [],
      notes: ['low one: 8 @ May 4, 2026 (61164.7)'],
    });
  });
  it('is a note, never a warning, also when the detail cannot be parsed', () => {
    expect(warningLines(t, [{ code: 'EPOCH_LOW_COVERAGE', detail: 'odd' }], 'en')).toEqual({
      warnings: [],
      notes: ['odd'],
    });
  });
});

describe('note codes', () => {
  it('general statements about the data set are notes, target specific ones stay warnings', () => {
    const out = warningLines(
      t,
      [
        { code: 'QUICK_RELEASE_CALIBRATION', detail: 'cal' },
        { code: 'WAVELENGTH_MIXTURE', detail: 'mix' },
        { code: 'SATURATION_RISK', detail: 'sat' },
      ],
      'en',
    );
    expect(out).toEqual({ warnings: ['sat'], notes: ['cal', 'mix'] });
  });
});

describe('measured saturation', () => {
  it('shows the counts and detectors measured by the build', () => {
    const detail =
      'The target core is saturated in 18 of 18 coadds (detectors D1, D2, D3, D4, D5, D6); saturated pixels are excluded from centroids and photometry.';
    expect(warningLines(t, [{ code: 'SATURATED_CORE', detail }], 'es')).toEqual({
      warnings: ['sat 18/18 D1, D2, D3, D4, D5, D6'],
      notes: [],
    });
  });
});
