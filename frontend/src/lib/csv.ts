// CSV exports of measurements. Values are written exactly as the API or the build photometry file gave them
// (no rounding, no fill-in): an empty cell means the quantity was not measured, with the reason in its column.
import type { AstrometryResponse, EpochPhotometry } from './types';

type Cell = string | number | boolean | null | undefined;

function cell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';
}

/** Light curve of one detector: one row per epoch, measured or not. */
export function lightCurveCsv(
  sequenceId: string,
  unit: string,
  rows: { p: EpochPhotometry; mid: number | undefined }[],
): string {
  return toCsv(
    [
      'sequence_id',
      'epoch',
      'detector',
      't_mid_mjd',
      'wavelength_min_um',
      'wavelength_max_um',
      `flux_${unit}`,
      `flux_err_${unit}`,
      'n_images',
      'reason',
    ],
    rows.map(({ p, mid }) => [
      sequenceId,
      p.epoch + 1,
      p.detector,
      mid,
      p.wavelength_um?.[0],
      p.wavelength_um?.[1],
      p.flux,
      p.flux_err,
      p.n_images,
      p.reason,
    ]),
  );
}

/** Astrometry: one row per epoch with its centroid and the residual of the linear motion fit. */
export function astrometryCsv(sequenceId: string, r: AstrometryResponse): string {
  const res = new Map((r.fit?.residuals ?? []).map((x) => [x.index, x]));
  return toCsv(
    [
      'sequence_id',
      'epoch',
      'detector',
      't_mid_mjd',
      'measured',
      'ra_deg',
      'dec_deg',
      'err_arcsec',
      'snr',
      'recalibration_stars',
      'residual_ra_arcsec',
      'residual_dec_arcsec',
      'reason',
    ],
    r.epochs.map((e) => [
      sequenceId,
      e.index + 1,
      r.detector_used,
      e.t_mid_mjd,
      e.measured,
      e.ra_deg,
      e.dec_deg,
      e.err_arcsec,
      e.snr,
      e.recalibration_stars,
      res.get(e.index)?.dra_arcsec,
      res.get(e.index)?.ddec_arcsec,
      e.reason,
    ]),
  );
}

/** Saves a text made in the browser as a file. */
export function downloadText(filename: string, text: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function downloadCsv(filename: string, text: string): void {
  downloadText(filename, text, 'text/csv');
}
