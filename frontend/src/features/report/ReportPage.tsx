// S-14f: public report page at /r/$reportId. Everything shown comes from the stored report document;
// the frame crops come from the reported sequence and degrade to a note when its frames are no longer kept.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { ApiError, getManifest, getReport, reportFileUrl, resolveAsset } from '../../lib/api';
import { skyToPixel, type Grid } from '../../lib/astrometry';
import { isDemo, useBackend } from '../../lib/backend';
import { formatDec, formatRa } from '../../lib/coords';
import { fmtMjd } from '../../lib/format';
import {
  FOVS,
  type Fov,
  type Lang,
  type Manifest,
  type ReportDocument,
  type ReportMark,
} from '../../lib/types';
import { readColors } from '../player/draw';
import { useView } from '../explorer/useView';
import { NextSteps } from './ReportFlow';
import { CheckRows, MotionLine, VerdictBox } from './ReportParts';
import { REPORT_ID_RE } from './reportModel';

const CROP_ARCSEC = 62;

export function ReportPage() {
  const { t } = useTranslation();
  const { reportId = '' } = useParams({ strict: false }) as { reportId?: string };
  const lang = useView().view.lang;
  const demo = isDemo(useBackend((s) => s.mode));
  const valid = REPORT_ID_RE.test(reportId);
  const q = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => getReport(reportId),
    enabled: valid && !demo,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
    staleTime: 60_000,
  });

  let body: React.ReactNode;
  if (demo) body = <Notice text={t('report.err.demo')} />;
  else if (!valid || (q.error instanceof ApiError && q.error.status === 404))
    body = <Notice text={t('report.page.notFound')} />;
  else if (q.error) body = <Notice text={t('report.page.loadError')} />;
  else if (!q.data) body = <Notice text={t('report.page.loading')} busy />;
  else body = <ReportBody doc={q.data} lang={lang} />;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-[1100px] flex-col gap-8 px-4 py-10 md:px-6"
      data-testid="report-page"
    >
      {body}
      <p>
        <Link to="/" className="text-label-13 text-cyan underline underline-offset-2">
          {t('pages.back')}
        </Link>
      </p>
    </main>
  );
}

function Notice({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <p
      className="rounded-xl border border-border bg-surface p-4 text-body-15 text-text-2"
      role={busy ? 'status' : 'alert'}
      data-testid="report-page-notice"
    >
      {text}
    </p>
  );
}

function detLabel(d: ReportDocument['detector']): string {
  return d === null || d === 'all' ? 'D1-D6' : `D${d}`;
}

function ReportBody({ doc, lang }: { doc: ReportDocument; lang: Lang }) {
  const { t } = useTranslation();
  const s = doc.sequence;
  const manifestQ = useQuery({
    queryKey: ['report-manifest', s.manifest_url],
    queryFn: () => getManifest(s.manifest_url),
    retry: false,
    staleTime: Infinity,
  });
  const manifest = manifestQ.data ?? null;
  const epochLabel = (epoch: number) => {
    const pos = manifest?.epochs.findIndex((e) => e.index === epoch) ?? -1;
    return `E${(pos >= 0 ? pos : epoch) + 1}`;
  };
  const created = doc.created_at.replace('T', ' ').replace(/(:\d\d)(\.\d+)?(Z|\+00:00)$/, '$1');
  const fov =
    s.fov_arcmin !== null && (FOVS as readonly number[]).includes(s.fov_arcmin)
      ? (s.fov_arcmin as Fov)
      : undefined;
  const explorerSearch = {
    lang,
    seq: s.sequence_id,
    ...(s.center_deg ? { ra: s.center_deg[0].toFixed(5), dec: s.center_deg[1].toFixed(5) } : {}),
    ...(fov ? { fov } : {}),
    ...(doc.detector !== null ? { det: doc.detector } : {}),
  };

  return (
    <>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="tnum text-caption-12 font-semibold uppercase tracking-wider text-glint">
            {t('report.page.kicker', { id: doc.report_id })}
          </p>
          <Badge tone="warning" data-testid="report-unconfirmed">
            {t('report.page.unconfirmed')}
          </Badge>
        </div>
        <h1 className="font-display text-heading-24 font-medium md:text-display-32">
          {t(`report.page.title.${doc.checks.verdict}`)}
        </h1>
        <p className="tnum font-mono text-caption-12 text-muted" data-testid="report-meta">
          {t('report.page.meta', {
            date: created,
            collections: s.collections.join(', ') || 'SPHEREx',
            det: detLabel(doc.detector),
            seq: s.sequence_id,
            pipeline: s.pipeline_version ?? '?',
          })}
        </p>
      </header>

      <section
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4"
        aria-labelledby="rp-what"
      >
        <h2 id="rp-what" className="text-body-15 font-semibold text-text">
          {t('report.page.whatTitle')}
        </h2>
        <p className="text-body-15 text-text-2">{t('report.page.what', { n: doc.marks.length })}</p>
        <VerdictBox verdict={doc.checks.verdict} />
      </section>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
        <figure className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="report-crops">
            {doc.marks.map((m) => (
              <Crop key={m.index} mark={m} doc={doc} manifest={manifest} label={epochLabel(m.epoch)} />
            ))}
          </div>
          <figcaption className="text-caption-12 text-muted">
            {t('report.page.cropsCaption', { size: CROP_ARCSEC, det: detLabel(doc.detector) })}
          </figcaption>
        </figure>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2" aria-labelledby="rp-motion">
            <h2 id="rp-motion" className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
              {t('report.page.motionTitle', { n: doc.checks.motion.n_marks })}
            </h2>
            <MotionLine motion={doc.checks.motion} lang={lang} />
          </section>
          <table className="w-full border-collapse overflow-hidden rounded-lg border border-border text-left">
            <caption className="sr-only">{t('report.page.marksCaption')}</caption>
            <thead className="bg-surface-2 text-caption-12 text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('report.page.colMark')}
                </th>
                <th scope="col" className="px-3 py-2 font-semibold">
                  {t('report.page.colPos')}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  {t('report.page.colDate')}
                </th>
              </tr>
            </thead>
            <tbody className="tnum font-mono text-caption-12 text-text">
              {doc.marks.map((m) => (
                <tr key={m.index} className="border-t border-border">
                  <th scope="row" className="px-3 py-2 font-normal">
                    {epochLabel(m.epoch)}
                  </th>
                  <td className="px-3 py-2">
                    {formatRa(m.ra_deg)} {formatDec(m.dec_deg)}
                    <span className="block text-muted">
                      {m.ra_deg.toFixed(5)}, {m.dec_deg >= 0 ? '+' : ''}
                      {m.dec_deg.toFixed(5)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.t_mid.slice(0, 10)}
                    <span className="block text-muted">MJD {fmtMjd(m.t_mid_mjd)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <section className="flex flex-col gap-3" aria-labelledby="rp-checks">
        <h2 id="rp-checks" className="text-title-20 font-medium text-text">
          {t('report.page.checksTitle')}
        </h2>
        <CheckRows checks={doc.checks} lang={lang} epochLabel={epochLabel} marks={doc.marks} />
        <p className="text-caption-12 text-muted">{t('report.page.propagated')}</p>
        <p className="text-caption-12 text-muted">{t('report.geocentric')}</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="rp-notes">
        <h2 id="rp-notes" className="text-title-20 font-medium text-text">
          {t('report.page.notesTitle')}
        </h2>
        {doc.notes ? (
          <p
            className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 text-body-15 text-text"
            data-testid="report-notes-public"
          >
            {doc.notes}
          </p>
        ) : (
          <p className="text-body-14 text-muted">{t('report.page.noNotes')}</p>
        )}
        <p className="text-caption-12 text-muted">{t('report.page.notesCaption')}</p>
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="rp-files">
        <h2 id="rp-files" className="text-title-20 font-medium text-text">
          {t('report.page.filesTitle')}
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-label-13">
          <a className="text-cyan underline underline-offset-2" href={reportFileUrl(doc.report_id, 'json')}>
            report.json
          </a>
          <a className="text-cyan underline underline-offset-2" href={reportFileUrl(doc.report_id, 'txt')}>
            report.txt
          </a>
          {s.target_id ? (
            <Link
              to="/t/$target"
              params={{ target: s.target_id }}
              search={{ lang }}
              className="text-cyan underline underline-offset-2"
            >
              {t('report.page.openExplorer')}
            </Link>
          ) : (
            <Link to="/" search={explorerSearch} className="text-cyan underline underline-offset-2">
              {t('report.page.openExplorer')}
            </Link>
          )}
        </div>
        {s.dois.length > 0 && (
          <p className="tnum font-mono text-caption-12 text-muted">
            {s.dois.map((d) => `DOI ${d}`).join(' · ')} · {t('report.page.obsIds')}
          </p>
        )}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="rp-next">
        <h2 id="rp-next" className="sr-only">
          {t('report.next.title')}
        </h2>
        <NextSteps />
        <p className="text-body-14 text-text-2">
          <span className="font-semibold text-text">{t('report.page.laterTitle')}</span>{' '}
          {t('report.page.later')}
        </p>
      </section>
    </>
  );
}

/** One crop of the marked frame, north up and east left, with the reporter's mark as a crosshair. */
function Crop({
  mark,
  doc,
  manifest,
  label,
}: {
  mark: ReportMark;
  doc: ReportDocument;
  manifest: Manifest | null;
  label: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone'>('loading');
  const url = mark.frame?.url ?? null;

  useEffect(() => {
    const center = doc.sequence.center_deg;
    if (!url || !center) {
      setState('gone');
      return;
    }
    let alive = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (!alive || !ref.current) return;
      const n = img.naturalWidth;
      const scale =
        manifest?.grid.pixel_scale_arcsec ?? ((doc.sequence.fov_arcmin ?? 6) * 60) / Math.max(n, 1);
      const grid: Grid = { ra0: center[0], dec0: center[1], scaleArcsec: scale, n };
      const p = skyToPixel(grid, mark.ra_deg, mark.dec_deg);
      const half = Math.max(4, Math.round(CROP_ARCSEC / scale / 2));
      const side = half * 2;
      const out = 192;
      const c = ref.current;
      c.width = out;
      c.height = out;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const col = readColors();
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = col.frame;
      ctx.fillRect(0, 0, out, out);
      const sx = Math.round(p.x) - half;
      const sy = Math.round(p.y) - half;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
      const k = out / side;
      const cx = (p.x - sx) * k;
      const cy = (p.y - sy) * k;
      ctx.strokeStyle = col.glint;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [dx, dy, ex, ey] of [
        [-16, 0, -6, 0],
        [6, 0, 16, 0],
        [0, -16, 0, -6],
        [0, 6, 0, 16],
      ]) {
        ctx.moveTo(cx + dx, cy + dy);
        ctx.lineTo(cx + ex, cy + ey);
      }
      ctx.stroke();
      setState('ok');
    };
    img.onerror = () => alive && setState('gone');
    img.src = resolveAsset(url);
    return () => {
      alive = false;
    };
  }, [url, doc, manifest, mark.ra_deg, mark.dec_deg]);

  return (
    <div className="flex flex-col gap-1">
      <div className="relative aspect-square overflow-hidden rounded-md border border-border bg-frame">
        <canvas
          ref={ref}
          className={state === 'ok' ? 'h-full w-full [image-rendering:pixelated]' : 'hidden'}
          role="img"
          aria-label={t('report.page.cropAlt', { e: label })}
        />
        {state !== 'ok' && (
          <span className="absolute inset-0 flex items-center justify-center p-2 text-center text-caption-12 text-muted">
            {state === 'loading' ? t('report.page.cropLoading') : t('report.page.cropGone')}
          </span>
        )}
      </div>
      <span className="tnum font-mono text-caption-12 text-text-2">
        {label} · {mark.t_mid.slice(0, 10)}
      </span>
    </div>
  );
}
