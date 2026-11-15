// F-34 "From Pluto to Planet X": seven chapters, scrolling story, real product views embedded by URL.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/button';
import { getManifest, getValidation } from '../../lib/api';
import { useBackend } from '../../lib/backend';
import { localNumber } from '../../lib/format';
import { localUnit } from '../../lib/units';
import type { Lang, Manifest } from '../../lib/types';
import { useTargets, useView } from '../explorer/useView';
import { useWiseCompanion, WiseTimeline } from '../wise/WiseTimeline';
import {
  CH6_VARIANT,
  CHAPTER_COUNT,
  chapterForKey,
  chapters,
  clampChapter,
  embedPath,
  openPath,
  type ChapterConfig,
} from './storyConfig';
import { measuredFact, targetPm } from './storyModel';

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

/** True while the element is within one viewport height of the screen (lazy mount of the embeds). */
function useNear(ref: React.RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => setNear(es.some((e) => e.isIntersecting)), {
      rootMargin: '100% 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

function Facts({ kind, lang }: { kind: 'ch4' | 'ch5'; lang: Lang }) {
  const { t } = useTranslation('story');
  const { t: tt } = useTranslation();
  const targets = useTargets().data;
  const mode = useBackend((s) => s.mode);
  const gen = useBackend((s) => s.generation);
  const validation = useQuery({
    queryKey: ['validation', gen, mode],
    queryFn: getValidation,
    enabled: kind === 'ch5',
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const lines: string[] = [];
  if (kind === 'ch4') {
    const pm = targetPm(targets, 'barnard');
    if (pm)
      lines.push(
        t('ch4.fact', {
          value: localNumber(lang, pm.arcsecPerYear, 2),
          unit: localUnit(tt, 'arcsec/yr'),
        }),
      );
  } else {
    const pm = targetPm(targets, 'wise0855');
    if (pm)
      lines.push(
        t('ch5.fact', {
          value: localNumber(lang, pm.arcsecPerYear, 2),
          unit: localUnit(tt, 'arcsec/yr'),
        }),
      );
    const m = measuredFact(validation.data, 'V-03', 'wise0855');
    if (m) {
      const unit = m.unit ? ` ${localUnit(tt, m.unit)}` : '';
      const err = m.err != null ? ` ± ${localNumber(lang, m.err, 2)}` : '';
      lines.push(t('ch5.measured', { value: `${localNumber(lang, m.measured, 2)}${err}${unit}` }));
      if (m.reference != null)
        lines.push(
          t('ch5.reference', {
            value: `${localNumber(lang, m.reference, 2)}${unit}`,
            source: m.source ?? t('ch5.sourceUnknown'),
          }),
        );
    }
  }
  if (lines.length === 0) return null;
  return (
    <ul
      className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-body-14 text-text-2"
      data-testid={`story-facts-${kind}`}
    >
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  );
}

type WiseState =
  | { phase: 'pending' }
  | { phase: 'none' }
  | { phase: 'ready'; sequenceId: string; manifest: Manifest | null };

/** Whether the preset has a WISE companion on this backend. Demo and fixture modes have none. */
function useStoryWise(target: string | undefined): WiseState {
  const targets = useTargets();
  const sid = target ? targets.data?.find((x) => x.id === target)?.sequence_id : undefined;
  const companion = useWiseCompanion(sid ?? undefined);
  const manifest = useQuery<Manifest>({
    queryKey: ['story', 'wise-manifest', sid],
    queryFn: () => getManifest(`/manifests/${sid}.json`),
    enabled: !!sid && !!companion.data,
    staleTime: 60_000,
    retry: false,
  });
  if (!target) return { phase: 'none' };
  if (targets.isPending || (!!sid && companion.isPending)) return { phase: 'pending' };
  if (!sid || !companion.data) return { phase: 'none' };
  if (manifest.isPending) return { phase: 'pending' };
  return { phase: 'ready', sequenceId: sid, manifest: manifest.data ?? null };
}

function Embed({
  ch,
  lang,
  reduced,
  wise,
}: {
  ch: ChapterConfig;
  lang: Lang;
  reduced: boolean;
  wise: WiseState;
}) {
  const { t } = useTranslation('story');
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box);
  const outer = ch.embed;
  if (!outer) return null;
  if (outer.kind === 'wise' && wise.phase === 'ready') {
    return (
      <div className="flex flex-col gap-2">
        <div data-testid={`story-embed-${ch.id}`} data-kind="wise" aria-label={t(`${ch.copy}.wiseTitle`)}>
          <WiseTimeline sequenceId={wise.sequenceId} manifest={wise.manifest} lang={lang} />
        </div>
        <a
          href={openPath(outer, lang)}
          className="self-start text-label-13 text-cyan underline underline-offset-2"
          data-testid={`story-open-${ch.id}`}
        >
          {t('openInDestello')}
        </a>
      </div>
    );
  }
  // Without a companion the chapter shows the fallback view; while the answer is pending it shows the waiting
  // box, so that no frame is mounted and replaced.
  const spec = outer.kind === 'wise' ? outer.fallback : outer;
  const pending = outer.kind === 'wise' && wise.phase === 'pending';
  const src = embedPath(spec, lang, reduced);
  const tall = spec.kind !== 'player';
  return (
    <div className="flex flex-col gap-2">
      <div
        ref={box}
        data-testid={`story-embed-${ch.id}`}
        data-mounted={near && !pending ? '1' : '0'}
        className={`w-full overflow-hidden rounded-xl border border-border bg-surface ${tall ? 'h-[720px]' : 'h-[620px]'}`}
      >
        {near && !pending ? (
          <iframe
            title={t(`${ch.copy}.embedTitle`)}
            src={src}
            loading="lazy"
            className="size-full border-0"
            data-testid={`story-frame-${ch.id}`}
          />
        ) : (
          <p className="grid size-full place-items-center p-4 text-center text-body-14 text-muted">
            {t('embedWaiting')}
          </p>
        )}
      </div>
      <a
        href={openPath(spec, lang)}
        className="self-start text-label-13 text-cyan underline underline-offset-2"
        data-testid={`story-open-${ch.id}`}
      >
        {t('openInDestello')}
      </a>
    </div>
  );
}

/** With the 16 years view shown, the closing paragraph describes it instead of the fallback player. */
function chapterBody(body: string[], ch: ChapterConfig, wise: WiseState, t: (k: string) => string): string[] {
  if (ch.embed?.kind !== 'wise' || wise.phase !== 'ready') return body;
  return [...body.slice(0, -1), t(`${ch.copy}.wiseIntro`)];
}

export function StoryPage() {
  const { t } = useTranslation('story');
  const lang = useView().view.lang;
  const reduced = useReducedMotion();
  const list = useMemo(() => chapters(CH6_VARIANT), []);
  const wiseTarget = list.map((c) => c.embed).find((e) => e?.kind === 'wise')?.target;
  const wise = useStoryWise(wiseTarget);
  const [active, setActive] = useState(0);
  const heads = useRef<(HTMLHeadingElement | null)[]>([]);
  const secs = useRef<(HTMLElement | null)[]>([]);
  // While a step scrolls to its chapter, the chapters passed on the way must not take over the counter.
  const lockUntil = useRef(0);

  // Track which chapter is on screen, for the counter and for the step controls.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (e.isIntersecting && Date.now() >= lockUntil.current)
            setActive(Number((e.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: '-35% 0px -60% 0px' },
    );
    secs.current.forEach((s) => s && io.observe(s));
    return () => io.disconnect();
  }, []);

  const go = useCallback(
    (i: number) => {
      const n = clampChapter(i);
      setActive(n);
      lockUntil.current = Date.now() + (reduced ? 150 : 1200);
      const h = heads.current[n];
      secs.current[n]?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
      h?.focus({ preventScroll: true });
    },
    [reduced],
  );

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const n = chapterForKey(e.key, active);
      if (n === null) return;
      e.preventDefault();
      go(n);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [active, go]);

  return (
    <main
      id="main"
      tabIndex={-1}
      className="mx-auto max-w-[920px] px-4 pb-16 md:px-6"
      data-testid="story"
      data-active={active}
      data-reduced={reduced ? '1' : '0'}
    >
      <header className="pb-6 pt-10">
        <p className="text-caption-12 font-semibold uppercase tracking-wider text-glint">{t('kicker')}</p>
        <h1 className="mt-1 font-display text-display-32 font-medium md:text-display-48">{t('title')}</h1>
        <p className="mt-4 text-body-15 text-text-2 md:text-title-20">{t('lead')}</p>
        <p className="mt-3 text-caption-12 text-muted" data-testid="story-keys">
          {t('keys')}
        </p>
        {reduced && (
          <p className="mt-2 text-caption-12 text-muted" data-testid="story-reduced">
            {t('reduced')}
          </p>
        )}
      </header>

      <nav
        aria-label={t('navLabel')}
        className="sticky top-0 z-10 flex items-center justify-between gap-2 border-y border-border bg-bg py-2"
        data-testid="story-nav"
      >
        <Button
          variant="secondary"
          onClick={() => go(active - 1)}
          disabled={active === 0}
          aria-label={t('prevLabel')}
          data-testid="story-prev"
        >
          {t('prev')}
        </Button>
        <p
          className="tnum min-w-0 truncate text-center text-label-13 text-muted"
          aria-live="polite"
          data-testid="story-counter"
        >
          {t('counter', { n: active + 1, total: CHAPTER_COUNT })}
        </p>
        <Button
          variant="secondary"
          onClick={() => go(active + 1)}
          disabled={active === CHAPTER_COUNT - 1}
          aria-label={t('nextLabel')}
          data-testid="story-next"
        >
          {t('next')}
        </Button>
      </nav>

      <div className="flex flex-col gap-16 pt-10">
        {list.map((ch, i) => (
          <section
            key={ch.id}
            id={`chapter-${ch.id}`}
            ref={(el) => {
              secs.current[i] = el;
            }}
            data-index={i}
            data-testid={`story-ch-${i + 1}`}
            aria-labelledby={`chapter-${ch.id}-h`}
            className="flex scroll-mt-20 flex-col gap-4"
          >
            <p className="tnum text-caption-12 font-semibold uppercase tracking-wider text-muted">
              {t('chapterLabel', { n: i + 1 })}
            </p>
            <h2
              id={`chapter-${ch.id}-h`}
              ref={(el) => {
                heads.current[i] = el;
              }}
              tabIndex={-1}
              className="font-display text-heading-24 font-medium md:text-display-32"
            >
              {t(`${ch.copy}.title`)}
            </h2>
            <div className="flex flex-col gap-3 text-body-15 text-text-2">
              {chapterBody(t(`${ch.copy}.body`, { returnObjects: true }) as string[], ch, wise, t).map(
                (p) => (
                  <p key={p}>{p}</p>
                ),
              )}
            </div>
            {ch.fact && <Facts kind={ch.fact} lang={lang} />}
            <Embed ch={ch} lang={lang} reduced={reduced} wise={wise} />
            {ch.huntLink && (
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/hunt"
                  search={{ lang }}
                  className="inline-flex min-h-[var(--hit-min)] items-center self-start rounded-lg bg-primary px-4 text-label-13 font-medium text-primary-foreground hover:bg-glint-hover"
                  data-testid="story-hunt"
                >
                  {t('huntCta')}
                </Link>
                <Link
                  to="/learn"
                  search={{ lang }}
                  className="inline-flex min-h-[var(--hit-min)] items-center self-start rounded-lg border border-border-strong bg-surface-2 px-4 text-label-13 font-medium text-text hover:bg-border"
                  data-testid="story-learn"
                >
                  {t('learnCta')}
                </Link>
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
