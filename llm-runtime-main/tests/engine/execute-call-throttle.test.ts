// NIB-T §17 — RED-phase acceptance tests for executeCall throttle.
// Reference: specs/NIB-T-LLMRUNTIME.md §17 (T-EC-70..T-EC-79).
//
// These tests set up a two-call sequence per scenario:
// 1st call "plants" a RateLimitSnapshot via rate-limit response headers;
// 2nd call, with a larger estimatedTokens, should trigger the throttle gate
// before the fetch and emit llm_call_throttled.
// fetch is stubbed via vi.stubGlobal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbortedError } from '../../src/errors/index.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createGoogleAdapter } from '../../src/factories/google.js';
import type { LLMCallEndEvent, LLMCallThrottledEvent, LLMRequest } from '../../src/types.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createScenarioFetch } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import { createControlledSignal } from '../helpers/mock-signal.js';

const LONG_PROMPT = 'word '.repeat(500); // ~500 words → high estimatedTokens.

describe('executeCall — throttle (§17)', () => {
  beforeEach(() => {
    // no global hook
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §17.1 throttle proactif déclenche ─────────────────────────
  describe('§17.1 throttle proactif', () => {
    function buildAnthropicAdapterWithThrottle(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const resetIso = new Date(Date.now() + 30_000).toISOString();
      // 1st fetch: returns 200 but with rate-limit headers indicating tiny budget remaining.
      // 2nd fetch: returns 200 again (post-throttle).
      const firstBody = {
        id: 'msg_ok1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const secondBody = { ...firstBody, id: 'msg_ok2' };
      const fetchMock = createScenarioFetch([
        {
          status: 200,
          body: firstBody,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '100',
            'anthropic-ratelimit-input-tokens-reset': resetIso,
          },
        },
        {
          status: 200,
          body: secondBody,
          headers: {},
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-70 | before 2nd fetch, llm_call_throttled event emitted with correct fields', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = buildAnthropicAdapterWithThrottle();
      const req1: LLMRequest = { messages: [{ role: 'user', content: 'short' }] };
      await adapter.call(req1);
      logger.reset();

      const req2: LLMRequest = { messages: [{ role: 'user', content: LONG_PROMPT }] };
      const promise = adapter.call(req2);
      // Flush microtasks so throttle gate fires before the fetch.
      await vi.advanceTimersByTimeAsync(0);

      const throttled = logger.find('llm_call_throttled') as LLMCallThrottledEvent | undefined;
      expect(throttled).toBeDefined();
      expect(throttled?.waitMs).toBeGreaterThan(0);
      expect(throttled?.waitMs).toBeLessThanOrEqual(30_000);
      expect(throttled?.reason).toBe('budget_insufficient');
      expect(throttled?.snapshotState).toBe('known');
      expect(throttled?.estimatedTokens).toBeGreaterThan(0);

      await vi.advanceTimersByTimeAsync(30_000);
      await promise;
    });

    it('T-EC-71 | adapter.call waits ~30_000ms before firing fetch', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = buildAnthropicAdapterWithThrottle();
      const req1: LLMRequest = { messages: [{ role: 'user', content: 'short' }] };
      await adapter.call(req1);
      expect(fetchMock.calls).toHaveLength(1);

      const req2: LLMRequest = { messages: [{ role: 'user', content: LONG_PROMPT }] };
      const promise = adapter.call(req2);
      // Before ~30s elapses, no 2nd fetch.
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchMock.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(fetchMock.calls).toHaveLength(2);
    });

    it('T-EC-72 | fetch eventually happens after the wait', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = buildAnthropicAdapterWithThrottle();
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });

      const promise = adapter.call({
        messages: [{ role: 'user', content: LONG_PROMPT }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await promise;

      expect(fetchMock.calls).toHaveLength(2);
    });
  });

  // ───────────────────────── §17.2 pas de throttle si snapshot null ─────────────────────────
  describe('§17.2 pas de throttle si snapshot null', () => {
    it('T-EC-73 | 1st call (no pre-existing snapshot) emits no llm_call_throttled', async () => {
      const fetchMock = createScenarioFetch([scenario.okFixture('anthropic/ok-simple')]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      await adapter.call({ messages: [{ role: 'user', content: LONG_PROMPT }] });

      expect(logger.find('llm_call_throttled')).toBeUndefined();
    });

    it('T-EC-74 | direct fetch on 1st call (no delay)', async () => {
      const fetchMock = createScenarioFetch([scenario.okFixture('anthropic/ok-simple')]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });

      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  // ───────────────────────── §17.3 Gemini: hasRateLimitHeaders: false ─────────────────────────
  describe('§17.3 pas de throttle si binding hasRateLimitHeaders=false (Gemini)', () => {
    it('T-EC-75 | 5 consecutive Gemini calls — no llm_call_throttled ever', async () => {
      const okBody = {
        candidates: [
          {
            content: { parts: [{ text: 'Hi' }], role: 'model' },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      };
      const fetchMock = createScenarioFetch(
        Array.from({ length: 5 }, () => ({ status: 200, body: okBody })),
      );
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createGoogleAdapter({
        model: 'gemini-2.0-flash',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      for (let i = 0; i < 5; i += 1) {
        await adapter.call({
          messages: [{ role: 'user', content: LONG_PROMPT }],
        });
      }

      expect(logger.findAll('llm_call_throttled')).toHaveLength(0);
    });
  });

  // ───────────────────────── §17.4 throttle annulé par abort ─────────────────────────
  describe('§17.4 throttle annulé par abort externe', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const resetIso = new Date(Date.now() + 30_000).toISOString();
      const firstBody = {
        id: 'msg_ok1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const fetchMock = createScenarioFetch([
        {
          status: 200,
          body: firstBody,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '100',
            'anthropic-ratelimit-input-tokens-reset': resetIso,
          },
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-76 | abort at ~100ms throws AbortedError (not waiting 30s)', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });

      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: LONG_PROMPT }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-77 | llm_call_throttled emitted then llm_call_end(success=false, errorKind=aborted)', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });
      logger.reset();

      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: LONG_PROMPT }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      expect(logger.find('llm_call_throttled')).toBeDefined();
      // Verify ordering: throttled must appear before end.
      const throttledIdx = logger.events.findIndex((e) => e.eventType === 'llm_call_throttled');
      const endIdx = logger.events.findIndex((e) => e.eventType === 'llm_call_end');
      expect(throttledIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThan(throttledIdx);

      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent?.success).toBe(false);
      expect(endEvent?.errorKind).toBe('aborted');
    });

    it('T-EC-78 | no fetch ever fired after abort during throttle wait', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });
      expect(fetchMock.calls).toHaveLength(1);

      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: LONG_PROMPT }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      // Only the initial fetch; no 2nd attempt.
      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  // ───────────────────────── §17.5 snapshot mis à jour après succès ─────────────────────────
  describe('§17.5 snapshot mis à jour après succès', () => {
    it('T-EC-79 | after a successful call with fresh headers, the snapshot reflects new budget', async () => {
      vi.useFakeTimers();
      const resetIso1 = new Date(Date.now() + 30_000).toISOString();
      const resetIso2 = new Date(Date.now() + 60_000).toISOString();

      const body1 = {
        id: 'msg1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: 'Hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      const body2 = { ...body1, id: 'msg2' };

      // 1st call: low remaining (100 tokens, reset in 30s).
      // 2nd call: snapshot budget exhausted → should throttle ~30s.
      // After 2nd success: new snapshot with high remaining (10000 tokens, reset in 60s).
      // 3rd call: no throttle (budget sufficient).
      const fetchMock = createScenarioFetch([
        {
          status: 200,
          body: body1,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '100',
            'anthropic-ratelimit-input-tokens-reset': resetIso1,
          },
        },
        {
          status: 200,
          body: body2,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '10000',
            'anthropic-ratelimit-input-tokens-reset': resetIso2,
          },
        },
        {
          status: 200,
          body: { ...body1, id: 'msg3' },
          headers: {},
        },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });

      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });

      const p2 = adapter.call({
        messages: [{ role: 'user', content: LONG_PROMPT }],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await p2;

      // After 2nd call: new snapshot with ample budget → 3rd call must not
      // throttle even for a long prompt.
      logger.reset();
      const p3 = adapter.call({
        messages: [{ role: 'user', content: LONG_PROMPT }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await p3;

      expect(logger.find('llm_call_throttled')).toBeUndefined();
    });
  });
});
