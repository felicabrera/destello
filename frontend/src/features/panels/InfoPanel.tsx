import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  epochMid,
  fmtMjd,
  isoDay,
  localDate,
  localNumber,
  localPercent,
  mjdIso,
  mjdToDate,
  bandRange,
} from '../../lib/format';
import {
  frameDetector,
  isLowCoverage,
  type DetectorSel,
  type EpochInfo,
  type FrameInfo,
  type Lang,
  type Manifest,
} from '../../lib/types';
import { resolveAsset } from '../../lib/api';
import { warningLines } from './warnings';
import { LowCoverageBadge } from '../player/LowCoverageBadge';

interface Props {
  manifest: Manifest | null;
  epoch: EpochInfo | null;
  epochIdx: number;
  totalEpochs: number;
  frame: FrameInfo | null;
  det: DetectorSel;
  lang: Lang;
  releaseLabel?: string;
  dataAsOf?: string;
}

function Row({ label, children, testid }: { label: string; children: React.ReactNode; testid?: string }) {
  return (
    <div
      className="grid grid-cols-[132px_minmax(0,1fr)] gap-x-3 border-b border-border py-2 last:border-b-0"
      data-testid={testid}
    >
      <dt className="text-label-13 text-muted">{label}</dt>
      <dd className="tnum min-w-0 break-words text-label-13 text-text">{children}</dd>
    </div>
  );
}

/** Every DOI of the sequence, trimmed, without repeats, in manifest order. */
export function uniqueDois(dois: readonly string[] | undefined): string[] {
  return [...new Set((dois ?? []).map((d) => d.trim()).filter(Boolean))];
}

export function InfoPanel({
  manifest,
  epoch,
  epochIdx,
  totalEpochs,
  frame,
  det,
  lang,
  releaseLabel,
  dataAsOf,
}: Props) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);

  const low = isLowCoverage(epoch);
  if (!epoch || !frame) {
    // F-31: a short revisit observed only some detectors. Say so instead of suggesting a frame is on its way.
    if (epoch && low)
      return (
        <div className="flex flex-col items-start gap-2" data-testid="info-panel">
          <LowCoverageBadge testId="info-low-badge" className="text-text" />
          <p className="text-body-14 text-text-2" data-testid="info-low-missing">
            {t('player.lowMissing', {
              detector: det === 'all' ? t('detector.allDet') : `D${det}`,
              epoch: epochIdx + 1,
            })}
          </p>
        </div>
      );
    return <p className="text-body-14 text-muted">{t('info.noFrame')}</p>;
  }
  // The coverage row appears once a sequence holds a low coverage epoch, so full epochs read as such.
  const showCoverage = low || !!manifest?.epochs.some(isLowCoverage);
  const mid = epochMid(epoch);
  const lines = warningLines(t, manifest?.warnings ?? [], lang);
  const collection = manifest?.provenance.collections.length
    ? manifest.provenance.collections.join(', ')
    : manifest?.request.release;
  const dois = uniqueDois(manifest?.provenance.dois);
  const detKey = det === 'all' ? 'all' : String(det);
  const stretch =
    manifest?.stretch[detKey] ??
    manifest?.stretch['0'] ??
    (manifest ? Object.values(manifest.stretch)[0] : undefined);
  const ids = frame.obs_ids;
  const shown = showAll ? ids : ids.slice(0, 3);
  const flagged = frame.flagged_fraction;
  // The static manifest exists only once the build is complete.
  const manifestUrl =
    manifest && manifest.build?.status !== 'partial' ? `/manifests/${manifest.sequence_id}.json` : null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ids.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div data-testid="info-panel">
      <dl>
        <Row label={t('info.frame')} testid="info-frame">
          {t('player.epochLine', {
            epoch: epochIdx + 1,
            total: totalEpochs,
            detector: det === 'all' ? t('detector.all') : `D${det}`,
            band: bandRange(frame, t('player.to')) ?? '',
          })}
        </Row>
        {showCoverage && (
          <Row label={t('info.coverage')} testid="info-coverage">
            {low ? (
              <>
                <LowCoverageBadge testId="info-low-badge" className="text-text" />
                <span className="mt-1 block text-text-2">{t('info.coverageLowBody')}</span>
              </>
            ) : (
              t('info.coverageFull')
            )}
          </Row>
        )}
        <Row label={t('info.release')}>
          {releaseLabel ?? collection ?? t('info.unavailable')}
          {dataAsOf && (
            <span className="text-muted">
              {' '}
              · {t('info.dataAsOf')} {dataAsOf}
            </span>
          )}
        </Row>
        <Row label={t('info.collection')}>{collection ?? t('info.unavailable')}</Row>
        <Row label={t('info.observed')}>
          {epoch.t_start && epoch.t_end
            ? `${isoDay(epoch.t_start)} ${t('player.to')} ${isoDay(epoch.t_end)}`
            : t('info.unavailable')}
          {epoch.t_start && epoch.t_end && (
            <span className="block text-muted">
              {localDate(lang, new Date(epoch.t_start))} {t('player.to')}{' '}
              {localDate(lang, new Date(epoch.t_end))}
            </span>
          )}
        </Row>
        <Row label={t('info.mid')}>
          {mid !== undefined
            ? `${mjdIso(mid)} · MJD ${fmtMjd(mid)} · ${localDate(lang, mjdToDate(mid))}`
            : t('info.unavailable')}
        </Row>
        <Row label={t('info.detector')}>{det === 'all' ? t('detector.allDet') : `D${det}`}</Row>
        <Row label={t('info.band')}>{bandRange(frame, t('player.to')) ?? t('info.unavailable')}</Row>
        <Row label={t('info.nimg')}>{localNumber(lang, frame.n_images)}</Row>
        <Row label={t('info.stretch')}>
          {stretch ? (
            <>
              {t('info.stretchValue', { count: totalEpochs })}
              <span className="block text-muted">
                {Number(stretch.vmin.toPrecision(3))} {t('player.to')} {Number(stretch.vmax.toPrecision(3))}{' '}
                {stretch.unit === 'normalized' ? t('info.unitNormalized') : stretch.unit}
              </span>
            </>
          ) : (
            t('info.unavailable')
          )}
        </Row>
        <Row label={t('info.pipeline')}>{manifest?.pipeline_version ?? t('info.unavailable')}</Row>
        <Row label={t('info.flagged')} testid="info-flagged">
          {localPercent(lang, flagged)}
          <span className="block text-caption-12 text-muted">{t('info.flagNote')}</span>
        </Row>
        <Row label={t('info.src')} testid="info-src">
          <span className="block text-muted">
            {t('info.srcSum', {
              count: ids.length,
              from: isoDay(epoch.t_start),
              to: isoDay(epoch.t_end),
              detectors:
                det === 'all'
                  ? t('info.manyDet', { count: manifest?.request.detectors.length ?? 6 })
                  : t('info.oneDet'),
            })}
          </span>
          <ul className="mt-1 space-y-0.5 break-all text-caption-12">
            {shown.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
          <span className="mt-1.5 flex flex-wrap gap-2">
            {ids.length > 3 && (
              <Button
                variant="ghost"
                size="sm"
                className="px-2"
                aria-expanded={showAll}
                onClick={() => setShowAll((s) => !s)}
              >
                {showAll ? t('info.hide') : t('info.showAll')}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="px-2" onClick={() => void copy()}>
              {copied ? t('info.copied') : t('info.copyList')}
            </Button>
          </span>
        </Row>
        <Row label={t('info.doi')}>
          {dois.length > 0 ? (
            <span className="flex flex-col items-start gap-1">
              {dois.map((d) => (
                <a
                  key={d}
                  className="text-cyan underline underline-offset-2"
                  href={`https://doi.org/${d}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  data-testid="info-doi"
                >
                  {d}
                </a>
              ))}
            </span>
          ) : (
            t('info.unavailable')
          )}
        </Row>
      </dl>
      <div className="mt-4">
        <h3 className="mb-2 text-caption-12 font-semibold uppercase tracking-wider text-muted">
          {t('info.downloads')}
        </h3>
        <div className="flex flex-wrap gap-2">
          {frame.fits_url ? (
            <Button asChild variant="secondary">
              <a href={resolveAsset(frame.fits_url)} download data-testid="dl-fits">
                {t('info.fits')}
              </a>
            </Button>
          ) : (
            <Button variant="secondary" aria-disabled title={t('info.unavailable')}>
              {t('info.fits')}
            </Button>
          )}
          {manifestUrl && (
            <Button asChild variant="secondary">
              <a href={resolveAsset(manifestUrl)} download data-testid="dl-manifest">
                {t('info.manifest')}
              </a>
            </Button>
          )}
        </div>
      </div>
      {lines.warnings.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-warning p-3 text-caption-12"
          role="note"
          data-testid="info-warnings"
        >
          <p className="font-semibold text-warning">{t('info.warnings')}</p>
          <ul className="mt-1 list-disc pl-4 text-text-2">
            {lines.warnings.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {lines.notes.length > 0 && (
        <div
          className="mt-4 rounded-lg border border-border p-3 text-caption-12"
          role="note"
          data-testid="info-notes"
        >
          <p className="font-semibold text-text">{t('info.dataNotes')}</p>
          <ul className="mt-1 list-disc pl-4 text-text-2">
            {lines.notes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export { frameDetector };
