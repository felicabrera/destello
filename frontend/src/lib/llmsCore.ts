// Text files for language-model readers, built from the route table and the English i18n files:
//   llms.txt       the index format of https://llmstxt.org/ (H1, blockquote, notes, H2 link lists, ## Optional)
//   llms-full.txt  one Markdown file with the content an assistant needs to answer questions without the app
//   <page>.md      Markdown twins of the pages that carry a `markdown` flag in seoRoutes.json
// Nothing here is invented: titles, descriptions and prose come from the i18n copy, the validation record from
// README.md. The prose that frames the files (summary line, notes) is the only text written for them.
import {
  indexableEntries,
  lookupKey,
  matchRoute,
  normalizeOrigin,
  resolvePageMeta,
  type Bundles,
  type RoutesFile,
} from './seoCore';

export interface LlmsContext {
  origin: string;
  routes: RoutesFile;
  /** English resource bundles: `translation` plus one entry per namespace. */
  bundles: Bundles;
  /** The validation section of README.md (from "### Validation results" up to the next "###" heading). */
  validation: string;
}

const get = (b: Bundles, key: string): string => lookupKey(b, key) ?? '';

/** Drops relative Markdown links (they point into the repository) and keeps their text. */
export function stripRelativeLinks(md: string): string {
  return md.replace(/\[([^\]]+)\]\((?!https?:\/\/|#)[^)]+\)/g, '$1');
}

export function extractReadmeValidation(readme: string): string {
  const start = readme.indexOf('### Validation results');
  if (start < 0) throw new Error('README.md has no "### Validation results" section');
  const rest = readme.slice(start + '### Validation results'.length);
  const end = rest.search(/\n###? /);
  const body = end < 0 ? rest : rest.slice(0, end);
  return stripRelativeLinks(body.trim());
}

interface Page {
  path: string;
  title: string;
  description: string;
  markdownPath?: string;
}

function pageFor(ctx: LlmsContext, path: string): Page {
  const match = matchRoute(ctx.routes, path);
  if (!match) throw new Error(`No route for ${path}`);
  const meta = resolvePageMeta(ctx.routes, ctx.bundles, match, path);
  return {
    path,
    title: meta.title.replace(/ \| Destello$/, ''),
    description: meta.description,
    markdownPath: meta.markdownPath,
  };
}

function link(ctx: LlmsContext, page: Page, title = page.title): string {
  const o = normalizeOrigin(ctx.origin);
  const href = page.markdownPath ? `${o}${page.markdownPath}` : `${o}${page.path === '/' ? '/' : page.path}`;
  return `- [${title}](${href}): ${page.description}`;
}

const SUMMARY =
  'Destello is a free, bilingual (English and Spanish) web tool that blinks real NASA SPHEREx infrared images of any sky position across survey epochs, so that moving and variable objects stand out. It was built for the NASA Space Apps Challenge 2026 challenge "Planet X and SPHEREx". It is an independent project and not an official NASA product.';

export function buildLlmsTxt(ctx: LlmsContext): string {
  const o = normalizeOrigin(ctx.origin);
  const b = ctx.bundles;
  const presets = ctx.routes.targetIds.map((id) => pageFor(ctx, `/t/${id}`));
  const lines: string[] = [
    '# Destello',
    '',
    `> ${SUMMARY}`,
    '',
    'Every image comes from NASA SPHEREx data served by NASA/IPAC IRSA; Destello does not simulate or interpolate data. Every page is also available in Spanish by adding `?lang=es` to its address. The validation page lists every test, including the ones that failed or could not be measured.',
    '',
    'Pages marked with a `.md` address have a plain Markdown version; the full text for assistants is in llms-full.txt.',
    '',
    '## Tool',
    '',
    link(ctx, pageFor(ctx, '/'), 'Explorer (home)'),
    ...presets.map((p) => link(ctx, p)),
    link(ctx, pageFor(ctx, '/comet'), '3I/ATLAS, interstellar comet'),
    '',
    '## Learn and take part',
    '',
    link(ctx, pageFor(ctx, '/story')),
    link(ctx, pageFor(ctx, '/science')),
    link(ctx, pageFor(ctx, '/learn')),
    link(ctx, pageFor(ctx, '/learn/guide'), 'Learn: teacher guide'),
    link(ctx, pageFor(ctx, '/hunt')),
    '',
    '## Validation and credits',
    '',
    link(ctx, pageFor(ctx, '/validation'), 'Validation report'),
    link(ctx, pageFor(ctx, '/about'), 'About and data acknowledgements'),
    '',
    '## Developers',
    '',
    link(ctx, pageFor(ctx, '/developers'), 'Developers: API, embed and URL contract'),
    `- [OpenAPI description](${o}/api/v1/openapi.json): machine-readable description of the public API, version 1.`,
    '',
    '## Data sources',
    '',
    '- [NASA SPHEREx data, NASA/IPAC Infrared Science Archive (IRSA)](https://irsa.ipac.caltech.edu/): the source of every image Destello shows. Data Release 1 DOI: [10.26131/IRSA678](https://doi.org/10.26131/IRSA678).',
    `- [Acknowledgements](${o}/about): ${get(b, 'pages.ack.gaia.t')}, ${get(b, 'pages.ack.wise.t')}, ${get(b, 'pages.ack.cds.t')} and ${get(b, 'pages.ack.jpl.t')} are credited with the wording their providers ask for.`,
    '- [JPL Small-Body Identification API](https://ssd-api.jpl.nasa.gov/doc/sb_ident.html): used to check marked positions against known small bodies.',
    '',
    '## Optional',
    '',
    `- [Full text for assistants](${o}/llms-full.txt): purpose, method, targets, the validation record, limits and credits in one Markdown file.`,
    `- [Sitemap](${o}/sitemap.xml): every indexable page in English and Spanish.`,
  ];
  return `${lines.join('\n')}\n`;
}

function paragraphs(b: Bundles, prefix: string, keys: string[]): string[] {
  return keys.map((k) => get(b, `${prefix}.${k}`)).filter(Boolean);
}

/** The science page as Markdown: lead and sections 1 to 7 (the limits as a list). */
export function buildScienceMd(ctx: LlmsContext, level = 1): string {
  const b = ctx.bundles;
  const h = (n: number) => '#'.repeat(level + n);
  const out: string[] = [`${h(0)} ${get(b, 'sci.title')}`, '', get(b, 'sci.lead'), ''];
  for (const n of [1, 2, 3, 4, 5]) {
    out.push(
      `${h(1)} ${get(b, `sci.s${n}.t`)}`,
      '',
      ...paragraphs(b, `sci.s${n}`, ['p1', 'p2']).flatMap((p) => [p, '']),
    );
  }
  out.push(`${h(1)} ${get(b, 'sci.s6.t')}`, '', get(b, 'sci.s6.p1'), '');
  for (let n = 1; n <= 6; n += 1) out.push(`- ${get(b, `sci.s6.l${n}.t`)}: ${get(b, `sci.s6.l${n}.d`)}`);
  out.push('', `${h(1)} ${get(b, 'sci.s7.t')}`, '', get(b, 'sci.s7.p1'), '');
  return out.join('\n');
}

export function buildAboutMd(ctx: LlmsContext, level = 1): string {
  const b = ctx.bundles;
  const h = (n: number) => '#'.repeat(level + n);
  const out: string[] = [
    `${h(0)} ${get(b, 'pages.about')} Destello`,
    '',
    get(b, 'pages2.aboutP1'),
    '',
    get(b, 'pages2.aboutP2'),
    '',
    `${h(1)} ${get(b, 'pages2.challengeTitle')}`,
    '',
    get(b, 'pages2.challengeBody'),
    '',
    `${h(1)} ${get(b, 'pages2.nonEndorseTitle')}`,
    '',
    get(b, 'pages2.nonEndorse'),
    '',
    `${h(1)} ${get(b, 'pages.ackTitle')}`,
    '',
    get(b, 'pages.ackIntro'),
    '',
  ];
  for (const k of ['spherex', 'gaia', 'wise', 'cds', 'jpl', 'software']) {
    out.push(`- ${get(b, `pages.ack.${k}.t`)}: ${get(b, `pages.ack.${k}.d`)}`);
  }
  out.push('');
  return out.join('\n');
}

export function buildValidationMd(ctx: LlmsContext, level = 1): string {
  const b = ctx.bundles;
  const h = (n: number) => '#'.repeat(level + n);
  return [
    `${h(0)} ${get(b, 'val.title')}`,
    '',
    get(b, 'val.lead'),
    '',
    'The text below is the validation record kept in the repository (README.md). The page itself reads the latest run from the server.',
    '',
    ctx.validation.replace(/^(#+) /gm, (_m, hashes: string) => `${'#'.repeat(hashes.length + level)} `),
    '',
  ].join('\n');
}

export function buildMarkdownTwins(ctx: LlmsContext): Record<string, string> {
  return {
    'about.md': buildAboutMd(ctx),
    'science.md': buildScienceMd(ctx),
    'validation.md': buildValidationMd(ctx),
  };
}

export function buildLlmsFull(ctx: LlmsContext): string {
  const o = normalizeOrigin(ctx.origin);
  const b = ctx.bundles;
  const out: string[] = [
    '# Destello: full text',
    '',
    `> ${SUMMARY}`,
    '',
    `This file collects what an assistant needs to answer questions about Destello without running the app. The index is ${o}/llms.txt. Every page is also available in Spanish by adding \`?lang=es\` to its address. The text is taken from the site copy and from the validation record in the repository.`,
    '',
    '## Purpose',
    '',
    get(b, 'pages2.aboutP1'),
    '',
    get(b, 'pages2.aboutP2'),
    '',
    get(b, 'pages2.challengeBody'),
    '',
    get(b, 'pages2.nonEndorse'),
    '',
    '## How it works',
    '',
    buildScienceMd(ctx, 2).split('\n').slice(2).join('\n').trimEnd(),
    '',
    '## Targets (presets)',
    '',
    'Five presets open ready-made fields. The text below is the product copy for each; the measured values are shown in the app and in the validation record.',
    '',
  ];
  for (const id of ctx.routes.targetIds) {
    const p = `presetCopy.${id}`;
    out.push(
      `### ${get(b, `${p}.name`)}`,
      '',
      `- Page: ${o}/t/${id}`,
      `- What it is: ${get(b, `${p}.kind`)}`,
      `- Headline: ${get(b, `${p}.headline`)}`,
      `- What to look for: ${get(b, `${p}.look`)}`,
      `- Limit: ${get(b, `${p}.limit`)}`,
      '',
    );
  }
  out.push(
    `The interstellar comet 3I/ATLAS has its own page: ${o}/comet. ${get(b, 'seo.comet.description')}`,
    '',
    '## Validation record',
    '',
    'Destello measures the motion and variability of known objects in SPHEREx images and compares the results with published values. The record below is copied from README.md. Failed and not measurable tests are part of the record and are not rounded into a success claim.',
    '',
    ctx.validation.replace(/^(#+) /gm, (_m, hashes: string) => `${'#'.repeat(hashes.length + 2)} `),
    '',
    '## Data sources and acknowledgements',
    '',
    get(b, 'pages.ackIntro'),
    '',
  );
  for (const k of ['spherex', 'gaia', 'wise', 'cds', 'jpl', 'software']) {
    out.push(`- ${get(b, `pages.ack.${k}.t`)}: ${get(b, `pages.ack.${k}.d`)}`);
  }
  out.push(
    '',
    '## Pages and links',
    '',
    ...indexableEntries(ctx.routes).map((e) => {
      const page = pageFor(ctx, e.path);
      return `- ${page.title}: ${o}${e.path}`;
    }),
    '',
    'How to link: use the address of a page, with `?lang=es` for Spanish. How to cite: cite the original data providers listed above, not Destello; Destello is an independent project built for the NASA Space Apps Challenge 2026.',
    '',
  );
  return out.join('\n');
}
