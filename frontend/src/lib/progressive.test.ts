import { describe, expect, it } from 'vitest';
import { mergeEpochs, shownDetector } from './progressive';
import type { EpochInfo, FrameInfo } from './types';

const frame = (detector: number): FrameInfo => ({
  detector,
  kind: 'coadd',
  url: `/frames/${detector}.webp`,
  n_images: 1,
  flagged_fraction: 0,
  obs_ids: [],
});
const epoch = (index: number, dets: number[]): EpochInfo => ({ index, frames: dets.map(frame) });

describe('mergeEpochs', () => {
  it('adds new epochs and keeps them ordered by index', () => {
    const out = mergeEpochs([epoch(1, [6])], [epoch(0, [6]), epoch(1, [6])]);
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it('takes the incoming epoch when it has at least as many frames', () => {
    const out = mergeEpochs([epoch(0, [6])], [epoch(0, [6, 5])]);
    expect(out[0].frames).toHaveLength(2);
  });

  it('keeps a known epoch that already has more frames', () => {
    const full = epoch(0, [0, 1, 2, 3, 4, 5, 6]);
    const out = mergeEpochs([full], [epoch(0, [6, 5])]);
    expect(out[0]).toBe(full);
  });
});

describe('shownDetector', () => {
  const partial = [epoch(0, [6]), epoch(1, [6])];

  it('returns the selection when the sequence is not building', () => {
    expect(shownDetector('all', false, [6], partial)).toBe('all');
  });

  it('returns the selection when no detector is published yet', () => {
    expect(shownDetector(3, true, [], [])).toBe(3);
  });

  it('falls back to the first published detector while the selection is pending', () => {
    expect(shownDetector('all', true, [6, 5], partial)).toBe(6);
    expect(shownDetector(3, true, [6, 5], partial)).toBe(6);
  });

  it('keeps the selection once it has frames', () => {
    expect(shownDetector(6, true, [6], partial)).toBe(6);
    expect(shownDetector('all', true, [6], [epoch(0, [0, 6])])).toBe('all');
  });
});
