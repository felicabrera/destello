/* The embed code box is focusable on purpose so keyboard users can scroll it. */
/* eslint-disable jsx-a11y/no-noninteractive-tabindex */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog';
import { cn } from '../../lib/cn';
import { searchToString, type EmbedControls, type EmbedTheme, type ViewSearch } from '../../lib/url-state';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Canonical page URL path (with defaults omitted). */
  pagePath: string;
  /** Search state of the current view, used to build the embed URL. */
  view: ViewSearch;
  targetId?: string;
  targetName: string;
  lang: 'en' | 'es';
  /** The view is still being built: the link is already final, the dialog says so. */
  building?: boolean;
}

type Size = 'compact' | 'standard' | 'large';
const SIZES: Record<Size, { w: number; h: number }> = {
  compact: { w: 360, h: 420 },
  standard: { w: 480, h: 520 },
  large: { w: 720, h: 600 },
};

interface Opt<T> {
  v: T;
  l: string;
  d?: string;
}

function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
  note,
}: {
  label: string;
  value: T;
  options: Opt<T>[];
  onChange: (v: T) => void;
  note?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-0.5 rounded-lg border border-border bg-bg p-0.5"
      >
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={cn(
              'flex min-h-[calc(var(--hit-min)-6px)] flex-1 flex-col items-center justify-center rounded-md px-2 text-label-13 font-medium',
              value === o.v ? 'bg-glint-soft text-glint' : 'text-text hover:bg-surface-2',
            )}
          >
            {o.l}
            {o.d && <span className="text-caption-12 font-normal text-muted">{o.d}</span>}
          </button>
        ))}
      </div>
      {note && <span className="text-caption-12 text-muted">{note}</span>}
    </div>
  );
}

export function ShareDialog({
  open,
  onOpenChange,
  pagePath,
  view,
  targetId,
  targetName,
  lang,
  building = false,
}: Props) {
  const { t } = useTranslation();
  const [size, setSize] = useState<Size>('standard');
  const [controls, setControls] = useState<EmbedControls>('minimal');
  const [theme, setTheme] = useState<EmbedTheme>('dark');
  const [play, setPlay] = useState(false);
  const [elang, setElang] = useState<'en' | 'es'>(lang);
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pageUrl = `${origin}${pagePath}`;

  const embedUrl = useMemo(() => {
    const s: ViewSearch = { ...view, lang: elang, controls, theme, play: play ? 1 : 0 };
    // Panel state does not apply to the chromeless player.
    delete s.tab;
    if (targetId) {
      s.target = targetId;
      delete s.ra;
      delete s.dec;
      delete s.name;
    }
    // Embed defaults differ from the page defaults: write play, controls and theme explicitly.
    return `${origin}/embed${searchToString(s)}`;
  }, [view, elang, controls, theme, play, targetId, origin]);

  const W = SIZES[size].w;
  const H = SIZES[size].h;
  const embedTitle = t('share.embedTitle', { name: targetName, lng: elang });
  const snippet = `<iframe src="${embedUrl}"\n        width="${W}" height="${H}" style="border:0" loading="lazy"\n        title="${embedTitle}"></iframe>`;
  const previewScale = Math.min(1, 340 / W);

  const copy = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setMsg(message);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setMsg(''), 2000);
    } catch {
      setMsg('');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[980px]" data-testid="share-dialog">
        <div className="flex items-start justify-between gap-4">
          <DialogTitle className="text-heading-24 font-medium">{t('share.title')}</DialogTitle>
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
        <DialogDescription className="mt-1 text-label-13 text-muted">{t('share.linkNote')}</DialogDescription>
        {building && (
          <p
            role="status"
            className="mt-3 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-label-13 text-text-2"
            data-testid="share-building-note"
          >
            {t('share.buildingNote')}
          </p>
        )}

        <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0">
            <label
              className="block text-caption-12 font-semibold uppercase tracking-wider text-muted"
              htmlFor="share-link"
            >
              {t('share.link')}
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id="share-link"
                readOnly
                value={pageUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="tnum min-h-[var(--hit-min)] min-w-0 flex-1 rounded-lg border border-border-strong bg-surface-2 px-3 text-label-13 text-text"
              />
              <Button
                variant="primary"
                onClick={() => void copy(pageUrl, t('share.linkDone'))}
                data-testid="copy-link"
              >
                {t('share.copyLink')}
              </Button>
            </div>

            <h3 className="mt-6 text-title-20 font-medium">{t('share.embed')}</h3>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Seg<Size>
                label={t('share.size')}
                value={size}
                onChange={setSize}
                options={[
                  { v: 'compact', l: t('share.sizeCompact'), d: t('share2.sizeCompactDesc') },
                  { v: 'standard', l: t('share.sizeStandard'), d: t('share2.sizeStandardDesc') },
                  { v: 'large', l: t('share.sizeLarge'), d: t('share2.sizeLargeDesc') },
                ]}
              />
              <Seg<EmbedControls>
                label={t('share.controls')}
                value={controls}
                onChange={setControls}
                options={[
                  { v: 'full', l: t('share.ctlFull') },
                  { v: 'minimal', l: t('share.ctlMin') },
                  { v: 'none', l: t('share.ctlNone') },
                ]}
                note={
                  controls === 'full'
                    ? t('share2.ctlNoteFull')
                    : controls === 'minimal'
                      ? t('share2.ctlNoteMinimal')
                      : t('share2.ctlNoteNone')
                }
              />
              <Seg<EmbedTheme>
                label={t('share.theme')}
                value={theme}
                onChange={setTheme}
                options={[
                  { v: 'dark', l: t('share.dark') },
                  { v: 'light', l: t('share.light') },
                ]}
              />
              <Seg<'en' | 'es'>
                label={t('share2.lang')}
                value={elang}
                onChange={setElang}
                options={[
                  { v: 'en', l: 'English' },
                  { v: 'es', l: 'Español' },
                ]}
              />
            </div>
            <label className="mt-3 flex min-h-[var(--hit-min)] items-center gap-3 text-label-13">
              <input
                type="checkbox"
                role="switch"
                checked={play}
                onChange={(e) => setPlay(e.target.checked)}
                className="size-4 accent-[var(--glint)]"
              />
              <span>
                {t('share.playOnLoad')}
                <span className="block text-caption-12 text-muted">{t('share.playOnLoadNote')}</span>
              </span>
            </label>
            <pre
              aria-label={t('share2.embedCode')}
              tabIndex={0}
              className="tnum mt-3 overflow-x-auto rounded-lg border border-border bg-bg p-3 text-caption-12 text-text-2"
              data-testid="embed-snippet"
            >
              {snippet}
            </pre>
            <div className="mt-3 flex items-center justify-between gap-3">
              <Button
                variant="secondary"
                onClick={() => void copy(snippet, t('share.codeDone'))}
                data-testid="copy-embed"
              >
                {t('share.copyCode')}
              </Button>
              <span
                role="status"
                aria-live="polite"
                className="text-label-13 text-success"
                data-testid="share-toast"
              >
                {msg}
              </span>
            </div>
          </div>

          <div className="hidden min-w-0 flex-col gap-2 lg:flex" data-testid="embed-preview">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-caption-12 font-semibold uppercase tracking-wider text-muted">
                {t('share2.preview')}
              </span>
              <span className="tnum text-caption-12 text-muted">
                {t('share2.previewNote', { w: W, h: H })}
              </span>
            </div>
            <div
              className="overflow-hidden rounded-lg border border-border bg-bg"
              style={{ width: W * previewScale, height: H * previewScale }}
            >
              {open && (
                <iframe
                  key={embedUrl}
                  src={embedUrl}
                  title={embedTitle}
                  width={W}
                  height={H}
                  style={{ border: 0, transform: `scale(${previewScale})`, transformOrigin: 'top left' }}
                  loading="lazy"
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
