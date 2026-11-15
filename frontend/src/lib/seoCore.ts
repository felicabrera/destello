// Pure search engine optimisation helpers: the head tag set of a page, robots.txt, the sitemap and the
// structured data. No side effects, so that the build script (scripts/seo-build.mjs) and the browser run the
// same code. Route metadata lives in seoRoutes.json and every string comes from the i18n files.

export type SeoLang = 'en' | 'es';

export interface RouteDef {
  id: string;
  path: string;
  /** i18n key of the page title; `ns:key` for a feature namespace. `{target}` is replaced by the preset id. */
  title: string;
  /** Add the ` | Destello` suffix to the title (default true). */
  suffix?: boolean;
  /** i18n key of the meta description. */
  description: string;
  index: boolean;
  priority?: string;
  /** The build writes a Markdown twin at `<path>.md` for this page. */
  markdown?: boolean;
}

export interface RoutesFile {
  targetIds: string[];
  routes: RouteDef[];
}

export const SITE_NAME = 'Destello';
export const FALLBACK_ORIGIN = 'http://localhost:8080';
export const IMAGE_PATH = '/brand/og-image-1200x630.png';
export const IMAGE_WIDTH = 1200;
export const IMAGE_HEIGHT = 630;
export const AUTHOR = { name: 'Felipe Cabrera', url: 'https://felicabrera.com' };
export const ROBOTS_INDEX = 'index, follow';
export const ROBOTS_NOINDEX = 'noindex, nofollow';
export const SEO_ATTR = 'data-seo';
/** Paths that robots.txt keeps crawlers away from (also served with X-Robots-Tag: noindex by Caddy, except /r/). */
export const DISALLOWED_PATHS = ['/api/', '/embed', '/r/', '/demo/', '/manifests/'];

export interface HeadTag {
  tag: 'meta' | 'link';
  attrs: Record<string, string>;
}

export interface HeadSpec {
  title: string;
  lang: SeoLang;
  tags: HeadTag[];
}

export interface HeadInput {
  origin: string;
  path: string;
  lang: SeoLang;
  /** Final document title. */
  title: string;
  description: string;
  index: boolean;
  imageAlt: string;
  /** Emit hreflang alternates (indexable pages only). */
  alternates?: boolean;
  /** Path of the Markdown twin of the page, when it has one. */
  markdownPath?: string;
}

export function normalizeOrigin(origin: string | undefined | null): string {
  const o = (origin ?? '').trim().replace(/\/+$/, '');
  return o || FALLBACK_ORIGIN;
}

export function pageTitle(title: string, suffix = true): string {
  return suffix ? `${title} | ${SITE_NAME}` : title;
}

export function canonicalUrl(origin: string, path: string, lang: SeoLang): string {
  const base = `${normalizeOrigin(origin)}${path.startsWith('/') ? path : `/${path}`}`;
  return lang === 'es' ? `${base}?lang=es` : base;
}

export function interpolate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
}

export type Bundle = Record<string, unknown>;
/** Resource bundles of one language: `translation` plus one entry per feature namespace. */
export type Bundles = Record<string, Bundle>;

/** Reads `ns:a.b.c` (or `a.b.c` in the default namespace) from the bundles. Returns undefined when missing. */
export function lookupKey(bundles: Bundles, key: string): string | undefined {
  const i = key.indexOf(':');
  const ns = i > 0 ? key.slice(0, i) : 'translation';
  const path = i > 0 ? key.slice(i + 1) : key;
  let cur: unknown = bundles[ns];
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
}

/** Finds the route of a pathname, or null for an unknown address. A trailing slash is ignored. */
export function matchRoute(file: RoutesFile, pathname: string): RouteMatch | null {
  const clean = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const parts = clean.split('/').filter(Boolean);
  for (const route of file.routes) {
    const rparts = route.path.split('/').filter(Boolean);
    if (rparts.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    rparts.forEach((rp, i) => {
      if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(parts[i]);
      else if (rp !== parts[i]) ok = false;
    });
    if (ok) return { route, params };
  }
  return null;
}

export interface PageMeta {
  path: string;
  title: string;
  description: string;
  index: boolean;
  markdownPath?: string;
}

/** Resolves the title and description of a matched route in one language. */
export function resolvePageMeta(
  file: RoutesFile,
  bundles: Bundles,
  match: RouteMatch,
  pathname: string,
): PageMeta {
  const { route, params } = match;
  const target = params.target;
  const knownTarget = route.id === 'target' ? file.targetIds.includes(target) : true;
  const titleKey = route.title.replace('{target}', target ?? '');
  const name = lookupKey(bundles, titleKey) ?? target ?? SITE_NAME;
  const title = pageTitle(
    route.id === 'target' && !knownTarget ? (target ?? SITE_NAME) : name,
    route.suffix !== false,
  );
  const description = interpolate(lookupKey(bundles, route.description) ?? '', { name });
  return {
    path: pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname,
    title,
    description,
    index: route.index && knownTarget,
    markdownPath: route.markdown ? `${route.path}.md` : undefined,
  };
}

export function buildHead(i: HeadInput): HeadSpec {
  const origin = normalizeOrigin(i.origin);
  const url = canonicalUrl(origin, i.path, i.lang);
  const image = `${origin}${IMAGE_PATH}`;
  const m = (name: string, content: string): HeadTag => ({ tag: 'meta', attrs: { name, content } });
  const p = (property: string, content: string): HeadTag => ({ tag: 'meta', attrs: { property, content } });
  const tags: HeadTag[] = [
    m('description', i.description),
    m('robots', i.index ? ROBOTS_INDEX : ROBOTS_NOINDEX),
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
  ];
  if (i.alternates) {
    tags.push(
      { tag: 'link', attrs: { rel: 'alternate', hreflang: 'en', href: canonicalUrl(origin, i.path, 'en') } },
      { tag: 'link', attrs: { rel: 'alternate', hreflang: 'es', href: canonicalUrl(origin, i.path, 'es') } },
      {
        tag: 'link',
        attrs: { rel: 'alternate', hreflang: 'x-default', href: canonicalUrl(origin, i.path, 'en') },
      },
    );
  }
  if (i.markdownPath) {
    tags.push({
      tag: 'link',
      attrs: { rel: 'alternate', type: 'text/markdown', href: `${origin}${i.markdownPath}` },
    });
  }
  tags.push(
    { tag: 'link', attrs: { rel: 'describedby', href: `${origin}/llms.txt` } },
    p('og:title', i.title),
    p('og:description', i.description),
    p('og:url', url),
    p('og:type', 'website'),
    p('og:site_name', SITE_NAME),
    p('og:locale', i.lang === 'es' ? 'es_ES' : 'en_US'),
    p('og:locale:alternate', i.lang === 'es' ? 'en_US' : 'es_ES'),
    p('og:image', image),
    p('og:image:width', String(IMAGE_WIDTH)),
    p('og:image:height', String(IMAGE_HEIGHT)),
    p('og:image:alt', i.imageAlt),
    m('twitter:card', 'summary_large_image'),
    m('twitter:title', i.title),
    m('twitter:description', i.description),
    m('twitter:image', image),
    m('twitter:image:alt', i.imageAlt),
  );
  return { title: i.title, lang: i.lang, tags };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Head markup of a spec, one tag per line, each carrying the data-seo marker. */
export function renderHeadHtml(head: HeadSpec, indent = '    '): string {
  const lines = [`${indent}<title>${escapeHtml(head.title)}</title>`];
  for (const t of head.tags) {
    const attrs = Object.entries(t.attrs)
      .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
      .join(' ');
    lines.push(`${indent}<${t.tag} ${attrs} ${SEO_ATTR} />`);
  }
  return lines.join('\n');
}

export interface IndexableEntry {
  id: string;
  path: string;
  priority: string;
}

/** Paths of every indexable route; the target route expands to one entry per preset. */
export function indexableEntries(file: RoutesFile): IndexableEntry[] {
  const out: IndexableEntry[] = [];
  for (const r of file.routes) {
    if (!r.index) continue;
    if (r.id === 'target') {
      for (const id of file.targetIds)
        out.push({ id: `target:${id}`, path: `/t/${id}`, priority: r.priority ?? '0.5' });
    } else out.push({ id: r.id, path: r.path, priority: r.priority ?? '0.5' });
  }
  return out;
}

export function buildRobotsTxt(origin: string, aiAgents: string[]): string {
  const rules = ['Allow: /', ...DISALLOWED_PATHS.map((p) => `Disallow: ${p}`)];
  const groups = [
    ['User-agent: *', ...rules].join('\n'),
    [...aiAgents.map((a) => `User-agent: ${a}`), ...rules].join('\n'),
  ];
  return `${groups.join('\n\n')}\n\nSitemap: ${normalizeOrigin(origin)}/sitemap.xml\n`;
}

export function buildSitemap(origin: string, entries: IndexableEntry[], lastmod: string): string {
  const o = normalizeOrigin(origin);
  const alt = (path: string) =>
    [
      ['en', canonicalUrl(o, path, 'en')],
      ['es', canonicalUrl(o, path, 'es')],
      ['x-default', canonicalUrl(o, path, 'en')],
    ]
      .map(([l, h]) => `      <xhtml:link rel="alternate" hreflang="${l}" href="${escapeHtml(h)}" />`)
      .join('\n');
  const urls = entries.flatMap((e) =>
    (['en', 'es'] as const).map(
      (lang) =>
        `  <url>\n    <loc>${escapeHtml(canonicalUrl(o, e.path, lang))}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <priority>${e.priority}</priority>\n${alt(e.path)}\n  </url>`,
    ),
  );
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`;
}

/** One JSON-LD graph: the web application and the web site, in English with Spanish declared. */
export function buildJsonLd(origin: string, description: string): Record<string, unknown> {
  const o = normalizeOrigin(origin);
  const person = { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url };
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        '@id': `${o}/#app`,
        name: SITE_NAME,
        url: `${o}/`,
        description,
        applicationCategory: 'EducationalApplication',
        operatingSystem: 'Any (web browser)',
        inLanguage: ['en', 'es'],
        isAccessibleForFree: true,
        creator: person,
        author: person,
      },
      {
        '@type': 'WebSite',
        '@id': `${o}/#site`,
        name: SITE_NAME,
        url: `${o}/`,
        description,
        inLanguage: ['en', 'es'],
        author: person,
      },
    ],
  };
}

/** JSON for an inline script: `<` is escaped so that the text can never close the element. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
}
