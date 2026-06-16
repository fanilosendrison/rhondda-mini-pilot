// NIB-T §13 — Acceptance tests for the Google Gemini binding.
// RED phase: source stubs throw "Not implemented".

import { describe, expect, it } from 'vitest';

import { googleBinding } from '../../src/bindings/google.js';
import type { BindingConfig } from '../../src/bindings/types.js';
import {
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  RateLimitError,
  ResponseParseError,
  TransientProviderError,
} from '../../src/errors/index.js';
import type { LLMRequest } from '../../src/types.js';
import { loadJsonFixture } from '../helpers/fixture-loader.js';
import { createMockClock } from '../helpers/mock-clock.js';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function baseConfig(overrides: Partial<BindingConfig> = {}): BindingConfig {
  return {
    model: 'gemini-2.0-flash',
    apiKey: 'AIza-xxx',
    ...overrides,
  };
}

describe('googleBinding', () => {
  // ─── §13.1 — buildRequest ──────────────────────────────────────────────

  describe('§13.1 buildRequest', () => {
    it('T-GG-01 | minimal request uses x-goog-api-key and maps content to contents/parts', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const http = googleBinding.buildRequest(request, baseConfig());
      expect(http.url).toContain('gemini-2.0-flash:generateContent');
      expect(http.headers['x-goog-api-key']).toBe('AIza-xxx');
      expect(http.headers['authorization']).toBeUndefined();
      expect(http.bodyJson['contents']).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    });

    it('T-GG-02 | system message extracted to systemInstruction', () => {
      const request: LLMRequest = {
        messages: [
          { role: 'system', content: 's' },
          { role: 'user', content: 'u' },
        ],
      };
      const http = googleBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['systemInstruction']).toEqual({
        parts: [{ text: 's' }],
      });
      const contents = http.bodyJson['contents'] as readonly {
        readonly role: string;
      }[];
      for (const c of contents) {
        expect(c.role).not.toBe('system');
      }
    });

    it('T-GG-03 | temperature and maxTokens mapped under generationConfig', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.3,
        maxTokens: 500,
      };
      const http = googleBinding.buildRequest(request, baseConfig());
      expect(http.bodyJson['generationConfig']).toEqual({
        temperature: 0.3,
        maxOutputTokens: 500,
      });
    });

    it('T-GG-04 | stopSequences mapped to generationConfig.stopSequences', () => {
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
        stopSequences: ['END'],
      };
      const http = googleBinding.buildRequest(request, baseConfig());
      const genCfg = http.bodyJson['generationConfig'] as Record<string, unknown>;
      expect(genCfg['stopSequences']).toEqual(['END']);
    });

    it('T-GG-05 | assistant role is remapped to "model"', () => {
      const request: LLMRequest = {
        messages: [
          { role: 'user', content: 'u1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'u2' },
        ],
      };
      const http = googleBinding.buildRequest(request, baseConfig());
      const contents = http.bodyJson['contents'] as readonly {
        readonly role: string;
      }[];
      const roles = contents.map((c) => c.role);
      expect(roles).toEqual(['user', 'model', 'user']);
    });
  });

  // ─── §13.2 — parseResponse ─────────────────────────────────────────────

  describe('§13.2 parseResponse', () => {
    it('T-GG-06 | ok-simple fixture yields rawContent and normalized usage', () => {
      const body = loadJsonFixture<unknown>('provider-responses/google/ok-simple.json');
      const parsed = googleBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('Hello');
      expect(parsed.terminationSignal).toBe('STOP');
      expect(parsed.usage.inputTokens).toBe(8);
      expect(parsed.usage.outputTokens).toBe(2);
      expect(parsed.providerModel).toBe('gemini-2.0-flash-001');
    });

    it('T-GG-07 | ok-max-tokens yields terminationSignal "MAX_TOKENS"', () => {
      const body = loadJsonFixture<unknown>('provider-responses/google/ok-max-tokens.json');
      const parsed = googleBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('MAX_TOKENS');
    });

    it('T-GG-08 | ok-safety-block throws ContentFilterError directly from parseResponse', () => {
      const body = loadJsonFixture<unknown>('provider-responses/google/ok-safety-block.json');
      expect(() => googleBinding.parseResponse(body, JSON_HEADERS)).toThrow(ContentFilterError);
    });

    it('T-GG-09 | unknown finishReason is passed through raw (mapping done by engine)', () => {
      const body = loadJsonFixture<unknown>('provider-responses/google/ok-unknown-finish.json');
      const parsed = googleBinding.parseResponse(body, JSON_HEADERS);
      expect(parsed.terminationSignal).toBe('FOO_UNKNOWN');
    });

    it('T-GG-10 | empty candidates array throws ResponseParseError', () => {
      const body = {
        candidates: [],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
          totalTokenCount: 0,
        },
        modelVersion: 'gemini-2.0-flash-001',
      };
      expect(() => googleBinding.parseResponse(body, JSON_HEADERS)).toThrow(ResponseParseError);
    });
  });

  // ─── §13.3 — terminationMap (complete) ─────────────────────────────────

  describe('§13.3 terminationMap', () => {
    it('T-GG-11 | STOP → completed', () => {
      expect(googleBinding.terminationMap['STOP']).toBe('completed');
    });

    it('T-GG-12 | MAX_TOKENS → max_tokens', () => {
      expect(googleBinding.terminationMap['MAX_TOKENS']).toBe('max_tokens');
    });

    it('T-GG-13 | SAFETY → content_filter', () => {
      expect(googleBinding.terminationMap['SAFETY']).toBe('content_filter');
    });

    it('T-GG-14 | RECITATION → content_filter', () => {
      expect(googleBinding.terminationMap['RECITATION']).toBe('content_filter');
    });

    it('T-GG-15 | BLOCKLIST → content_filter', () => {
      expect(googleBinding.terminationMap['BLOCKLIST']).toBe('content_filter');
    });

    it('T-GG-16 | PROHIBITED_CONTENT → content_filter', () => {
      expect(googleBinding.terminationMap['PROHIBITED_CONTENT']).toBe('content_filter');
    });

    it('T-GG-17 | SPII → content_filter', () => {
      expect(googleBinding.terminationMap['SPII']).toBe('content_filter');
    });

    it('T-GG-18 | LANGUAGE → content_filter', () => {
      expect(googleBinding.terminationMap['LANGUAGE']).toBe('content_filter');
    });

    it('T-GG-19 | MALFORMED_FUNCTION_CALL → unknown', () => {
      expect(googleBinding.terminationMap['MALFORMED_FUNCTION_CALL']).toBe('unknown');
    });

    it('T-GG-20 | FINISH_REASON_UNSPECIFIED → unknown', () => {
      expect(googleBinding.terminationMap['FINISH_REASON_UNSPECIFIED']).toBe('unknown');
    });

    it('T-GG-21 | OTHER → unknown', () => {
      expect(googleBinding.terminationMap['OTHER']).toBe('unknown');
    });
  });

  // ─── §13.4 — quirks ────────────────────────────────────────────────────

  describe('§13.4 quirks', () => {
    it('T-GG-22 | hasRateLimitHeaders === false', () => {
      expect(googleBinding.quirks.hasRateLimitHeaders).toBe(false);
    });

    it('T-GG-23 | mayRouteModel === false', () => {
      expect(googleBinding.quirks.mayRouteModel).toBe(false);
    });

    it('T-GG-24 | defaultSanitization', () => {
      expect(googleBinding.quirks.defaultSanitization).toEqual({
        stripThinkingTags: true,
        stripJsonFence: true,
      });
    });
  });

  // ─── §13.5 — readRateLimitHeaders ──────────────────────────────────────

  describe('§13.4 classifyError', () => {
    it('T-GG-classify-400 | 400 → InvalidRequestError', () => {
      const err = googleBinding.classifyError({
        aborted: false,
        timeout: false,
        headers: {},
        status: 400,
        bodyText: 'bad request',
      });
      expect(err).toBeInstanceOf(InvalidRequestError);
    });

    it('T-GG-classify-401 | 401 → AuthError', () => {
      const err = googleBinding.classifyError({
        aborted: false,
        timeout: false,
        headers: {},
        status: 401,
        bodyText: 'unauthorized',
      });
      expect(err).toBeInstanceOf(AuthError);
    });

    it('T-GG-classify-429 | 429 → RateLimitError', () => {
      const err = googleBinding.classifyError({
        aborted: false,
        timeout: false,
        headers: {},
        status: 429,
        bodyText: 'rate limited',
      });
      expect(err).toBeInstanceOf(RateLimitError);
    });

    it('T-GG-classify-500 | 500 → TransientProviderError', () => {
      const err = googleBinding.classifyError({
        aborted: false,
        timeout: false,
        headers: {},
        status: 500,
        bodyText: 'server error',
      });
      expect(err).toBeInstanceOf(TransientProviderError);
    });
  });

  describe('§13.5 readRateLimitHeaders', () => {
    it('T-GG-25 | any headers return null (Gemini exposes no rate-limit headers)', () => {
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = googleBinding.readRateLimitHeaders(
        { 'x-ratelimit-remaining-tokens': '12345' },
        clock.nowMono(),
        clock.nowWall(),
      );
      expect(snapshot).toBeNull();
    });
  });
});
