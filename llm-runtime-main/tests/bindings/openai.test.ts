// NIB-T §11 — Acceptance + property tests for the OpenAI binding.
// RED phase: source stubs throw "Not implemented".

import { describe, expect, it } from 'vitest';

import { openaiBinding } from '../../src/bindings/openai.js';
import type { BindingConfig } from '../../src/bindings/types.js';
import {
  AuthError,
  InvalidRequestError,
  RateLimitError,
  ResponseParseError,
  TransientProviderError,
} from '../../src/errors/index.js';
import type { ProviderErrorSignal } from '../../src/services/error-classifier-base.js';
import type { LLMRequest } from '../../src/types.js';
import { loadJsonFixture } from '../helpers/fixture-loader.js';
import { createMockClock } from '../helpers/mock-clock.js';
import { seededRandom } from '../helpers/seeded-random.js';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function baseConfig(overrides: Partial<BindingConfig> = {}): BindingConfig {
  return {
    model: 'gpt-4o',
    apiKey: 'sk-x',
    ...overrides,
  };
}

function makeSignal(overrides: Partial<ProviderErrorSignal> = {}): ProviderErrorSignal {
  return {
    aborted: false,
    timeout: false,
    headers: {},
    ...overrides,
  };
}

describe('openaiBinding', () => {
  // ─── §11.1 — buildRequest ──────────────────────────────────────────────

  describe('§11.1 buildRequest', () => {
    it('T-OA-01 | minimal request uses chat/completions endpoint with Bearer auth', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const http = openaiBinding.buildRequest(request, baseConfig());
      expect(http.url).toBe('https://api.openai.com/v1/chat/completions');
      expect(http.headers['authorization']).toBe('Bearer sk-x');
      expect(http.bodyJson['model']).toBe('gpt-4o');
      expect(http.bodyJson['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('T-OA-02 | system message remains inside messages (not extracted)', () => {
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
      };
      const http = openaiBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['messages']).toEqual([
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ]);
    });

    it('T-OA-03 | temperature + maxTokens mapped to max_tokens', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        maxTokens: 1000,
      };
      const http = openaiBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['temperature']).toBe(0.5);
      expect(http.bodyJson['max_tokens']).toBe(1000);
    });

    it('T-OA-04 | stopSequences mapped to stop', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        stopSequences: ['END'],
      };
      const http = openaiBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['stop']).toEqual(['END']);
    });

    it('T-OA-05 | endpoint override replaces URL', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const http = openaiBinding.buildRequest(
        request,
        baseConfig({ endpoint: 'https://custom.proxy/v1/chat/completions' }),
      );
      expect(http.url).toBe('https://custom.proxy/v1/chat/completions');
    });
  });

  // ─── §11.2 — parseResponse ─────────────────────────────────────────────

  describe('§11.2 parseResponse', () => {
    it('T-OA-06 | ok-simple fixture normalizes prompt_tokens → inputTokens', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai/ok-simple.json');
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('Hello');
      expect(parsed.terminationSignal).toBe('stop');
      expect(parsed.usage.inputTokens).toBe(8);
      expect(parsed.usage.outputTokens).toBe(2);
      expect(parsed.usage.totalTokens).toBe(10);
      expect(parsed.providerResponseId).toBe('chatcmpl-xxx');
      expect(parsed.providerModel).toBe('gpt-4o-2024-08-06');
    });

    it('T-OA-07 | ok-length yields terminationSignal "length"', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai/ok-length.json');
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('length');
    });

    it('T-OA-08 | ok-content-filter yields terminationSignal "content_filter"', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai/ok-content-filter.json');
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('content_filter');
    });

    it('T-OA-09 | deepseek-r1-think keeps <think> tags in rawContent (engine strips later)', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai/ok-deepseek-r1-think.json');
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('<think>long reasoning here</think>final answer');
    });

    it('T-OA-10 | empty choices array throws ResponseParseError', () => {
      const body = {
        id: 'chatcmpl-empty',
        model: 'gpt-4o',
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      expect(() => openaiBinding.parseResponse(body, JSON_HEADERS)).toThrow(ResponseParseError);
    });

    it('T-OA-11 | choices[0].message.content null yields rawContent === "" and finish_reason passed through', () => {
      const body = {
        id: 'chatcmpl-toolcalls',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null, tool_calls: [] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('');
      expect(parsed.terminationSignal).toBe('tool_calls');
    });

    it('T-OA-12 | body without usage yields usage fields all undefined (never 0 invented)', () => {
      const body = {
        id: 'chatcmpl-nousage',
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      const parsed = openaiBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.usage.inputTokens).toBeUndefined();
      expect(parsed.usage.outputTokens).toBeUndefined();
      expect(parsed.usage.totalTokens).toBeUndefined();
    });
  });

  // ─── §11.3 — classifyError ─────────────────────────────────────────────

  describe('§11.3 classifyError', () => {
    it('T-OA-13 | status 400 → InvalidRequestError', () => {
      const err = openaiBinding.classifyError(makeSignal({ status: 400 }));
      expect(err).toBeInstanceOf(InvalidRequestError);
    });

    it('T-OA-14 | status 401 → AuthError', () => {
      const err = openaiBinding.classifyError(makeSignal({ status: 401 }));
      expect(err).toBeInstanceOf(AuthError);
    });

    it('T-OA-15 | status 429 → RateLimitError', () => {
      const err = openaiBinding.classifyError(makeSignal({ status: 429 }));
      expect(err).toBeInstanceOf(RateLimitError);
    });

    it('T-OA-16 | status 500 → TransientProviderError', () => {
      const err = openaiBinding.classifyError(makeSignal({ status: 500 }));
      expect(err).toBeInstanceOf(TransientProviderError);
    });

    it('T-OA-17 | status 503 → TransientProviderError', () => {
      const err = openaiBinding.classifyError(makeSignal({ status: 503 }));
      expect(err).toBeInstanceOf(TransientProviderError);
    });
  });

  // ─── §11.4 — readRateLimitHeaders ──────────────────────────────────────

  describe('§11.4 readRateLimitHeaders', () => {
    it('T-OA-18 | openai-ok fixture yields remainingTokens 142000 with monotone reset', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers = loadJsonFixture<Record<string, string>>('rate-limit-headers/openai-ok.json');
      const snapshot = openaiBinding.readRateLimitHeaders(
        headers,
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error('unreachable');
      expect(snapshot.remainingTokens).toBe(142000);
      expect(snapshot.state).toBe('known');
      // "10s" reset → nowMono + 10000 = 11000
      expect(snapshot.resetTokensAt).toBe(11000);
    });

    it('T-OA-19 | empty headers yield null', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = openaiBinding.readRateLimitHeaders({}, clock.nowMono(), clock.nowWall());
      expect(snapshot).toBeNull();
    });

    it('T-OA-20 | reset "1m30s" parsed as 90s — resetTokensAt === nowMono + 90000', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers: Record<string, string> = {
        'x-ratelimit-limit-tokens': '150000',
        'x-ratelimit-remaining-tokens': '142000',
        'x-ratelimit-reset-tokens': '1m30s',
      };
      const snapshot = openaiBinding.readRateLimitHeaders(
        headers,
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error('unreachable');
      expect(snapshot.resetTokensAt).toBe(91000);
    });
  });

  // ─── §11.5 — terminationMap and quirks ─────────────────────────────────

  describe('§11.5 terminationMap and quirks', () => {
    it('T-OA-21 | stop → completed', () => {
      expect(openaiBinding.terminationMap['stop']).toBe('completed');
    });

    it('T-OA-22 | length → max_tokens', () => {
      expect(openaiBinding.terminationMap['length']).toBe('max_tokens');
    });

    it('T-OA-23 | content_filter → content_filter', () => {
      expect(openaiBinding.terminationMap['content_filter']).toBe('content_filter');
    });

    it('T-OA-24 | tool_calls → completed', () => {
      expect(openaiBinding.terminationMap['tool_calls']).toBe('completed');
    });

    it('T-OA-25 | quirks values match OpenAI defaults', () => {
      expect(openaiBinding.quirks.hasRateLimitHeaders).toBe(true);
      expect(openaiBinding.quirks.mayRouteModel).toBe(false);
      expect(openaiBinding.quirks.defaultSanitization).toEqual({
        stripThinkingTags: true,
        stripJsonFence: false,
      });
    });
  });

  // ─── Properties ────────────────────────────────────────────────────────

  describe('properties', () => {
    it('P-OA-a | buildRequest is idempotent — 20 iterations', () => {
      const rng = seededRandom(0xb01);
      for (let i = 0; i < 20; i += 1) {
        const request: LLMRequest = {
          messages: [{ role: 'user', content: rng.randomString(32) }],
        };
        const http1 = openaiBinding.buildRequest(request, baseConfig());
        const http2 = openaiBinding.buildRequest(request, baseConfig());
        expect(JSON.stringify(http1)).toBe(JSON.stringify(http2));
      }
    });

    it('P-OA-b | parseResponse is idempotent — 20 iterations', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai/ok-simple.json');
      for (let i = 0; i < 20; i += 1) {
        const p1 = openaiBinding.parseResponse(body, JSON_HEADERS);
        const p2 = openaiBinding.parseResponse(body, JSON_HEADERS);
        expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
      }
    });

    it('P-OA-c | terminationMap is frozen', () => {
      expect(Object.isFrozen(openaiBinding.terminationMap)).toBe(true);
    });
  });
});
