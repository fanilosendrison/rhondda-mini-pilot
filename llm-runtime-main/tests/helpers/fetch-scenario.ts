// NIB-T §27.6 — fluent builders for MockResponse scenarios.
// Test-time utility (not production code).

import type { ProviderLongId } from '../../src/types.js';
import { loadJsonFixture } from './fixture-loader.js';
import type { MockResponse } from './mock-fetch.js';

function providerOkBody(provider: ProviderLongId, content: string): unknown {
  switch (provider) {
    case 'anthropic':
      return {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      };
    case 'openai':
    case 'deepseek':
    case 'mistral':
    case 'groq':
    case 'together':
    case 'ollama':
      return {
        id: 'chatcmpl_test',
        object: 'chat.completion',
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    case 'google':
      return {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: content }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
      };
  }
}

export const scenario = {
  rateLimit(retryAfterSec?: number): MockResponse {
    if (retryAfterSec !== undefined) {
      return {
        status: 429,
        body: { error: 'rate limited' },
        headers: { 'retry-after': String(retryAfterSec) },
      };
    }
    return {
      status: 429,
      body: { error: 'rate limited' },
      headers: {},
    };
  },
  overloaded(): MockResponse {
    return {
      status: 529,
      body: { error: 'overloaded' },
      headers: {},
    };
  },
  serverError(): MockResponse {
    return {
      status: 500,
      body: { error: 'internal server error' },
      headers: {},
    };
  },
  authError(): MockResponse {
    return {
      status: 401,
      body: { error: 'unauthorized' },
      headers: {},
    };
  },
  invalidRequest(): MockResponse {
    return {
      status: 400,
      body: { error: 'invalid request' },
      headers: {},
    };
  },
  ok(provider: ProviderLongId, content: string): MockResponse {
    return {
      status: 200,
      body: providerOkBody(provider, content),
      headers: {},
    };
  },
  okFixture(fixtureName: string): MockResponse {
    const body = loadJsonFixture<unknown>(`provider-responses/${fixtureName}.json`);
    return {
      status: 200,
      body,
      headers: {},
    };
  },
  timeout(afterMs: number): MockResponse {
    return {
      status: 0,
      body: null,
      headers: {},
      delayMs: afterMs,
      throwError: Object.assign(new Error('Request timed out'), {
        name: 'AbortError',
      }),
    };
  },
  networkError(kind: string): MockResponse {
    return {
      status: 0,
      body: null,
      headers: {},
      throwError: Object.assign(new TypeError(`Network error: ${kind}`), {
        code: kind,
      }),
    };
  },
};
