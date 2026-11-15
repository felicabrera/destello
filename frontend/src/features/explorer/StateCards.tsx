// System states from board S-19: no data, rate limited, error with code, empty. Single epoch, IRSA degraded and demo
// are rendered by the Explorer as inline notices because they keep the frame visible.
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { fmtDuration } from '../../lib/format';
import type { TargetItem } from '../../lib/types';
import { PRESETS } from '../../lib/presets';

export function StateShell({
  tone,
  title,
  children,
  code,
  testid,
}: {
  tone: 'neutral' | 'warning' | 'danger';
  title: string;
  children: ReactNode;
  code?: string;
  testid: string;
}) {
  return (
    <section
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'grid aspect-square w-full place-items-center rounded-xl border bg-surface p-6',
        tone === 'danger' ? 'border-danger' : tone === 'warning' ? 'border-warning' : 'border-border-strong',
      )}
      data-testid={testid}
    >
      <div className="flex max-w-[440px] flex-col gap-3">
        <h2 className="text-heading-24 font-medium text-text">{title}</h2>
        <div className="flex flex-col gap-3 text-body-14 text-text-2">{children}</div>
        {code && (
          <p className="tnum text-caption-12 text-muted" data-testid="error-code">
            {code}
          </p>
        )}
      </div>
    </section>
  );
}

export function PresetLinks({ onOpen, label }: { onOpen: (id: string) => void; label: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="mb-2 text-caption-12 font-semibold uppercase tracking-wider text-muted">{label}</p>
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Button key={p.id} variant="secondary" size="sm" onClick={() => onOpen(p.id)}>
            {t(`presetCopy.${p.id}.chip`)}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function NoDataCard({
  releaseLabel,
  fov,
  dataAsOf,
  onOpen,
}: {
  releaseLabel: string;
  fov: number;
  dataAsOf?: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <StateShell tone="neutral" title={t('states.noDataTitle')} code="NO_COVERAGE" testid="state-nodata">
      <p>{t('states.noDataBody', { release: releaseLabel, fov })}</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>{t('states.noDataR1')}</li>
        <li>{t('states.noDataR2', { date: dataAsOf ?? '' })}</li>
      </ul>
      <PresetLinks onOpen={onOpen} label={t('states.noDataTry')} />
      <a
        className="text-label-13 text-cyan underline underline-offset-2"
        href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
        target="_blank"
        rel="noreferrer noopener"
      >
        {t('states.noDataIrsa')}
      </a>
      <p className="text-caption-12 text-muted">{t('states.noDataNote')}</p>
    </StateShell>
  );
}

export function RateLimitedCard({
  retryAfter,
  onRetry,
  onOpen,
}: {
  retryAfter: number;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(Math.max(1, retryAfter));
  useEffect(() => {
    const id = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(id);
  }, []);
  const time = `${Math.floor(left / 60)} min ${String(left % 60).padStart(2, '0')} s`;
  return (
    <StateShell
      tone="warning"
      title={t('states.rateTitle', { time })}
      code={`RATE_LIMITED · 429 · Retry-After ${retryAfter} s`}
      testid="state-rate"
    >
      <p>{t('states.rateBody')}</p>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          onClick={onRetry}
          aria-disabled={left > 0}
          disabled={left > 0}
          data-testid="rate-retry"
        >
          {t('states.rateButton', { time: fmtDuration(left) })}
        </Button>
      </div>
      <PresetLinks onOpen={onOpen} label={t('presets.label')} />
    </StateShell>
  );
}

export function ErrorCard({
  code,
  onRetry,
  onOpen,
}: {
  code: string;
  onRetry: () => void;
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const known = i18n.exists(`errors.${code}`);
  return (
    <StateShell
      tone="danger"
      title={t('states.errorTitle')}
      code={`${t('states.errorCode')}: ${code}`}
      testid="state-error"
    >
      <p>{known ? t(`errors.${code}`) : t('states.errorBody')}</p>
      <div>
        <Button variant="primary" onClick={onRetry} data-testid="error-retry">
          {t('states.retry')}
        </Button>
      </div>
      <PresetLinks onOpen={onOpen} label={t('presets.label')} />
    </StateShell>
  );
}

export function EmptyCard({ onOpen, onTour }: { onOpen: (id: string) => void; onTour?: () => void }) {
  const { t } = useTranslation();
  return (
    <StateShell tone="neutral" title={t('states.emptyTitle')} testid="state-empty">
      <p>{t('states.emptyBody')}</p>
      <PresetLinks onOpen={onOpen} label={t('presets.label')} />
      <ol className="list-decimal space-y-1 pl-5 text-label-13">
        <li>{t('presets.step1')}</li>
        <li>{t('presets.step2')}</li>
        <li>{t('presets.step3')}</li>
      </ol>
      {onTour && (
        <Button variant="secondary" className="self-start" onClick={onTour} data-testid="tour-start">
          {t('tour.take')}
        </Button>
      )}
    </StateShell>
  );
}

export function SingleEpochCard({
  releaseLabel,
  targets,
  onOpen,
}: {
  releaseLabel: string;
  targets: TargetItem[] | undefined;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="rounded-xl border border-warning bg-surface p-4"
      role="status"
      data-testid="state-single"
    >
      <h2 className="text-title-20 font-medium">{t('states.singleTitle')}</h2>
      <p className="mt-1 text-body-14 text-text-2">{t('states.singleBody', { release: releaseLabel })}</p>
      <dl className="mt-3 grid gap-2 text-label-13">
        <div>
          <dt className="font-semibold text-success">{t('states.singleStill')}</dt>
          <dd className="text-text-2">{t('states.singleStillBody')}</dd>
        </div>
        <div>
          <dt className="font-semibold text-warning">{t('states.singleNeeds')}</dt>
          <dd className="text-text-2">{t('states.singleNeedsBody')}</dd>
        </div>
      </dl>
      {targets && <PresetLinks onOpen={onOpen} label={t('states.singleSuggest')} />}
    </section>
  );
}
