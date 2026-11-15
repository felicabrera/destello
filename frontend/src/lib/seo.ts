// Runtime side of the search engine optimisation: one place that sets the title, description, language,
// canonical, hreflang, Open Graph and Twitter tags for every routed page. The tags themselves are built by the
// pure functions in seoCore.ts, which the build script also uses for the prerendered pages.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import type { TFunction } from 'i18next';
import routes from './seoRoutes.json';
import {
  SEO_ATTR,
  buildHead,
  matchRoute,
  normalizeOrigin,
  pageTitle,
  type HeadSpec,
  type RoutesFile,
  type SeoLang,
} from './seoCore';

export const ROUTES = routes as RoutesFile;

/** Site origin: the build variable, else the origin the page is served from. */
export function siteOrigin(): string {
  const fromEnv = import.meta.env.VITE_PUBLIC_URL as string | undefined;
  if (fromEnv && fromEnv.trim()) return normalizeOrigin(fromEnv);
  return typeof window === 'undefined' ? normalizeOrigin(undefined) : normalizeOrigin(window.location.origin);
}

/** Values a page can set itself (the explorer names its target, error pages mark themselves noindex). */
export interface SeoOverride {
  /** Page title without the site suffix. */
  title?: string;
  description?: string;
  index?: boolean;
}

interface SeoStore {
  override: SeoOverride | null;
  set: (o: SeoOverride | null) => void;
}

export const useSeoStore = create<SeoStore>((s) => ({
  override: null,
  set: (override) => s({ ...s, override }),
}));

/** Called by a page that knows more than the route table does. The override is removed when the page unmounts. */
export function useSeo(override: SeoOverride): void {
  const set = useSeoStore((s) => s.set);
  const { title, description, index } = override;
  useEffect(() => {
    set({ title, description, index });
    return () => set(null);
  }, [set, title, description, index]);
}

export interface BuildArgs {
  pathname: string;
  lang: SeoLang;
  t: TFunction;
  origin: string;
  override: SeoOverride | null;
}

const NOT_FOUND_TITLE_KEY = 'errors:notFound.docTitle';

/** Head of the current page. Unknown addresses (404, crash route) are never indexed. */
export function headForRoute({ pathname, lang, t, origin, override }: BuildArgs): HeadSpec {
  const match = matchRoute(ROUTES, pathname);
  const imageAlt = t('seo.imageAlt');
  const knownTarget = match?.route.id !== 'target' || ROUTES.targetIds.includes(match.params.target ?? '');
  const tr = (key: string, vars: Record<string, string> = {}) =>
    (t as unknown as (k: string, o?: Record<string, string>) => string)(key, vars);
  let title: string;
  let description: string;
  let index = false;
  let markdownPath: string | undefined;
  if (match) {
    const { route, params } = match;
    const key = route.title.replace('{target}', params.target ?? '');
    const name = route.id === 'report' ? tr(key, { id: params.reportId ?? '' }) : tr(key);
    title = pageTitle(
      route.id === 'target' && !knownTarget ? (params.target ?? name) : name,
      route.suffix !== false,
    );
    description = tr(route.description, { name });
    index = route.index && knownTarget;
    markdownPath = route.markdown ? `${route.path}.md` : undefined;
  } else {
    title = pageTitle(tr(NOT_FOUND_TITLE_KEY));
    description = tr('seo.error.description');
  }
  if (override?.title) title = pageTitle(override.title);
  if (override?.description) description = override.description;
  if (override?.index === false) index = false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return buildHead({
    origin,
    path,
    lang,
    title,
    description,
    index,
    imageAlt,
    alternates: index,
    markdownPath,
  });
}

/** Writes a head spec into the document: replaces every tag this module wrote before. */
export function applyHead(head: HeadSpec, doc: Document = document): void {
  doc.title = head.title;
  doc.documentElement.lang = head.lang;
  doc.head.querySelectorAll(`[${SEO_ATTR}]`).forEach((el) => el.remove());
  for (const t of head.tags) {
    const el = doc.createElement(t.tag);
    for (const [k, v] of Object.entries(t.attrs)) el.setAttribute(k, v);
    el.setAttribute(SEO_ATTR, '');
    doc.head.appendChild(el);
  }
}

/** Keeps the document head in step with the route, the language and the page override. Mount once in the root. */
export function useSeoManager(pathname: string, lang: SeoLang): void {
  const { t, i18n } = useTranslation();
  const override = useSeoStore((s) => s.override);
  useEffect(() => {
    // The language switch is asynchronous: build with a translator fixed to the requested language.
    const fixed = i18n.getFixedT(lang);
    applyHead(headForRoute({ pathname, lang, t: fixed, origin: siteOrigin(), override }));
  }, [pathname, lang, override, t, i18n]);
}
