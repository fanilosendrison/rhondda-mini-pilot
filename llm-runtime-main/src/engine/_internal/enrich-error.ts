// Shared error enrichment for execute-call and execute-embedding.
// Reconstructs an LLMRuntimeError with engine-known context (callId, provider,
// model, attempts) overwriting binding-provided fields.

import type { LLMRuntimeError } from '../../errors/index.js';
import type { ProviderLongId } from '../../types.js';

export interface EnrichErrorContext {
  readonly callId: string;
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly attempts: number;
}

// Superset of all subclass-specific fields across the error taxonomy.
const PRESERVED_FIELDS = [
  'retryAfterMs',
  'status',
  'networkErrorKind',
  'timeoutMs',
  'truncationMode',
  'reason',
] as const;

export function enrichError(err: LLMRuntimeError, ctx: EnrichErrorContext): LLMRuntimeError {
  const Ctor = err.constructor as new (init: Record<string, unknown>) => LLMRuntimeError;
  const init: Record<string, unknown> = {
    message: err.message,
    callId: ctx.callId,
    provider: ctx.provider,
    model: ctx.model,
    attempts: ctx.attempts,
  };
  if (err.cause !== undefined) init['cause'] = err.cause;
  for (const key of PRESERVED_FIELDS) {
    const v = (err as unknown as Record<string, unknown>)[key];
    if (v !== undefined) init[key] = v;
  }
  return new Ctor(init);
}
