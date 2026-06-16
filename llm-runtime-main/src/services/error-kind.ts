// NIB-M-ERROR-KIND — stub.

export type LLMErrorKind =
  | 'auth'
  | 'invalid_request'
  | 'rate_limit'
  | 'overloaded'
  | 'transient_provider'
  | 'provider_protocol'
  | 'response_parse'
  | 'timeout'
  | 'aborted'
  | 'silent_truncation'
  | 'content_filter';

export const ALL_LLM_ERROR_KINDS: readonly LLMErrorKind[] = [
  'auth',
  'invalid_request',
  'rate_limit',
  'overloaded',
  'transient_provider',
  'provider_protocol',
  'response_parse',
  'timeout',
  'aborted',
  'silent_truncation',
  'content_filter',
] as const;

// NIB-M-ERROR-KIND §3.2 — closed set of retriable-by-nature kinds.
const RETRIABLE_KINDS: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>([
  'rate_limit',
  'overloaded',
  'transient_provider',
  'timeout',
]);

export function isRetriableKind(kind: LLMErrorKind): boolean {
  return RETRIABLE_KINDS.has(kind);
}
