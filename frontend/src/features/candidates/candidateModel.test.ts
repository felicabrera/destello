// F-29 candidates to review: marker geometry, grouping, labels, error mapping and URL state.
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/api';
import type { Candidate, EpochInfo } from '../../lib/types';
import { buildPath, parseSearch, validateSearch } from '../../lib/url-state';
import {
  PAIR_RING_R,
  RING_R,
  STATUS_DASH,
  brighterEpoch,
  candidateErrorKey,
  candidateMarkers,
  coordsText,
  formatDeg,
  formatDetectors,
  groupCandidates,
  hitMarker,
  markerFor,
  pairFor,
  pairHasLowEpoch,
  reportMarksFor,
  unavailableCatalogs,
} from './candidateModel';

function cand(over: Partial<Candidate> & Pick<Candidate, 'id'>): Candidate {
  return {
    kind: 'brighter_in_a',
    status: 'unmatched',
    snr: 8,
    snr_local: 7.5,
    detectors: [3, 4],
    snr_by_detector: [8, 6],
    ra_deg: 10,
    dec_deg: -5,
    x: 20.5,
    y: 30.5,
    a: null,
    b: null,
    separation_arcsec: null,
    match: null,
    ...over,
  };
}
const posB = { ra_deg: 1, dec_deg: 2, x: 34, y: 35 };
const moved = cand({
  id: 'c9',
  kind: 'moved',
  x: 39,
  y: 35,
  a: { ra_deg: 1, dec_deg: 2, x: 44, y: 35 },
  b: posB,
  separation_arcsec: 31,
});

describe('F-29 epoch pair', () => {
  it('uses the shown epoch and the reference in Diff', () => {
    expect(pairFor('diff', [0, 1, 2], 2, 0)).toEqual({ a: 2, b: 0, posA: 2, posB: 0 });
    expect(pairFor('diff', [0, 1, 2], 0, 1)).toEqual({ a: 0, b: 1, posA: 0, posB: 1 });
  });
  it('has no pair on the reference epoch, on the first epoch of Diff seq, or outside the difference modes', () => {
    expect(pairFor('diff', [0, 1, 2], 1, 1)).toBeNull();
    expect(pairFor('diffseq', [0, 1, 2], 0, 0)).toBeNull();
    expect(pairFor('blink', [0, 1, 2], 2, 0)).toBeNull();
    expect(pairFor('diff', [], 0, 0)).toBeNull();
  });
  it('compares with the previous epoch in Diff seq, by manifest index', () => {
    expect(pairFor('diffseq', [0, 2, 3], 1, 0)).toEqual({ a: 2, b: 0, posA: 1, posB: 0 });
  });
  it('follows the epoch subtracted on screen when Diff seq skips a revisit (F-31)', () => {
    expect(pairFor('diffseq', [0, 1, 2], 2, 0, 0)).toEqual({ a: 2, b: 0, posA: 2, posB: 0 });
  });
});

describe('F-31 low coverage pairs', () => {
  const epochs: EpochInfo[] = [
    { index: 0, frames: [] },
    { index: 1, frames: [], coverage: 'low' },
    { index: 2, frames: [], coverage: 'full' },
  ];
  it('flags a pair when either epoch has low coverage', () => {
    expect(pairHasLowEpoch({ a: 1, b: 0, posA: 1, posB: 0 }, epochs)).toBe(true);
    expect(pairHasLowEpoch({ a: 2, b: 1, posA: 2, posB: 1 }, epochs)).toBe(true);
  });
  it('accepts two full coverage epochs and no pair', () => {
    expect(pairHasLowEpoch({ a: 2, b: 0, posA: 2, posB: 0 }, epochs)).toBe(false);
    expect(pairHasLowEpoch(null, epochs)).toBe(false);
  });
  it('maps the server refusal to its own message', () => {
    expect(candidateErrorKey(new ApiError(422, 'LOW_COVERAGE_EPOCH', 'low'))).toBe('LOW_COVERAGE_EPOCH');
  });
});

describe('F-29 grouping and labels', () => {
  const list = [
    cand({ id: 'c1', status: 'unchecked' }),
    cand({ id: 'c2', status: 'target' }),
    cand({ id: 'c3', status: 'unmatched' }),
    cand({ id: 'c4', status: 'known_source' }),
    cand({ id: 'c5', status: 'not_measurable' }),
    cand({ id: 'c6', status: 'unmatched' }),
  ];
  it('lists entries without a catalog match first, then the unchecked ones, keeping the server order', () => {
    const g = groupCandidates(list);
    expect(g.primary.map((c) => c.id)).toEqual(['c3', 'c6', 'c1']);
    expect(g.groups.target.map((c) => c.id)).toEqual(['c2']);
    expect(g.groups.known_source.map((c) => c.id)).toEqual(['c4']);
    expect(g.groups.not_measurable.map((c) => c.id)).toEqual(['c5']);
  });
  it('formats detectors, degrees and clipboard text', () => {
    expect(formatDetectors([5, 3, 4])).toBe('D3 D4 D5');
    expect(formatDetectors([])).toBe('');
    expect(formatDeg(269.45888)).toBe('269.4589');
    expect(coordsText({ ra_deg: 269.45888, dec_deg: 4.813618 })).toBe('269.458880 +4.813618');
    expect(coordsText({ ra_deg: 331.1, dec_deg: -56.86652 })).toBe('331.100000 -56.866520');
  });
  it('names the epoch in which an entry is brighter with the number shown in the interface', () => {
    const pair = { a: 2, b: 0, posA: 2, posB: 0 };
    expect(brighterEpoch({ kind: 'brighter_in_a' }, pair)).toBe(3);
    expect(brighterEpoch({ kind: 'brighter_in_b' }, pair)).toBe(1);
    expect(brighterEpoch({ kind: 'moved' }, pair)).toBeNull();
  });
  it('reports the catalogs that did not answer', () => {
    expect(unavailableCatalogs({ catalogs: { gaia_dr3: 'ok', catwise2020: 'ok' } })).toEqual([]);
    expect(
      unavailableCatalogs({ catalogs: { gaia_dr3: 'unavailable', catwise2020: 'unavailable' } }),
    ).toEqual(['gaia_dr3', 'catwise2020']);
  });
});

describe('F-29 marker geometry', () => {
  it('draws one ring at the position of an unpaired entry', () => {
    const m = markerFor(cand({ id: 'c1' }), false);
    expect(m.rings).toEqual([{ x: 20.5, y: 30.5, r: RING_R }]);
    expect(m.line).toBeNull();
  });
  it('draws two rings for a moved pair, joined from epoch B to epoch A between the ring edges', () => {
    const m = markerFor(moved, true);
    expect(m.selected).toBe(true);
    expect(m.rings.map((q) => [q.x, q.y])).toEqual([
      [34, 35],
      [44, 35],
    ]);
    expect(m.line?.[0].x).toBeCloseTo(34 + PAIR_RING_R, 6);
    expect(m.line?.[1].x).toBeCloseTo(44 - PAIR_RING_R, 6);
    expect(m.line?.[0].y).toBe(35);
  });
  it('omits the segment when the two rings overlap', () => {
    const close = { ...moved, a: { ...posB, x: 35 } };
    expect(markerFor(close, false).line).toBeNull();
  });
  it('gives every status its own line pattern except the two explained ones', () => {
    const key = (d: number[]) => d.join(',');
    expect(STATUS_DASH.unmatched).toEqual([]);
    expect(key(STATUS_DASH.target)).toBe(key(STATUS_DASH.known_source));
    expect(
      new Set([
        key(STATUS_DASH.unmatched),
        key(STATUS_DASH.unchecked),
        key(STATUS_DASH.target),
        key(STATUS_DASH.not_measurable),
      ]).size,
    ).toBe(4);
  });
  it('draws the default list, the opened groups and the selected entry, with the selection on top', () => {
    const list = [
      cand({ id: 'c1' }),
      cand({ id: 'c2', status: 'target', x: 50, y: 50 }),
      cand({ id: 'c3', status: 'known_source', x: 70, y: 70 }),
      cand({ id: 'c4', status: 'unchecked', x: 90, y: 90 }),
    ];
    expect(candidateMarkers(list, null).map((m) => m.id)).toEqual(['c1', 'c4']);
    expect(candidateMarkers(list, null, { target: true }).map((m) => m.id)).toEqual(['c1', 'c2', 'c4']);
    const sel = candidateMarkers(list, 'c3');
    expect(sel.map((m) => m.id)).toEqual(['c1', 'c4', 'c3']);
    expect(sel[2].selected).toBe(true);
    expect(sel[0].selected).toBe(false);
  });
  it('finds the marker under a point, nearest first', () => {
    const ms = candidateMarkers([cand({ id: 'c1' }), cand({ id: 'c2', x: 24.5, y: 30.5 }), moved], null);
    expect(hitMarker(ms, { x: 20.6, y: 30.4 })?.id).toBe('c1');
    expect(hitMarker(ms, { x: 23.9, y: 30.5 })?.id).toBe('c2');
    expect(hitMarker(ms, { x: 44.5, y: 35.5 })?.id).toBe('c9');
    expect(hitMarker(ms, { x: 80, y: 80 })).toBeNull();
  });
  it('prefills the report marks per epoch of the pair', () => {
    const pair = { a: 2, b: 0, posA: 2, posB: 0 };
    expect(reportMarksFor(moved, pair)).toEqual({ 2: { x: 44, y: 35 }, 0: { x: 34, y: 35 } });
    expect(reportMarksFor(cand({ id: 'c1' }), pair)).toEqual({
      2: { x: 20.5, y: 30.5 },
      0: { x: 20.5, y: 30.5 },
    });
  });
});

describe('F-29 errors and URL state', () => {
  it('maps API errors to translated messages', () => {
    expect(candidateErrorKey(new ApiError(422, 'TOO_FEW_EPOCHS', 'x'))).toBe('TOO_FEW_EPOCHS');
    expect(candidateErrorKey(new ApiError(422, 'INVALID_EPOCHS', 'x'))).toBe('INVALID_EPOCHS');
    expect(candidateErrorKey(new ApiError(409, 'NO_FITS', 'x'))).toBe('NO_FITS');
    expect(candidateErrorKey(new ApiError(429, 'UNKNOWN', 'x'))).toBe('RATE_LIMITED');
    expect(candidateErrorKey(new ApiError(404, 'NOT_FOUND', 'x'))).toBe('NOT_FOUND');
    expect(candidateErrorKey(new ApiError(404, 'DEMO_UNAVAILABLE', 'x'))).toBe('DEMO_UNAVAILABLE');
    expect(candidateErrorKey(new ApiError(0, 'NETWORK', 'x'))).toBe('network');
    expect(candidateErrorKey(new ApiError(500, 'BOOM', 'x'))).toBe('generic');
    expect(candidateErrorKey(new Error('x'))).toBe('generic');
  });
  it('keeps the toggle in the URL with a short key and ignores other values', () => {
    expect(validateSearch(parseSearch('?mode=diff&cand=1')).cand).toBe(1);
    expect(validateSearch(parseSearch('?cand=0')).cand).toBeUndefined();
    expect(validateSearch(parseSearch('?cand=yes')).cand).toBeUndefined();
    expect(buildPath('barnard', { mode: 'diff', frame: 2, cand: 1 })).toBe(
      '/t/barnard?mode=diff&frame=2&cand=1',
    );
    expect(buildPath('barnard', { mode: 'diff', frame: 2 })).toBe('/t/barnard?mode=diff&frame=2');
  });
});
