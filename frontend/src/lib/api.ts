// Hand-written typed API client for docs/06. Base from VITE_API_BASE (default /api/v1).
// In development, when the backend does not answer, calls are served by src/dev-fixtures (excluded from production).
// In production, when the API is unreachable, the client switches to the static demo host (VITE_DEMO_BASE).
import type {
  AstrometryRequest,
  AstrometryResponse,
  CandidatesResult,
  CreateSequenceResult,
  DifferenceResult,
  Estimate,
  Health,
  Manifest,
  MotionSearchResult,
  MoverEphemerisCheck,
  MoverListing,
  MoverSpectrum,
  NeossatDoc,
  OverlayData,
  PathData,
  PhotometryDoc,
  Releases,
  ReportCheckRequest,
  ReportCheckResult,
  ReportCreated,
  ReportDocument,
  ReportRequest,
  Resolved,
  SeqEvent,
  SequenceRequest,
  SequenceStatus,
  SpectrumResponse,
  TargetItem,
  ValidationReport,
} from './types';
import type { WiseAstrometry, WiseManifest } from './wise';
import type { HuntCandidates, HuntCounters, HuntNext, HuntVoteRequest, HuntVoteResult } from './hunt';

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api/v1';
/** Static demo host (F-18). Defaults to the bundled /demo path; the probe checks that it answers. */
export const DEMO_BASE: string = ((import.meta.env.VITE_DEMO_BASE as string | undefined) || '/demo').replace(
  /\/$/,
  '',
);

export type BackendMode = 'unknown' | 'live' | 'fixture' | 'demo';
let currentMode: BackendMode = 'unknown';
export function setBackendMode(m: BackendMode): void {
  currentMode = m;
  demoWiseIndex = null;
}
export function getBackendMode(): BackendMode {
  return currentMode;
}

export class ApiError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, detail: string, retryAfter?: number) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface Problem {
  code?: string;
  detail?: string;
  title?: string;
  status?: number;
}

export interface FixtureReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

async function fixtureCall(method: string, path: string, body: unknown): Promise<FixtureReply> {
  if (import.meta.env.DEV) {
    const m = await import('../dev-fixtures');
    return m.handle(method, path, body);
  }
  throw new ApiError(0, 'NETWORK', 'fixtures unavailable');
}

export interface DemoTarget {
  url: string;
  /** A missing file is an expected state (not every sequence has it cached). */
  optional: boolean;
}

/**
 * Static layout on the demo host: /targets.json, /health.json, /releases.json, /validation.json, /movers.json,
 * /movers/{id}/{spectrum|ephemeris-check|neossat}.json, /overlays/{id}/{catalog}.json,
 * /difference/{id}/{a}-{b}-{det}.json, /candidates/{id}/{a}-{b}.json, /motion-search/{id}.json.
 * Manifests and frames keep their documented paths. Written by scripts/export_demo.py.
 */
export function demoTarget(method: string, path: string): DemoTarget | undefined {
  if (method !== 'GET') return undefined;
  const p = path.split('?')[0];
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  const fixed: Record<string, string> = {
    '/targets': 'targets.json',
    '/releases': 'releases.json',
    '/health': 'health.json',
    '/validation': 'validation.json',
    '/movers': 'movers.json',
  };
  if (fixed[p]) return { url: `${DEMO_BASE}/${fixed[p]}`, optional: false };
  // F-33: the NEOSSat panel treats a missing document as "none stored".
  const mv = /^\/movers\/([0-9a-f]{16})\/(spectrum|ephemeris-check|neossat)$/.exec(p);
  if (mv) return { url: `${DEMO_BASE}/movers/${mv[1]}/${mv[2]}.json`, optional: mv[2] === 'neossat' };
  const o = /^\/sequences\/([0-9a-f]{16})\/overlays\/(\w+)$/.exec(p);
  if (o) return { url: `${DEMO_BASE}/overlays/${o[1]}/${o[2]}.json`, optional: false };
  const d = /^\/sequences\/([0-9a-f]{16})\/difference$/.exec(p);
  if (d)
    return {
      url: `${DEMO_BASE}/difference/${d[1]}/${query.get('a')}-${query.get('b')}-${query.get('detector')}.json`,
      optional: false,
    };
  // F-29: candidate lists are cached for some pairs only; a missing one is an expected state, not a failure.
  const c = /^\/sequences\/([0-9a-f]{16})\/candidates$/.exec(p);
  if (c)
    return {
      url: `${DEMO_BASE}/candidates/${c[1]}/${query.get('a')}-${query.get('b')}.json`,
      optional: true,
    };
  // F-32: a motion search is cached only for some sequences.
  const m = /^\/sequences\/([0-9a-f]{16})\/motion-search$/.exec(p);
  if (m) return { url: `${DEMO_BASE}/motion-search/${m[1]}.json`, optional: true };
  return undefined;
}

/** F-40: bundle path of a companion document, or undefined when the path is not a companion route. */
export function demoWiseUrl(
  path: string,
): { sid: string; kind: 'manifest' | 'astrometry'; url: string } | undefined {
  const m = /^\/sequences\/([0-9a-f]{16})\/wise(\/astrometry)?$/.exec(path.split('?')[0]);
  if (!m) return undefined;
  return m[2]
    ? { sid: m[1], kind: 'astrometry', url: `${DEMO_BASE}/wise/${m[1]}.astrometry.json` }
    : { sid: m[1], kind: 'manifest', url: `${DEMO_BASE}/wise/${m[1]}.json` };
}

async function demoCall(method: string, path: string): Promise<FixtureReply> {
  const target = demoTarget(method, path);
  const url = target?.url;
  const optional = target?.optional ?? false;
  if (!url) throw new ApiError(404, 'NOT_FOUND', 'not available in demo mode');
  if (optional) {
    // The static host may answer a missing file with a 404 or with the application page (not JSON).
    try {
      const res = await fetch(url);
      if (res.ok) return { status: 200, body: await res.json() };
    } catch {
      /* treated as absent below */
    }
    throw new ApiError(404, 'DEMO_UNAVAILABLE', `not cached in the demo: ${url}`);
  }
  const res = await fetch(url);
  if (!res.ok) throw new ApiError(res.status, 'NOT_FOUND', `demo asset missing: ${url}`);
  return { status: 200, body: await res.json() };
}

async function http<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; data: T }> {
  if (currentMode === 'fixture') {
    const r = await fixtureCall(method, path, body);
    return unwrap<T>(r.status, r.body, r.headers, path);
  }
  if (currentMode === 'demo') {
    const r = await demoCall(method, path);
    return unwrap<T>(r.status, r.body, r.headers, path);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers:
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', 'network error');
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const headers: Record<string, string> = {};
  const ra = res.headers.get('Retry-After');
  if (ra) headers['retry-after'] = ra;
  return unwrap<T>(res.status, data, headers, path);
}

function unwrap<T>(
  status: number,
  data: unknown,
  headers: Record<string, string> | undefined,
  path: string,
): { status: number; data: T } {
  if (status >= 200 && status < 300) return { status, data: data as T };
  const p = (data ?? {}) as Problem;
  const retry = headers?.['retry-after'] ? Number(headers['retry-after']) : undefined;
  const code =
    p.code ??
    (status === 429 ? 'RATE_LIMITED' : status === 404 ? 'NOT_FOUND' : status >= 500 ? 'UNKNOWN' : 'UNKNOWN');
  throw new ApiError(status, code, p.detail ?? p.title ?? `HTTP ${status} on ${path}`, retry);
}

export function resolveAsset(url: string): string {
  if (/^(data:|blob:|https?:)/.test(url)) return url;
  if (currentMode === 'demo' && DEMO_BASE) return `${DEMO_BASE}${url}`;
  return url;
}

export async function getHealth(signal?: AbortSignal): Promise<Health> {
  return (await http<Health>('GET', '/health', undefined, signal)).data;
}
/** The OpenAPI document of the API (docs/06 section 1), as served at /api/v1/openapi.json. */
export async function getOpenApi<T>(): Promise<T> {
  return (await http<T>('GET', '/openapi.json')).data;
}
export async function getReleases(): Promise<Releases> {
  return (await http<Releases>('GET', '/releases')).data;
}
export async function getTargets(): Promise<TargetItem[]> {
  const { data } = await http<TargetItem[] | { targets: TargetItem[] }>('GET', '/targets');
  return Array.isArray(data) ? data : data.targets;
}
/** Client side limit for the name resolver: the upstream service can hang for minutes when it is unreachable. */
const RESOLVE_TIMEOUT_MS = 15000;
export async function resolveName(name: string): Promise<Resolved> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ApiError(504, 'RESOLVER_UNAVAILABLE', 'The name resolver did not answer in time.')),
      RESOLVE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      http<Resolved>('GET', `/resolve?name=${encodeURIComponent(name)}`).then((r) => r.data),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function createSequence(req: SequenceRequest): Promise<CreateSequenceResult> {
  const { status, data } = await http<{
    sequence_id: string;
    status: string;
    manifest_url?: string;
    refreshing?: boolean;
    events_url?: string;
    estimate?: Estimate;
  }>('POST', '/sequences', req);
  if (status === 200 && data.manifest_url)
    return {
      kind: 'ready',
      sequence_id: data.sequence_id,
      manifest_url: data.manifest_url,
      refreshing: data.refreshing === true,
    };
  return {
    kind: 'queued',
    sequence_id: data.sequence_id,
    events_url: data.events_url ?? `${API_BASE}/sequences/${data.sequence_id}/events`,
    estimate: data.estimate,
  };
}
export async function getSequence(id: string): Promise<SequenceStatus> {
  return (await http<SequenceStatus>('GET', `/sequences/${id}`)).data;
}
/** ASSUMED endpoint, not in docs/06: GET /sequences/estimate. Returns null when the backend lacks it. */
export async function getEstimate(req: {
  ra_deg: number;
  dec_deg: number;
  fov_arcmin: number;
  release?: string | null;
  /** F-31: count the short revisits too. */
  include_partial?: boolean;
}): Promise<Estimate | null> {
  const q = new URLSearchParams({
    ra_deg: String(req.ra_deg),
    dec_deg: String(req.dec_deg),
    fov_arcmin: String(req.fov_arcmin),
  });
  if (req.release) q.set('release', req.release);
  if (req.include_partial) q.set('include_partial', 'true');
  try {
    return (await http<Estimate>('GET', `/sequences/estimate?${q}`)).data;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 0)) return null;
    throw e;
  }
}
/** F-26: the photometry sidecar named by the manifest (same origin, or the demo base in demo mode). */
export async function getPhotometry(url: string, signal?: AbortSignal): Promise<PhotometryDoc> {
  let res: Response;
  try {
    res = await fetch(resolveAsset(url), { signal });
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error');
  }
  if (!res.ok)
    throw new ApiError(
      res.status,
      res.status === 404 ? 'NOT_FOUND' : 'UNKNOWN',
      `HTTP ${res.status} on ${url}`,
    );
  return (await res.json()) as PhotometryDoc;
}
export async function getManifest(url: string): Promise<Manifest> {
  const target = resolveAsset(url);
  if (currentMode === 'fixture') {
    const r = await fixtureCall('GET', url, undefined);
    return unwrap<Manifest>(r.status, r.body, r.headers, url).data;
  }
  let res: Response;
  try {
    res = await fetch(target);
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error');
  }
  if (!res.ok)
    throw new ApiError(res.status, res.status === 404 ? 'NOT_FOUND' : 'UNKNOWN', `manifest ${res.status}`);
  return (await res.json()) as Manifest;
}
export async function getDifference(
  id: string,
  a: number,
  b: number,
  detector: number,
): Promise<DifferenceResult> {
  // a and b are 0-based manifest epoch indices.
  return (
    await http<DifferenceResult>('GET', `/sequences/${id}/difference?a=${a}&b=${b}&detector=${detector}`)
  ).data;
}
export async function getOverlay(id: string, catalog: 'gaia_dr3' | 'catwise2020'): Promise<OverlayData> {
  return (await http<OverlayData>('GET', `/sequences/${id}/overlays/${catalog}`)).data;
}

/** F-29: places where epochs a and b differ (0-based manifest epoch indices, D = A - scaled B). */
export async function getCandidates(
  id: string,
  a: number,
  b: number,
  signal?: AbortSignal,
): Promise<CandidatesResult> {
  return (await http<CandidatesResult>('GET', `/sequences/${id}/candidates?a=${a}&b=${b}`, undefined, signal))
    .data;
}

/** F-32: sources that move consistently over the full coverage epochs of a sequence (candidates to review). */
export async function getMotionSearch(id: string, signal?: AbortSignal): Promise<MotionSearchResult> {
  return (await http<MotionSearchResult>('GET', `/sequences/${id}/motion-search`, undefined, signal)).data;
}

/** F-27: predicted path of a source with catalog motion over the sequence span. */
export async function getPath(
  id: string,
  p: {
    ra_deg: number;
    dec_deg: number;
    pmra_masyr: number;
    pmdec_masyr: number;
    parallax_mas: number | null;
    ref_epoch: string;
  },
): Promise<PathData> {
  const q = new URLSearchParams({
    ra_deg: String(p.ra_deg),
    dec_deg: String(p.dec_deg),
    pmra_masyr: String(p.pmra_masyr),
    pmdec_masyr: String(p.pmdec_masyr),
    ref_epoch: p.ref_epoch,
  });
  if (p.parallax_mas != null && p.parallax_mas > 0) q.set('parallax_mas', String(p.parallax_mas));
  return (await http<PathData>('GET', `/sequences/${id}/path?${q}`)).data;
}

export async function getSpectrum(
  id: string,
  p: {
    ra_deg: number;
    dec_deg: number;
    pmra_masyr?: number | null;
    pmdec_masyr?: number | null;
    ref_epoch?: string | null;
  },
  signal?: AbortSignal,
): Promise<SpectrumResponse> {
  const q = new URLSearchParams({ ra_deg: String(p.ra_deg), dec_deg: String(p.dec_deg) });
  if (p.pmra_masyr != null) q.set('pmra_masyr', String(p.pmra_masyr));
  if (p.pmdec_masyr != null) q.set('pmdec_masyr', String(p.pmdec_masyr));
  if (p.ref_epoch) q.set('ref_epoch', p.ref_epoch);
  return (await http<SpectrumResponse>('GET', `/sequences/${id}/spectrum?${q}`, undefined, signal)).data;
}
export async function postAstrometry(
  id: string,
  req: AstrometryRequest,
  signal?: AbortSignal,
): Promise<AstrometryResponse> {
  return (await http<AstrometryResponse>('POST', `/sequences/${id}/astrometry`, req, signal)).data;
}
/** ASSUMED endpoint: GET /validation serves validation.json. A 404 means no validation run is published. */
/** F-33: built moving-target sequences (campaigns grouped under their designation). */
export async function getMovers(): Promise<MoverListing[]> {
  return (await http<MoverListing[]>('GET', '/movers')).data;
}
export async function getMoverSpectrum(id: string): Promise<MoverSpectrum> {
  return (await http<MoverSpectrum>('GET', `/movers/${id}/spectrum`)).data;
}
export async function getMoverEphemerisCheck(id: string): Promise<MoverEphemerisCheck> {
  return (await http<MoverEphemerisCheck>('GET', `/movers/${id}/ephemeris-check`)).data;
}
/** F-33: nearest NEOSSat frame per SPHEREx exposure (a different telescope; never SPHEREx data). */
export async function getMoverNeossat(id: string): Promise<NeossatDoc> {
  return (await http<NeossatDoc>('GET', `/movers/${id}/neossat`)).data;
}
export async function getValidation(): Promise<ValidationReport | null> {
  try {
    return (await http<ValidationReport>('GET', '/validation')).data;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 0)) return null;
    throw e;
  }
}

export type EventHandler = (e: SeqEvent) => void;

/** Open the SSE stream. Returns a disposer. Falls back to polling GET /sequences/{id} if the stream fails. */
export function openEvents(
  id: string,
  eventsUrl: string,
  onEvent: EventHandler,
  onFatal: (e: ApiError) => void,
): () => void {
  let closed = false;
  let es: EventSource | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let disposeFixture: (() => void) | null = null;
  const dispose = () => {
    closed = true;
    es?.close();
    if (poll) clearInterval(poll);
    disposeFixture?.();
  };

  if (currentMode === 'fixture' && import.meta.env.DEV) {
    void import('../dev-fixtures').then((m) => {
      if (closed) return;
      disposeFixture = m.openFixtureEvents(id, onEvent);
    });
    return dispose;
  }

  // Detectors already reported by the polling fallback (the stream may have reported others before failing;
  // the consumer deduplicates by detector).
  const polled = new Set<number>();
  const startPolling = () => {
    if (poll || closed) return;
    poll = setInterval(() => {
      void getSequence(id)
        .then((s) => {
          if (closed) return;
          if (s.status !== 'ready' && s.partial_manifest_url && s.detectors_ready) {
            for (const d of s.detectors_ready) {
              if (polled.has(d)) continue;
              polled.add(d);
              onEvent({
                type: 'detector_ready',
                data: {
                  detector: d,
                  manifest_url: s.partial_manifest_url,
                  detectors_ready: s.detectors_ready,
                },
              });
            }
          }
          if (s.status === 'ready' && s.manifest_url) {
            onEvent({ type: 'completed', data: { manifest_url: s.manifest_url } });
            dispose();
          } else if (s.status === 'failed') {
            onEvent({ type: 'failed', data: { code: 'UNKNOWN' } });
            dispose();
          }
        })
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) {
            onFatal(e);
            dispose();
          }
        });
    }, 3000);
  };

  try {
    es = new EventSource(eventsUrl);
  } catch {
    startPolling();
    return dispose;
  }
  const names = ['status', 'progress', 'detector_ready', 'epoch_ready', 'completed', 'failed'] as const;
  for (const n of names) {
    es.addEventListener(n, (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent<string>).data) as never;
        onEvent({ type: n, data } as SeqEvent);
        if (n === 'completed' || n === 'failed') dispose();
      } catch {
        /* ignore malformed event */
      }
    });
  }
  es.onerror = () => {
    if (closed) return;
    es?.close();
    startPolling();
  };
  return dispose;
}

// ------------------------------------------------------------------ F-22 candidate reports
/** Runs the automated checks for a set of marks without storing anything. */
export async function postReportCheck(
  req: ReportCheckRequest,
  signal?: AbortSignal,
): Promise<ReportCheckResult> {
  return (await http<ReportCheckResult>('POST', '/reports/check', req, signal)).data;
}
export async function postReport(req: ReportRequest): Promise<ReportCreated> {
  return (await http<ReportCreated>('POST', '/reports', req)).data;
}
export async function getReport(id: string): Promise<ReportDocument> {
  return (await http<ReportDocument>('GET', `/reports/${encodeURIComponent(id)}`)).data;
}
/** Download links of a stored report (served by the API, attachment disposition). */
export function reportFileUrl(id: string, ext: 'json' | 'txt'): string {
  return `${API_BASE}/reports/${encodeURIComponent(id)}.${ext}`;
}

// ------------------------------------------------------------------ F-35 Hunt
export async function postHuntNext(session: string): Promise<HuntNext> {
  return (await http<HuntNext>('POST', '/hunt/next', { session })).data;
}
export async function postHuntVote(req: HuntVoteRequest): Promise<HuntVoteResult> {
  return (await http<HuntVoteResult>('POST', '/hunt/votes', req)).data;
}
export async function getHuntCounters(signal?: AbortSignal): Promise<HuntCounters> {
  return (await http<HuntCounters>('GET', '/hunt/counters', undefined, signal)).data;
}
export async function getHuntCandidates(signal?: AbortSignal): Promise<HuntCandidates> {
  return (await http<HuntCandidates>('GET', '/hunt/candidates', undefined, signal)).data;
}

let demoWiseIndex: Promise<Record<string, { manifest?: boolean; astrometry?: boolean }>> | null = null;
/** The exporter writes wise/index.json listing the sequences that have a companion, so no 404 is probed. */
function loadDemoWiseIndex() {
  demoWiseIndex ??= fetch(`${DEMO_BASE}/wise/index.json`, { headers: { Accept: 'application/json' } })
    .then(async (r) => {
      if (!r.ok) return {};
      const doc = (await r.json()) as {
        sequences?: Record<string, { manifest?: boolean; astrometry?: boolean }>;
      };
      return doc.sequences ?? {};
    })
    .catch(() => ({}));
  return demoWiseIndex;
}

/**
 * F-40 companion documents. The API answers 204 when a sequence has no companion, so the console stays clean.
 * Demo mode reads the bundle, guided by wise/index.json (absent for bundles built before F-40). Fixture mode carries no WISE data: it asks only when a spec sets `__DESTELLO_WISE__`.
 */
async function wiseGet<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  if (currentMode === 'demo') {
    const t = demoWiseUrl(path);
    if (!t) return null;
    const entry = (await loadDemoWiseIndex())[t.sid];
    if (!entry || !entry[t.kind]) return null;
    try {
      const res = await fetch(t.url, { signal, headers: { Accept: 'application/json' } });
      return res.ok ? ((await res.json()) as T) : null;
    } catch {
      return null;
    }
  }
  // Fixture mode has no companion unless a spec says that it answers these routes.
  if (currentMode === 'fixture' && !(window as { __DESTELLO_WISE__?: boolean }).__DESTELLO_WISE__)
    return null;
  const res = await fetch(`${API_BASE}${path}`, { signal, headers: { Accept: 'application/json' } });
  // 204: the sequence has no companion (the normal case).
  if (res.status !== 200) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** WISE/NEOWISE companion manifest of a SPHEREx sequence, or null when none exists. */
export function getWiseManifest(sid: string, signal?: AbortSignal): Promise<WiseManifest | null> {
  return wiseGet<WiseManifest>(`/sequences/${sid}/wise`, signal);
}
/** Stored long-baseline astrometry of the companion, or null when none is stored. */
export function getWiseAstrometry(sid: string, signal?: AbortSignal): Promise<WiseAstrometry | null> {
  return wiseGet<WiseAstrometry>(`/sequences/${sid}/wise/astrometry`, signal);
}
