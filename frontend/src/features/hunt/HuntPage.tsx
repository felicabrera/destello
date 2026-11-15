// F-35 Hunt page: one field at a time, five answers, optional mark, counters and a first-visit tutorial.
// Anonymous: the only identifier is a random token kept in this browser (lib/hunt.ts).
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { useView } from '../explorer/useView';
import { HuntCandidates } from './HuntCandidates';
import { HuntCounters } from './HuntCounters';
import { HuntReview } from './HuntReview';
import { HuntTutorial, useHuntTutorial } from './HuntTutorial';
import { useHuntFlow } from './useHuntFlow';

function Card({
  tone = 'neutral',
  title,
  children,
  testid,
}: {
  tone?: 'neutral' | 'danger' | 'warning';
  title: string;
  children?: React.ReactNode;
  testid: string;
}) {
  const border =
    tone === 'danger' ? 'border-danger' : tone === 'warning' ? 'border-warning' : 'border-border-strong';
  return (
    <section
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`flex flex-col gap-3 rounded-xl border bg-surface p-6 ${border}`}
      data-testid={testid}
    >
      <h2 className="text-heading-24 font-medium text-text">{title}</h2>
      <div className="flex flex-col gap-3 text-body-14 text-text-2">{children}</div>
    </section>
  );
}

export function HuntPage() {
  const { t } = useTranslation('hunt');
  const v = useView();
  const flow = useHuntFlow();
  const start = useHuntTutorial((s) => s.start);
  const maybeAutoStart = useHuntTutorial((s) => s.maybeAutoStart);
  const continueRef = useRef<HTMLButtonElement>(null);
  const { phase, reveal } = flow;
  const field = phase.kind === 'field' ? phase.field : null;

  useEffect(() => {
    maybeAutoStart();
  }, [maybeAutoStart]);

  // The Explorer model reads the sequence from the URL: point it at the field before the review mounts, and
  // start every field from the default view (blink, first epoch).
  const seqInUrl = v.view.seq;
  const update = v.update;
  useEffect(() => {
    if (field && seqInUrl !== field.sequence_id)
      update({
        seq: field.sequence_id,
        frame: undefined,
        ref: undefined,
        mode: undefined,
        ov: undefined,
        det: undefined,
      });
  }, [field, seqInUrl, update]);

  useEffect(() => {
    if (reveal) continueRef.current?.focus();
  }, [reveal]);

  const ready = field !== null && seqInUrl === field.sequence_id;
  const rate = flow.problem?.kind === 'rate' ? flow.problem : null;
  const other = flow.problem?.kind === 'other' ? flow.problem : null;

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto flex max-w-[1440px] flex-col gap-4 px-4 py-4 md:px-6 xl:px-8"
      data-testid="hunt"
    >
      <HuntTutorial />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-heading-24 font-medium md:text-display-32">{t('title')}</h1>
          <p className="mt-1 max-w-[720px] text-body-15 text-muted">{t('subtitle')}</p>
        </div>
        <Button variant="secondary" onClick={start} data-testid="hunt-tutorial-open">
          {t('tutorial.replay')}
        </Button>
      </header>

      {phase.kind === 'loading' && (
        <p role="status" className="text-body-14 text-muted" data-testid="hunt-loading">
          {t('loading')}
        </p>
      )}
      {phase.kind === 'empty' && (
        <Card title={t('empty.title')} testid="hunt-empty">
          <p>{t('empty.body')}</p>
        </Card>
      )}
      {phase.kind === 'done' && (
        <Card title={t('done.title')} testid="hunt-done">
          <p>{t('done.body')}</p>
        </Card>
      )}
      {phase.kind === 'error' && (
        <Card tone="danger" title={t('error.title')} testid="hunt-error">
          <p>{t('error.body')}</p>
          <p className="tnum text-caption-12 text-muted">{phase.code}</p>
          <Button className="self-start" onClick={() => void flow.next()} data-testid="hunt-retry">
            {t('error.retry')}
          </Button>
        </Card>
      )}

      {field && (
        <div className="flex flex-col gap-3">
          <div
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-label-13 text-muted"
            data-testid="hunt-progress"
          >
            <span className="font-semibold text-text">{t('field.heading', { n: flow.reviewed + 1 })}</span>
            <span className="tnum">{t('field.epochs', { n: field.epochs })}</span>
            <span className="tnum">{t('field.reviewed', { n: flow.reviewed })}</span>
            <span className="tnum">{t('field.remaining', { n: flow.remaining })}</span>
          </div>
          {rate && (
            <Card tone="warning" title={t('rate.title')} testid="hunt-rate">
              <p>{t('rate.body', { seconds: rate.retryAfter })}</p>
            </Card>
          )}
          {other && (
            <Card tone="danger" title={t('error.title')} testid="hunt-vote-error">
              <p className="tnum text-caption-12 text-muted">{other.code}</p>
            </Card>
          )}
          {flow.reveal && (
            <section
              role="status"
              className="flex flex-col gap-2 rounded-xl border border-glint bg-surface p-4"
              data-testid="hunt-gold"
              data-correct={flow.reveal.gold.correct ? 'true' : 'false'}
            >
              <h2 className="text-title-20 font-semibold text-text">{t('gold.title')}</h2>
              <p className="text-body-14 text-text-2" data-testid="hunt-gold-answer">
                {flow.reveal.gold.correct
                  ? t('gold.right')
                  : t('gold.wrong', { answer: t(`labels.${flow.reveal.gold.answer}.name`) })}
              </p>
              <p className="text-caption-12 text-muted">
                {t('gold.answer', { answer: t(`labels.${flow.reveal.gold.answer}.name`) })}. {t('gold.why')}
              </p>
              <Button
                ref={continueRef}
                variant="primary"
                className="self-start"
                onClick={() => void flow.next()}
                data-testid="hunt-continue"
              >
                {t('gold.continue')}
              </Button>
            </section>
          )}
          {ready ? (
            <HuntReview
              key={field.field_id}
              field={field}
              busy={flow.busy}
              problem={flow.problem}
              locked={flow.reveal !== null}
              onVote={(i) => void flow.vote(i)}
            />
          ) : (
            <p role="status" className="text-body-14 text-muted">
              {t('loading')}
            </p>
          )}
        </div>
      )}

      <span className="sr-live" role="status" aria-live="polite" data-testid="hunt-recorded">
        {flow.recorded > 0 && !flow.reveal ? t('classify.recorded') : ''}
      </span>
      <HuntCandidates lang={v.view.lang} />
      <HuntCounters lang={v.view.lang} />
      <p className="text-caption-12 text-muted" data-testid="hunt-privacy">
        {t('privacy')}
      </p>
    </main>
  );
}
