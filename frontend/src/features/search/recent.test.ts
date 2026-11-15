import { describe, expect, it } from 'vitest';
import { recentSearchList, rememberSearch } from './SearchBox';

describe('recent searches (session memory only)', () => {
  it('keeps the newest first, deduplicates and caps at five', () => {
    rememberSearch({ label: 'Barnard', preset: 'barnard' });
    for (let i = 0; i < 6; i++) rememberSearch({ label: `p${i}`, path: `/?name=p${i}` });
    rememberSearch({ label: 'p3 again', path: '/?name=p3' });
    const list = recentSearchList();
    expect(list).toHaveLength(5);
    expect(list[0]).toEqual({ label: 'p3 again', path: '/?name=p3' });
    expect(list.filter((r) => r.path === '/?name=p3')).toHaveLength(1);
    expect(list.some((r) => r.preset === 'barnard')).toBe(false);
  });
});
