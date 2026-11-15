// S-10: Aladin Lite v3 context view (F-21). Bundled from the npm package and loaded with a dynamic import
// only when the tab opens. Sky tiles are 2MASS and AllWISE surveys served by NASA/IPAC IRSA through this site
// (`/hips/...`), so the visitor's browser contacts no third-party host.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { cssVar } from '../../lib/plotly';
import { cn } from '../../lib/cn';

interface Props {
  ra: number;
  dec: number;
  fovArcmin: number;
  /**
   * Shown in place of the player while a build has no frames yet (docs/07 section 11). The map is then labelled
   * as a context survey image so it is never mistaken for SPHEREx data.
   */
  preview?: boolean;
}

interface Survey {
  id: string;
  /** HiPS served by NASA/IPAC IRSA through this site (`/hips/...`), or an absolute HiPS id. */
  hips: string;
  labelKey: string;
}
const SURVEYS: Survey[] = [
  { id: '2mass', hips: '/hips/2MASS/Color', labelKey: 'ctx.s2mass' },
  { id: 'allwise', hips: '/hips/AllWISE/RGB-W4-W2-W1', labelKey: 'ctx.sAllwise' },
];

function hipsOf(s: Survey): string {
  return s.hips.startsWith('/') ? window.location.origin + s.hips : s.hips;
}
// SPHEREx HiPS is shown only when a HiPS id is configured at build time (VITE_SPHEREX_HIPS).
const SPHEREX_HIPS = (import.meta.env.VITE_SPHEREX_HIPS as string | undefined) || '';
if (SPHEREX_HIPS) SURVEYS.push({ id: 'spherex', hips: SPHEREX_HIPS, labelKey: 'ctx.sSpherex' });

type Aladin = import('aladin-lite').AladinInstance;
type Overlay = ReturnType<(typeof import('aladin-lite'))['default']['graphicOverlay']>;

function corners(ra: number, dec: number, fovArcmin: number): [number, number][] {
  const h = fovArcmin / 2 / 60;
  const dRa = h / Math.max(Math.cos((dec * Math.PI) / 180), 1e-6);
  return [
    [ra + dRa, dec - h],
    [ra - dRa, dec - h],
    [ra - dRa, dec + h],
    [ra + dRa, dec + h],
  ];
}

export function ContextPanel({ ra, dec, fovArcmin, preview = false }: Props) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const aladin = useRef<Aladin | null>(null);
  const overlay = useRef<Overlay | null>(null);
  const lib = useRef<(typeof import('aladin-lite'))['default'] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [survey, setSurvey] = useState(SURVEYS[0].id);
  const [attempt, setAttempt] = useState(0);

  const drawOutline = useCallback(() => {
    const A = lib.current;
    const al = aladin.current;
    if (!A || !al) return;
    try {
      overlay.current?.removeAll();
      const o = A.graphicOverlay({ color: cssVar('cyan'), lineWidth: 2, name: 'fov' });
      al.addOverlay?.(o);
      o.addFootprints([A.polygon(corners(ra, dec, fovArcmin))]);
      overlay.current = o;
    } catch {
      /* the outline is a nicety; the map stays usable without it */
    }
  }, [ra, dec, fovArcmin]);

  // Create the map once per attempt.
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    const el = host.current;
    if (!el) return;
    import('aladin-lite')
      .then(async (m) => {
        const A = m.default;
        await A.init;
        if (cancelled || !host.current) return;
        lib.current = A;
        const first = SURVEYS.find((s) => s.id === survey) ?? SURVEYS[0];
        aladin.current = A.aladin(host.current, {
          survey: hipsOf(first),
          target: `${ra} ${dec}`,
          fov: Math.max(fovArcmin / 60 / 0.5, 0.05),
          showReticle: false,
          showZoomControl: true,
          showFullscreenControl: false,
          showLayersControl: false,
          showGotoControl: false,
          showSimbadPointerControl: false,
          showCooGridControl: false,
          showSettingsControl: false,
          showShareControl: false,
          showStatusBar: false,
          showFrame: false,
          cooFrame: 'ICRSd',
          // The startup logger posts view parameters to a third-party host; never send it.
          log: false,
        });
        drawOutline();
        setState('ready');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
      aladin.current = null;
      overlay.current = null;
      if (el) el.replaceChildren();
    };
    // The map is rebuilt only on retry; position, FoV and survey changes update it in place below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    const al = aladin.current;
    if (!al || state !== 'ready') return;
    try {
      al.gotoRaDec(ra, dec);
      al.setFoV(Math.max(fovArcmin / 60 / 0.5, 0.05));
    } catch {
      /* ignore */
    }
    drawOutline();
  }, [ra, dec, fovArcmin, state, drawOutline]);

  useEffect(() => {
    const al = aladin.current;
    if (!al || state !== 'ready') return;
    const s = SURVEYS.find((x) => x.id === survey);
    if (s) {
      try {
        al.setImageSurvey(hipsOf(s));
      } catch {
        /* ignore */
      }
    }
  }, [survey, state]);

  return (
    <div
      className={cn('flex flex-col gap-3', preview && 'rounded-xl border border-border bg-surface p-4')}
      data-testid={preview ? 'build-sky-preview' : 'context-panel'}
      data-state={state}
      role={preview ? 'region' : undefined}
      aria-labelledby={preview ? 'build-sky-title' : undefined}
    >
      {preview && (
        <p
          className="flex flex-wrap items-center gap-2 text-label-13 text-text-2"
          data-testid="build-sky-label"
        >
          <Badge tone="warning">{t('buildSky.badge')}</Badge>
          <span>{t('buildSky.label')}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={preview ? 'build-sky-title' : undefined} className="text-body-15 font-semibold">
          {t(preview ? 'buildSky.title' : 'ctx.title')}
        </h3>
        <div
          role="radiogroup"
          aria-label={t('ctx.survey')}
          className="flex overflow-hidden rounded-md border border-border-strong"
        >
          {SURVEYS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={survey === s.id}
              onClick={() => setSurvey(s.id)}
              className={cn(
                'min-h-[var(--hit-min)] px-3 text-label-13',
                survey === s.id ? 'bg-glint-soft font-semibold text-glint' : 'text-text hover:bg-surface-2',
              )}
              data-testid={`survey-${s.id}`}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </div>
      </div>
      {!preview && <p className="text-label-13 text-text-2">{t('ctx.intro')}</p>}
      <div className="relative aspect-square w-full overflow-hidden rounded-lg border border-border bg-frame">
        {/* Aladin sets its container to position: relative, so the size must not come from inset alone. */}
        <div ref={host} className="absolute inset-0 h-full w-full" data-testid="aladin-host" />
        {state === 'loading' && (
          <div
            className="absolute inset-0 grid place-items-center bg-frame text-label-13 text-muted"
            role="status"
            data-testid="context-loading"
          >
            {t('ctx.loading')}
          </div>
        )}
        {state === 'failed' && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface p-4 text-center"
            role="alert"
            data-testid="context-failed"
          >
            <p className="text-label-13 text-text">{t('ctx.failed')}</p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              {t('states.retry')}
            </Button>
          </div>
        )}
      </div>
      <p className="text-caption-12 text-muted">{t('ctx.note', { fov: fovArcmin })}</p>
      <p className="text-caption-12 text-muted">{t('ctx.creditMirror')}</p>
    </div>
  );
}
