// Shared network error classification for execute-call and execute-embedding.
// Best-effort mapping of fetch-level errors to NetworkErrorKind.

import type { NetworkErrorKind } from '../errors/index.js';

export function classifyNetworkError(err: unknown): NetworkErrorKind | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const raw =
    typeof e.code === 'string'
      ? e.code
      : typeof e.cause?.code === 'string'
        ? e.cause.code
        : undefined;
  if (raw === undefined) return undefined;
  if (raw === 'dns' || raw === 'ENOTFOUND' || raw === 'EAI_AGAIN') return 'dns';
  if (raw === 'connection' || raw === 'ECONNREFUSED') return 'connection';
  if (raw === 'reset' || raw === 'ECONNRESET') return 'reset';
  return 'unknown';
}
