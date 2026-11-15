// F-28 "Surprise me": a curated list of real, scientifically interesting fields.
// Astrometry is copied from the published catalogs named in `catalog` (Gaia DR3, reference epoch J2016.0,
// retrieved through the Gaia DR3 TAP service; SN 2023ixf from the NASA/IPAC Extragalactic Database, J2000.0,
// no proper motion). Nothing here is invented or rounded beyond the catalog precision that matters at the
// SPHEREx pixel scale (about 6.2 arcsec). Names and reasons live in i18n under `surprise.items.<id>`.
import { MJD_J2000, propagate } from './astrometry';

export interface SurpriseField {
  id: string;
  /** Catalog designation shown with the position, e.g. "Gaia DR3 5853498713190525696". */
  catalog: string;
  ra_deg: number;
  dec_deg: number;
  /** Reference epoch of `ra_deg` and `dec_deg`. */
  ref_epoch: string;
  pmra_masyr: number | null;
  pmdec_masyr: number | null;
  parallax_mas: number | null;
  kind: 'mover' | 'variable' | 'transient';
}

const GAIA = 'Gaia DR3';

export const SURPRISE_FIELDS: readonly SurpriseField[] = [
  {
    id: 'proxima',
    catalog: `${GAIA} 5853498713190525696`,
    ra_deg: 217.392321472,
    dec_deg: -62.676075117,
    ref_epoch: 'J2016.0',
    pmra_masyr: -3781.741,
    pmdec_masyr: 769.465,
    parallax_mas: 768.067,
    kind: 'mover',
  },
  {
    id: 'teegarden',
    catalog: `${GAIA} 35227046884571776`,
    ra_deg: 43.269642477,
    dec_deg: 16.864373819,
    ref_epoch: 'J2016.0',
    pmra_masyr: 3429.083,
    pmdec_masyr: -3805.541,
    parallax_mas: 260.988,
    kind: 'mover',
  },
  {
    id: 'vanmaanen',
    catalog: `${GAIA} 2552928187080872832`,
    ra_deg: 12.29674025,
    dec_deg: 5.376556608,
    ref_epoch: 'J2016.0',
    pmra_masyr: 1231.399,
    pmdec_masyr: -2711.883,
    parallax_mas: 231.78,
    kind: 'mover',
  },
  {
    id: 'wolf359',
    catalog: `${GAIA} 3864972938605115520`,
    ra_deg: 164.103190308,
    dec_deg: 7.002726941,
    ref_epoch: 'J2016.0',
    pmra_masyr: -3866.338,
    pmdec_masyr: -2699.215,
    parallax_mas: 415.179,
    kind: 'mover',
  },
  {
    id: 'kapteyn',
    catalog: `${GAIA} 4810594479418041856`,
    ra_deg: 77.95993735,
    dec_deg: -45.043812699,
    ref_epoch: 'J2016.0',
    pmra_masyr: 6491.223,
    pmdec_masyr: -5708.614,
    parallax_mas: 254.199,
    kind: 'mover',
  },
  {
    id: 'groombridge1830',
    catalog: `${GAIA} 4034171629042489088`,
    ra_deg: 178.267353208,
    dec_deg: 37.692826947,
    ref_epoch: 'J2016.0',
    pmra_masyr: 4002.655,
    pmdec_masyr: -5817.8,
    parallax_mas: 109.03,
    kind: 'mover',
  },
  {
    id: 'lacaille9352',
    catalog: `${GAIA} 6553614253923452800`,
    ra_deg: 346.50391668,
    dec_deg: -35.847164208,
    ref_epoch: 'J2016.0',
    pmra_masyr: 6765.995,
    pmdec_masyr: 1330.285,
    parallax_mas: 304.135,
    kind: 'mover',
  },
  {
    id: 'trappist1',
    catalog: `${GAIA} 2635476908753563008`,
    ra_deg: 346.626521628,
    dec_deg: -5.043528319,
    ref_epoch: 'J2016.0',
    pmra_masyr: 930.788,
    pmdec_masyr: -479.038,
    parallax_mas: 80.212,
    kind: 'mover',
  },
  {
    id: 'ross128',
    catalog: `${GAIA} 3796072592206250624`,
    ra_deg: 176.93768799,
    dec_deg: 0.79911997,
    ref_epoch: 'J2016.0',
    pmra_masyr: 607.299,
    pmdec_masyr: -1223.028,
    parallax_mas: 296.305,
    kind: 'mover',
  },
  {
    id: 'v1647ori',
    catalog: `${GAIA} 3219119189974545024`,
    ra_deg: 86.554741821,
    dec_deg: -0.101361668,
    ref_epoch: 'J2016.0',
    pmra_masyr: 0.918,
    pmdec_masyr: -1.057,
    parallax_mas: 2.422,
    kind: 'variable',
  },
  {
    id: 'fuori',
    catalog: `${GAIA} 3336092864798790144`,
    ra_deg: 86.343197589,
    dec_deg: 9.070069778,
    ref_epoch: 'J2016.0',
    pmra_masyr: 2.441,
    pmdec_masyr: -2.507,
    parallax_mas: 2.454,
    kind: 'variable',
  },
  {
    id: 'ttau',
    catalog: `${GAIA} 48192969034959232`,
    ra_deg: 65.49768837,
    dec_deg: 19.535056373,
    ref_epoch: 'J2016.0',
    pmra_masyr: 11.682,
    pmdec_masyr: -14.341,
    parallax_mas: 6.89,
    kind: 'variable',
  },
  {
    id: 'boyajian',
    catalog: `${GAIA} 2081900940499099136`,
    ra_deg: 301.56432145,
    dec_deg: 44.456840694,
    ref_epoch: 'J2016.0',
    pmra_masyr: -10.375,
    pmdec_masyr: -10.273,
    parallax_mas: 2.255,
    kind: 'variable',
  },
  {
    id: 'sn2023ixf',
    catalog: 'NED SN 2023ixf',
    ra_deg: 210.910675,
    dec_deg: 54.31165,
    ref_epoch: 'J2000.0',
    pmra_masyr: null,
    pmdec_masyr: null,
    parallax_mas: null,
    kind: 'transient',
  },
];

export const SURPRISE_IDS: readonly string[] = SURPRISE_FIELDS.map((f) => f.id);

export function surpriseField(id: string | undefined): SurpriseField | undefined {
  return id ? SURPRISE_FIELDS.find((f) => f.id === id) : undefined;
}

/**
 * Epoch of the field centre: J2026.0, inside the SPHEREx survey span. A fixed epoch keeps the centre, and
 * therefore the sequence identifier, the same for every visit of the same pick. Per-epoch positions are still
 * propagated from the catalog reference epoch by the player and the backend.
 */
export const SURPRISE_CENTER_MJD = MJD_J2000 + 26 * 365.25;

export function surpriseCenter(f: SurpriseField): { ra: number; dec: number } {
  return propagate(
    {
      ra_deg: f.ra_deg,
      dec_deg: f.dec_deg,
      ref_epoch: f.ref_epoch,
      pmra_masyr: f.pmra_masyr,
      pmdec_masyr: f.pmdec_masyr,
    },
    SURPRISE_CENTER_MJD,
  );
}

/** Random pick, never the one currently shown. `rand` is injectable for tests. */
export function pickSurprise(current: string | undefined, rand: () => number = Math.random): SurpriseField {
  const pool = SURPRISE_FIELDS.filter((f) => f.id !== current);
  const i = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
  return pool[Math.max(0, i)];
}
