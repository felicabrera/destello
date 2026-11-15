import { describe, expect, it } from 'vitest';
import { embedSnippet, endpointsByTag, firstSentence } from './developersModel';

describe('developersModel', () => {
  it('groups operations by first tag and keeps the order', () => {
    const g = endpointsByTag({
      paths: {
        '/a': { get: { tags: ['x'], summary: 'A', description: 'One. Two.' } },
        '/b': { post: { tags: ['y'], summary: 'B' }, get: { tags: ['x'], summary: 'B2' } },
        '/c': { parameters: [] },
      },
    });
    expect(g.map(([t]) => t)).toEqual(['x', 'y']);
    expect(g[0][1].map((e) => `${e.method} ${e.path}`)).toEqual(['GET /a', 'GET /b']);
    expect(g[0][1][0].description).toBe('One.');
  });
  it('cuts a description at the first sentence', () => {
    expect(firstSentence('Hello\n  world. More.')).toBe('Hello world.');
    expect(firstSentence(undefined)).toBe('');
  });
  it('builds the embed snippet', () => {
    expect(embedSnippet('https://h.test', 'T')).toContain('src="https://h.test/embed?');
  });
});
