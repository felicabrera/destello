// F-33 page /comet: the 3I/ATLAS preset. Exposure blink by detector, aligned stack, spectrum, NEOSSat view.
// URL: seq (campaign), det (1 to 6), frame (1-based), mode (stack for the aligned stack), play, lang.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { useView } from '../explorer/useView';
import { warningLines } from '../panels/warnings';
import { CometPlayer } from './CometPlayer';
import { CometResultCard, campaignLabel } from './CometResultCard';
import { MoverSpectrumPanel } from './MoverSpectrumPanel';
import { NeossatPanel } from './NeossatPanel';
import { choices, exposureDetectors, exposuresFor, stacksFor } from './cometModel';
import {
  useMoverCheck,
  useMoverManifest,
  useMoverNeossat,
  useMoverSpectrum,
  useMovers,
  useValidationReport,
} from './useComet';

function useReducedMotion(): boolean {
  const [r, setR] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}

function Seg<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testid,
}: {
  label: string;
  value: T;
  options: { v: T; text: string }[];
  onChange: (v: T) => void;
  testid: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-2" data-testid={testid}>
      <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          aria-pressed={o.v === value}
          onClick={() => onChange(o.v)}
          className={cn(
            'min-h-[var(--hit-min)] rounded-lg border px-3 text-body-14 transition-colors duration-(--duration-fast)',
            o.v === value
              ? 'border-glint bg-glint-soft font-semibold text-text'
              : 'border-border-strong bg-transparent font-medium text-text hover:bg-surface-2',
          )}
          data-testid={`${testid}-${String(o.v)}`}
        >
          {o.text}
        </button>
      ))}
    </div>
  );
}

export function CometPage() {
  const { t } = useTranslation('comet');
  const { t: tr } = useTranslation();
  const v = useView();
  const lang = v.view.lang;
  const reduced = useReducedMotion();
  const movers = useMovers();
  const opts = useMemo(() => choices(movers.data), [movers.data]);
  const seq = v.view.seq && opts.some((o) => o.sequenceId === v.view.seq) ? v.view.seq : opts[0]?.sequenceId;
  const manifest = useMoverManifest(seq);
  const spectrum = useMoverSpectrum(seq);
  const check = useMoverCheck(seq);
  const neo = useMoverNeossat(seq);
  const report = useValidationReport();
  const m = manifest.data;
  const campaign = opts.find((o) => o.sequenceId === seq)?.campaign?.index ?? 0;

  const dets = useMemo(() => (m ? exposureDetectors(m) : []), [m]);
  const det = typeof v.view.det === 'number' && dets.includes(v.view.det) ? v.view.det : (dets[0] ?? 1);
  const mode: 'exposures' | 'stack' = v.view.mode === 'stack' ? 'stack' : 'exposures';
  const exposures = useMemo(() => (m ? exposuresFor(m, det) : []), [m, det]);
  const stack = m ? stacksFor(m, det)[0] : undefined;
  const index = Math.min(Math.max((v.view.frame ?? 1) - 1, 0), Math.max(exposures.length - 1, 0));
  const [playing, setPlaying] = useState(false);
  const update = v.update;
  const setIndex = useCallback((i: number) => update({ frame: i + 1 }), [update]);
  const cur = exposures[index];
  const warns = useMemo(
    () => (m ? warningLines(tr, m.warnings, lang) : { warnings: [], notes: [] }),
    [m, tr, lang],
  );

  let body: React.ReactNode;
  if (movers.isPending || (opts.length > 0 && manifest.isPending))
    body = (
      <p className="text-body-14 text-muted" role="status" data-testid="comet-loading">
        {t('loading')}
      </p>
    );
  else if (!seq || manifest.isError || !m)
    body = (
      <div
        className="flex flex-col gap-3 rounded-xl border border-border-strong bg-surface p-6"
        role="alert"
        data-testid="comet-unavailable"
      >
        <p className="text-body-14 text-text">{t('unavailable')}</p>
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            void movers.refetch();
            void manifest.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </div>
    );
  else
    body = (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col gap-2">
            {opts.length > 1 && (
              <Seg
                label={t('campaign')}
                value={seq}
                options={opts.map((o) => ({
                  v: o.sequenceId,
                  text: o.campaign ? campaignLabel(lang, o.campaign) : o.sequenceId,
                }))}
                onChange={(s) => update({ seq: s, frame: undefined })}
                testid="comet-campaign"
              />
            )}
            <Seg
              label={t('detector')}
              value={det}
              options={dets.map((d) => ({ v: d, text: `D${d}` }))}
              onChange={(d) => update({ det: d as 1 | 2 | 3 | 4 | 5 | 6, frame: undefined })}
              testid="comet-det"
            />
            <Seg
              label={t('mode.label')}
              value={mode}
              options={[
                { v: 'exposures', text: t('mode.exposures') },
                { v: 'stack', text: t('mode.stack') },
              ]}
              onChange={(x) => update({ mode: x === 'stack' ? 'stack' : undefined })}
              testid="comet-mode"
            />
          </div>
          <CometPlayer
            manifest={m}
            lang={lang}
            mode={mode}
            exposures={exposures}
            stack={stack}
            index={index}
            onIndex={setIndex}
            playing={playing}
            onPlaying={setPlaying}
            reduced={reduced}
          />
          <ul className="flex flex-col gap-1 text-caption-12 text-text-2" data-testid="comet-warnings">
            {[...warns.warnings, ...warns.notes].map((w) => (
              <li key={w} className="rounded-lg border border-border p-2">
                {w}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <CometResultCard
            lang={lang}
            manifest={m}
            spectrum={spectrum.data}
            check={check.data}
            report={report.data}
            campaign={campaign}
          />
          <MoverSpectrumPanel
            lang={lang}
            manifest={m}
            spectrum={spectrum.data}
            check={check.data}
            report={report.data}
            campaign={campaign}
          />
          <NeossatPanel
            lang={lang}
            doc={neo.data}
            loading={neo.isPending}
            failed={neo.isError}
            obsId={mode === 'exposures' ? cur?.obsId : undefined}
          />
        </div>
      </div>
    );

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-4 md:px-6 xl:px-8"
      data-testid="comet-page"
    >
      <header className="flex flex-col gap-1">
        <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">{t('kicker')}</p>
        <h1 className="text-heading-24 font-medium text-text">{t('title')}</h1>
        <p className="max-w-3xl text-body-14 text-text-2">{t('intro')}</p>
      </header>
      {body}
    </main>
  );
}
