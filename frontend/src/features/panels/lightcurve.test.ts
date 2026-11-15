// F-26 light curve helpers, checked against a real photometry sidecar of the demo (WISE 0855).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EpochInfo, EpochPhotometry, PhotometryDoc } from '../../lib/types';
import { lcDefaultDetector, lcDetectors, lcRows } from './LightCurve';

const doc = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../tests/fixtures/manifests/3bf0d84f65f4400c.photometry.json'),
    'utf-8',
  ),
) as PhotometryDoc;
const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../tests/fixtures/manifests/3bf0d84f65f4400c.json'), 'utf-8'),
) as { epochs: EpochInfo[] };

describe('F-26 light curve', () => {
  it('reads the detectors of the sidecar and keeps the shown one', () => {
    const rows = doc.epoch_photometry;
    const dets = lcDetectors(rows);
    expect(dets.length).toBeGreaterThan(0);
    expect(dets).toEqual([...dets].sort((a, b) => a - b));
    expect(lcDefaultDetector(rows, dets[dets.length - 1])).toBe(dets[dets.length - 1]);
    expect(dets).toContain(lcDefaultDetector(rows, 'all'));
  });

  it('orders one detector by epoch and attaches the manifest mid time', () => {
    const det = lcDetectors(doc.epoch_photometry)[0];
    const rows = lcRows(doc.epoch_photometry, det, manifest.epochs);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r, i) => {
      expect(r.p.detector).toBe(det);
      if (i > 0) expect(r.p.epoch).toBeGreaterThan(rows[i - 1].p.epoch);
      const ep = manifest.epochs.find((e) => e.index === r.p.epoch);
      expect(r.mid).toBe(ep?.t_mid_mjd);
    });
    // Values are passed through unchanged.
    const src = doc.epoch_photometry.find((p) => p.detector === det && p.epoch === rows[0].p.epoch);
    expect(rows[0].p.flux).toBe(src?.flux);
  });

  it('prefers the detector with the most measured epochs when all are shown', () => {
    const rows: EpochPhotometry[] = [
      { epoch: 0, detector: 1, flux: null, n_images: 3, reason: 'saturated_core' },
      { epoch: 1, detector: 1, flux: 2, n_images: 3 },
      { epoch: 0, detector: 4, flux: 1, n_images: 3 },
      { epoch: 1, detector: 4, flux: 1.1, n_images: 3 },
    ];
    expect(lcDefaultDetector(rows, 'all')).toBe(4);
    expect(lcDefaultDetector(rows, 1)).toBe(1);
    expect(lcDefaultDetector([], 'all')).toBeNull();
  });
});
