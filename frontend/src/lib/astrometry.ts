// Epoch-correct positions (docs/00-context.md non-negotiable 4): linear proper-motion propagation and TAN projection
// onto the manifest grid. Frame px use edge coordinates (pixel i spans [i, i+1]); North up, East left.
import { dateToMjd } from './format';

export interface Grid {
  ra0: number;
  dec0: number;
  scaleArcsec: number;
  n: number;
}

const D2R = Math.PI / 180;
export const MJD_J2000 = 51544.5;

export interface Motion {
  ra_deg: number;
  dec_deg: number;
  /** Reference epoch of the position: "J2016.0", an ISO date, or null when unknown. */
  ref_epoch: string | null | undefined;
  pmra_masyr: number | null | undefined;
  pmdec_masyr: number | null | undefined;
}

export function refEpochToMjd(ref: string | null | undefined): number | undefined {
  if (!ref) return undefined;
  const j = /^J(\d{4}(?:\.\d+)?)$/.exec(ref.trim());
  if (j) return MJD_J2000 + (Number(j[1]) - 2000) * 365.25;
  const m = /^MJD\s*(\d+(?:\.\d+)?)$/i.exec(ref.trim());
  if (m) return Number(m[1]);
  const d = new Date(ref);
  return Number.isNaN(d.getTime()) ? undefined : dateToMjd(d);
}

/** Reference epoch in the form the API accepts ("J2016.0" or "MJD57388.0"), or null when it cannot be read. */
export function apiRefEpoch(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const s = ref.trim();
  if (/^J\d{4}(?:\.\d+)?$/.test(s)) return s;
  const mjd = refEpochToMjd(s);
  return mjd === undefined ? null : `MJD${mjd.toFixed(5)}`;
}

/** Display label of a reference epoch: Julian years (J2015.9) for MJD values, otherwise the text as given. */
export function refEpochLabel(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (/^MJD/i.test(ref.trim())) {
    const mjd = refEpochToMjd(ref);
    if (mjd !== undefined) return `J${(2000 + (mjd - MJD_J2000) / 365.25).toFixed(1)}`;
  }
  return ref;
}

/** Propagate a position to `mjd`. Without a reference epoch or motion the position is returned unchanged. */
export function propagate(m: Motion, mjd: number): { ra: number; dec: number } {
  const t0 = refEpochToMjd(m.ref_epoch);
  if (t0 === undefined || (!m.pmra_masyr && !m.pmdec_masyr)) return { ra: m.ra_deg, dec: m.dec_deg };
  const years = (mjd - t0) / 365.25;
  const dec = m.dec_deg + ((m.pmdec_masyr ?? 0) * years) / 3_600_000;
  const cosd = Math.cos(m.dec_deg * D2R);
  const ra = m.ra_deg + ((m.pmra_masyr ?? 0) * years) / 3_600_000 / Math.max(cosd, 1e-6);
  return { ra: ((ra % 360) + 360) % 360, dec };
}

export function skyToPixel(g: Grid, ra: number, dec: number): { x: number; y: number } {
  const a = (ra - g.ra0) * D2R;
  const d = dec * D2R;
  const d0 = g.dec0 * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(a);
  const xi = (Math.cos(d) * Math.sin(a)) / cosc;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(a)) / cosc;
  const scale = (g.scaleArcsec / 3600) * D2R;
  return { x: g.n / 2 - xi / scale, y: g.n / 2 - eta / scale };
}

export function pixelToSky(g: Grid, x: number, y: number): { ra: number; dec: number } {
  const scale = (g.scaleArcsec / 3600) * D2R;
  const xi = -(x - g.n / 2) * scale;
  const eta = -(y - g.n / 2) * scale;
  const rho = Math.hypot(xi, eta);
  const d0 = g.dec0 * D2R;
  if (rho === 0) return { ra: g.ra0, dec: g.dec0 };
  const c = Math.atan(rho);
  const dec = Math.asin(Math.cos(c) * Math.sin(d0) + (eta * Math.sin(c) * Math.cos(d0)) / rho);
  const ra =
    g.ra0 * D2R +
    Math.atan2(xi * Math.sin(c), rho * Math.cos(d0) * Math.cos(c) - eta * Math.sin(d0) * Math.sin(c));
  return { ra: (((ra / D2R) % 360) + 360) % 360, dec: dec / D2R };
}

/** Frame size in px for a field of view: N = round(FoV in arcsec / scale). */
export function frameSize(fovArcmin: number, scaleArcsec: number): number {
  return Math.round((fovArcmin * 60) / scaleArcsec);
}

/** Total proper motion in arcsec/yr. */
export function totalPm(m: { pmra_masyr?: number | null; pmdec_masyr?: number | null }): number {
  return Math.hypot(m.pmra_masyr ?? 0, m.pmdec_masyr ?? 0) / 1000;
}
