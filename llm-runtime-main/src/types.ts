// Public types for @vegacorp/llm-runtime (shapes inferred from NIB-T-LLMRUNTIME).
// Stubs only — no logic. GREEN will refine against NIB-S §5/§6.

// ───────────────────────── Roles & Messages ─────────────────────────

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
}

// ───────────────────────── Providers ─────────────────────────

export type ProviderLongId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'deepseek'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'ollama';

export const ALL_PROVIDER_LONG_IDS: readonly ProviderLongId[] = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'mistral',
  'groq',
  'together',
  'ollama',
] as const;

// ───────────────────────── Termination ─────────────────────────

export type TerminationReason =
  | 'completed'
  | 'max_tokens'
  | 'stop_sequence'
  | 'content_filter'
  | 'unknown';

// ───────────────────────── Usage / Integrity / Sanitization ─────────────────────────

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface LLMSanitizationInfo {
  readonly thinkingTagsRemoved: boolean;
  readonly jsonFenceRemoved: boolean;
}

export type TruncationMode =
  | 'heuristic_json_unclosed'
  | 'explicit_max_tokens'
  | 'silent_prompt_truncation';

export interface LLMIntegrityInfo {
  readonly truncationDetected: boolean;
  readonly truncationMode?: TruncationMode;
}

// ───────────────────────── Request ─────────────────────────

export interface LLMRequest {
  readonly messages: readonly LLMMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: readonly string[];
}

// ───────────────────────── Response ─────────────────────────

export interface LLMResponse {
  readonly callId: string;
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly providerModel?: string;
  readonly providerResponseId?: string;
  readonly content: string;
  readonly rawContent: string;
  readonly termination: TerminationReason;
  readonly attemptCount: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly usage: LLMUsage;
  readonly sanitization: LLMSanitizationInfo;
  readonly integrity: LLMIntegrityInfo;
}

// ───────────────────────── Policies ─────────────────────────

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly maxBackoffMs: number;
}

export interface TimeoutPolicy {
  readonly perAttemptMs: number;
}

export interface SanitizationPolicy {
  readonly stripThinkingTags?: boolean;
  readonly stripJsonFence?: boolean;
}

export interface IntegrityPolicy {
  readonly detectHeuristicTruncation?: boolean;
  readonly failOnSilentTruncation?: boolean;
  readonly failOnUnknownTermination?: boolean;
  readonly failOnModelMismatch?: boolean;
  readonly modelMismatchPredicate?: (requestModel: string, responseModel: string) => boolean;
}

export interface LoggingPolicy {
  readonly enabled?: boolean;
  readonly logger?: LLMLogger;
}

// ───────────────────────── Logger ─────────────────────────

export interface LLMLogger {
  emit(event: LLMEvent): void;
}

// ───────────────────────── Events (15 types, closed union) ─────────────────────────

export type LLMEvent =
  | LLMCallStartEvent
  | LLMCallAttemptStartEvent
  | LLMCallThrottledEvent
  | LLMCallRetryScheduledEvent
  | LLMCallFetchErrorEvent
  | LLMCallProviderErrorEvent
  | LLMCallParseErrorEvent
  | LLMCallSanitizedEvent
  | LLMCallUnknownErrorClassifiedEvent
  | LLMCallUnknownTerminationEvent
  | LLMCallEndEvent
  | LLMEmbeddingStartEvent
  | LLMEmbeddingBatchEvent
  | LLMEmbeddingRetryScheduledEvent
  | LLMEmbeddingEndEvent;

interface BaseEvent {
  readonly eventType: string;
  readonly callId: string;
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly timestamp: string;
}

export interface LLMCallStartEvent extends BaseEvent {
  readonly eventType: 'llm_call_start';
  readonly endpoint: string;
  readonly messagesCount: number;
}

export interface LLMCallAttemptStartEvent extends BaseEvent {
  readonly eventType: 'llm_call_attempt_start';
  readonly attempt: number;
}

export interface LLMCallThrottledEvent extends BaseEvent {
  readonly eventType: 'llm_call_throttled';
  readonly waitMs: number;
  readonly reason: string;
  readonly snapshotState: 'known' | 'unknown' | 'partial';
  readonly estimatedTokens: number;
}

export interface LLMCallRetryScheduledEvent extends BaseEvent {
  readonly eventType: 'llm_call_retry_scheduled';
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
  readonly errorKind: LLMErrorKind;
}

export interface LLMCallFetchErrorEvent extends BaseEvent {
  readonly eventType: 'llm_call_fetch_error';
  readonly networkErrorKind?: string;
  readonly message: string;
}

export interface LLMCallProviderErrorEvent extends BaseEvent {
  readonly eventType: 'llm_call_provider_error';
  readonly status: number;
  readonly semanticErrorKind: LLMErrorKind;
  readonly retryable: boolean;
}

export interface LLMCallParseErrorEvent extends BaseEvent {
  readonly eventType: 'llm_call_parse_error';
  readonly message: string;
}

export interface LLMCallSanitizedEvent extends BaseEvent {
  readonly eventType: 'llm_call_sanitized';
  readonly thinkingTagsRemoved: boolean;
  readonly jsonFenceRemoved: boolean;
  readonly rawContentPreview?: string;
}

export interface LLMCallUnknownErrorClassifiedEvent extends BaseEvent {
  readonly eventType: 'llm_call_unknown_error_classified';
  readonly status?: number;
  readonly bodySnippet?: string;
  readonly networkErrorKind?: string;
  readonly rawMessage: string;
}

export interface LLMCallUnknownTerminationEvent extends BaseEvent {
  readonly eventType: 'llm_call_unknown_termination';
  readonly rawSignal: string;
}

export interface LLMCallEndEvent extends BaseEvent {
  readonly eventType: 'llm_call_end';
  readonly success: boolean;
  readonly durationMs: number;
  readonly attemptCount: number;
  readonly termination?: TerminationReason;
  readonly usage?: LLMUsage;
  readonly providerModel?: string;
  readonly errorKind?: LLMErrorKind;
}

export interface LLMEmbeddingStartEvent extends BaseEvent {
  readonly eventType: 'llm_embedding_start';
  readonly endpoint: string;
  readonly textsCount: number;
  readonly batchSize: number;
}

export interface LLMEmbeddingBatchEvent extends BaseEvent {
  readonly eventType: 'llm_embedding_batch';
  readonly batchIndex: number;
  readonly batchTextsCount: number;
  readonly durationMs: number;
}

export interface LLMEmbeddingRetryScheduledEvent extends BaseEvent {
  readonly eventType: 'llm_embedding_retry_scheduled';
  readonly batchIndex: number;
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: string;
  readonly errorKind: LLMErrorKind;
}

export interface LLMEmbeddingEndEvent extends BaseEvent {
  readonly eventType: 'llm_embedding_end';
  readonly success: boolean;
  readonly totalBatches: number;
  readonly totalDurationMs: number;
  readonly errorKind?: LLMErrorKind;
}

// ───────────────────────── Adapters ─────────────────────────

export interface AdapterStats {
  readonly totalCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalDurationMs: number;
}

export interface AdapterConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly sanitization: SanitizationPolicy;
  readonly integrity?: IntegrityPolicy;
  readonly logging?: LoggingPolicy;
  readonly providerOptions?: unknown;
}

export interface EmbeddingAdapterConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly batchSize?: number;
  readonly retry?: RetryPolicy;
  readonly timeout?: TimeoutPolicy;
  readonly logging?: LoggingPolicy;
}

export interface ProviderAdapter {
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly stats: AdapterStats;
  call(request: LLMRequest, options?: { signal?: AbortSignal }): Promise<LLMResponse>;
}

export interface EmbeddingAdapter {
  readonly provider: ProviderLongId;
  readonly model: string;
  readonly stats: AdapterStats;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

// LLMErrorKind used by event types above. Re-export removed — index.ts exports
// it directly from services/error-kind.js.
import type { LLMErrorKind } from './services/error-kind.js';
