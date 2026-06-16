// Bindings types — internal canonical shapes (NOT exported from index.ts per C-GL-02).

import type { LLMRuntimeError } from '../errors/index.js';
import type { ProviderErrorSignal } from '../services/error-classifier-base.js';
import type { RateLimitSnapshot } from '../services/throttle-resolver.js';
import type { LLMRequest, LLMUsage, ProviderLongId, TerminationReason } from '../types.js';

// ───────────────────────── Canonical intermediate shapes ─────────────────────────

export interface CanonicalHttpRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly bodyKind: 'json';
  readonly bodyJson: Record<string, unknown>;
}

export interface ParsedProviderResponse {
  readonly rawContent: string;
  readonly terminationSignal: string;
  readonly usage: LLMUsage;
  readonly providerResponseId?: string;
  readonly providerModel?: string;
}

// ───────────────────────── Binding config & quirks ─────────────────────────

export interface BindingConfig {
  readonly model: string;
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly providerOptions?: unknown;
}

export interface DefaultSanitization {
  readonly stripThinkingTags: boolean;
  readonly stripJsonFence: boolean;
}

export interface ProviderQuirks {
  readonly hasRateLimitHeaders: boolean;
  readonly mayRouteModel: boolean;
  readonly defaultSanitization: DefaultSanitization;
}

export interface EmbeddingQuirks {
  readonly hasRateLimitHeaders: boolean;
}

// ───────────────────────── Binding interfaces ─────────────────────────

export interface ProviderBinding {
  readonly provider: ProviderLongId;
  readonly buildRequest: (request: LLMRequest, config: BindingConfig) => CanonicalHttpRequest;
  readonly parseResponse: (
    body: unknown,
    headers: Record<string, string>,
  ) => ParsedProviderResponse;
  readonly classifyError: (signal: ProviderErrorSignal) => LLMRuntimeError;
  readonly readRateLimitHeaders: (
    headers: Record<string, string>,
    nowMono: number,
    nowWall: Date,
  ) => RateLimitSnapshot | null;
  readonly terminationMap: Readonly<Record<string, TerminationReason>>;
  readonly quirks: ProviderQuirks;
}

export interface EmbeddingBinding {
  readonly provider: ProviderLongId;
  readonly buildRequest: (texts: readonly string[], config: BindingConfig) => CanonicalHttpRequest;
  readonly parseEmbeddings: (body: unknown, headers: Record<string, string>) => number[][];
  readonly classifyError: (signal: ProviderErrorSignal) => LLMRuntimeError;
  readonly readRateLimitHeaders: (
    headers: Record<string, string>,
    nowMono: number,
    nowWall: Date,
  ) => RateLimitSnapshot | null;
  readonly quirks: EmbeddingQuirks;
}

// ───────────────────────── Compatible providers ─────────────────────────

export type OpenAICompatibleProvider = 'deepseek' | 'mistral' | 'groq' | 'together' | 'ollama';
