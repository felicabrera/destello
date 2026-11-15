// F-32 motion search: tracks on the frame, hit testing, formatting, ordering and error mapping.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import type { MotionSource } from '../../lib/types';
import {
  arcsecYr,
  hitTrack,
  isFinalMotionError,
  motionErrorKey,
  motionTracks,
  orderSources,
  unavailableMotionCatalogs,
} from './motionModel';

function src(over: Partial<MotionSource> & Pick<MotionSource, 'id'>): MotionSource {
  return {
    status: 'unmatched',
    snr: 12,
    detectors: [2, 3],
    snr_by_detector: [12, 9],
    pmra_masyr: 3748,
    pmdec_masyr: -2567,
    pmra_err_masyr: 165,
    pmdec_err_masyr: 165,
    pm_total_masyr: 4543,
    ref_epoch_jyear: 2025.9,
    ra_deg: 331,
    dec_deg: -56.8,
    x: 20,
    y: 20,
    // Deliberately out of order: tracks are drawn in epoch order.
    track: [
      { epoch: 2, ra_deg: 0, dec_deg: 0, x: 30, y: 20 },
      { epoch: 0, ra_deg: 0, dec_deg: 0, x: 10, y: 20 },
      { epoch: 1, ra_deg: 0, dec_deg: 0, x: 20, y: 20 },
    ],
    match: null,
    ...over,
  };
}

describe('F-32 motion tracks', () => {
  it('orders the points by epoch and marks the position of the epoch on screen', () => {
    const [t] = motionTracks([src({ id: 'm1' })], null, 1);
    expect(t.points).toEqual([
      { x: 10, y: 20 },
      { x: 20, y: 20 },
      { x: 30, y: 20 },
    ]);
    expect(t.current).toEqual({ x: 20, y: 20 });
    expect(t.selected).toBe(false);
  });

  it('has no current position when no single epoch is shown or the epoch was not searched', () => {
    expect(motionTracks([src({ id: 'm1' })], null, null)[0].current).toBeNull();
    // A low coverage epoch (index 3) is never part of the search.
    expect(motionTracks([src({ id: 'm1' })], null, 3)[0].current).toBeNull();
  });

  it('draws the selected track last', () => {
    const list = motionTracks([src({ id: 'm1' }), src({ id: 'm2' }), src({ id: 'm3' })], 'm1', 0);
    expect(list.map((t) => t.id)).toEqual(['m2', 'm3', 'm1']);
    expect(list[2].selected).toBe(true);
  });

  it('hits a track near its line or its points, nearest first, and nothing far away', () => {
    const tracks = motionTracks(
      [
        src({ id: 'm1' }),
        src({
          id: 'm2',
          track: [
            { epoch: 0, ra_deg: 0, dec_deg: 0, x: 10, y: 22 },
            { epoch: 1, ra_deg: 0, dec_deg: 0, x: 30, y: 22 },
          ],
        }),
      ],
      null,
      0,
    );
    expect(hitTrack(tracks, { x: 15, y: 20.5 })?.id).toBe('m1');
    expect(hitTrack(tracks, { x: 15, y: 21.8 })?.id).toBe('m2');
    expect(hitTrack(tracks, { x: 15, y: 40 })).toBeNull();
    // Past the end of the segment the distance is to the end point.
    expect(hitTrack(tracks, { x: 34, y: 20 })).toBeNull();
  });
});

describe('F-32 formatting and order', () => {
  it('shows mas/yr as arcsec/yr with the uncertainty, localized', () => {
    expect(arcsecYr('en', 3748, 165)).toBe('3.75 ± 0.17');
    expect(arcsecYr('es', -2567, 165)).toBe('-2,57 ± 0,17');
    expect(arcsecYr('en', 42.4)).toBe('0.042');
    expect(arcsecYr('en', 42.4, 0.2)).toBe('0.042 ± < 0.001');
  });

  it('lists sources without a catalog counterpart first, keeping the server order inside each group', () => {
    const list = [
      src({ id: 'm1', status: 'target' }),
      src({ id: 'm2', status: 'unchecked' }),
      src({ id: 'm3', status: 'known_source' }),
      src({ id: 'm4', status: 'unmatched' }),
      src({ id: 'm5', status: 'unmatched' }),
    ];
    expect(orderSources(list).map((s) => s.id)).toEqual(['m4', 'm5', 'm2', 'm1', 'm3']);
  });

  it('names the catalogs that did not answer', () => {
    expect(unavailableMotionCatalogs({ catalogs: { gaia_dr3: 'ok', catwise2020: 'unavailable' } })).toEqual([
      'catwise2020',
    ]);
    expect(unavailableMotionCatalogs({ catalogs: {} })).toEqual([]);
  });
});

describe('F-32 errors', () => {
  it('maps API errors to message keys', () => {
    expect(motionErrorKey(new ApiError(422, 'TOO_FEW_EPOCHS', 'x'))).toBe('TOO_FEW_EPOCHS');
    expect(motionErrorKey(new ApiError(422, 'NO_FITS', 'x'))).toBe('NO_FITS');
    expect(motionErrorKey(new ApiError(429, 'SOMETHING', 'x'))).toBe('RATE_LIMITED');
    expect(motionErrorKey(new ApiError(404, 'NOT_FOUND', 'x'))).toBe('NOT_FOUND');
    expect(motionErrorKey(new ApiError(0, 'NETWORK', 'x'))).toBe('network');
    expect(motionErrorKey(new ApiError(500, 'INTERNAL', 'x'))).toBe('generic');
    expect(motionErrorKey(new TypeError('fetch failed'))).toBe('network');
    expect(motionErrorKey(new Error('x'))).toBe('generic');
  });

  it('offers no retry for an answer that a new request cannot change', () => {
    expect(isFinalMotionError('TOO_FEW_EPOCHS')).toBe(true);
    expect(isFinalMotionError('DEMO_UNAVAILABLE')).toBe(true);
    expect(isFinalMotionError('RATE_LIMITED')).toBe(false);
    expect(isFinalMotionError('network')).toBe(false);
  });
});
