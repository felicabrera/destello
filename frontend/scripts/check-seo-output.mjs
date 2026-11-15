// Checks the files the SEO build writes. With a directory (default dist) it reads the files; with an http(s)
// URL it fetches them, which also checks the content types set by Caddy.
//   node scripts/check-seo-output.mjs dist
//   node scripts/check-seo-output.mjs http://localhost:18080
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const target = process.argv[2] ?? 'dist';
const remote = /^https?:\/\//.test(target);
const FILES = {
  '/robots.txt': { type: /^text\/plain/, has: ['User-agent: *', 'Disallow: /api/', 'Sitemap: '] },
  '/sitemap.xml': { type: /xml/, has: ['<urlset', 'hreflang="x-default"', '/t/barnard'] },
  '/llms.txt': { type: /^text\/plain/, has: ['# Destello', '\n> ', '## Optional'] },
  '/llms-full.txt': { type: /^text\/plain/, has: ['# Destello: full text', '## Validation record'] },
  '/about.md': { type: /^text\/markdown/, has: ['# '] },
  '/science.md': { type: /^text\/markdown/, has: ['# '] },
  '/validation.md': { type: /^text\/markdown/, has: ['# '] },
  '/story': { type: /^text\/html/, has: ['<title>From Pluto to Planet X | Destello</title>', 'rel="canonical"'] },
  '/t/barnard': { type: /^text\/html/, has: ["<title>Barnard's Star | Destello</title>", 'og:image'] },
};

let failed = 0;
for (const [p, rule] of Object.entries(FILES)) {
  let body;
  let type = '';
  let robots = '';
  try {
    if (remote) {
      const r = await fetch(new URL(p, target));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      body = await r.text();
      type = r.headers.get('content-type') ?? '';
      robots = r.headers.get('x-robots-tag') ?? '';
    } else {
      const file = p.includes('.') ? p.slice(1) : `${p.slice(1)}/index.html`;
      body = await readFile(path.join(target, file), 'utf-8');
      type = rule.type.source;
    }
  } catch (e) {
    console.log(`FAIL ${p}: ${e.message}`);
    failed += 1;
    continue;
  }
  const problems = [];
  if (remote && !rule.type.test(type)) problems.push(`content type ${type}`);
  if (remote && /noindex/i.test(robots)) problems.push(`X-Robots-Tag ${robots}`);
  for (const s of rule.has) if (!body.includes(s)) problems.push(`missing ${JSON.stringify(s)}`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${p}${remote ? `  ${type}` : ''}${problems.length ? `  ${problems.join('; ')}` : ''}`);
  if (problems.length) failed += 1;
}
process.exit(failed ? 1 : 0);
