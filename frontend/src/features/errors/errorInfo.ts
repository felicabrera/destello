import { RELEASE } from '../../lib/errorReport';

const CHUNK_PATTERN =
  /dynamically imported module|importing a module script failed|loading chunk|loading css chunk|failed to fetch module/i;

/** Whether the error is a failed lazy chunk download (typically after a deploy renames the chunks). */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? '');
  return CHUNK_PATTERN.test(text);
}

/** Short reference for support: UTC time and release tag. Never contains the error message. */
export function errorReference(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19)}Z ${RELEASE}`;
}

/** The raw message is only shown in development builds. */
export function devMessage(error: unknown): string | null {
  if (!import.meta.env.DEV) return null;
  return error instanceof Error ? error.message : String(error);
}

/** Truncate a requested path for display (text only, never HTML). */
export function truncatePath(path: string, max = 120): string {
  return path.length > max ? `${path.slice(0, max)}...` : path;
}
