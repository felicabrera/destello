import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import routes from './seoRoutes.json';
import {
  buildLlmsFull,
  buildLlmsTxt,
  buildMarkdownTwins,
  extractReadmeValidation,
  stripRelativeLinks,
  type LlmsContext,
} from './llmsCore';
import type { Bundle, Bundles, RoutesFile } from './seoCore';

const NS = ['comet', 'developers', 'errors', 'hunt', 'learn', 'story', 'wise'];
const bundles: Bundles = { translation: en as Bundle };
for (const ns of NS) {
  bundles[ns] = JSON.parse(readFileSync(resolve(__dirname, `../i18n/en/${ns}.json`), 'utf-8')) as Bundles;
}
const readme = readFileSync(resolve(__dirname, '../../../README.md'), 'utf-8');
const ctx: LlmsContext = {
  origin: 'https://example.test',
  routes: routes as RoutesFile,
  bundles,
  validation: extractReadmeValidation(readme),
};

describe('llms.txt', () => {
  const txt = buildLlmsTxt(ctx);
  const lines = txt.split('\n');

  it('follows the specification order: H1, blockquote, notes, H2 link lists, Optional last', () => {
    expect(lines[0]).toBe('# Destello');
    expect(lines[1]).toBe('');
    expect(lines[2].startsWith('> ')).toBe(true);
    const h2 = lines.filter((l) => l.startsWith('## '));
    expect(h2.length).toBeGreaterThanOrEqual(4);
    expect(h2[h2.length - 1]).toBe('## Optional');
    expect(lines.filter((l) => l.startsWith('# '))).toHaveLength(1);
    // Notes between the blockquote and the first H2 hold no headings.
    const firstH2 = lines.findIndex((l) => l.startsWith('## '));
    expect(lines.slice(3, firstH2).some((l) => l.startsWith('#'))).toBe(false);
  });
  it('lists every entry as a Markdown link with an absolute URL and a note', () => {
    const items = lines.filter((l) => l.startsWith('- '));
    expect(items.length).toBeGreaterThan(15);
    for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\(https?:\/\/[^)\s]+\)(: .+)?$/);
  });
  it('covers the pages, the five presets, the API description and the sources', () => {
    for (const p of [
      '/t/barnard',
      '/t/wise0855',
      '/t/epsindib',
      '/t/rwaur',
      '/t/rdra',
      '/comet',
      '/story',
      '/hunt',
      '/learn',
      '/learn/guide',
      '/developers',
      '/api/v1/openapi.json',
    ]) {
      expect(txt).toContain(`https://example.test${p}`);
    }
    expect(txt).toContain('https://example.test/science.md');
    expect(txt).toContain('https://example.test/validation.md');
    expect(txt).toContain('?lang=es');
    expect(txt).toContain('irsa.ipac.caltech.edu');
  });
});

describe('llms-full.txt and Markdown twins', () => {
  const full = buildLlmsFull(ctx);
  it('is Markdown with the sections an assistant needs', () => {
    expect(full.startsWith('# Destello: full text\n')).toBe(true);
    for (const h of [
      '## Purpose',
      '## How it works',
      '## Targets (presets)',
      '## Validation record',
      '## Data sources and acknowledgements',
      '## Pages and links',
    ]) {
      expect(full).toContain(h);
    }
  });
  it('keeps the failed and not measurable rows of the validation record', () => {
    expect(full).toContain('fail');
    expect(full).toContain('not measurable');
    expect(full).toContain('not rounded into a success claim');
  });
  it('has no unresolved template variables or relative repository links', () => {
    expect(full).not.toMatch(/\{\{|\]\((?!https?:)/);
  });
  it('writes the three twins', () => {
    const twins = buildMarkdownTwins(ctx);
    expect(Object.keys(twins).sort()).toEqual(['about.md', 'science.md', 'validation.md']);
    for (const t of Object.values(twins)) expect(t.startsWith('# ')).toBe(true);
  });
  it('strips repository links only', () => {
    expect(stripRelativeLinks('[docs/11](docs/11.md) and [x](https://a.test)')).toBe(
      'docs/11 and [x](https://a.test)',
    );
  });
  it('uses no em dash', () => {
    const dash = String.fromCharCode(0x2014);
    expect(full.includes(dash) || buildLlmsTxt(ctx).includes(dash)).toBe(false);
  });
});
