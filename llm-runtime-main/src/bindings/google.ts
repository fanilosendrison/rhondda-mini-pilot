// NIB-M-BINDINGS-COMPLETION §6 — Google Gemini generateContent binding.

import { ContentFilterError, type LLMRuntimeError, ResponseParseError } from '../errors/index.js';
import { classifyErrorBase, type ProviderErrorSignal } from '../services/error-classifier-base.js';
import type { RateLimitSnapshot } from '../services/throttle-resolver.js';
import type { LLMRequest, LLMUsage, TerminationReason } from '../types.js';
import { coerceBodyToObject } from './_internal/openai-common.js';
import type { CanonicalHttpRequest, ParsedProviderResponse, ProviderBinding } from './types.js';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

const FILTER_REASONS = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'LANGUAGE',
]);

const TERMINATION_MAP: Readonly<Record<string, TerminationReason>> = Object.freeze({
  STOP: 'completed',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  BLOCKLIST: 'content_filter',
  PROHIBITED_CONTENT: 'content_filter',
  SPII: 'content_filter',
  LANGUAGE: 'content_filter',
  MALFORMED_FUNCTION_CALL: 'unknown',
  FINISH_REASON_UNSPECIFIED: 'unknown',
  OTHER: 'unknown',
});

function mapRole(role: 'system' | 'user' | 'assistant'): 'user' | 'model' {
  return role === 'assistant' ? 'model' : 'user';
}

function buildRequest(
  request: LLMRequest,
  config: { model: string; apiKey: string; endpoint?: string },
): CanonicalHttpRequest {
  const systemParts: string[] = [];
  const contents: Array<{ role: 'user' | 'model'; parts: ReadonlyArray<{ text: string }> }> = [];
  for (const msg of request.messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    else contents.push({ role: mapRole(msg.role), parts: [{ text: msg.content }] });
  }

  const genConfig: Record<string, unknown> = {};
  if (request.temperature !== undefined) genConfig['temperature'] = request.temperature;
  if (request.maxTokens !== undefined) genConfig['maxOutputTokens'] = request.maxTokens;
  if (request.stopSequences !== undefined) genConfig['stopSequences'] = [...request.stopSequences];

  const body: Record<string, unknown> = { contents };
  if (systemParts.length > 0)
    body['systemInstruction'] = { parts: [{ text: systemParts.join('\n\n') }] };
  if (Object.keys(genConfig).length > 0) body['generationConfig'] = genConfig;

  const base = (config.endpoint ?? DEFAULT_BASE).replace(/\/$/, '');
  const url = `${base}/v1beta/models/${config.model}:generateContent`;

  return {
    method: 'POST',
    url,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.apiKey,
    },
    bodyKind: 'json',
    bodyJson: body,
  };
}

function parseResponse(body: unknown, _headers: Record<string, string>): ParsedProviderResponse {
  const obj = coerceBodyToObject(body, 'google');

  // Safety-block: prompt blocked before any candidate was produced.
  const promptFeedback = obj['promptFeedback'] as Record<string, unknown> | undefined;
  const blockReason = promptFeedback?.['blockReason'];
  const candidates = obj['candidates'];
  const candidatesEmpty = !Array.isArray(candidates) || candidates.length === 0;
  if (typeof blockReason === 'string' && candidatesEmpty) {
    throw new ContentFilterError({
      message: `google: prompt blocked: ${blockReason}`,
      reason: blockReason,
    });
  }

  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ResponseParseError({ message: 'google: missing candidates' });
  }
  const candidate = candidates[0] as Record<string, unknown>;
  const content = candidate['content'] as Record<string, unknown> | undefined;
  const parts = Array.isArray(content?.['parts']) ? (content['parts'] as unknown[]) : [];

  // Candidate-level safety block: finishReason signals filter + no content produced.
  const candidateFinish = candidate['finishReason'];
  if (
    typeof candidateFinish === 'string' &&
    FILTER_REASONS.has(candidateFinish) &&
    parts.length === 0
  ) {
    throw new ContentFilterError({
      message: `google: candidate blocked: ${candidateFinish}`,
      reason: candidateFinish,
    });
  }
  const textParts: string[] = [];
  for (const part of parts) {
    if (part !== null && typeof part === 'object') {
      const p = part as Record<string, unknown>;
      if (typeof p['text'] === 'string') textParts.push(p['text']);
    }
  }

  const usage: LLMUsage = {};
  const usageMeta = obj['usageMetadata'] as Record<string, unknown> | undefined;
  if (usageMeta !== undefined) {
    const input =
      typeof usageMeta['promptTokenCount'] === 'number' ? usageMeta['promptTokenCount'] : undefined;
    const output =
      typeof usageMeta['candidatesTokenCount'] === 'number'
        ? usageMeta['candidatesTokenCount']
        : undefined;
    const total =
      typeof usageMeta['totalTokenCount'] === 'number' ? usageMeta['totalTokenCount'] : undefined;
    if (input !== undefined) (usage as { inputTokens?: number }).inputTokens = input;
    if (output !== undefined) (usage as { outputTokens?: number }).outputTokens = output;
    if (total !== undefined) (usage as { totalTokens?: number }).totalTokens = total;
  }

  const finishReason = candidate['finishReason'];
  return {
    rawContent: textParts.join(''),
    terminationSignal:
      typeof finishReason === 'string' ? finishReason : 'FINISH_REASON_UNSPECIFIED',
    usage,
    ...(typeof obj['responseId'] === 'string' ? { providerResponseId: obj['responseId'] } : {}),
    ...(typeof obj['modelVersion'] === 'string' ? { providerModel: obj['modelVersion'] } : {}),
  };
}

function classifyError(signal: ProviderErrorSignal): LLMRuntimeError {
  // Google has no provider-specific status overrides beyond the base classifier.
  return classifyErrorBase(signal);
}

function readRateLimitHeaders(
  _headers: Record<string, string>,
  _nowMono: number,
  _nowWall: Date,
): RateLimitSnapshot | null {
  // Gemini does not expose usable rate-limit headers (NIB-M-BINDINGS-COMPLETION §6.5).
  return null;
}

export const googleBinding: ProviderBinding = {
  provider: 'google',
  buildRequest,
  parseResponse,
  classifyError,
  readRateLimitHeaders,
  terminationMap: TERMINATION_MAP,
  quirks: {
    hasRateLimitHeaders: false,
    mayRouteModel: false,
    defaultSanitization: {
      stripThinkingTags: true,
      stripJsonFence: true,
    },
  },
};
