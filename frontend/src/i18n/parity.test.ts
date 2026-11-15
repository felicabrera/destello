import { describe, expect, it } from 'vitest';
import en from './en.json';
import es from './es.json';

// Feature namespaces: every i18n/<lang>/<name>.json is a namespace checked like the default one.
const toMap = (files: Record<string, { default: unknown }>) =>
  new Map(Object.entries(files).map(([p, m]) => [/\/([^/]+)\.json$/.exec(p)?.[1] ?? p, m.default]));
const enNs = toMap(import.meta.glob('./en/*.json', { eager: true }));
const esNs = toMap(import.meta.glob('./es/*.json', { eager: true }));

const SUFFIX = /_(zero|one|two|few|many|other)$/;

function leaves(obj: unknown, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => leaves(v, `${prefix}[${i}]`, out));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, String(obj));
  }
  return out;
}
const norm = (keys: Iterable<string>) => new Set([...keys].map((k) => k.replace(SUFFIX, '')));
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

const pairs: [string, unknown, unknown][] = [
  ['translation', en, es],
  ...[...enNs.keys()].map((n): [string, unknown, unknown] => [n, enNs.get(n), esNs.get(n)]),
];

describe('i18n namespaces', () => {
  it('has the same namespace files in both languages', () => {
    expect([...enNs.keys()].sort()).toEqual([...esNs.keys()].sort());
  });
});

describe.each(pairs)('i18n parity (EN/ES), namespace %s', (_ns, enDoc, esDoc) => {
  const a = leaves(enDoc);
  const b = leaves(esDoc);
  it('has the same keys in both languages (plural suffixes normalized)', () => {
    const ka = norm(a.keys());
    const kb = norm(b.keys());
    expect([...ka].filter((k) => !kb.has(k))).toEqual([]);
    expect([...kb].filter((k) => !ka.has(k))).toEqual([]);
  });
  it('has no empty strings', () => {
    for (const [k, v] of [...a, ...b]) expect(v.trim(), k).not.toBe('');
  });
  it('uses the same interpolation variables per key', () => {
    for (const [k, v] of a) {
      const other = b.get(k);
      if (other !== undefined) expect(vars(other), k).toEqual(vars(v));
    }
  });
  it('excludes prototype-only strings', () => {
    expect(JSON.stringify(enDoc)).not.toContain('protoOnly');
    expect(JSON.stringify(esDoc)).not.toContain('protoOnly');
  });
  it('avoids dash separators and typographic quotes in copy', () => {
    const banned = /[–—“”‘’]/;
    for (const [k, v] of [...a, ...b]) expect(banned.test(v), k).toBe(false);
  });
});
