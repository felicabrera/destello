import { describe, expect, it } from 'vitest';
import type { TargetItem } from '../../lib/types';
import { nearbyMover } from './useExplorerSource';

const wise = {
  id: 'wise0855',
  names: { en: 'WISE 0855-0714', es: 'WISE 0855-0714' },
  ra_deg: 133.7831722,
  dec_deg: -7.2442516,
  astrometry: {
    ref_epoch: 'MJD57338.571065',
    ra_deg: 133.7831722,
    dec_deg: -7.2442516,
    pmra_masyr: -8021.2,
    pmdec_masyr: 1035.7,
  },
} as unknown as TargetItem;

const rdra = {
  id: 'rdra',
  names: { en: 'R Draconis', es: 'R Draconis' },
  ra_deg: 245.0,
  dec_deg: 66.75,
  astrometry: { ref_epoch: 'J2016.0', ra_deg: 245.0, dec_deg: 66.75, pmra_masyr: -15, pmdec_masyr: 30 },
} as unknown as TargetItem;

describe('nearbyMover', () => {
  it('matches the challenge coordinates of WISE 0855 to its preset', () => {
    // 08h55m10.831s -07d14m42.53s, about 43 arcsec from the CatWISE2020 position.
    expect(nearbyMover([rdra, wise], 133.79513, -7.24515)?.id).toBe('wise0855');
  });

  it('ignores positions outside the match radius', () => {
    expect(nearbyMover([wise], 133.85, -7.2442516)).toBeUndefined();
  });

  it('ignores slow presets even when the position coincides', () => {
    expect(nearbyMover([rdra], 245.0, 66.75)).toBeUndefined();
  });

  it('handles a missing target list', () => {
    expect(nearbyMover(undefined, 133.79513, -7.24515)).toBeUndefined();
  });
});
