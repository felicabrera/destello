// Pure helpers of the /developers page: the OpenAPI document and the fixed tables of docs/06.
import { DETECTORS, FOVS, FPS_VALUES, MODES, OVERLAYS, TABS } from '../../lib/types';

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  deprecated?: boolean;
}
export interface OpenApiDoc {
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation | unknown>>;
}
export interface Endpoint {
  method: string;
  path: string;
  summary: string;
  description: string;
  tag: string;
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** First sentence of an operation description, on one line. */
export function firstSentence(text: string | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  return (m?.[1] ?? flat).slice(0, 280);
}

/** Endpoints of an OpenAPI document, grouped by first tag in order of appearance. */
export function endpointsByTag(doc: OpenApiDoc): [string, Endpoint[]][] {
  const groups = new Map<string, Endpoint[]>();
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method] as OpenApiOperation | undefined;
      if (!op || typeof op !== 'object') continue;
      const tag = op.tags?.[0] ?? '';
      const list = groups.get(tag) ?? [];
      list.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        description: firstSentence(op.description),
        tag,
      });
      groups.set(tag, list);
    }
  }
  return [...groups.entries()];
}

export type LimitUnit = 'perMinute' | 'per10Minutes' | 'perHour';
/** docs/06 section 2; the API does not expose its limits. */
export const RATE_LIMITS: { id: string; n: number; unit: LimitUnit }[] = [
  { id: 'all', n: 120, unit: 'perMinute' },
  { id: 'build', n: 6, unit: 'per10Minutes' },
  { id: 'reports', n: 10, unit: 'perHour' },
  { id: 'checks', n: 30, unit: 'perHour' },
  { id: 'compute', n: 30, unit: 'perMinute' },
  { id: 'errors', n: 20, unit: 'perHour' },
];

/** docs/06 section 5; the values come from the same constants as the URL parser. */
export const URL_PARAMS: { id: string; names: string; values: string }[] = [
  { id: 'ra', names: 'ra, dec', values: 'decimal | sexagesimal' },
  { id: 'name', names: 'name', values: 'text' },
  { id: 'fov', names: 'fov', values: FOVS.join(', ') },
  { id: 'det', names: 'det', values: `${DETECTORS.join(', ')}, all` },
  { id: 'mode', names: 'mode', values: MODES.join(', ') },
  { id: 'ref', names: 'ref', values: '1, 2, ...' },
  { id: 'frame', names: 'frame', values: '1, 2, ...' },
  { id: 'rgb', names: 'rgb', values: '6,3,1' },
  { id: 'track', names: 'track', values: '1' },
  { id: 'fps', names: 'fps', values: FPS_VALUES.join(', ') },
  { id: 'play', names: 'play', values: '0, 1' },
  { id: 'ov', names: 'ov', values: OVERLAYS.join(', ') },
  { id: 'tab', names: 'tab', values: TABS.join(', ') },
  { id: 'release', names: 'release', values: 'spherex_qr3, ...' },
  { id: 'partial', names: 'partial', values: '1' },
  { id: 'lang', names: 'lang', values: 'en, es' },
  { id: 'seq', names: 'seq', values: '16 hex digits' },
];

export const URL_EXAMPLE = '/t/wise0855?det=6&mode=diff&ref=1&frame=3&ov=catwise&tab=measure&lang=es';

export function embedSnippet(origin: string, title: string): string {
  return `<iframe src="${origin}/embed?target=barnard&lang=en&play=0"\n        width="480" height="520" style="border:0" loading="lazy"\n        title="${title}"></iframe>`;
}
