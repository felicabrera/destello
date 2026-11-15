// Sequence orchestration: POST /sequences or a cached manifest, SSE progress, progressive epochs.
import { create } from 'zustand';
import { ApiError, API_BASE, createSequence, getManifest, getSequence, openEvents } from '../lib/api';
import type { Estimate, EpochInfo, Manifest, SeqEvent, TargetItem } from '../lib/types';
import { clearBitmaps } from '../lib/bitmaps';
import { mergeEpochs } from '../lib/progressive';

export type SeqSource =
  | { kind: 'preset'; target: TargetItem; fov: number; release?: string; partial?: true }
  | { kind: 'coords'; ra: number; dec: number; fov: number; release?: string; partial?: true }
  | { kind: 'seq'; id: string };

export function sourceKey(s: SeqSource): string {
  if (s.kind === 'seq') return `seq:${s.id}`;
  const partial = s.partial ? ':partial' : '';
  if (s.kind === 'preset') return `preset:${s.target.id}:${s.fov}:${s.release ?? ''}${partial}`;
  return `coords:${s.ra.toFixed(5)}:${s.dec.toFixed(5)}:${s.fov}:${s.release ?? ''}${partial}`;
}

export type StageName = 'query' | 'cutouts' | 'coadd' | 'render' | 'photometry';
export interface StageProgress {
  done: number;
  total: number;
}

export interface SeqError {
  code: string;
  status?: number;
  retryAfter?: number;
}

interface SeqState {
  key: string | null;
  source: SeqSource | null;
  phase: 'idle' | 'building' | 'ready' | 'error';
  sequenceId: string | null;
  epochs: EpochInfo[];
  /** Final manifest, or the partial one while a build runs (`manifest.build.status`). */
  manifest: Manifest | null;
  /** Detectors published so far, in publication order, and the ones still building. */
  detectorsReady: number[];
  detectorsPending: number[];
  status: 'queued' | 'running' | null;
  position: number | null;
  progress: Partial<Record<StageName, StageProgress>>;
  estimate: Estimate | null;
  error: SeqError | null;
  startedAt: number | null;
  /** The server holds newer SPHEREx data than this manifest and is rebuilding the sequence. */
  refreshing: boolean;
  /** `priorityDetector` is the detector on screen: a new build publishes it first. */
  start: (source: SeqSource, priorityDetector?: number) => void;
  retry: () => void;
  cancel: () => void;
}

/** Called when the server accepts a new build, even if its view was left before the answer arrived. */
let onAccepted: ((id: string, source: SeqSource, key: string) => void) | null = null;
export function setBuildAcceptedListener(fn: typeof onAccepted) {
  onAccepted = fn;
}

let generation = 0;
let dispose: (() => void) | null = null;

const blank = {
  key: null,
  source: null,
  phase: 'idle' as const,
  sequenceId: null,
  epochs: [] as EpochInfo[],
  manifest: null,
  detectorsReady: [] as number[],
  detectorsPending: [] as number[],
  status: null,
  position: null,
  progress: {},
  estimate: null,
  error: null,
  startedAt: null,
  refreshing: false,
};

function toError(e: unknown): SeqError {
  if (e instanceof ApiError) return { code: e.code, status: e.status, retryAfter: e.retryAfter };
  return { code: 'UNKNOWN' };
}

export const useSequence = create<SeqState>((set, get) => ({
  ...blank,
  cancel: () => {
    generation++;
    dispose?.();
    dispose = null;
    set({ ...blank });
  },
  retry: () => {
    const src = get().source;
    if (src) {
      set({ key: null });
      get().start(src);
    }
  },
  start: (source, priorityDetector) => {
    const key = sourceKey(source);
    if (get().key === key && get().phase !== 'error') return;
    generation++;
    const gen = generation;
    dispose?.();
    dispose = null;
    clearBitmaps();
    set({ ...blank, key, source, phase: 'building', startedAt: Date.now() });
    const live = () => gen === generation;

    const finish = async (manifestUrl: string, quiet = false): Promise<boolean> => {
      try {
        const manifest = await getManifest(manifestUrl);
        if (!live()) return true;
        if (manifest.epochs.length === 0) {
          set({ phase: 'error', error: { code: 'NO_COVERAGE' } });
          return true;
        }
        set({
          phase: 'ready',
          manifest,
          epochs: manifest.epochs,
          sequenceId: manifest.sequence_id,
          status: null,
          detectorsPending: [],
        });
        return true;
      } catch (e) {
        if (quiet) return false;
        if (live()) set({ phase: 'error', error: toError(e) });
        return true;
      }
    };

    // Partial manifest of a running build: every kept epoch, frames only for the published detectors.
    const seenDetectors = new Set<number>();
    const partial = async (detector: number, manifestUrl: string) => {
      try {
        const manifest = await getManifest(manifestUrl);
        if (!live() || get().phase !== 'building') return;
        const ready = manifest.build?.detectors_ready ?? [];
        const known = get().manifest?.build?.detectors_ready.length ?? 0;
        // Requests can resolve out of order: never go back to a manifest with fewer detectors.
        if (ready.length < known) return;
        set((s) => ({
          manifest,
          epochs: mergeEpochs(s.epochs, manifest.epochs),
          detectorsReady: ready.length >= s.detectorsReady.length ? ready : s.detectorsReady,
          detectorsPending: manifest.build?.detectors_pending ?? s.detectorsPending,
        }));
      } catch {
        // The next detector_ready, the polling fallback or `completed` brings the frames.
        seenDetectors.delete(detector);
      }
    };

    const follow = (id: string, eventsUrl: string, estimate?: Estimate) => {
      set({ sequenceId: id, estimate: estimate ?? null, status: 'queued' });
      dispose = openEvents(
        id,
        eventsUrl,
        (ev: SeqEvent) => {
          if (!live()) return;
          switch (ev.type) {
            case 'status':
              if (ev.data.status === 'failed') set({ phase: 'error', error: { code: 'UNKNOWN' } });
              else if (ev.data.status === 'ready') void 0;
              else set({ status: ev.data.status, position: ev.data.position ?? null });
              break;
            case 'progress':
              set((s) => ({
                status: 'running',
                progress: { ...s.progress, [ev.data.stage]: { done: ev.data.done, total: ev.data.total } },
              }));
              break;
            case 'epoch_ready': {
              const ep: EpochInfo = {
                index: ev.data.epoch,
                frames: ev.data.frames,
                t_start: ev.data.t_start,
                t_end: ev.data.t_end,
                t_mid_mjd: ev.data.t_mid_mjd,
                n_images: ev.data.n_images,
                ...(ev.data.coverage ? { coverage: ev.data.coverage } : {}),
              };
              set((s) => ({
                epochs: [...s.epochs.filter((x) => x.index !== ep.index), ep].sort(
                  (a, b) => a.index - b.index,
                ),
              }));
              break;
            }
            case 'detector_ready': {
              // Replayed to late streams and possibly delivered twice: one fetch per detector.
              const d = ev.data.detector;
              if (seenDetectors.has(d)) break;
              seenDetectors.add(d);
              const ready = ev.data.detectors_ready;
              const pendingDets = ev.data.detectors_pending;
              set((s) => ({
                status: 'running',
                detectorsReady: ready.length >= s.detectorsReady.length ? ready : s.detectorsReady,
                detectorsPending:
                  pendingDets && ready.length >= s.detectorsReady.length ? pendingDets : s.detectorsPending,
              }));
              void partial(d, ev.data.manifest_url);
              break;
            }
            case 'completed':
              void finish(ev.data.manifest_url);
              break;
            case 'failed':
              set({ phase: 'error', error: { code: ev.data.code, retryAfter: ev.data.retry_after_s } });
              break;
          }
        },
        (e) => {
          if (live()) set({ phase: 'error', error: toError(e) });
        },
      );
    };

    void (async () => {
      try {
        if (source.kind === 'seq') {
          if (await finish(`/manifests/${source.id}.json`, true)) return;
          const s = await getSequence(source.id);
          if (!live()) return;
          if (s.status === 'ready' && s.manifest_url) await finish(s.manifest_url);
          else follow(source.id, `${API_BASE}/sequences/${source.id}/events`);
          return;
        }
        if (source.kind === 'preset') {
          const t = source.target;
          const defFov = t.default_view?.fov_arcmin ?? 6;
          if (t.sequence_id && source.fov === defFov && !source.release && !source.partial) {
            try {
              const manifest = await getManifest(`/manifests/${t.sequence_id}.json`);
              if (!live()) return;
              set({ phase: 'ready', manifest, epochs: manifest.epochs, sequenceId: manifest.sequence_id });
              return;
            } catch {
              /* cache miss: build normally */
            }
          }
        }
        const priority =
          priorityDetector !== undefined && priorityDetector >= 1 && priorityDetector <= 6
            ? { priority_detector: priorityDetector }
            : {};
        // F-31: the flag is part of the sequence id, so it is sent only when the user asked for it.
        const lowCoverage = source.partial ? { include_partial: true } : {};
        const req =
          source.kind === 'preset'
            ? {
                ...priority,
                ...lowCoverage,
                ra_deg: source.target.ra_deg,
                dec_deg: source.target.dec_deg,
                fov_arcmin: source.fov,
                detectors: [1, 2, 3, 4, 5, 6],
                release: source.release ?? null,
                track: null,
              }
            : {
                ...priority,
                ...lowCoverage,
                ra_deg: source.ra,
                dec_deg: source.dec,
                fov_arcmin: source.fov,
                detectors: [1, 2, 3, 4, 5, 6],
                release: source.release ?? null,
                track: null,
              };
        const res = await createSequence(req);
        if (res.kind !== 'ready') onAccepted?.(res.sequence_id, source, key);
        if (!live()) return;
        if (res.kind === 'ready') {
          set({ sequenceId: res.sequence_id, refreshing: res.refreshing });
          await finish(res.manifest_url);
        } else follow(res.sequence_id, res.events_url, res.estimate);
      } catch (e) {
        if (live()) set({ phase: 'error', error: toError(e) });
      }
    })();
  },
}));
