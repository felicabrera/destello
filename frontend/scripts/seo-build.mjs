// Runs after `vite build` and before the precompress step. Writes into dist/:
//   robots.txt, sitemap.xml, llms.txt, llms-full.txt, the Markdown twins (about.md, science.md, validation.md)
//   and one prerendered copy of index.html per indexable route, whose head carries that route's English
//   title, description, canonical, Open Graph and Twitter tags (for link previews and crawlers that do not run
//   JavaScript). The body stays the SPA shell; the browser replaces the head at runtime (src/lib/seo.ts).
// Route metadata (src/lib/seoRoutes.json), the tag builders (src/lib/seoCore.ts, src/lib/llmsCore.ts) and the
// strings (src/i18n) are the same ones the browser uses. The origin comes from VITE_PUBLIC_URL.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(process.argv[2] ?? path.join(FRONTEND, 'dist'));
const README = path.resolve(FRONTEND, '..', 'README.md');

// Crawler tokens named here were checked against their operators' own documentation (read 2026-11-15):
//   GPTBot, OAI-SearchBot  https://developers.openai.com/api/docs/bots (robots.txt tags: OAI-SearchBot for
//                          ChatGPT search, GPTBot for model training). ChatGPT-User is left out: the page says
//                          robots.txt rules may not apply to user-initiated fetches.
//   ClaudeBot, Claude-User, Claude-SearchBot
//                          https://support.claude.com/en/articles/8896518 (Anthropic: all three honour robots.txt)
//   PerplexityBot          https://docs.perplexity.ai/guides/bots (search index; Perplexity-User is left out: the
//                          page says that fetcher generally ignores robots.txt)
//   Google-Extended        https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers
//                          (control token for Gemini training and grounding; does not affect Google Search)
const AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'PerplexityBot',
  'Google-Extended',
];

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf-8'));
}

async function bundlesFor(lang) {
  const dir = path.join(FRONTEND, 'src', 'i18n');
  const bundles = { translation: await readJson(path.join(dir, `${lang}.json`)) };
  const { readdir } = await import('node:fs/promises');
  for (const f of await readdir(path.join(dir, lang))) {
    if (f.endsWith('.json')) bundles[f.replace(/\.json$/, '')] = await readJson(path.join(dir, lang, f));
  }
  return bundles;
}

async function write(rel, text) {
  const file = path.join(DIST, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf-8');
}

const vite = await createServer({
  root: FRONTEND,
  configFile: false,
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, entries: ['src/lib/seoCore.ts'], include: [] },
});
try {
  const core = await vite.ssrLoadModule('/src/lib/seoCore.ts');
  const llms = await vite.ssrLoadModule('/src/lib/llmsCore.ts');
  const routes = await readJson(path.join(FRONTEND, 'src/lib/seoRoutes.json'));
  const en = await bundlesFor('en');
  const origin = core.normalizeOrigin(process.env.VITE_PUBLIC_URL);
  const epoch = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date();
  const lastmod = epoch.toISOString().slice(0, 10);

  const shell = await readFile(path.join(DIST, 'index.html'), 'utf-8');
  // Tags this script writes (marked data-seo) and the static defaults of index.html are replaced together.
  const stripped = shell
    .replace(/<title>[\s\S]*?<\/title>\s*/g, '')
    .replace(/[ \t]*<(?:meta|link)\b[^>]*\sdata-seo\b[^>]*>\s*/g, '')
    .replace(/[ \t]*<script\b[^>]*\sdata-seo-ld\b[^>]*>[\s\S]*?<\/script>\s*/g, '');
  if (!stripped.includes('</head>')) throw new Error('dist/index.html has no </head>');

  const imageAlt = core.lookupKey(en, 'seo.imageAlt');
  const entries = core.indexableEntries(routes);
  const homeMeta = core.resolvePageMeta(routes, en, core.matchRoute(routes, '/'), '/');
  const jsonLd = `    <script type="application/ld+json" data-seo-ld>\n${core.jsonLdScript(core.buildJsonLd(origin, homeMeta.description))}\n    </script>\n`;

  for (const e of entries) {
    const match = core.matchRoute(routes, e.path);
    const meta = core.resolvePageMeta(routes, en, match, e.path);
    const head = core.buildHead({
      origin,
      path: e.path,
      lang: 'en',
      title: meta.title,
      description: meta.description,
      index: meta.index,
      imageAlt,
      alternates: true,
      markdownPath: meta.markdownPath,
    });
    const block = `${core.renderHeadHtml(head)}\n${e.path === '/' ? jsonLd : ''}  `;
    const html = stripped.replace('</head>', `${block}</head>`);
    await write(e.path === '/' ? 'index.html' : `${e.path.slice(1)}/index.html`, html);
  }

  await write('robots.txt', core.buildRobotsTxt(origin, AI_AGENTS));
  await write('sitemap.xml', core.buildSitemap(origin, entries, lastmod));

  const ctx = { origin, routes, bundles: en, validation: llms.extractReadmeValidation(await readFile(README, 'utf-8')) };
  await write('llms.txt', llms.buildLlmsTxt(ctx));
  await write('llms-full.txt', llms.buildLlmsFull(ctx));
  for (const [name, text] of Object.entries(llms.buildMarkdownTwins(ctx))) await write(name, text);

  console.log(`seo-build: ${entries.length} prerendered pages, origin ${origin}, lastmod ${lastmod}`);
} finally {
  await vite.close();
}
