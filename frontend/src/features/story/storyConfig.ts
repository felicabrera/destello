// F-34 story mode: one config object per chapter. Embeds go through the existing URL contract (docs/06
// section 5 and 6): the chromeless /embed route for a player, the Explorer route for a panel state. Nothing here
// is a measurement: numbers shown beside an embed are read from the API at runtime (storyModel.ts).
import type { Lang } from '../../lib/types';
import { stringifySearch, type PresetId } from '../../lib/url-state';

export type Ch6Variant = 'variable' | 'comet';

/** A real view of the product, addressed only by URL parameters. */
export type EmbedSpec =
  | SimpleEmbed
  /**
   * The 16 years view (WiseTimeline) of a preset that has a WISE companion. It is rendered in the page, not in a
   * frame. Without a companion (demo and fixture modes, other presets) `fallback` is shown so the chapter is
   * never empty.
   */
  | { kind: 'wise'; target: PresetId; fallback: SimpleEmbed };

export type SimpleEmbed =
  /** Chromeless player: /embed?target=<preset>. */
  | { kind: 'player'; target: PresetId; params?: Record<string, string>; autoplay: boolean }
  /** A panel state of the Explorer: /t/<preset>?tab=<panel>. */
  | { kind: 'explorer'; target: PresetId; params: Record<string, string> }
  /** The moving-target page (F-33): /comet, the newest built campaign. */
  | { kind: 'comet' };

export type FactKey = 'ch4' | 'ch5';

export interface ChapterConfig {
  id: string;
  /** i18n base key under story:, for example "ch4". Chapter 6 resolves its variant below. */
  copy: string;
  embed?: EmbedSpec;
  /** Facts block read from the API (see storyModel.ts). */
  fact?: FactKey;
  /** The chapter ends with a link to the hunt. */
  huntLink?: boolean;
}

/**
 * Chapter 6 switches here. Set 'comet' and the embed below to the 3I/ATLAS preset when F-33
 * lands. Both copy variants live in i18n (story:ch6.variable.*, story:ch6.comet.*).
 */
export const CH6_VARIANT: Ch6Variant = 'comet';

const CH6_EMBEDS: Record<Ch6Variant, EmbedSpec | undefined> = {
  // R Draconis variability: Spectrum panel, one curve per epoch.
  variable: { kind: 'explorer', target: 'rdra', params: { tab: 'spectrum', play: '0' } },
  // 3I/ATLAS: the exposures that follow the comet and the measured spectrum. Copy carries no numbers.
  comet: { kind: 'comet' },
};

export function chapters(ch6: Ch6Variant = CH6_VARIANT): ChapterConfig[] {
  return [
    { id: 'pluto', copy: 'ch1' },
    { id: 'backyard', copy: 'ch2' },
    {
      id: 'colors',
      copy: 'ch3',
      // The Spectrum panel of an object with a strong spectral signature.
      embed: { kind: 'explorer', target: 'rdra', params: { tab: 'spectrum', play: '0' } },
    },
    {
      id: 'barnard',
      copy: 'ch4',
      // The 16 years view of the WISE 0855 field; the Barnard player when no companion exists.
      embed: {
        kind: 'wise',
        target: 'wise0855',
        fallback: { kind: 'player', target: 'barnard', autoplay: true },
      },
      fact: 'ch4',
    },
    {
      id: 'wise0855',
      copy: 'ch5',
      embed: { kind: 'player', target: 'wise0855', autoplay: true, params: { det: '6' } },
      fact: 'ch5',
    },
    { id: 'comet', copy: `ch6.${ch6}`, embed: CH6_EMBEDS[ch6] },
    { id: 'turn', copy: 'ch7', huntLink: true },
  ];
}

export const CHAPTER_COUNT = chapters().length;

/** Path and query of an embed. Autoplay is off whenever the visitor asks for reduced motion. */
export function embedPath(spec: EmbedSpec, lang: Lang, reduced: boolean): string {
  if (spec.kind === 'wise') return embedPath(spec.fallback, lang, reduced);
  if (spec.kind === 'comet') return `/comet${stringifySearch({ play: '0', lang })}`;
  if (spec.kind === 'player') {
    const q = stringifySearch({
      target: spec.target,
      controls: 'full',
      ...spec.params,
      play: spec.autoplay && !reduced ? '1' : '0',
      lang,
    });
    return `/embed${q}`;
  }
  return `/t/${spec.target}${stringifySearch({ ...spec.params, play: '0', lang })}`;
}

/** The same view in the full product, for the "open" link. */
export function openPath(spec: EmbedSpec, lang: Lang): string {
  if (spec.kind === 'wise') return `/t/${spec.target}${stringifySearch({ play: '0', lang })}`;
  if (spec.kind === 'comet') return `/comet${stringifySearch({ lang })}`;
  if (spec.kind === 'player')
    return `/t/${spec.target}${stringifySearch({ ...spec.params, play: '0', lang })}`;
  return embedPath(spec, lang, true);
}

export function clampChapter(i: number, count = CHAPTER_COUNT): number {
  return Math.min(Math.max(Math.trunc(i), 0), count - 1);
}

/** Documented keys: N next, P previous, 1 to 7 jump. Returns the target index or null. */
export function chapterForKey(key: string, current: number, count = CHAPTER_COUNT): number | null {
  if (key === 'n' || key === 'N') return clampChapter(current + 1, count);
  if (key === 'p' || key === 'P') return clampChapter(current - 1, count);
  if (/^[1-9]$/.test(key) && Number(key) <= count) return Number(key) - 1;
  return null;
}
