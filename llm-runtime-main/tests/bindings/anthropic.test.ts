// NIB-T §10 — Acceptance + property tests for the Anthropic binding.
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.

import { describe, expect, it } from 'vitest';

import { anthropicBinding } from '../../src/bindings/anthropic.js';
import type { BindingConfig } from '../../src/bindings/types.js';
import {
  AuthError,
  InvalidRequestError,
  OverloadedError,
  RateLimitError,
  ResponseParseError,
} from '../../src/errors/index.js';
import type { ProviderErrorSignal } from '../../src/services/error-classifier-base.js';
import type { LLMRequest } from '../../src/types.js';
import { deepFreeze } from '../helpers/deep-freeze.js';
import { loadJsonFixture } from '../helpers/fixture-loader.js';
import { createMockClock } from '../helpers/mock-clock.js';
import { seededRandom } from '../helpers/seeded-random.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function baseConfig(overrides: Partial<BindingConfig> = {}): BindingConfig {
  return {
    model: 'claude-opus-4-6',
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

// ─── §10.1 — buildRequest ──────────────────────────────────────────────────

describe('anthropicBinding', () => {
  describe('§10.1 buildRequest', () => {
    it('T-AN-01 | minimal POST builds correct URL, headers, and body', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const config = baseConfig();
      const http = anthropicBinding.buildRequest(request, config);
      expect(http.method).toBe('POST');
      expect(http.url).toBe('https://api.anthropic.com/v1/messages');
      expect(http.headers['x-api-key']).toBe('sk-x');
      expect(http.headers['anthropic-version']).toBe('2023-06-01');
      expect(http.bodyKind).toBe('json');
      expect(http.bodyJson['model']).toBe('claude-opus-4-6');
      expect((http.bodyJson['messages'] as readonly unknown[])[0]).toEqual({
        role: 'user',
        content: 'hi',
      });
    });

    it('T-AN-02 | system message extracted to top-level system field', () => {
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
      };
      const http = anthropicBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['system']).toBe('sys');
      expect(http.bodyJson['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('T-AN-03 | temperature and maxTokens are mapped', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        maxTokens: 500,
      };
      const http = anthropicBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['temperature']).toBe(0.7);
      expect(http.bodyJson['max_tokens']).toBe(500);
    });

    it('T-AN-04 | stopSequences mapped to stop_sequences', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        stopSequences: ['END', 'STOP'],
      };
      const http = anthropicBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['stop_sequences']).toEqual(['END', 'STOP']);
    });

    it('T-AN-05 | extendedThinking providerOption produces thinking block', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const config = baseConfig({
        providerOptions: {
          extendedThinking: { enabled: true, budgetTokens: 4000 },
        },
      });
      const http = anthropicBinding.buildRequest(request, config);
      expect(http.bodyJson['thinking']).toEqual({
        type: 'enabled',
        budget_tokens: 4000,
      });
    });

    it('T-AN-06 | endpoint override replaces URL', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const config = baseConfig({ endpoint: 'https://custom.proxy/v1/messages' });
      const http = anthropicBinding.buildRequest(request, config);
      expect(http.url).toBe('https://custom.proxy/v1/messages');
    });

    it('T-AN-07 | preserves user/assistant alternation', () => {
      const request: LLMRequest = {
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
        ],
      };
      const http = anthropicBinding.buildRequest(request, baseConfig());
      const messages = http.bodyJson['messages'] as readonly unknown[];
      expect(messages.length).toBe(3);
      expect(messages).toEqual([
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ]);
    });
  });

  // ─── §10.2 — parseResponse ───────────────────────────────────────────────

  describe('§10.2 parseResponse', () => {
    it('T-AN-08 | ok-simple fixture yields rawContent, termination, usage', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-simple.json');
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('Hello');
      expect(parsed.terminationSignal).toBe('end_turn');
      expect(parsed.usage.inputTokens).toBe(10);
      expect(parsed.usage.outputTokens).toBe(5);
      expect(parsed.usage.totalTokens).toBe(15);
      expect(parsed.providerModel).toBe('claude-opus-4-6-20260301');
    });

    it('T-AN-09 | ok-with-thinking extracts text only (thinking ignored by binding)', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-with-thinking.json');
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('Answer');
    });

    it('T-AN-10 | ok-max-tokens yields terminationSignal "max_tokens"', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-max-tokens.json');
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('max_tokens');
    });

    it('T-AN-11 | ok-stop-sequence yields terminationSignal "stop_sequence"', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-stop-sequence.json');
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('stop_sequence');
    });

    it('T-AN-12 | ok-tool-use yields terminationSignal "tool_use" and text-only rawContent', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-tool-use.json');
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('tool_use');
      expect(parsed.rawContent).toBe('Let me check...');
    });

    it('T-AN-13 | concatenates multiple text blocks in order', () => {
      const body = {
        content: [
          { type: 'text', text: 'A' },
          { type: 'text', text: 'B' },
        ],
        stop_reason: 'end_turn',
        model: 'claude-opus-4-6-20260301',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('AB');
    });

    it('T-AN-14 | non-JSON body throws ResponseParseError', () => {
      expect(() => anthropicBinding.parseResponse('<html>...</html>', JSON_HEADERS)).toThrow(
        ResponseParseError,
      );
    });

    it('T-AN-15 | empty object body throws ResponseParseError', () => {
      expect(() => anthropicBinding.parseResponse({}, JSON_HEADERS)).toThrow(ResponseParseError);
    });

    it('T-AN-16 | empty content array yields rawContent === ""', () => {
      const body = {
        content: [],
        stop_reason: 'end_turn',
        model: 'claude-opus-4-6-20260301',
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      const parsed = anthropicBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('');
    });

    it('T-AN-17 | text block missing text field throws ResponseParseError', () => {
      const body = {
        content: [{ type: 'text' }],
        stop_reason: 'end_turn',
        model: 'claude-opus-4-6-20260301',
        usage: { input_tokens: 1, output_tokens: 0 },
      };
      expect(() => anthropicBinding.parseResponse(body, JSON_HEADERS)).toThrow(ResponseParseError);
    });
  });

  // ─── §10.3 — classifyError (provider overrides) ──────────────────────────

  describe('§10.3 classifyError', () => {
    it('T-AN-18 | status 529 yields OverloadedError (Anthropic override)', () => {
      const signal = makeSignal({ status: 529, bodyText: 'Overloaded' });
      const err = anthropicBinding.classifyError(signal);
      expect(err).toBeInstanceOf(OverloadedError);
    });

    it('T-AN-19 | status 400 yields InvalidRequestError', () => {
      const signal = makeSignal({ status: 400, bodyText: 'bad request' });
      const err = anthropicBinding.classifyError(signal);
      expect(err).toBeInstanceOf(InvalidRequestError);
    });

    it('T-AN-20 | status 401 yields AuthError', () => {
      const signal = makeSignal({ status: 401, bodyText: 'invalid x-api-key' });
      const err = anthropicBinding.classifyError(signal);
      expect(err).toBeInstanceOf(AuthError);
    });

    it('T-AN-21 | status 429 with retry-after: 30 yields RateLimitError retryAfterMs === 30000', () => {
      const signal = makeSignal({
        status: 429,
        headers: { 'retry-after': '30' },
      });
      const err = anthropicBinding.classifyError(signal);
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30000);
    });
  });

  // ─── §10.4 — readRateLimitHeaders ────────────────────────────────────────

  describe('§10.4 readRateLimitHeaders', () => {
    it('T-AN-23 | anthropic-ok fixture yields known snapshot with correct monotone reset', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers = loadJsonFixture<Record<string, string>>(
        'rate-limit-headers/anthropic-ok.json',
      );
      const snapshot = anthropicBinding.readRateLimitHeaders(
        headers,
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error('unreachable');
      expect(snapshot.remainingTokens).toBe(42500);
      expect(snapshot.state).toBe('known');
      // 5 min delta from nowWall → nowMono + 300000 = 301000
      expect(snapshot.resetTokensAt).toBe(301000);
    });

    it('T-AN-24 | empty headers yield null', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = anthropicBinding.readRateLimitHeaders({}, clock.nowMono(), clock.nowWall());
      expect(snapshot).toBeNull();
    });

    it('T-AN-25 | only remaining header (no limit/reset) yields null', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = anthropicBinding.readRateLimitHeaders(
        { 'anthropic-ratelimit-input-tokens-remaining': '42500' },
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).toBeNull();
    });

    it('T-AN-26 | reset absent but remaining present yields null', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = anthropicBinding.readRateLimitHeaders(
        {
          'anthropic-ratelimit-input-tokens-limit': '50000',
          'anthropic-ratelimit-input-tokens-remaining': '42500',
        },
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).toBeNull();
    });
  });

  // ─── §10.5 — terminationMap ──────────────────────────────────────────────

  describe('§10.5 terminationMap', () => {
    it('T-AN-27 | end_turn → completed', () => {
      expect(anthropicBinding.terminationMap['end_turn']).toBe('completed');
    });

    it('T-AN-28 | max_tokens → max_tokens', () => {
      expect(anthropicBinding.terminationMap['max_tokens']).toBe('max_tokens');
    });

    it('T-AN-29 | stop_sequence → stop_sequence', () => {
      expect(anthropicBinding.terminationMap['stop_sequence']).toBe('stop_sequence');
    });

    it('T-AN-30 | tool_use → completed', () => {
      expect(anthropicBinding.terminationMap['tool_use']).toBe('completed');
    });

    it('T-AN-31 | refusal is NOT defined (handled via ContentFilterError)', () => {
      expect(anthropicBinding.terminationMap['refusal']).toBeUndefined();
    });
  });

  // ─── §10.6 — quirks ──────────────────────────────────────────────────────

  describe('§10.6 quirks', () => {
    it('T-AN-32 | hasRateLimitHeaders === true', () => {
      expect(anthropicBinding.quirks.hasRateLimitHeaders).toBe(true);
    });

    it('T-AN-33 | mayRouteModel === true', () => {
      expect(anthropicBinding.quirks.mayRouteModel).toBe(true);
    });

    it('T-AN-34 | defaultSanitization === { stripThinkingTags: true, stripJsonFence: true }', () => {
      expect(anthropicBinding.quirks.defaultSanitization).toEqual({
        stripThinkingTags: true,
        stripJsonFence: true,
      });
    });
  });

  // ─── §10.7 — properties ──────────────────────────────────────────────────

  describe('§10.7 properties', () => {
    it('P-AN-a | buildRequest is idempotent — 20 iterations', () => {
      const rng = seededRandom(0xa01);
      for (let i = 0; i < 20; i += 1) {
        const withTemp = rng.randomBool();
        const withMax = rng.randomBool();
        const request: LLMRequest = {
          messages: [{ role: 'user', content: rng.randomString(32) }],
          ...(withTemp ? { temperature: 0.5 } : {}),
          ...(withMax ? { maxTokens: 256 } : {}),
        };
        const config = baseConfig();
        const http1 = anthropicBinding.buildRequest(request, config);
        const http2 = anthropicBinding.buildRequest(request, config);
        expect(JSON.stringify(http1)).toBe(JSON.stringify(http2));
      }
    });

    it('P-AN-b | buildRequest does not mutate deep-frozen inputs — 20 iterations', () => {
      const rng = seededRandom(0xa02);
      for (let i = 0; i < 20; i += 1) {
        const request = deepFreeze<LLMRequest>({
          messages: [{ role: 'user' as const, content: rng.randomString(32) }],
        });
        const config = deepFreeze(baseConfig());
        expect(() => anthropicBinding.buildRequest(request, config)).not.toThrow();
      }
    });

    it('P-AN-c | parseResponse is idempotent on the same body — 20 iterations', () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-simple.json');
      for (let i = 0; i < 20; i += 1) {
        const p1 = anthropicBinding.parseResponse(body, JSON_HEADERS);
        const p2 = anthropicBinding.parseResponse(body, JSON_HEADERS);
        expect(JSON.stringify(p1)).toBe(JSON.stringify(p2));
      }
    });

    it('P-AN-d | terminationMap is frozen', () => {
      expect(Object.isFrozen(anthropicBinding.terminationMap)).toBe(true);
    });
  });
});
