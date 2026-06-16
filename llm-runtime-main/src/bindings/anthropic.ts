// NIB-M-BINDINGS-COMPLETION §3 — Anthropic Messages API binding.

import { ResponseParseError } from '../errors/index.js';
import { classifyErrorBase } from '../services/error-classifier-base.js';
import type { RateLimitSnapshot } from '../services/throttle-resolver.js';
import type { LLMRequest, LLMUsage, TerminationReason } from '../types.js';
import { coerceBodyToObject, parseIntStr } from './_internal/openai-common.js';
import type {
  BindingConfig,
  CanonicalHttpRequest,
  ParsedProviderResponse,
  ProviderBinding,
} from './types.js';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface AnthropicProviderOptions {
  readonly extendedThinking?: {
    readonly enabled?: boolean;
    readonly budgetTokens?: number;
  };
}

const TERMINATION_MAP: Readonly<Record<string, TerminationReason>> = Object.freeze({
  end_turn: 'completed',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  tool_use: 'completed',
});

function buildRequest(request: LLMRequest, config: BindingConfig): CanonicalHttpRequest {
  const systemParts: string[] = [];
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const msg of request.messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    else chatMessages.push({ role: msg.role, content: msg.content });
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: request.maxTokens ?? 1024,
    messages: chatMessages,
  };
  if (systemParts.length > 0) body['system'] = systemParts.join('\n\n');
  if (request.temperature !== undefined) body['temperature'] = request.temperature;
  if (request.stopSequences !== undefined) body['stop_sequences'] = [...request.stopSequences];

  const opts = config.providerOptions as AnthropicProviderOptions | undefined;
  if (opts?.extendedThinking?.enabled === true) {
    body['thinking'] = {
      type: 'enabled',
      budget_tokens: opts.extendedThinking.budgetTokens ?? 0,
    };
  }

  return {
    method: 'POST',
    url: config.endpoint ?? DEFAULT_ENDPOINT,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    bodyKind: 'json',
    bodyJson: body,
  };
}

function parseResponse(body: unknown, _headers: Record<string, string>): ParsedProviderResponse {
  const obj = coerceBodyToObject(body, 'anthropic');
  if (!Array.isArray(obj['content'])) {
    throw new ResponseParseError({ message: 'anthropic: missing content[]' });
  }
  if (typeof obj['stop_reason'] !== 'string') {
    throw new ResponseParseError({ message: 'anthropic: missing stop_reason' });
  }

  const textParts: string[] = [];
  for (const block of obj['content'] as unknown[]) {
    if (block === null || typeof block !== 'object') {
      throw new ResponseParseError({ message: 'anthropic: invalid content block' });
    }
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text') {
      if (typeof b['text'] !== 'string') {
        throw new ResponseParseError({ message: 'anthropic: text block missing text field' });
      }
      textParts.push(b['text']);
    }
    // thinking and tool_use blocks are ignored in rawContent.
  }

  const usage: LLMUsage = {};
  const rawUsage = obj['usage'];
  if (rawUsage !== null && typeof rawUsage === 'object') {
    const u = rawUsage as Record<string, unknown>;
    const input = typeof u['input_tokens'] === 'number' ? u['input_tokens'] : undefined;
    const output = typeof u['output_tokens'] === 'number' ? u['output_tokens'] : undefined;
    if (input !== undefined) (usage as { inputTokens?: number }).inputTokens = input;
    if (output !== undefined) (usage as { outputTokens?: number }).outputTokens = output;
    if (input !== undefined && output !== undefined) {
      (usage as { totalTokens?: number }).totalTokens = input + output;
    }
  }

  const out: ParsedProviderResponse = {
    rawContent: textParts.join(''),
    terminationSignal: obj['stop_reason'],
    usage,
    ...(typeof obj['id'] === 'string' ? { providerResponseId: obj['id'] } : {}),
    ...(typeof obj['model'] === 'string' ? { providerModel: obj['model'] } : {}),
  };
  return out;
}

function classifyError(signal: import('../services/error-classifier-base.js').ProviderErrorSignal) {
  // Anthropic has no provider-specific status overrides beyond the base classifier.
  // 529 (Overloaded) is handled by classifyErrorBase.
  return classifyErrorBase(signal);
}

function parseIsoDate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function readRateLimitHeaders(
  headers: Record<string, string>,
  nowMono: number,
  nowWall: Date,
): RateLimitSnapshot | null {
  // NIB-M-BINDINGS-COMPLETION §3.5: read aggregate tokens bucket first,
  // fall back to input-tokens bucket for broader provider compatibility.
  const remaining =
    parseIntStr(headers['anthropic-ratelimit-tokens-remaining']) ??
    parseIntStr(headers['anthropic-ratelimit-input-tokens-remaining']);
  const resetWallMs =
    parseIsoDate(headers['anthropic-ratelimit-tokens-reset']) ??
    parseIsoDate(headers['anthropic-ratelimit-input-tokens-reset']);
  if (remaining === undefined || resetWallMs === undefined) return null;
  const deltaMs = resetWallMs - nowWall.getTime();
  const resetMono = nowMono + Math.max(deltaMs, 0);
  return {
    remainingTokens: remaining,
    resetTokensAt: resetMono,
    lastCallOutputTokens: 0,
    state: 'known',
  };
}

export const anthropicBinding: ProviderBinding = {
  provider: 'anthropic',
  buildRequest,
  parseResponse,
  classifyError,
  readRateLimitHeaders,
  terminationMap: TERMINATION_MAP,
  quirks: {
    hasRateLimitHeaders: true,
    mayRouteModel: true,
    defaultSanitization: {
      stripThinkingTags: true,
      stripJsonFence: true,
    },
  },
};
