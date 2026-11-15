// Cloudflare Turnstile widget for report submission (docs/10). Rendered only when VITE_TURNSTILE_SITEKEY is set;
// the script is loaded on demand from the only allowed host and never on pages that do not submit reports.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const TURNSTILE_SITEKEY: string = (import.meta.env.VITE_TURNSTILE_SITEKEY as string | undefined) || '';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render(
    el: HTMLElement,
    opts: {
      sitekey: string;
      theme?: 'dark' | 'light' | 'auto';
      language?: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    },
  ): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export function TurnstileWidget({
  lang,
  onToken,
}: {
  lang: 'en' | 'es';
  onToken: (token: string | null) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let id: string | null = null;
    let alive = true;
    loadTurnstile()
      .then((api) => {
        if (!alive || !ref.current) return;
        id = api.render(ref.current, {
          sitekey: TURNSTILE_SITEKEY,
          theme: 'dark',
          language: lang,
          callback: (tok) => onToken(tok),
          'expired-callback': () => onToken(null),
          'error-callback': () => {
            onToken(null);
            setState('error');
          },
        });
        setState('ready');
      })
      .catch(() => alive && setState('error'));
    return () => {
      alive = false;
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [lang, onToken]);
  return (
    <div className="flex flex-col gap-1.5" data-testid="turnstile">
      <div ref={ref} className="min-h-[65px]" />
      {/* Text alternative path (handoff/accessibility.md): what the check is and what to do when it fails. */}
      <span className="text-caption-12 text-muted" role={state === 'error' ? 'alert' : undefined}>
        {state === 'error' ? t('report.turnstileError') : t('report.turnstileNote')}
      </span>
    </div>
  );
}
