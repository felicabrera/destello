// Search engine optimisation: title, description, canonical, hreflang, robots and the single h1 on the
// pages that matter, in both languages, against the dev fixtures.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { lookupKey, matchRoute, resolvePageMeta, type Bundles, type RoutesFile } from '../../src/lib/seoCore';

const routes = JSON.parse(
  readFileSync(resolve(process.cwd(), 'src/lib/seoRoutes.json'), 'utf-8'),
) as RoutesFile;
const ORIGIN = 'http://localhost:5173';
const NS = ['comet', 'developers', 'errors', 'hunt', 'learn', 'story', 'wise'];

function bundles(lang: 'en' | 'es'): Bundles {
  const dir = resolve(process.cwd(), 'src/i18n');
  const out: Bundles = { translation: JSON.parse(readFileSync(resolve(dir, `${lang}.json`), 'utf-8')) };
  for (const ns of NS) out[ns] = JSON.parse(readFileSync(resolve(dir, lang, `${ns}.json`), 'utf-8'));
  return out;
}

interface Case {
  name: string;
  path: string;
  /** Route path for the metadata lookup. */
  route: string;
  index: boolean;
  h1: boolean;
}
const CASES: Case[] = [
  { name: 'home', path: '/', route: '/', index: true, h1: true },
  { name: 'story', path: '/story', route: '/story', index: true, h1: true },
  { name: 'target', path: '/t/barnard', route: '/t/barnard', index: true, h1: true },
  { name: 'embed', path: '/embed?target=barnard', route: '/embed', index: false, h1: false },
];

async function head(page: Page) {
  return page.evaluate(() => {
    const get = (sel: string, attr: string) => document.head.querySelector(sel)?.getAttribute(attr) ?? null;
    return {
      title: document.title,
      lang: document.documentElement.lang,
      description: get('meta[name="description"]', 'content'),
      robots: get('meta[name="robots"]', 'content'),
      canonical: get('link[rel="canonical"]', 'href'),
      hreflang: Object.fromEntries(
        [...document.head.querySelectorAll('link[rel="alternate"][hreflang]')].map((l) => [
          l.getAttribute('hreflang'),
          l.getAttribute('href'),
        ]),
      ) as Record<string, string>,
      ogTitle: get('meta[property="og:title"]', 'content'),
      ogUrl: get('meta[property="og:url"]', 'content'),
      ogImage: get('meta[property="og:image"]', 'content'),
      ogLocale: get('meta[property="og:locale"]', 'content'),
      twitterCard: get('meta[name="twitter:card"]', 'content'),
      h1: document.querySelectorAll('h1').length,
    };
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

for (const lang of ['en', 'es'] as const) {
  for (const c of CASES) {
    test(`${c.name} head tags in ${lang}`, async ({ page }) => {
      const joiner = c.path.includes('?') ? '&' : '?';
      await page.goto(`${c.path}${joiner}lang=${lang}`);
      const b = bundles(lang);
      const m = matchRoute(routes, c.route);
      expect(m).not.toBeNull();
      const expected = resolvePageMeta(routes, b, m!, c.route);
      // The head is written after the lazy page and the language are ready: wait for it.
      await expect.poll(async () => (await head(page)).lang).toBe(lang);
      if (c.name === 'target') await expect.poll(async () => (await head(page)).title).toMatch(/Barnard/);
      else await expect.poll(async () => (await head(page)).title).toBe(expected.title);
      const h = await head(page);

      expect(h.lang).toBe(lang);
      if (c.name === 'target') {
        expect(h.title).toMatch(/Barnard.* \| Destello$/);
        expect(h.description).toContain('Barnard');
      } else {
        expect(h.title).toBe(expected.title);
        expect(h.description).toBe(expected.description);
      }
      expect(h.description!.length).toBeGreaterThanOrEqual(120);
      expect(h.description!.length).toBeLessThanOrEqual(170);

      const canonicalPath = c.route === '/' ? '/' : c.route;
      expect(h.canonical).toBe(`${ORIGIN}${canonicalPath}${lang === 'es' ? '?lang=es' : ''}`);
      expect(h.robots).toBe(c.index ? 'index, follow' : 'noindex, nofollow');
      expect(h.ogUrl).toBe(h.canonical);
      expect(h.ogTitle).toBe(h.title);
      expect(h.ogImage).toBe(`${ORIGIN}/brand/og-image-1200x630.png`);
      expect(h.ogLocale).toBe(lang === 'es' ? 'es_ES' : 'en_US');
      expect(h.twitterCard).toBe('summary_large_image');

      if (c.index) {
        expect(h.hreflang).toEqual({
          en: `${ORIGIN}${canonicalPath}`,
          es: `${ORIGIN}${canonicalPath}?lang=es`,
          'x-default': `${ORIGIN}${canonicalPath}`,
        });
      } else {
        expect(h.hreflang).toEqual({});
      }
      if (c.h1) expect(h.h1).toBe(1);
      expect(lookupKey(b, 'seo.imageAlt')).toBeTruthy();
    });
  }

  test(`descriptions and titles differ per page in ${lang}`, async ({ page }) => {
    const titles = new Set<string>();
    const descriptions = new Set<string>();
    for (const c of CASES) {
      const joiner = c.path.includes('?') ? '&' : '?';
      await page.goto(`${c.path}${joiner}lang=${lang}`);
      await expect.poll(async () => (await head(page)).lang).toBe(lang);
      await expect
        .poll(async () => (await head(page)).canonical)
        .toContain(c.route === '/' ? ORIGIN + '/' : c.route);
      const h = await head(page);
      titles.add(h.title);
      descriptions.add(h.description ?? '');
    }
    expect(titles.size).toBe(CASES.length);
    expect(descriptions.size).toBe(CASES.length);
  });
}

test('an unknown address is not indexed and the language switch updates the head', async ({ page }) => {
  await page.goto('/this-page-does-not-exist');
  await expect.poll(async () => (await head(page)).robots).toBe('noindex, nofollow');
  await page.goto('/story');
  await expect.poll(async () => (await head(page)).lang).toBe('en');
  await page.getByTestId('lang-toggle').click();
  await expect.poll(async () => (await head(page)).lang).toBe('es');
  const h = await head(page);
  expect(h.canonical).toBe(`${ORIGIN}/story?lang=es`);
  expect(h.title).toBe(resolvePageMeta(routes, bundles('es'), matchRoute(routes, '/story')!, '/story').title);
});

for (const path of [
  '/science',
  '/validation',
  '/about',
  '/hunt',
  '/comet',
  '/learn',
  '/learn/guide',
  '/developers',
]) {
  test(`${path} has one h1, a title and an indexable head`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(async () => (await head(page)).title).toMatch(/ \| Destello$/);
    const h = await head(page);
    expect(h.robots).toBe('index, follow');
    expect(h.canonical).toBe(`${ORIGIN}${path}`);
    // Every image has an alt attribute (empty for decorative ones) and every link has a name.
    const missingAlt = await page.locator('img:not([alt])').count();
    expect(missingAlt).toBe(0);
    const unnamed = await page
      .locator('a')
      .evaluateAll(
        (els) =>
          els.filter(
            (a) =>
              !(a.textContent ?? '').trim() &&
              !a.getAttribute('aria-label') &&
              !a.querySelector('img[alt]:not([alt=""])'),
          ).length,
      );
    expect(unnamed).toBe(0);
  });
}
