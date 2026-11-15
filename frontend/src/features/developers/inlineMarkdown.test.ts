import { describe, expect, it } from 'vitest';
import { parseInline } from './inlineMarkdown';

describe('parseInline', () => {
  it('splits text, code and http links', () => {
    expect(parseInline('a `b` [c](https://x.org/y) d')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'code', text: 'b' },
      { kind: 'text', text: ' ' },
      { kind: 'link', text: 'c', href: 'https://x.org/y' },
      { kind: 'text', text: ' d' },
    ]);
  });
  it('leaves non-http links as plain text', () => {
    expect(parseInline('[x](javascript:alert(1))')).toEqual([
      { kind: 'text', text: '[x](javascript:alert(1))' },
    ]);
  });
});
