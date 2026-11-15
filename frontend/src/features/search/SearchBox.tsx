import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { ApiError, resolveName } from '../../lib/api';
import {
  fmtDeg,
  formatDec,
  formatRa,
  formatSeparation,
  looksLikeCoordinates,
  parseCoordinates,
  separationDeg,
  type CoordError,
} from '../../lib/coords';
import { matchPresets, PRESETS } from '../../lib/presets';
import type { Lang, TargetItem } from '../../lib/types';

interface Props {
  targets: TargetItem[] | undefined;
  demo: boolean;
  onOpenPreset: (id: string) => void;
  onOpenPath: (path: string) => void;
  /** Called after a successful submit (closes the mobile overlay). */
  onDone?: () => void;
  focusOnMount?: boolean;
  className?: string;
}

type Phase = 'idle' | 'resolving' | 'notfound' | 'resolverDown' | 'demoOff';

/** A search that opened a view. Kept in session memory only (docs/07 section 4): never persisted. */
export interface RecentSearch {
  label: string;
  /** Either a preset id or an app path (`/?ra=..&dec=..`, `/?name=..`). */
  preset?: string;
  path?: string;
}

const RECENT_MAX = 5;
let recentSearches: RecentSearch[] = [];

export function rememberSearch(item: RecentSearch): RecentSearch[] {
  const key = item.preset ?? item.path;
  recentSearches = [item, ...recentSearches.filter((r) => (r.preset ?? r.path) !== key)].slice(0, RECENT_MAX);
  return recentSearches;
}

export function recentSearchList(): RecentSearch[] {
  return recentSearches;
}

const FORMATS = [
  '150.11917 2.20583',
  '08h55m10.831s -07d14m42.53s',
  '08:55:10.831 -07:14:42.53',
  '08 55 10.831 -7 14 42.53',
];

export function SearchBox({
  targets,
  demo,
  onOpenPreset,
  onOpenPath,
  onDone,
  focusOnMount,
  className,
}: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  // Closed after a submit so the list does not stay open over the result; reopens on the next focus.
  const [recentClosed, setRecentClosed] = useState(false);
  const [active, setActive] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [notFoundQuery, setNotFoundQuery] = useState('');
  const [recent, setRecent] = useState<RecentSearch[]>(recentSearchList);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusOnMount) inputRef.current?.focus();
  }, [focusOnMount]);

  const attempt = useMemo(() => (looksLikeCoordinates(q) ? parseCoordinates(q) : null), [q]);
  const names = useMemo(() => {
    const loc: Partial<Record<string, Record<Lang, string>>> = {};
    for (const p of PRESETS)
      loc[p.id] = {
        en: t(`presetCopy.${p.id}.name`, { lng: 'en' }),
        es: t(`presetCopy.${p.id}.name`, { lng: 'es' }),
      };
    return loc;
  }, [t]);
  const matches = useMemo(
    () => (attempt || q.trim().length < 2 ? [] : matchPresets(q, targets, names).slice(0, 5)),
    [q, targets, names, attempt],
  );

  const near = useMemo(() => {
    if (!attempt || !attempt.ok || !targets) return null;
    let best: { t: TargetItem; sep: number } | null = null;
    for (const tg of targets) {
      const sep = separationDeg(attempt.raDeg, attempt.decDeg, tg.ra_deg, tg.dec_deg);
      if (sep < 10 / 60 && (!best || sep < best.sep)) best = { t: tg, sep };
    }
    return best;
  }, [attempt, targets]);

  const showRecent = focus && !recentClosed && q.trim() === '' && phase === 'idle' && recent.length > 0;
  const suggestionCount = showRecent ? recent.length : matches.length;
  const open = focus && q.trim() !== '' && phase !== 'resolving';

  const remember = (item: RecentSearch) => {
    setRecent(rememberSearch(item));
    setRecentClosed(true);
  };
  const openPreset = (pid: string) => {
    remember({ label: t(`presetCopy.${pid}.name`), preset: pid });
    onOpenPreset(pid);
  };
  const openRecent = (r: RecentSearch) => {
    remember(r);
    if (r.preset) onOpenPreset(r.preset);
    else if (r.path) onOpenPath(r.path);
    onDone?.();
  };

  const errText = (e: CoordError): string => {
    switch (e.code) {
      case 'raRange':
        return t('search.raRange', { value: e.value });
      case 'decRange':
        return t('search.decRange', { value: e.value });
      case 'minRange':
        return t('search.minRange');
      case 'format':
        return t('search.invalidFormat');
      default:
        return t('search.keepTyping');
    }
  };

  const submit = async () => {
    const text = q.trim();
    if (!text) {
      const r = showRecent ? recent[Math.min(active, recent.length - 1)] : undefined;
      if (r) openRecent(r);
      return;
    }
    setPhase('idle');
    if (attempt) {
      if (!attempt.ok) return;
      if (demo) {
        setPhase('demoOff');
        return;
      }
      const path = `/?ra=${fmtDeg(attempt.raDeg)}&dec=${fmtDeg(attempt.decDeg)}`;
      remember({ label: `${fmtDeg(attempt.raDeg)} ${fmtDeg(attempt.decDeg)}`, path });
      onOpenPath(path);
      setQ('');
      onDone?.();
      return;
    }
    const pick = suggestionCount > 0 ? matches[Math.min(active, suggestionCount - 1)] : undefined;
    if (pick && (pick.exact || active < suggestionCount)) {
      openPreset(pick.id);
      setQ('');
      onDone?.();
      return;
    }
    if (demo) {
      setPhase('demoOff');
      return;
    }
    setPhase('resolving');
    try {
      const r = await resolveName(text);
      const path = `/?name=${encodeURIComponent(r.query || text)}`;
      remember({ label: r.query || text, path });
      onOpenPath(path);
      setPhase('idle');
      setQ('');
      onDone?.();
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.status === 404 || e.code === 'RESOLVE_FAILED' || e.code === 'NOT_FOUND')
      ) {
        setNotFoundQuery(text);
        setPhase('notfound');
      } else if (e instanceof ApiError && (e.code === 'RESOLVER_UNAVAILABLE' || e.status >= 500)) {
        setNotFoundQuery(text);
        setPhase('resolverDown');
      } else {
        setNotFoundQuery(text);
        setPhase('notfound');
      }
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(suggestionCount - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (q) setQ('');
      else inputRef.current?.blur();
      setPhase('idle');
    }
  };

  const describedBy = `${id}-desc`;
  const showError = attempt && !attempt.ok && q.trim() !== '';
  const invalid = !!showError && attempt && !attempt.ok && attempt.error.code !== 'empty';

  return (
    <div className={cn('relative min-w-0', className)} data-testid="searchbox">
      <label htmlFor={`${id}-input`} className="sr-only">
        {t('search.label')}
      </label>
      <div
        className={cn(
          'flex h-10 items-center gap-2.5 rounded-lg border bg-surface-2 pl-3 pr-2 min-h-[var(--hit-min)]',
          invalid ? 'border-danger' : focus ? 'border-cyan' : 'border-border-strong',
        )}
      >
        {invalid ? (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--danger)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01" />
          </svg>
        ) : phase === 'resolving' ? (
          <svg
            className="motion-safe:animate-spin"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--cyan)"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.55" strokeLinecap="round" />
          </svg>
        ) : (
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--muted)"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        )}
        <input
          ref={inputRef}
          id={`${id}-input`}
          role="combobox"
          aria-expanded={open || showRecent}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            (open || showRecent) && suggestionCount > 0 ? `${id}-opt-${active}` : undefined
          }
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setPhase('idle');
          }}
          onFocus={() => {
            setFocus(true);
            setRecentClosed(false);
          }}
          onBlur={() => setTimeout(() => setFocus(false), 120)}
          onKeyDown={onKey}
          placeholder={t('search.placeholder')}
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent text-body-14 text-text outline-none focus-visible:shadow-none"
          data-testid="search-input"
        />
        <button
          type="button"
          onClick={() => void submit()}
          className="min-h-[calc(var(--hit-min)-8px)] rounded-md bg-primary px-3 text-label-13 font-semibold text-primary-foreground hover:bg-glint-hover"
          data-testid="search-go"
        >
          {t('search.button')}
        </button>
      </div>
      <div id={describedBy} className="sr-live" aria-live="polite">
        {attempt?.ok
          ? `${formatRa(attempt.raDeg)} ${formatDec(attempt.decDeg)}`
          : showError
            ? errText(attempt.error)
            : ''}
      </div>

      {showRecent && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={t('search.recent')}
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-pop"
          data-testid="search-recent"
        >
          <p className="px-4 pb-1 pt-3 text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('search.recent')}
          </p>
          <ul className="flex flex-col p-1.5">
            {recent.map((r, i) => (
              <li key={r.preset ?? r.path} role="option" id={`${id}-opt-${i}`} aria-selected={i === active}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    openRecent(r);
                  }}
                  className={cn(
                    'flex min-h-[var(--hit-min)] w-full items-center rounded-md p-2.5 text-left text-body-14 hover:bg-border',
                    i === active && 'bg-border',
                  )}
                >
                  <span className="truncate">{r.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && (
        <div
          id={`${id}-list`}
          role={suggestionCount > 0 ? 'listbox' : undefined}
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-hidden rounded-xl border border-border-strong bg-surface-2 shadow-pop"
          data-testid="search-dropdown"
        >
          {attempt?.ok && (
            <div className="flex flex-col gap-3 p-4" data-testid="coords-preview">
              <div className="flex items-center gap-2 text-label-13 font-semibold text-success">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {attempt.format === 'sexagesimal' ? t('search.parsedSexa') : t('search.parsedDec')}
              </div>
              <div className="tnum grid grid-cols-[32px_auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-label-13">
                <span className="text-muted">{t('search.raLabel')}</span>
                <span>{fmtDeg(attempt.raDeg)}</span>
                <span className="text-muted">{formatRa(attempt.raDeg)}</span>
                <span className="text-muted">Dec</span>
                <span>{fmtDeg(attempt.decDeg)}</span>
                <span className="text-muted">{formatDec(attempt.decDeg)}</span>
              </div>
              <p className="border-t border-border pt-2.5 text-label-13 text-muted">
                {near ? (
                  <Trans
                    i18nKey="search.near"
                    values={{
                      name: t(`presetCopy.${near.t.id}.name`),
                      separation: formatSeparation(near.sep),
                    }}
                    components={{ b: <span className="font-medium text-text" /> }}
                  />
                ) : (
                  t('search.far')
                )}
              </p>
              {demo && <p className="text-caption-12 text-warning">{t('search.demoOff')}</p>}
            </div>
          )}
          {showError && attempt && !attempt.ok && (
            <div className="flex flex-col gap-2 p-4" role="alert" data-testid="coords-error">
              <p className="text-label-13 font-semibold text-danger">{errText(attempt.error)}</p>
              <p className="text-caption-12 text-muted">{t('search.formats')}</p>
              <ul className="tnum space-y-0.5 text-caption-12 text-text-2">
                {FORMATS.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          {!attempt && suggestionCount > 0 && (
            <ul className="flex flex-col p-1.5" aria-label={t('presets.label')}>
              {matches.map((m, i) => (
                <li key={m.id} role="option" id={`${id}-opt-${i}`} aria-selected={i === active}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      openPreset(m.id);
                      setQ('');
                      onDone?.();
                    }}
                    className={cn(
                      'flex min-h-[var(--hit-min)] w-full items-center gap-2.5 rounded-md p-2.5 text-left hover:bg-border',
                      i === active && 'bg-border',
                    )}
                    data-testid={`suggest-${m.id}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-body-14 font-medium">{t(`presetCopy.${m.id}.name`)}</span>
                      <span className="text-caption-12 text-muted">{t(`presetCopy.${m.id}.kind`)}</span>
                    </span>
                    <span className="rounded-md border border-border-strong px-1.5 text-caption-12 font-semibold">
                      {t('search.preset')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!attempt && q.trim().length >= 2 && phase === 'idle' && !demo && (
            <p className="border-t border-border px-4 py-2.5 text-label-13 text-muted">
              {t('search.lookup', { query: q.trim() })}
            </p>
          )}
          {!attempt && demo && suggestionCount === 0 && (
            <p className="px-4 py-3 text-label-13 text-warning" role="status">
              {t('search.demoOff')}
            </p>
          )}
          {phase === 'demoOff' && (
            <div
              className="border-t border-border p-4 text-label-13 text-text-2"
              role="status"
              data-testid="demo-off"
            >
              <p className="font-semibold text-text">{t('search.demoOff')}</p>
              <p className="mt-1">{t('search.demoOffWhy')}</p>
            </div>
          )}
          <div className="tnum flex gap-3 border-t border-border px-4 py-2 text-caption-12 text-muted">
            <span>{t('search.kChoose')}</span>
            <span>{t('search.kBuild')}</span>
            <span>{t('search.kClose')}</span>
          </div>
        </div>
      )}
      {phase === 'resolverDown' && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 flex flex-col gap-2 rounded-xl border border-warning bg-surface-2 p-4 shadow-pop"
          role="alert"
          data-testid="resolver-down"
        >
          <p className="text-body-14 font-semibold">{t('search.resolverDown', { query: notFoundQuery })}</p>
          <p className="text-label-13 text-muted">{t('search.resolverDownSub')}</p>
          <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('search.tryPreset')}
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onOpenPreset(p.id);
                  setQ('');
                  setPhase('idle');
                  onDone?.();
                }}
                className="min-h-[var(--hit-min)] rounded-lg border border-border-strong px-3 text-label-13 hover:bg-border"
              >
                {t(`presetCopy.${p.id}.chip`)}
              </button>
            ))}
          </div>
        </div>
      )}
      {phase === 'notfound' && (
        <div
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 flex flex-col gap-2 rounded-xl border border-danger bg-surface-2 p-4 shadow-pop"
          role="alert"
          data-testid="notfound"
        >
          <p className="text-body-14 font-semibold">{t('search.notFound', { query: notFoundQuery })}</p>
          <p className="text-label-13 text-muted">{t('search.notFoundSub')}</p>
          <p className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
            {t('search.tryPreset')}
          </p>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onOpenPreset(p.id);
                  setQ('');
                  setPhase('idle');
                  onDone?.();
                }}
                className="min-h-[var(--hit-min)] rounded-lg border border-border-strong px-3 text-label-13 hover:bg-border"
              >
                {t(`presetCopy.${p.id}.chip`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
