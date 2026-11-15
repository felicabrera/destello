import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import es from '../i18n/es.json';
import routes from './seoRoutes.json';
import { PRESET_IDS } from './url-state';
import {
  buildHead,
  buildJsonLd,
  buildRobotsTxt,
  buildSitemap,
  canonicalUrl,
  indexableEntries,
  jsonLdScript,
  lookupKey,
  matchRoute,
  normalizeOrigin,
  pageTitle,
  renderHeadHtml,
  resolvePageMeta,
  type Bundle,
  type Bundles,
  type RoutesFile,
} from './seoCore';

const file = routes as RoutesFile;
const NS = ['comet', 'developers', 'errors', 'hunt', 'learn', 'story', 'wise'];
function bundles(lang: 'en' | 'es'): Bundles {
  const out: Bundles = { translation: (lang === 'en' ? en : es) as Bundle };
  for (const ns of NS) {
    out[ns] = JSON.parse(readFileSync(resolve(__dirname, `../i18n/${lang}/${ns}.json`), 'utf-8')) as Bundles;
  }
  return out;
}
const ORIGIN = 'https://example.test';

describe('origin and urls', () => {
  it('normalizes the origin and falls back to the local default', () => {
    expect(normalizeOrigin('https://example.test///')).toBe('https://example.test');
    expect(normalizeOrigin('')).toBe('http://localhost:8080');
    expect(normalizeOrigin(undefined)).toBe('http://localhost:8080');
  });
  it('keeps ?lang=es only for Spanish and never carries view state', () => {
    expect(canonicalUrl(ORIGIN, '/t/barnard', 'en')).toBe('https://example.test/t/barnard');
    expect(canonicalUrl(ORIGIN, '/t/barnard', 'es')).toBe('https://example.test/t/barnard?lang=es');
    expect(canonicalUrl(ORIGIN, '/', 'en')).toBe('https://example.test/');
  });
  it('builds titles with the site suffix', () => {
    expect(pageTitle('Story')).toBe('Story | Destello');
    expect(pageTitle('Home title', false)).toBe('Home title');
  });
});

describe('route table', () => {
  it('lists the same presets as the URL contract', () => {
    expect(file.targetIds).toEqual([...PRESET_IDS]);
  });
  it('matches routes, parameters and trailing slashes', () => {
    expect(matchRoute(file, '/')?.route.id).toBe('home');
    expect(matchRoute(file, '/story/')?.route.id).toBe('story');
    expect(matchRoute(file, '/learn/guide')?.route.id).toBe('guide');
    expect(matchRoute(file, '/t/rdra')?.params.target).toBe('rdra');
    expect(matchRoute(file, '/r/abc')?.route.index).toBe(false);
    expect(matchRoute(file, '/__crash')).toBeNull();
    expect(matchRoute(file, '/nope/deeper/path')).toBeNull();
  });
  it('indexes the pages and the five presets, not the embed or reports', () => {
    const paths = indexableEntries(file).map((e) => e.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/story');
    expect(paths).toContain('/t/barnard');
    expect(paths.filter((p) => p.startsWith('/t/'))).toHaveLength(5);
    expect(paths).not.toContain('/embed');
    expect(paths.some((p) => p.startsWith('/r/'))).toBe(false);
  });
  it.each(['en', 'es'] as const)(
    'resolves every key in %s with distinct titles and sound descriptions',
    (lang) => {
      const b = bundles(lang);
      const titles = new Set<string>();
      const descriptions = new Set<string>();
      for (const path of [...indexableEntries(file).map((e) => e.path), '/embed', '/r/x']) {
        const m = matchRoute(file, path);
        expect(m, path).not.toBeNull();
        if (!m) continue;
        const meta = resolvePageMeta(file, b, m, path);
        expect(meta.title, path).not.toBe('');
        expect(meta.description, path).not.toBe('');
        expect(meta.description, path).not.toContain('{{');
        expect(meta.description.length, path).toBeGreaterThanOrEqual(130);
        expect(meta.description.length, path).toBeLessThanOrEqual(166);
        titles.add(meta.title);
        descriptions.add(meta.description);
      }
      expect(titles.size).toBe(descriptions.size);
      expect(descriptions.size).toBe(indexableEntries(file).length + 2);
    },
  );
  it('names the target in its title and description', () => {
    const b = bundles('en');
    const m = matchRoute(file, '/t/barnard');
    const meta = m && resolvePageMeta(file, b, m, '/t/barnard');
    expect(meta?.title).toBe("Barnard's Star | Destello");
    expect(meta?.description).toContain("Barnard's Star");
  });
  it('does not index an unknown target', () => {
    const m = matchRoute(file, '/t/unknown');
    expect(m && resolvePageMeta(file, bundles('en'), m, '/t/unknown').index).toBe(false);
  });
  it('uses the home title without the suffix', () => {
    const m = matchRoute(file, '/');
    expect(m && resolvePageMeta(file, bundles('en'), m, '/').title).toBe(
      lookupKey(bundles('en'), 'seo.home.title'),
    );
  });
});

describe('buildHead', () => {
  const input = {
    origin: ORIGIN,
    path: '/story',
    lang: 'en' as const,
    title: 'From Pluto to Planet X | Destello',
    description: 'A description.',
    index: true,
    imageAlt: 'Alt text',
    alternates: true,
  };
  const find = (tags: ReturnType<typeof buildHead>['tags'], key: string, value: string) =>
    tags.find((t) => t.attrs[key] === value);

  it('sets canonical, hreflang alternates, Open Graph and Twitter tags', () => {
    const head = buildHead(input);
    expect(find(head.tags, 'rel', 'canonical')?.attrs.href).toBe('https://example.test/story');
    const alts = head.tags.filter((t) => t.attrs.hreflang).map((t) => [t.attrs.hreflang, t.attrs.href]);
    expect(alts).toEqual([
      ['en', 'https://example.test/story'],
      ['es', 'https://example.test/story?lang=es'],
      ['x-default', 'https://example.test/story'],
    ]);
    expect(find(head.tags, 'name', 'robots')?.attrs.content).toBe('index, follow');
    expect(find(head.tags, 'property', 'og:url')?.attrs.content).toBe('https://example.test/story');
    expect(find(head.tags, 'property', 'og:type')?.attrs.content).toBe('website');
    expect(find(head.tags, 'property', 'og:site_name')?.attrs.content).toBe('Destello');
    expect(find(head.tags, 'property', 'og:locale')?.attrs.content).toBe('en_US');
    expect(find(head.tags, 'property', 'og:locale:alternate')?.attrs.content).toBe('es_ES');
    expect(find(head.tags, 'property', 'og:image')?.attrs.content).toBe(
      'https://example.test/brand/og-image-1200x630.png',
    );
    expect(find(head.tags, 'property', 'og:image:width')?.attrs.content).toBe('1200');
    expect(find(head.tags, 'property', 'og:image:height')?.attrs.content).toBe('630');
    expect(find(head.tags, 'property', 'og:image:alt')?.attrs.content).toBe('Alt text');
    expect(find(head.tags, 'name', 'twitter:card')?.attrs.content).toBe('summary_large_image');
    expect(find(head.tags, 'name', 'description')?.attrs.content).toBe('A description.');
  });
  it('switches locale and canonical for Spanish', () => {
    const head = buildHead({ ...input, lang: 'es' });
    expect(find(head.tags, 'rel', 'canonical')?.attrs.href).toBe('https://example.test/story?lang=es');
    expect(find(head.tags, 'property', 'og:locale')?.attrs.content).toBe('es_ES');
    expect(head.lang).toBe('es');
  });
  it('marks non-indexable pages noindex and drops the alternates', () => {
    const head = buildHead({ ...input, path: '/embed', index: false, alternates: false });
    expect(find(head.tags, 'name', 'robots')?.attrs.content).toBe('noindex, nofollow');
    expect(head.tags.some((t) => t.attrs.hreflang)).toBe(false);
  });
  it('adds a Markdown alternate when the page has a twin', () => {
    const head = buildHead({ ...input, path: '/about', markdownPath: '/about.md' });
    expect(find(head.tags, 'type', 'text/markdown')?.attrs.href).toBe('https://example.test/about.md');
  });
  it('renders escaped, marked head markup', () => {
    const html = renderHeadHtml(buildHead({ ...input, title: 'A & "B"', description: '<x>' }));
    expect(html).toContain('<title>A &amp; &quot;B&quot;</title>');
    expect(html).toContain('content="&lt;x&gt;"');
    expect(
      html
        .split('\n')
        .slice(1)
        .every((l) => l.includes('data-seo')),
    ).toBe(true);
  });
});

describe('robots.txt and sitemap', () => {
  it('repeats the disallows in the crawler group and names the sitemap', () => {
    const txt = buildRobotsTxt(ORIGIN, ['GPTBot', 'ClaudeBot']);
    const groups = txt.trim().split('\n\n');
    expect(groups[0]).toContain('User-agent: *');
    expect(groups[1]).toContain('User-agent: GPTBot\nUser-agent: ClaudeBot');
    for (const g of groups.slice(0, 2)) {
      for (const p of ['/api/', '/embed', '/r/', '/demo/', '/manifests/'])
        expect(g).toContain(`Disallow: ${p}`);
      expect(g).toContain('Allow: /');
    }
    expect(txt).toContain('Sitemap: https://example.test/sitemap.xml');
  });
  it('lists both languages of every route with alternates and the build date', () => {
    const xml = buildSitemap(ORIGIN, indexableEntries(file), '2026-11-15');
    expect(xml).toContain('<loc>https://example.test/t/barnard</loc>');
    expect(xml).toContain('<loc>https://example.test/t/barnard?lang=es</loc>');
    expect(xml).toContain('hreflang="x-default"');
    expect(xml.match(/<lastmod>2026-11-15<\/lastmod>/g)).toHaveLength(indexableEntries(file).length * 2);
    expect(xml).not.toContain('/embed');
  });
});

describe('structured data', () => {
  it('describes the web application and the web site', () => {
    const ld = buildJsonLd(ORIGIN, 'Description') as { '@graph': Record<string, unknown>[] };
    const app = ld['@graph'].find((x) => x['@type'] === 'WebApplication');
    expect(app).toMatchObject({
      name: 'Destello',
      url: 'https://example.test/',
      applicationCategory: expect.any(String),
      inLanguage: ['en', 'es'],
      isAccessibleForFree: true,
      creator: { '@type': 'Person', name: 'Felipe Cabrera', url: 'https://felicabrera.com' },
      author: { '@type': 'Person', name: 'Felipe Cabrera' },
    });
    expect(ld['@graph'].some((x) => x['@type'] === 'WebSite')).toBe(true);
  });
  it('cannot close the script element', () => {
    expect(jsonLdScript({ a: '</script>' })).not.toContain('</script>');
  });
});

describe('index.html static defaults', () => {
  const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf-8');
  it('carries the English home values from the i18n files', () => {
    const b = bundles('en');
    expect(html).toContain(`<title>${lookupKey(b, 'seo.home.title')}</title>`);
    expect(html).toContain(`content="${lookupKey(b, 'seo.home.description')}"`);
    expect(html).toContain('rel="canonical" href="%VITE_PUBLIC_URL%/"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('<noscript>');
    expect(html).toContain('href="/about"');
  });
  it('has exactly one JSON-LD block', () => {
    expect(html.match(/application\/ld\+json/g)).toHaveLength(1);
  });
});

describe('copy rules', () => {
  it('uses no em dash in the SEO strings', () => {
    const dash = String.fromCharCode(0x2014);
    expect(JSON.stringify(en.seo).includes(dash)).toBe(false);
    expect(JSON.stringify(es.seo).includes(dash)).toBe(false);
  });
});
