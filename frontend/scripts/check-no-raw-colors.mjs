// Fails when a raw hex color or rgb()/hsl() literal appears in components or features.
// Allowed: src/styles/tokens.css (source of truth) and src/dev-fixtures (labeled synthetic data).
// A line containing "allow-raw-color" is skipped on purpose.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, sep } from 'node:path';

const roots = ['src'];
const skip = ['src/styles/tokens.css', 'src/dev-fixtures'];
const exts = new Set(['.ts', '.tsx', '.css']);
const hex = /#[0-9a-fA-F]{3,8}\b/;
const fn = /\b(?:rgba?|hsla?)\(/;
let bad = 0;

function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f).split(sep).join('/');
    if (skip.some((s) => p.startsWith(s))) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (exts.has(extname(p))) check(p);
  }
}

function check(p) {
  if (p.endsWith('.test.ts') || p.endsWith('.test.tsx')) return;
  readFileSync(p, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes('allow-raw-color')) return;
      if (hex.test(line) || fn.test(line)) {
        console.error(`${p}:${i + 1}: raw color literal: ${line.trim()}`);
        bad++;
      }
    });
}

roots.forEach(walk);
if (bad) {
  console.error(`\n${bad} raw color literal(s) found. Use tokens from src/styles/tokens.css.`);
  process.exit(1);
}
console.log('check-no-raw-colors: ok');
