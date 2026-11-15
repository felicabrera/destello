// F-22 / S-14: report a candidate mover. Replaces the right panel so the player stays visible while marking.
// Copy never claims a discovery: candidate, unconfirmed, no catalog match, worth a closer look.
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { ApiError, postReport, postReportCheck, reportFileUrl } from '../../lib/api';
import { cn } from '../../lib/cn';
import { formatDec, formatRa } from '../../lib/coords';
import { localNumber, mjdIso } from '../../lib/format';
import type { ReportCheckResult, ReportCreated, ReportMarkIn } from '../../lib/types';
import { useUi } from '../../store/ui';
import type { useExplorer } from '../explorer/useExplorer';
import { CheckRows, MotionLine, VerdictBox } from './ReportParts';
import { TURNSTILE_SITEKEY, TurnstileWidget } from './Turnstile';
import { MAX_MARKS, MIN_MARKS, NOTES_MAX, isValidContact, marksToSky, nudge, seedMark } from './reportModel';

type Model = ReturnType<typeof useExplorer>;
type Step = 'mark' | 'check' | 'results' | 'notes' | 'done';
const STEPS: Step[] = ['mark', 'check', 'results', 'notes', 'done'];
const KNOWN_ERRORS = [
  'RATE_LIMITED',
  'TURNSTILE_FAILED',
  'TURNSTILE_UNAVAILABLE',
  'REPORTS_UNAVAILABLE',
  'INVALID_MARKS',
  'POSITION_OUTSIDE_FIELD',
  'VALIDATION_ERROR',
  'NOT_FOUND',
];

function errorKey(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return 'RATE_LIMITED';
    if (KNOWN_ERRORS.includes(e.code)) return e.code;
    if (e.status === 0) return 'network';
    return 'generic';
  }
  return e instanceof TypeError ? 'network' : 'generic';
}

export function ReportFlow({ x, onClose }: { x: Model; onClose: () => void }) {
  const { t } = useTranslation();
  const lang = x.lang;
  const marks = useUi((s) => s.reportMarks);
  const setReportMark = useUi((s) => s.setReportMark);
  const [step, setStep] = useState<Step>('mark');
  const [result, setResult] = useState<ReportCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [contact, setContact] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<ReportCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const sequenceId = x.seq.sequenceId ?? null;
  const cur = x.epochs[x.frameIdx];
  const curEpoch = cur?.index ?? null;
  const nMarks = Object.keys(marks).length;
  const sky: ReportMarkIn[] = useMemo(() => (x.grid ? marksToSky(marks, x.grid) : []), [marks, x.grid]);
  const marksKey = JSON.stringify(sky);

  // Changing a mark after the checks makes their result stale: go back to marking.
  const checkedKey = useRef<string | null>(null);
  useEffect(() => {
    if (checkedKey.current !== null && checkedKey.current !== marksKey && step !== 'done') {
      checkedKey.current = null;
      setResult(null);
      setStep('mark');
    }
  }, [marksKey, step]);

  // Move focus to the step heading so keyboard and screen reader users follow the flow.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const epochLabel = useCallback(
    (epochIndex: number) => {
      const pos = x.epochs.findIndex((e) => e.index === epochIndex);
      return `E${(pos >= 0 ? pos : epochIndex) + 1}`;
    },
    [x.epochs],
  );

  const runChecks = async () => {
    if (!sequenceId || sky.length < MIN_MARKS) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setError(null);
    setStep('check');
    try {
      const r = await postReportCheck({ sequence_id: sequenceId, marks: sky, detector: x.det }, ac.signal);
      if (ac.signal.aborted) return;
      checkedKey.current = marksKey;
      setResult(r);
      setStep('results');
    } catch (e) {
      if (ac.signal.aborted) return;
      setError(errorKey(e));
      setStep('mark');
    }
  };

  const contactOk = isValidContact(contact);
  const needToken = !!TURNSTILE_SITEKEY;
  const canSubmit = !submitting && contactOk && notes.length <= NOTES_MAX && (!needToken || !!token);

  const submit = async () => {
    if (!sequenceId || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const c = await postReport({
        sequence_id: sequenceId,
        marks: sky,
        detector: x.det,
        notes: notes.trim(),
        contact: contact.trim() || null,
        turnstile_token: token,
      });
      setCreated(c);
      setStep('done');
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setSubmitting(false);
    }
  };

  const onToken = useCallback((tok: string | null) => setToken(tok), []);
  const permalink = created ? `${window.location.origin}/r/${created.report_id}` : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(permalink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const stepIdx = STEPS.indexOf(step);
  const markable = x.epochs.map((e, i) => ({ e, i })).filter(({ e }) => e.frames.length > 0);
  const curMark = curEpoch !== null ? marks[curEpoch] : undefined;
  const curMarkable = !!cur && cur.frames.length > 0;
  const placeHere = () => {
    if (curEpoch === null || !curMarkable) return;
    if (!curMark && nMarks >= MAX_MARKS) return;
    setReportMark(curEpoch, curMark ?? seedMark(marks, curEpoch, x.n));
  };

  return (
    <section
      className="flex flex-col rounded-xl border border-border bg-surface"
      aria-labelledby="report-heading"
      data-testid="report-flow"
    >
      <header className="flex flex-col gap-3 border-b border-border p-4">
        <h2
          id="report-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-title-20 font-medium outline-none"
        >
          {t('report.title')}
        </h2>
        <ol className="grid grid-cols-5 gap-1.5" aria-label={t('report.stepsLabel')}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === stepIdx ? 'step' : undefined}
              className={cn(
                'flex flex-col gap-1 text-caption-12',
                i <= stepIdx ? 'text-text' : 'text-muted',
                i === stepIdx && 'font-semibold',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'h-0.5 rounded-full',
                  i < stepIdx ? 'bg-muted' : i === stepIdx ? 'bg-text' : 'bg-border',
                )}
              />
              <span>
                {i + 1} {t(`report.step.${s}`)}
              </span>
            </li>
          ))}
        </ol>
      </header>

      <div className="flex flex-col gap-4 p-4" aria-live="polite">
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-danger p-3 text-body-14 text-text"
            data-testid="report-error"
          >
            {t(`report.err.${error}`)}
          </p>
        )}

        {step === 'mark' && (
          <>
            <p className="text-body-14 text-text-2">{t('report.markIntro')}</p>
            <ul
              className="flex flex-col gap-1.5"
              aria-label={t('report.marksLabel')}
              data-testid="report-marks"
            >
              {markable.map(({ e, i }) => {
                const m = marks[e.index];
                const s = m && x.grid ? sky.find((q) => q.epoch === e.index) : undefined;
                const on = i === x.frameIdx;
                return (
                  <li
                    key={e.index}
                    className={cn(
                      'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2',
                      on ? 'border-cyan' : 'border-border',
                    )}
                  >
                    <span className="tnum font-mono text-label-13 text-text">E{i + 1}</span>
                    <span className="tnum font-mono text-caption-12 text-muted">
                      {e.t_mid_mjd !== undefined ? mjdIso(e.t_mid_mjd) : ''}
                    </span>
                    <span className={cn('text-caption-12', m ? 'text-text' : 'text-muted')}>
                      {m ? t('report.marked') : t('report.notMarked')}
                    </span>
                    {s && (
                      <span className="tnum w-full font-mono text-caption-12 text-text-2">
                        {formatRa(s.ra_deg)} {formatDec(s.dec_deg)}
                      </span>
                    )}
                    <span className="ml-auto flex gap-1">
                      {!on && (
                        <Button size="sm" variant="ghost" onClick={() => x.setFrameFromUser(i)}>
                          {t('report.show', { e: `E${i + 1}` })}
                        </Button>
                      )}
                      {m && (
                        <Button size="sm" variant="ghost" onClick={() => setReportMark(e.index, null)}>
                          {t('report.clear', { e: `E${i + 1}` })}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div
              className="flex flex-col gap-2 rounded-lg border border-border p-3"
              data-testid="report-keyboard"
            >
              <span className="text-label-13 font-medium text-text">{t('report.keyboardTitle')}</span>
              <span className="text-caption-12 text-muted">{t('report.keyboardHelp')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  onClick={placeHere}
                  disabled={!curMarkable || (!curMark && nMarks >= MAX_MARKS)}
                  data-testid="report-place"
                >
                  {curMark ? t('report.placed') : t('report.place')}
                </Button>
                {(['n', 's', 'e', 'w'] as const).map((d) => (
                  <Button
                    key={d}
                    size="sm"
                    variant="ghost"
                    disabled={!curMark}
                    aria-label={t(`report.nudge.${d}`)}
                    onClick={() =>
                      curMark && curEpoch !== null && setReportMark(curEpoch, nudge(curMark, d, x.n))
                    }
                  >
                    {t(`report.dir.${d}`)}
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-caption-12 text-muted">
              {nMarks < MIN_MARKS
                ? t('report.needMarks', { n: MIN_MARKS - nMarks })
                : t('report.thirdOptional')}
            </p>
          </>
        )}

        {step === 'check' && (
          <>
            <p className="text-body-14 text-text-2">{t('report.checking')}</p>
            <CheckRows running />
            <p className="text-caption-12 text-muted">{t('report.checkingTime')}</p>
          </>
        )}

        {step === 'results' && result && (
          <>
            <VerdictBox verdict={result.checks.verdict} />
            <MotionLine motion={result.checks.motion} lang={lang} />
            <CheckRows checks={result.checks} lang={lang} epochLabel={epochLabel} marks={result.marks} />
            <p className="text-caption-12 text-muted">{t('report.geocentric')}</p>
          </>
        )}

        {step === 'notes' && (
          <>
            <label className="flex flex-col gap-1.5">
              <span className="text-label-13 font-medium text-text">{t('report.notesLabel')}</span>
              <textarea
                value={notes}
                maxLength={NOTES_MAX}
                rows={4}
                onChange={(e) => setNotes(e.target.value)}
                aria-describedby="report-notes-help"
                className="rounded-lg border border-border-strong bg-surface-2 p-2 text-body-14 text-text"
                data-testid="report-notes"
              />
              <span id="report-notes-help" className="tnum text-caption-12 text-muted">
                {t('report.notesCount', {
                  n: localNumber(lang, notes.length),
                  max: localNumber(lang, NOTES_MAX),
                })}
              </span>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-label-13 font-medium text-text">{t('report.contactLabel')}</span>
              <input
                type="email"
                value={contact}
                maxLength={254}
                autoComplete="email"
                placeholder={t('report.contactPlaceholder')}
                onChange={(e) => setContact(e.target.value)}
                aria-invalid={!contactOk || undefined}
                aria-describedby="report-contact-help"
                className="h-10 rounded-lg border border-border-strong bg-surface-2 px-2 text-body-14 text-text"
                data-testid="report-contact"
              />
              <span
                id="report-contact-help"
                className={cn('text-caption-12', contactOk ? 'text-muted' : 'text-danger')}
              >
                {contactOk ? t('report.contactHelp') : t('report.contactInvalid')}
              </span>
            </label>
            {needToken && <TurnstileWidget lang={lang} onToken={onToken} />}
            <p className="text-caption-12 text-muted">{t('report.publicNotice')}</p>
          </>
        )}

        {step === 'done' && created && (
          <>
            <p className="text-body-15 font-medium text-text">{t('report.saved')}</p>
            <div className="flex flex-col gap-1.5">
              <span className="text-label-13 text-muted">{t('report.permalink')}</span>
              <div className="flex flex-wrap items-center gap-2">
                <code
                  className="break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-caption-12 text-text"
                  data-testid="report-link"
                >
                  {permalink}
                </code>
                <Button size="sm" onClick={copy}>
                  {copied ? t('report.copied') : t('report.copy')}
                </Button>
              </div>
              <span className="text-caption-12 text-muted">
                {t('report.alsoFiles')}{' '}
                <a
                  className="text-cyan underline underline-offset-2"
                  href={reportFileUrl(created.report_id, 'json')}
                >
                  report.json
                </a>{' '}
                ·{' '}
                <a
                  className="text-cyan underline underline-offset-2"
                  href={reportFileUrl(created.report_id, 'txt')}
                >
                  report.txt
                </a>
              </span>
            </div>
            <NextSteps />
          </>
        )}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-border p-4">
        {step === 'mark' && (
          <>
            <Button onClick={onClose}>{t('report.cancel')}</Button>
            <Button
              variant="primary"
              onClick={runChecks}
              disabled={nMarks < MIN_MARKS || !sequenceId}
              data-testid="report-run"
            >
              {t('report.runChecks')}
            </Button>
          </>
        )}
        {step === 'check' && (
          <>
            <Button
              onClick={() => {
                abortRef.current?.abort();
                setStep('mark');
              }}
            >
              {t('report.back')}
            </Button>
            <Button variant="primary" disabled>
              {t('report.running')}
            </Button>
          </>
        )}
        {step === 'results' && (
          <>
            <Button onClick={() => setStep('mark')}>{t('report.back')}</Button>
            <Button variant="primary" onClick={() => setStep('notes')} data-testid="report-to-notes">
              {t('report.addNotes')}
            </Button>
          </>
        )}
        {step === 'notes' && (
          <>
            <Button onClick={() => setStep('results')}>{t('report.back')}</Button>
            <Button variant="primary" onClick={submit} disabled={!canSubmit} data-testid="report-submit">
              {submitting ? t('report.submitting') : t('report.submit')}
            </Button>
          </>
        )}
        {step === 'done' && created && (
          <>
            <Button onClick={onClose}>{t('report.close')}</Button>
            <Button variant="primary" asChild>
              <Link to="/r/$reportId" params={{ reportId: created.report_id }} search={{ lang }}>
                {t('report.openPage')}
              </Link>
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}

const NEXT_URLS = {
  byw: 'https://www.zooniverse.org/projects/marckuchner/backyard-worlds-planet-9',
  mpc: 'https://www.minorplanetcenter.net/',
} as const;

export function NextSteps() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3" data-testid="report-next">
      <span className="text-label-13 font-medium text-text">{t('report.next.title')}</span>
      <span className="text-caption-12 text-muted">{t('report.next.noReview')}</span>
      {(['byw', 'mpc'] as const).map((k) => (
        <div key={k} className="flex flex-col gap-0.5">
          <a
            className="text-label-13 text-cyan underline underline-offset-2"
            href={NEXT_URLS[k]}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t(`report.next.${k}.name`)}
          </a>
          <span className="text-caption-12 text-text-2">{t(`report.next.${k}.text`)}</span>
        </div>
      ))}
    </div>
  );
}
