// Renders the inline Markdown of docs/17 cells: [text](url) links (http and https only) and `code`.
// Built from React nodes, never from HTML strings.
import type { ReactNode } from 'react';

export type Piece = { kind: 'text' | 'code'; text: string } | { kind: 'link'; text: string; href: string };

const TOKEN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`/g;

export function parseInline(src: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', text: src.slice(last, at) });
    if (m[1] !== undefined && m[2] !== undefined) out.push({ kind: 'link', text: m[1], href: m[2] });
    else out.push({ kind: 'code', text: m[3] ?? '' });
    last = at + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
}

export function Inline({ text }: { text: string }): ReactNode {
  return parseInline(text).map((p, i) =>
    p.kind === 'link' ? (
      <a
        key={i}
        href={p.href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all text-cyan underline underline-offset-2"
      >
        {p.text}
      </a>
    ) : p.kind === 'code' ? (
      <code key={i} className="break-all rounded-xs bg-surface-2 px-1 font-mono text-caption-12">
        {p.text}
      </code>
    ) : (
      <span key={i}>{p.text}</span>
    ),
  );
}
