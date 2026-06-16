// NIB-M-BINDINGS-COMPLETION §5 — Factory for OpenAI-compatible providers
// (DeepSeek, Mistral, Groq, Together, Ollama).

import type { RateLimitSnapshot } from '../services/throttle-resolver.js';
import {
  buildOpenAILikeRequest,
  classifyOpenAILikeError,
  OPENAI_TERMINATION_MAP,
  parseIntStr,
  parseOpenAILikeResponse,
  parseOpenAIResetDuration,
  readOpenAILikeRateLimitHeaders,
} from './_internal/openai-common.js';
import type { OpenAICompatibleProvider, ProviderBinding, ProviderQuirks } from './types.js';

const FALLBACK_RESET_MS = 60_000;

function defaultEndpointFor(provider: OpenAICompatibleProvider): string {
  switch (provider) {
    case 'deepseek':
      return 'https://api.deepseek.com/v1';
    case 'mistral':
      return 'https://api.mistral.ai/v1';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'together':
      return 'https://api.together.xyz/v1';
    case 'ollama':
      return 'http://localhost:11434/v1';
  }
}

function quirksFor(provider: OpenAICompatibleProvider): ProviderQuirks {
  const defaultSanitization = { stripThinkingTags: true, stripJsonFence: false };
  switch (provider) {
    case 'deepseek':
    case 'mistral':
    case 'groq':
    case 'together':
      return { hasRateLimitHeaders: true, mayRouteModel: false, defaultSanitization };
    case 'ollama':
      return { hasRateLimitHeaders: false, mayRouteModel: false, defaultSanitization };
  }
}

function readMistralHeaders(
  headers: Record<string, string>,
  nowMono: number,
): RateLimitSnapshot | null {
  const remaining = parseIntStr(headers['x-ratelimit-remaining-tokens']);
  if (remaining === undefined) return null;
  const resetStr = headers['x-ratelimit-reset-tokens'];
  const resetMs = resetStr !== undefined ? parseOpenAIResetDuration(resetStr) : undefined;
  if (resetMs === undefined) {
    // Mistral does not expose a reset header → 60s fallback with partial state.
    return {
      remainingTokens: remaining,
      resetTokensAt: nowMono + FALLBACK_RESET_MS,
      lastCallOutputTokens: 0,
      state: 'partial',
    };
  }
  return {
    remainingTokens: remaining,
    resetTokensAt: nowMono + resetMs,
    lastCallOutputTokens: 0,
    state: 'known',
  };
}

function readTogetherHeaders(
  headers: Record<string, string>,
  nowMono: number,
): RateLimitSnapshot | null {
  const remaining = parseIntStr(headers['x-tokenlimit-remaining']);
  if (remaining === undefined) return null;
  const resetStr = headers['x-tokenlimit-reset'];
  const resetSec = parseIntStr(resetStr);
  if (resetSec === undefined) {
    return {
      remainingTokens: remaining,
      resetTokensAt: nowMono + FALLBACK_RESET_MS,
      lastCallOutputTokens: 0,
      state: 'partial',
    };
  }
  return {
    remainingTokens: remaining,
    resetTokensAt: nowMono + resetSec * 1000,
    lastCallOutputTokens: 0,
    state: 'known',
  };
}

function readRateLimitHeadersFor(
  provider: OpenAICompatibleProvider,
): (headers: Record<string, string>, nowMono: number) => RateLimitSnapshot | null {
  switch (provider) {
    case 'deepseek':
      return readOpenAILikeRateLimitHeaders;
    case 'ollama':
      return () => null;
    case 'mistral':
      return readMistralHeaders;
    case 'groq':
      return readOpenAILikeRateLimitHeaders;
    case 'together':
      return readTogetherHeaders;
  }
}

export function createOpenAICompatibleBinding(provider: OpenAICompatibleProvider): ProviderBinding {
  const readFn = readRateLimitHeadersFor(provider);
  const fallbackEndpoint = defaultEndpointFor(provider);
  return {
    provider,
    buildRequest: (request, config) =>
      buildOpenAILikeRequest(config.endpoint ?? fallbackEndpoint, request, config),
    parseResponse: (body) => parseOpenAILikeResponse(body),
    classifyError: (signal) => classifyOpenAILikeError(signal, provider),
    readRateLimitHeaders: (headers, nowMono) => readFn(headers, nowMono),
    terminationMap: OPENAI_TERMINATION_MAP,
    quirks: quirksFor(provider),
  };
}
