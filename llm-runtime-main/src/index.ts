// @vegacorp/llm-runtime — public surface (NIB-T §26.1 C-GL-01).
// C-GL-02 lists internals NOT to re-export: executeCall, executeEmbedding,
// CanonicalHttpRequest, ParsedProviderResponse, ProviderErrorSignal,
// RateLimitSnapshot, ProviderBinding, EmbeddingBinding, ProviderQuirks, clock, ulid.

// ───────────────────────── Errors (taxonomy) ─────────────────────────
export {
  AbortedError,
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  LLMRuntimeError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from './errors/index.js';
// ───────────────────────── Factories ─────────────────────────
export { createAnthropicAdapter } from './factories/anthropic.js';
// ───────────────────────── Helpers ─────────────────────────
export { buildSimplePrompt } from './factories/build-simple-prompt.js';
export { createGoogleAdapter } from './factories/google.js';
export { createOpenAIAdapter } from './factories/openai.js';
export type { OpenAICompatibleAdapterConfig } from './factories/openai-compatible.js';
export { createOpenAICompatibleAdapter } from './factories/openai-compatible.js';
export { createOpenAIEmbeddingAdapter } from './factories/openai-embeddings.js';
export type { LLMErrorKind } from './services/error-kind.js';
// ───────────────────────── Error kinds ─────────────────────────
export { ALL_LLM_ERROR_KINDS, isRetriableKind } from './services/error-kind.js';
// ───────────────────────── Types ─────────────────────────
export type {
  AdapterConfig,
  AdapterStats,
  EmbeddingAdapter,
  EmbeddingAdapterConfig,
  IntegrityPolicy,
  LLMEvent,
  LLMIntegrityInfo,
  LLMLogger,
  LLMMessage,
  LLMRequest,
  LLMResponse,
  LLMRole,
  LLMSanitizationInfo,
  LLMUsage,
  LoggingPolicy,
  ProviderAdapter,
  ProviderLongId,
  RetryPolicy,
  SanitizationPolicy,
  TerminationReason,
  TimeoutPolicy,
} from './types.js';
