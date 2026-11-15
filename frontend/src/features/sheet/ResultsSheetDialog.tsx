// F-30 results sheet: a printable summary of the current view, with the same content as a JSON download. It reads
// what the view has already loaded (manifest, view state, measurements in the query cache) and requests nothing.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';
import { ApiError } from '../../lib/api';
import { downloadText } from '../../lib/csv';
import { localNumber } from '../../lib/format';
import type {
  AstrometryResponse,
  DetectorSel,
  Lang,
  PhotometryDoc,
  SpectrumResponse,
  TargetItem,
} from '../../lib/types';
import { localUnit } from '../../lib/units';
import type { useExplorer } from '../explorer/useExplorer';
import { arcsecYr } from '../motion/motionModel';
import { LC_REASONS } from '../panels/LightCurve';
import { mas, verdictOf } from '../panels/MeasurePanel';
import { astrometryKey, photometryKey, spectrumKey } from '../panels/queryKeys';
import { fmtFlux } from '../panels/SpectrumPanel';
import { useSelection } from '../panels/useSelection';
import { warningLines } from '../panels/warnings';
import { buildSheet, sheetFileName, sheetJson, type SheetModel, type SheetPhotometry } from './sheetModel';

type Model = ReturnType<typeof useExplorer>;

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  x: Model;
  targetName: string | null;
  /** Shareable URL of the view. */
  viewUrl: string;
  presetId?: string;
  target?: TargetItem;
}

/** Class set on the root element while the sheet is open: the print rules in styles/index.css key on it. */
const PRINT_CLASS = 'sheet-print';

const utc = (iso: string | null): string | null => (iso ? iso.slice(0, 19).replace('T', ' ') : null);
const detLabel = (t: TFunction, d: DetectorSel) => (d === 'all' ? t('detector.allDet') : `D${d}`);

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`rs-${id}`} className="mt-5" data-testid={`sheet-${id}`}>
      <h3
        id={`rs-${id}`}
        className="border-b border-border-strong pb-1 text-caption-12 font-semibold uppercase tracking-wider text-text"
      >
        {title}
      </h3>
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </section>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return (
    <dl className="grid gap-x-4 gap-y-1 text-label-13 sm:grid-cols-[11rem_minmax(0,1fr)]">{children}</dl>
  );
}

function Row({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="tnum min-w-0 break-words text-text max-sm:mb-1" data-testid={testid}>
        {children}
      </dd>
    </>
  );
}

function Table({
  label,
  head,
  rows,
  testid,
}: {
  label: string;
  head: string[];
  rows: ReactNode[][];
  testid?: string;
}) {
  return (
    <div
      className="overflow-x-auto print:overflow-visible"
      role="region"
      aria-label={label}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be reachable by keyboard
      tabIndex={0}
      data-testid={testid}
    >
      <table className="tnum w-full text-caption-12">
        <thead>
          <tr className="text-left text-muted">
            {head.map((h) => (
              <th key={h} scope="col" className="py-1 pr-3 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border align-top">
              {r.map((c, j) => (
                <td key={j} className="py-1 pr-3">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhotometryTable({ p, title, lang }: { p: SheetPhotometry; title: string; lang: Lang }) {
  const { t } = useTranslation();
  const na = t('info.unavailable');
  const reason = (code: string | null) =>
    code && (LC_REASONS as readonly string[]).includes(code)
      ? t(`lc.reason.${code}`)
      : t('lc.reason.unknown');
  const c = p.change;
  return (
    <>
      <Table
        label={title}
        head={[
          t('info.epoch'),
          t('results.midMjd'),
          t('spec.colFlux', { unit: p.flux_unit }),
          t('meas2.colN'),
        ]}
        rows={p.rows.map((r) => [
          `E${r.epoch}`,
          r.t_mid_mjd != null ? r.t_mid_mjd.toFixed(1) : na,
          r.flux != null
            ? `${fmtFlux(lang, r.flux)}${r.flux_err != null ? ` ± ${fmtFlux(lang, r.flux_err)}` : ''}`
            : reason(r.reason),
          String(r.n_images),
        ])}
      />
      <p className="text-label-13 text-text" data-testid="sheet-change">
        {!c
          ? t('results.changeNone', { det: p.detector })
          : c.percent == null
            ? t('results.changeAbs', {
                from: c.from_epoch,
                to: c.to_epoch,
                det: p.detector,
                value: fmtFlux(lang, c.flux_change),
                unit: p.flux_unit,
              })
            : c.sigma == null
              ? t('results.changeNoSigma', {
                  from: c.from_epoch,
                  to: c.to_epoch,
                  det: p.detector,
                  pct: localNumber(lang, c.percent, 1),
                })
              : t('results.change', {
                  from: c.from_epoch,
                  to: c.to_epoch,
                  det: p.detector,
                  pct: localNumber(lang, c.percent, 1),
                  sigma: localNumber(lang, c.sigma, 1),
                })}
      </p>
    </>
  );
}

function Sub({ title, children, testid }: { title: string; children: ReactNode; testid: string }) {
  return (
    <div className="flex break-inside-avoid flex-col gap-1.5" data-testid={testid}>
      <h4 className="text-label-13 font-semibold text-text">{title}</h4>
      {children}
    </div>
  );
}

/** The sheet itself: every value comes from the model. */
export function SheetView({ model, lang, presetId }: { model: SheetModel; lang: Lang; presetId?: string }) {
  const { t } = useTranslation();
  const na = t('info.unavailable');
  const list = (v: string[]) => (v.length ? v.join(', ') : na);
  const { target, data, frames, measurements: ms, warnings, traceability } = model;
  const pm = ms.proper_motion;
  const sp = ms.spectrum;
  const lc = ms.light_curve;
  const cand = ms.candidates;
  const motion = ms.motion_search;
  const pr = ms.preset_result;
  const anyMeasurement = !!(pm || sp || lc || cand || motion || pr);
  const prDigits = pr?.unit === 'mag' ? 3 : pr?.unit === 'mas/yr' ? 0 : 2;
  const band = (lo: number | null, hi: number | null) =>
    lo != null && hi != null ? t('detector.range', { min: lo.toFixed(2), max: hi.toFixed(2) }) : null;
  const frameBand = band(frames.wavelength_min_um, frames.wavelength_max_um);

  return (
    <div className="text-label-13 text-text">
      <Section id="header" title={t('results.h.view')}>
        <Rows>
          <Row label={t('results.target')} testid="sheet-target">
            {target.name ?? t('export.field')}
          </Row>
          <Row label={t('results.position')} testid="sheet-position">
            {t('cand.coords', { ra: target.ra_deg.toFixed(6), dec: target.dec_deg.toFixed(6) })}
          </Row>
          <Row label={t('fov.label')}>{t('fov.arcmin', { value: target.fov_arcmin })}</Row>
          <Row label={t('share.link')} testid="sheet-url">
            <a className="break-all text-cyan underline underline-offset-2" href={model.view_url}>
              {model.view_url}
            </a>
          </Row>
          <Row label={t('results.generated')} testid="sheet-generated">
            {utc(model.generated_at_utc)}
          </Row>
        </Rows>
      </Section>

      <Section id="data" title={t('results.h.data')}>
        {data.build_status === 'partial' && (
          <p role="note" data-testid="sheet-partial">
            {t('results.partial')}
          </p>
        )}
        <Rows>
          <Row label={t('info.collection')}>
            {list(data.collections)}
            {data.data_as_of && ` (${t('info.dataAsOf')} ${data.data_as_of})`}
          </Row>
          <Row label={t('info.doi')} testid="sheet-doi">
            {data.dois.length
              ? data.dois.map((d, i) => (
                  <span key={d}>
                    {i > 0 && ', '}
                    <a
                      className="text-cyan underline underline-offset-2"
                      href={`https://doi.org/${d}`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {d}
                    </a>
                  </span>
                ))
              : na}
          </Row>
          <Row label={t('results.services')}>{list(data.services)}</Row>
          <Row label={t('info.pipeline')}>{data.pipeline_version}</Row>
          <Row label={t('info.sequence')} testid="sheet-sequence">
            {data.sequence_id}
          </Row>
        </Rows>
        <Table
          label={t('results.epochs')}
          testid="sheet-epochs"
          head={[
            t('info.epoch'),
            t('results.start'),
            t('results.end'),
            t('results.midMjd'),
            t('meas2.colN'),
            t('results.coadds'),
            t('info.coverage'),
          ]}
          rows={data.epochs.map((e) => [
            `E${e.epoch}`,
            utc(e.t_start_utc) ?? na,
            utc(e.t_end_utc) ?? na,
            e.t_mid_mjd != null ? e.t_mid_mjd.toFixed(1) : na,
            e.n_images != null ? String(e.n_images) : na,
            [
              ...e.detectors_with_coadds.map((d) => `D${d}`),
              ...(e.broadband_coadd ? [t('detector.broadband')] : []),
            ].join(', ') || na,
            t(`coverage.${e.coverage}`),
          ])}
        />
      </Section>

      <Section id="frames" title={t('results.h.frames')}>
        <Rows>
          <Row label={t('mode.label')} testid="sheet-mode">
            {t(`mode.${frames.mode}`)}
          </Row>
          <Row label={t('info.detector')} testid="sheet-detector">
            {frames.rgb_detectors
              ? t('mode.rgbLegend', {
                  r: `D${frames.rgb_detectors[0]}`,
                  g: `D${frames.rgb_detectors[1]}`,
                  b: `D${frames.rgb_detectors[2]}`,
                })
              : detLabel(t, frames.detector)}
            {frameBand && ` (${frameBand})`}
          </Row>
          {frames.epoch_shown != null && (
            <Row label={t('results.epochShown')}>{t('mode.refOption', { n: frames.epoch_shown })}</Row>
          )}
          {frames.reference_epoch != null && (
            <Row label={t('mode.reference')}>{t('mode.refOption', { n: frames.reference_epoch })}</Row>
          )}
          <Row label={t('info.stretch')} testid="sheet-stretch">
            {frames.mode === 'diff' || frames.mode === 'diffseq'
              ? t('results.stretchDiff')
              : frames.stretch.length === 0
                ? na
                : frames.stretch.map((s) => (
                    <span key={String(s.detector)} className="block">
                      {t('results.stretchValue', {
                        detector: detLabel(t, s.detector),
                        method: s.method,
                        vmin: Number(s.vmin.toPrecision(3)),
                        vmax: Number(s.vmax.toPrecision(3)),
                        unit: s.unit === 'normalized' ? t('info.unitNormalized') : s.unit,
                      })}
                    </span>
                  ))}
          </Row>
        </Rows>
      </Section>

      <Section id="measurements" title={t('results.h.measurements')}>
        {!anyMeasurement && <p data-testid="sheet-nomeasurements">{t('results.noMeasurements')}</p>}
        {ms.position && (
          <p className="tnum text-muted" data-testid="sheet-measured-position">
            {t('results.measuredAt')}:{' '}
            {t('cand.coords', { ra: ms.position.ra_deg.toFixed(6), dec: ms.position.dec_deg.toFixed(6) })}
          </p>
        )}

        {pr && (
          <Sub title={t('results.preset')} testid="sheet-preset">
            {pr.status === 'ok' && pr.value != null && pr.unit ? (
              <Rows>
                <Row
                  label={
                    pr.kind === 'motion'
                      ? t('presets.labelMotion')
                      : pr.unit === 'mag'
                        ? t('presets.labelMag')
                        : presetId
                          ? t(`presetCopy.${presetId}.measuredLabel`)
                          : t('presets.result')
                  }
                >
                  {localNumber(lang, pr.value, prDigits)}
                  {pr.err != null && ` ± ${localNumber(lang, pr.err, prDigits)}`} {localUnit(t, pr.unit)}
                </Row>
                {pr.reference_value != null && (
                  <Row label={t('presets.reference')}>
                    {localNumber(lang, pr.reference_value, prDigits)} {localUnit(t, pr.unit)}
                    {pr.reference_source ? ` (${pr.reference_source})` : ''}
                  </Row>
                )}
                {pr.agreement_sigma != null && (
                  <Row label={t('results.agreement')}>
                    {t('spec.nSigma', { n: localNumber(lang, pr.agreement_sigma, 1) })}
                  </Row>
                )}
                {pr.significance_sigma != null && (
                  <Row label={t('results.significance')}>
                    {t('spec.nSigma', { n: localNumber(lang, pr.significance_sigma, 1) })}
                  </Row>
                )}
              </Rows>
            ) : (
              <p>{t('presets.notMeasurable')}</p>
            )}
          </Sub>
        )}

        {pm && (
          <Sub title={t('meas.fitTitle')} testid="sheet-pm">
            {pm.fit ? (
              <Rows>
                <Row label="μα*" testid="sheet-pmra">
                  {mas(lang, pm.fit.pmra_masyr, pm.fit.pmra_err_masyr)} {t('meas.unit')}
                </Row>
                <Row label="μδ" testid="sheet-pmdec">
                  {mas(lang, pm.fit.pmdec_masyr, pm.fit.pmdec_err_masyr)} {t('meas.unit')}
                </Row>
                <Row label="μ">
                  {mas(lang, pm.fit.pm_total_masyr)} {t('meas.unit')}
                </Row>
                {pm.fit.parallax_mas != null && (
                  <Row label={t('meas.parallax')}>
                    {localNumber(lang, pm.fit.parallax_mas, 1)} mas{' '}
                    {pm.fit.parallax_fixed ? t('meas.fixed') : t('meas.fitted')}
                  </Row>
                )}
                {pm.fit.chi2_red != null && (
                  <Row label={t('meas2.chi2')}>{localNumber(lang, pm.fit.chi2_red, 2)}</Row>
                )}
                {pm.detector_used != null && <Row label={t('meas2.detectorUsed')}>D{pm.detector_used}</Row>}
                {pm.epochs_measured != null && pm.epochs_total != null && (
                  <Row label={t('meas2.epochsLabel')}>
                    {t('meas2.epochsValue', { n: pm.epochs_measured, total: pm.epochs_total })}
                  </Row>
                )}
                {pm.recalibration_catalog && (
                  <Row label={t('meas2.recalCatalog')}>{pm.recalibration_catalog}</Row>
                )}
                <Row label={t('meas.refTitle')} testid="sheet-pm-ref">
                  {pm.reference ? (
                    <>
                      μα* {mas(lang, pm.reference.pmra_masyr, pm.reference.pmra_err_masyr)}, μδ{' '}
                      {mas(lang, pm.reference.pmdec_masyr, pm.reference.pmdec_err_masyr)} {t('meas.unit')}
                      <span className="block font-sans">
                        {t('meas.source')}: {pm.reference.source}
                        {pm.reference.ref_epoch && `. ${t('meas2.refEpoch')}: ${pm.reference.ref_epoch}`}
                      </span>
                    </>
                  ) : (
                    t('meas.noRef')
                  )}
                </Row>
                {pm.agreement_sigma != null && (
                  <Row label={t('results.agreement')} testid="sheet-pm-agreement">
                    {t(`meas.verdict.${verdictOf(pm.agreement_sigma)}`)},{' '}
                    {t('spec.nSigma', { n: localNumber(lang, pm.agreement_sigma, 1) })}
                  </Row>
                )}
              </Rows>
            ) : (
              <div data-testid="sheet-pm-notmeasurable">
                <p className="font-semibold">{t('meas2.notMeasurableTitle')}</p>
                <p>
                  {pm.reason_code === 'TOO_FEW_EPOCHS'
                    ? t('meas.tooFewBody')
                    : pm.reason_code === 'POSITION_OUTSIDE_FIELD'
                      ? t('errors.POSITION_OUTSIDE_FIELD')
                      : t('meas2.notMeasurableCount', {
                          measured: pm.epochs_measured ?? 0,
                          total: pm.epochs_total ?? 0,
                          detector: pm.detector_used ?? '',
                        })}
                </p>
                {pm.unmeasured_epochs.some((e) => e.reason) && (
                  <p className="tnum">
                    {t('results.reasons')}:{' '}
                    {pm.unmeasured_epochs
                      .filter((e) => e.reason)
                      .map((e) => `E${e.epoch} ${e.reason}`)
                      .join('; ')}
                  </p>
                )}
              </div>
            )}
            {pm.warnings.length > 0 && (
              <p className="tnum text-muted">
                {t('info.warnings')}: {pm.warnings.map((w) => w.code).join(', ')}
              </p>
            )}
          </Sub>
        )}

        {sp && (
          <Sub title={t('spec.title')} testid="sheet-spectrum">
            <p>
              {t('spec2.usable', { n: sp.n_usable, total: sp.n_points })}.{' '}
              {sp.aperture_radius_arcsec != null &&
                `${t('spec.aperture', { r: localNumber(lang, sp.aperture_radius_arcsec, 1) })} `}
              {sp.wavelength_min_um != null &&
                sp.wavelength_max_um != null &&
                t('results.waveRange', {
                  range: band(sp.wavelength_min_um, sp.wavelength_max_um),
                })}
            </p>
            {sp.photometry && (
              <PhotometryTable
                p={sp.photometry}
                title={`${t('spec.photTitle')}, D${sp.photometry.detector}`}
                lang={lang}
              />
            )}
            {sp.warnings.length > 0 && (
              <p className="tnum text-muted">
                {t('info.warnings')}: {sp.warnings.map((w) => w.code).join(', ')}
              </p>
            )}
          </Sub>
        )}

        {lc && (
          <Sub title={`${t('lc.title')}, D${lc.photometry.detector}`} testid="sheet-lc">
            {lc.aperture_radius_arcsec != null && (
              <p className="text-muted">
                {t('lc.note', { r: localNumber(lang, lc.aperture_radius_arcsec, 0) })}
              </p>
            )}
            <PhotometryTable p={lc.photometry} title={t('lc.title')} lang={lang} />
          </Sub>
        )}

        {cand && (
          <Sub title={t('cand.title')} testid="sheet-candidates">
            {cand.status === 'loaded' && cand.counts ? (
              <>
                <p>
                  {t('results.candPair', {
                    a: cand.epoch_a,
                    b: cand.epoch_b,
                    sigma: cand.threshold_sigma != null ? localNumber(lang, cand.threshold_sigma, 1) : na,
                  })}
                </p>
                <Rows>
                  <Row label={t('cand.count.listed')} testid="sheet-cand-listed">
                    {cand.counts.listed}
                  </Row>
                  <Row label={t('cand.status.unmatched')}>{cand.counts.unmatched}</Row>
                  <Row label={t('cand.status.unchecked')}>{cand.counts.unchecked}</Row>
                  <Row label={t('cand.status.target')}>{cand.counts.target}</Row>
                  <Row label={t('cand.status.known_source')}>{cand.counts.known_source}</Row>
                  <Row label={t('cand.status.not_measurable')}>{cand.counts.not_measurable}</Row>
                </Rows>
                <p className="text-muted">
                  {t('cand.dropped', {
                    single: cand.counts.single_detector_dropped,
                    extended: cand.counts.extended_dropped,
                  })}
                  {cand.truncated ? ` ${t('cand.truncated')}` : ''}
                </p>
                <p className="text-muted">{t('cand.disclaimer')}</p>
              </>
            ) : (
              <p data-testid="sheet-cand-notloaded">{t('results.candNotLoaded')}</p>
            )}
          </Sub>
        )}

        {motion && (
          <Sub title={t('motion.title')} testid="sheet-motion">
            <p>
              {t('results.motionMethod', {
                epochs: motion.epochs.join(', '),
                years: localNumber(lang, motion.baseline_years, 2),
                sigma: localNumber(lang, motion.threshold_sigma, 1),
                n: motion.min_detectors,
              })}
            </p>
            <Rows>
              <Row label={t('motion.count.listed')} testid="sheet-motion-listed">
                {motion.counts.listed ?? 0}
              </Row>
              <Row label={t('motion.status.unmatched')}>{motion.counts.unmatched ?? 0}</Row>
              <Row label={t('motion.status.unchecked')}>{motion.counts.unchecked ?? 0}</Row>
              <Row label={t('motion.status.target')}>{motion.counts.target ?? 0}</Row>
              <Row label={t('motion.status.known_source')}>{motion.counts.known_source ?? 0}</Row>
            </Rows>
            {motion.sources.map((s) => (
              <p key={s.id} className="tnum">
                {`${s.id}, ${t(`motion.status.${s.status}`)}: `}
                {t('motion.pm', {
                  pmra: arcsecYr(lang, s.pmra_masyr, s.pmra_err_masyr),
                  pmdec: arcsecYr(lang, s.pmdec_masyr, s.pmdec_err_masyr),
                  unit: t('motion.unit'),
                })}
              </p>
            ))}
            {motion.truncated && <p className="text-muted">{t('motion.truncated')}</p>}
            <p className="text-muted">{t('motion.disclaimer')}</p>
          </Sub>
        )}
      </Section>

      {(warnings.warning_lines.length > 0 || warnings.note_lines.length > 0) && (
        <Section id="warnings" title={t('info.warnings')}>
          {warnings.warning_lines.length > 0 && (
            <ul className="list-disc pl-4" data-testid="sheet-warning-lines">
              {warnings.warning_lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          {warnings.note_lines.length > 0 && (
            <div data-testid="sheet-note-lines">
              <p className="font-semibold">{t('info.dataNotes')}</p>
              <ul className="list-disc pl-4">
                {warnings.note_lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </Section>
      )}

      <Section id="trace" title={t('results.h.trace')}>
        <div data-testid="sheet-obsids">
          <p className="font-semibold">{t('results.obsIds')}</p>
          {traceability.obs_ids.length === 0 ? (
            <p>{na}</p>
          ) : (
            <ul className="tnum mt-1 flex flex-col gap-1 text-caption-12">
              {traceability.obs_ids.map((g) => (
                <li key={`${g.epoch}-${g.detector}`} className="break-all">
                  <span className="font-semibold">
                    E{g.epoch} {g.detector === 'all' ? t('detector.broadband') : `D${g.detector}`} (
                    {g.obs_ids.length}):
                  </span>{' '}
                  {g.obs_ids.join(' ')}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="break-inside-avoid" data-testid="sheet-ack">
          <p className="font-semibold">{t('pages.ackTitle')}</p>
          <p className="text-muted">{t('pages.ackIntro')}</p>
          <dl className="mt-1 flex flex-col gap-1">
            {traceability.acknowledgements.map((a) => (
              <div key={a.id}>
                <dt className="inline font-semibold">{a.title}: </dt>
                <dd className="inline">{a.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>
    </div>
  );
}

function SheetBody({ x, targetName, viewUrl, presetId, target }: Omit<Props, 'open' | 'onOpenChange'>) {
  const { t } = useTranslation();
  const { lang, view } = x;
  const manifest = x.seq.manifest;
  const id = x.seq.sequenceId;
  const sel = useSelection(x);
  const [now] = useState(() => new Date());

  // Observers of the cache entries the panels fill: they never fetch (skipToken).
  const astro = useQuery<AstrometryResponse>({
    queryKey: astrometryKey(id, sel?.key, typeof x.det === 'number' ? x.det : null, x.mode),
    queryFn: skipToken,
  });
  const spec = useQuery<SpectrumResponse>({
    queryKey: spectrumKey(id, sel?.key, x.mode),
    queryFn: skipToken,
  });
  const phot = useQuery<PhotometryDoc>({
    queryKey: photometryKey(manifest?.photometry_url ?? null, x.mode),
    queryFn: skipToken,
  });
  const astroData = astro.data ?? null;
  const astroError = astro.error instanceof ApiError ? astro.error.code : null;
  const specData = spec.data ?? null;
  const photData = phot.data ?? null;
  const candActive = x.cand.active;
  const candData = x.cand.data;
  const motionData = x.motion.data;
  const ovKey = view.ov.join(',');

  useEffect(() => {
    document.documentElement.classList.add(PRINT_CLASS);
    return () => document.documentElement.classList.remove(PRINT_CLASS);
  }, []);

  const model = useMemo(() => {
    if (!manifest) return null;
    const usesGaia = ovKey.includes('gaia') || !!astroData || candActive || !!motionData;
    const usesWise = ovKey.includes('catwise') || candActive || !!motionData;
    const acks = ['spherex', ...(usesGaia ? ['gaia'] : []), ...(usesWise ? ['wise'] : [])];
    return buildSheet({
      now,
      language: lang,
      viewUrl,
      targetName,
      manifest,
      epochs: x.epochs,
      view: {
        mode: view.mode,
        detector: x.det,
        frameIdx: x.frameIdx,
        refIdx: x.refIdx,
        pairIndex: x.items[x.frameIdx]?.pair,
        rgb: x.rgb,
      },
      selection: sel ? { ra_deg: sel.ra_deg, dec_deg: sel.dec_deg, kind: sel.kind } : null,
      astrometry: astroData || astroError ? { data: astroData, errorCode: astroError } : null,
      spectrum: specData,
      photometry: photData,
      candidates: candActive ? { data: candData } : null,
      motionSearch: motionData,
      presetResult: target ? { result: target.result ?? null, notMeasurable: !!target.not_measurable } : null,
      warningLines: warningLines(t, manifest.warnings, lang),
      acknowledgements: acks.map((k) => ({
        id: k,
        title: t(`pages.ack.${k}.t`),
        text: t(`pages.ack.${k}.d`),
      })),
    });
  }, [
    manifest,
    now,
    lang,
    viewUrl,
    targetName,
    x.epochs,
    view.mode,
    x.det,
    x.frameIdx,
    x.refIdx,
    x.items,
    x.rgb,
    sel,
    astroData,
    astroError,
    specData,
    photData,
    candActive,
    candData,
    motionData,
    target,
    ovKey,
    t,
  ]);

  return (
    <>
      <div data-sheet-noprint>
        <div className="flex items-start justify-between gap-4">
          <DialogDescription className="text-label-13 text-muted">{t('results.desc')}</DialogDescription>
          <DialogClose asChild>
            <Button variant="ghost" aria-label={t('app.close')} className="-mr-2 -mt-1 px-2">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </Button>
          </DialogClose>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!model}
            onClick={() => window.print()}
            className="h-auto whitespace-normal py-1.5"
            data-testid="sheet-print"
          >
            {t('results.print')}
          </Button>
          <Button
            variant="secondary"
            disabled={!model}
            onClick={() => model && downloadText(sheetFileName(model), sheetJson(model), 'application/json')}
            data-testid="sheet-json"
          >
            {t('results.json')}
          </Button>
        </div>
      </div>

      <article
        data-theme="light"
        data-sheet
        className="mt-4 rounded-lg bg-surface p-4 text-text sm:p-6 print:mt-0 print:rounded-none print:p-0"
        data-testid="results-sheet"
      >
        <header>
          <p className="font-display text-caption-12 font-semibold uppercase tracking-wider text-muted">
            Destello
          </p>
          <DialogTitle className="text-title-20 font-medium text-text">{t('results.title')}</DialogTitle>
        </header>
        {model ? (
          <SheetView model={model} lang={lang} presetId={presetId} />
        ) : (
          <p className="mt-4 text-body-14 text-text-2" role="note" data-testid="sheet-notready">
            {t('results.notReady')}
          </p>
        )}
      </article>
    </>
  );
}

export function ResultsSheetDialog({ open, onOpenChange, ...rest }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-sheet-dialog className="max-w-[880px] p-4 sm:p-6" data-testid="results-dialog">
        {open && <SheetBody {...rest} />}
      </DialogContent>
    </Dialog>
  );
}
