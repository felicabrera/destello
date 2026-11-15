// Static preset metadata: ids, glyphs, HUD label offsets (design, final) and aliases for local name matching.
// No coordinates, proper motions, epochs or measured values live here: those come from the API (GET /targets).
import type { DetectorSel, Lang, TargetItem } from './types';
import { PRESET_IDS, type PresetId } from './url-state';

export type Glyph = 'barnard' | 'wise' | 'eps' | 'rwaur' | 'rdra';

export interface PresetStatic {
  id: PresetId;
  glyph: Glyph;
  /** HUD label offset from the target ring centre, frame px (design, final). */
  label: { dx: number; dy: number };
  /** Design default detector, used only when the API does not state one. */
  det: DetectorSel;
  /** Whether the target is expected to move (draws the motion track and ghosts). */
  mover: boolean;
  aliases: string[];
}

export const PRESETS: PresetStatic[] = [
  {
    id: 'barnard',
    glyph: 'barnard',
    label: { dx: 7, dy: -1 },
    det: 'all',
    mover: true,
    aliases: [
      "barnard's star",
      'barnards star',
      'barnard',
      'estrella de barnard',
      'gj 699',
      'gliese 699',
      'bd+04 3561a',
      'v2500 oph',
    ],
  },
  {
    id: 'wise0855',
    glyph: 'wise',
    label: { dx: -9, dy: 7 },
    det: 6,
    mover: true,
    aliases: [
      'wise 0855',
      'wise 0855-0714',
      'wise0855',
      'wise j085510.83-071442.5',
      'wise j0855-0714',
      'w0855',
    ],
  },
  {
    id: 'epsindib',
    glyph: 'eps',
    label: { dx: 6, dy: -6 },
    det: 'all',
    mover: true,
    aliases: [
      'eps indi b',
      'epsilon indi b',
      'epsilon indi ba',
      'epsilon indi bb',
      'eps ind b',
      'eps indi ba',
      'epsilon indi',
      'eps indi',
      'indi b',
    ],
  },
  {
    id: 'rwaur',
    glyph: 'rwaur',
    label: { dx: 7, dy: -1 },
    det: 3,
    mover: false,
    aliases: ['rw aur', 'rw aurigae', 'rwaur', 'rw auriga'],
  },
  {
    id: 'rdra',
    glyph: 'rdra',
    label: { dx: 7, dy: -1 },
    det: 'all',
    mover: false,
    aliases: ['r dra', 'r draconis', 'rdra', 'r draco'],
  },
];

export function presetStatic(id: string): PresetStatic | undefined {
  return PRESETS.find((p) => p.id === id);
}

export function isPresetId(id: string | undefined): id is PresetId {
  return !!id && (PRESET_IDS as readonly string[]).includes(id);
}

/** Lowercase, strip accents and punctuation (keeping digits, letters, + and -), collapse spaces. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[^a-z0-9+\-'.\s]/g, ' ')
    .replace(/'s\b/g, 's')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface NameMatch {
  id: PresetId;
  exact: boolean;
}

/** Match typed text against localized preset names (from the API when available) and aliases. */
export function matchPresets(
  query: string,
  targets: TargetItem[] | undefined,
  localizedNames: Partial<Record<string, Record<Lang, string>>> = {},
): NameMatch[] {
  const q = normalizeName(query);
  if (q.length < 2) return [];
  const out: NameMatch[] = [];
  for (const p of PRESETS) {
    const names = new Set<string>(p.aliases.map(normalizeName));
    const t = targets?.find((x) => x.id === p.id);
    if (t) {
      names.add(normalizeName(t.names.en));
      names.add(normalizeName(t.names.es));
    }
    const l = localizedNames[p.id];
    if (l) {
      names.add(normalizeName(l.en));
      names.add(normalizeName(l.es));
    }
    const all = [...names];
    if (all.includes(q)) out.push({ id: p.id, exact: true });
    else if (all.some((n) => n.startsWith(q) || (q.length >= 4 && n.includes(q))))
      out.push({ id: p.id, exact: false });
  }
  return out.sort((a, b) => Number(b.exact) - Number(a.exact));
}
