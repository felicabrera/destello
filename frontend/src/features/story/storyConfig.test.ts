import { describe, expect, it } from 'vitest';
import { CHAPTER_COUNT, chapterForKey, chapters, clampChapter, embedPath, openPath } from './storyConfig';
import { measuredFact, targetPm } from './storyModel';
import type { TargetItem, ValidationReport } from '../../lib/types';

describe('chapter config', () => {
  it('has seven chapters with unique ids', () => {
    const c = chapters();
    expect(c).toHaveLength(7);
    expect(CHAPTER_COUNT).toBe(7);
    expect(new Set(c.map((x) => x.id)).size).toBe(7);
  });

  it('chapters 1, 2 and 7 are text only; 7 links to the hunt', () => {
    const c = chapters();
    expect(c[0].embed).toBeUndefined();
    expect(c[1].embed).toBeUndefined();
    expect(c[6].embed).toBeUndefined();
    expect(c[6].huntLink).toBe(true);
  });

  it('chapter 6 switches variant in one place', () => {
    expect(chapters('variable')[5].copy).toBe('ch6.variable');
    expect(chapters('variable')[5].embed).toMatchObject({ kind: 'explorer', target: 'rdra' });
    expect(chapters('comet')[5].copy).toBe('ch6.comet');
    expect(chapters('comet')[5].embed).toEqual({ kind: 'comet' });
    expect(embedPath({ kind: 'comet' }, 'es', false)).toBe('/comet?play=0&lang=es');
  });
});

describe('embed paths', () => {
  const wise = chapters()[3].embed!;
  if (wise.kind !== 'wise') throw new Error('chapter 4 is the 16 years view');
  const player = wise.fallback;
  it('player embeds go through /embed with the preset as target', () => {
    const p = embedPath(player, 'es', false);
    expect(p).toMatch(/^\/embed\?/);
    expect(p).toContain('target=barnard');
    expect(p).toContain('lang=es');
    expect(p).toContain('play=1');
  });
  it('chapter 4 is the 16 years view of WISE 0855 with the Barnard player as fallback', () => {
    expect(wise).toMatchObject({ target: 'wise0855', fallback: { kind: 'player', target: 'barnard' } });
    expect(embedPath(wise, 'en', true)).toContain('target=barnard');
    expect(openPath(wise, 'es')).toBe('/t/wise0855?play=0&lang=es');
  });
  it('reduced motion turns autoplay off', () => {
    expect(embedPath(player, 'en', true)).toContain('play=0');
  });
  it('panel embeds open the spectrum tab without autoplay', () => {
    const p = embedPath(chapters()[2].embed!, 'en', false);
    expect(p).toMatch(/^\/t\/rdra\?/);
    expect(p).toContain('tab=spectrum');
    expect(p).toContain('play=0');
  });
  it('the open link leads to the Explorer for a player', () => {
    expect(openPath(player, 'en')).toMatch(/^\/t\/barnard\?/);
  });
});

describe('keyboard navigation', () => {
  it('maps N, P and digits and clamps at the ends', () => {
    expect(chapterForKey('n', 0)).toBe(1);
    expect(chapterForKey('N', 6)).toBe(6);
    expect(chapterForKey('p', 0)).toBe(0);
    expect(chapterForKey('p', 3)).toBe(2);
    expect(chapterForKey('5', 0)).toBe(4);
    expect(chapterForKey('8', 0)).toBeNull();
    expect(chapterForKey('0', 0)).toBeNull();
    expect(chapterForKey('x', 0)).toBeNull();
    expect(clampChapter(-3)).toBe(0);
    expect(clampChapter(99)).toBe(6);
  });
});

describe('facts come from the API shapes only', () => {
  const targets = [
    { id: 'barnard', astrometry: { pmra_masyr: 3000, pmdec_masyr: 4000 } },
    { id: 'wise0855', astrometry: {} },
  ] as unknown as TargetItem[];
  it('derives total proper motion in arcsec per year', () => {
    expect(targetPm(targets, 'barnard')?.arcsecPerYear).toBeCloseTo(5);
    expect(targetPm(targets, 'wise0855')).toBeNull();
    expect(targetPm(undefined, 'barnard')).toBeNull();
  });
  const report = (status: 'pass' | 'fail') =>
    ({
      tests: [
        {
          id: 'V-03',
          target: 'wise0855',
          status,
          measured: 1.5,
          err: 0.1,
          reference: 1.6,
          unit: 'arcsec/yr',
        },
      ],
    }) as unknown as ValidationReport;
  it('uses a validation row only when it passed', () => {
    expect(measuredFact(report('pass'), 'V-03', 'wise0855')?.measured).toBe(1.5);
    expect(measuredFact(report('fail'), 'V-03', 'wise0855')).toBeNull();
    expect(measuredFact(null, 'V-03', 'wise0855')).toBeNull();
  });
});
