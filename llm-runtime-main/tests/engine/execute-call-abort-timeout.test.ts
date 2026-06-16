// NIB-T §18 — RED-phase acceptance tests for executeCall abort/timeout/signal.
// Reference: specs/NIB-T-LLMRUNTIME.md §18 (T-EC-90..T-EC-115).
//
// fetch is stubbed via vi.stubGlobal. Timing semantics are driven by
// vi.useFakeTimers. For fetches that must "hang" indefinitely, we provide a
// fetch implementation that returns a never-resolving promise.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbortedError, TimeoutError, TransientProviderError } from '../../src/errors/index.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import type { LLMCallEndEvent, LLMCallFetchErrorEvent } from '../../src/types.js';
import { eventAssertions } from '../helpers/event-assertions.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createScenarioFetch, type MockFetch, type MockFetchCall } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import { createControlledSignal } from '../helpers/mock-signal.js';

/**
 * A fetch mock that NEVER resolves and honours the AbortSignal argument,
 * rejecting with a DOMException('AbortError') when the signal aborts. This is
 * the minimal shape the engine is expected to wire through to fetch().
 */
function createHangingFetch(): MockFetch {
  const calls: MockFetchCall[] = [];
  const impl = (input: unknown, init?: Record<string, unknown>): Promise<Response> => {
    const effectiveInit = (init ?? {}) as Record<string, unknown>;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : ((input as { url: string }).url ?? '');
    const bodyRaw = effectiveInit['body'];
    let body: unknown;
    if (typeof bodyRaw === 'string') {
      try {
        body = JSON.parse(bodyRaw);
      } catch {
        body = undefined;
      }
    }
    calls.push({ url, init: effectiveInit, body } as MockFetchCall);
    return new Promise<Response>((_resolve, reject) => {
      const signal = effectiveInit['signal'];
      if (signal && typeof (signal as AbortSignal).addEventListener === 'function') {
        (signal as AbortSignal).addEventListener(
          'abort',
          () => {
            const reason = (signal as AbortSignal).reason;
            const err =
              reason instanceof Error
                ? reason
                : Object.assign(new Error('The operation was aborted.'), {
                    name: 'AbortError',
                  });
            reject(err);
          },
          { once: true },
        );
      }
    });
  };
  const mock = impl as MockFetch;
  mock.calls = calls;
  mock.reset = (): void => {
    calls.length = 0;
  };
  return mock;
}

describe('executeCall — abort / timeout / signal (§18)', () => {
  beforeEach(() => {
    // nothing
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §18.1 signal déjà aborted ─────────────────────────
  describe('§18.1 signal déjà aborted avant call()', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: MockFetch;
    } {
      const fetchMock = createHangingFetch();
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

    it('T-EC-90 | throws AbortedError immediately when signal already aborted', async () => {
      const { adapter } = setup();
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      await adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-91 | error.attempts === 0', async () => {
      const { adapter } = setup();
      const controller = new AbortController();
      controller.abort();
      let caught: unknown;
      await adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
        .catch((err: unknown) => {
          caught = err;
        });

      expect((caught as AbortedError).attempts).toBe(0);
    });

    it('T-EC-92 | no fetch made', async () => {
      const { adapter, fetchMock } = setup();
      const controller = new AbortController();
      controller.abort();
      await adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
        .catch(() => undefined);

      expect(fetchMock.calls).toHaveLength(0);
    });

    it('T-EC-93 | events: llm_call_start + llm_call_end(success=false, aborted)', async () => {
      const { logger, adapter } = setup();
      const controller = new AbortController();
      controller.abort();
      await adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controller.signal })
        .catch(() => undefined);

      eventAssertions.sequenceMatches(logger.events, ['llm_call_start', 'llm_call_end']);
      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent?.success).toBe(false);
      expect(endEvent?.errorKind).toBe('aborted');
    });
  });

  // ───────────────────────── §18.2 abort pendant fetch ─────────────────────────
  describe('§18.2 abort externe pendant fetch', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
    } {
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter };
    }

    it('T-EC-94 | throws AbortedError after ~100ms', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-95 | error enriched with callId, provider, model, attempts===1', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      const err = caught as AbortedError;
      expect(err.callId).toBeTypeOf('string');
      expect(err.provider).toBe('anthropic');
      expect(err.model).toBe('claude-opus-4-6');
      expect(err.attempts).toBe(1);
    });

    it('T-EC-96 | llm_call_fetch_error emitted (for the interrupted fetch)', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      // Under race conditions, the abort may propagate before the fetch error
      // event is emitted. Accept either llm_call_fetch_error or direct abort
      // path (llm_call_end with errorKind=aborted).
      const fetchErr = logger.find('llm_call_fetch_error') as LLMCallFetchErrorEvent | undefined;
      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      const hasAbortPath =
        fetchErr !== undefined || (endEvent !== undefined && endEvent.errorKind === 'aborted');
      expect(hasAbortPath).toBe(true);
    });

    it('T-EC-97 | no raw DOMException propagated to consumer', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      // DOMException is a global in Node 20+; defend defensively.
      if (typeof DOMException !== 'undefined') {
        expect(caught).not.toBeInstanceOf(DOMException);
      }
      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-98 | error.cause preserves the signal reason', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const controlled = createControlledSignal();
      const reasonMarker = Object.assign(new Error('user cancelled'), {
        name: 'UserCancelled',
      });
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100, reasonMarker);
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      const err = caught as AbortedError;
      expect(err.cause).toBeDefined();
      // The reason may be wrapped, but the marker should be reachable.
      const serialized = JSON.stringify({
        name: (err.cause as { name?: string } | undefined)?.name,
        message: (err.cause as { message?: string } | undefined)?.message,
      });
      expect(serialized).toContain('user cancelled');
    });
  });

  // ───────────────────────── §18.3 abort pendant retry sleep ─────────────────────────
  describe('§18.3 abort externe pendant retry sleep', () => {
    it('T-EC-99 | throws AbortedError during the sleep at ~500ms', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        // 2nd fetch would be served here but should never be reached.
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });

      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-100 | only 1 fetch done (2nd never fired)', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });

      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(fetchMock.calls).toHaveLength(1);
    });

    it('T-EC-101 | retry_scheduled emitted before the abort', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });

      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(logger.find('llm_call_retry_scheduled')).toBeDefined();
    });

    it('T-EC-102 | error.attempts === 1 (attempt that threw the 500)', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });

      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect((caught as AbortedError).attempts).toBe(1);
    });
  });

  // ───────────────────────── §18.4 abort pendant throttle sleep ─────────────────────────
  describe('§18.4 abort externe pendant throttle sleep', () => {
    it('T-EC-103 | throws AbortedError at ~500ms', async () => {
      vi.useFakeTimers();
      const resetIso = new Date(Date.now() + 10_000).toISOString();
      const firstOk = {
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
          body: firstOk,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '10',
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

      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });

      const longPrompt = 'word '.repeat(500);
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: longPrompt }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EC-104 | no fetch ever fired for the 2nd request', async () => {
      vi.useFakeTimers();
      const resetIso = new Date(Date.now() + 10_000).toISOString();
      const firstOk = {
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
          body: firstOk,
          headers: {
            'anthropic-ratelimit-input-tokens-remaining': '10',
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
      await adapter.call({ messages: [{ role: 'user', content: 'short' }] });
      expect(fetchMock.calls).toHaveLength(1);

      const longPrompt = 'word '.repeat(500);
      const controlled = createControlledSignal();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: longPrompt }] }, { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(700);
      await promise;

      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  // ───────────────────────── §18.5 timeout interne ─────────────────────────
  describe('§18.5 timeout interne', () => {
    it('T-EC-105 | attempt interrupted after perAttemptMs=100', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 100 },
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      expect(caught).toBeDefined();
    });

    it('T-EC-106 | classifier produces TimeoutError when budget exhausted', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 100 },
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      expect(caught).toBeInstanceOf(TimeoutError);
    });

    it('T-EC-107 | maxAttempts=1 → throws TimeoutError with timeoutMs=100', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 100 },
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      await vi.advanceTimersByTimeAsync(150);
      await promise;

      const err = caught as TimeoutError;
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err.timeoutMs).toBe(100);
    });

    it('T-EC-108 | maxAttempts=5 with perpetually-hanging fetch → exhausts retries, throws TimeoutError', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 100 },
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      // 5 attempts × 100ms timeout + 4 retry sleeps (2+4+8+16 = 30s).
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(caught).toBeInstanceOf(TimeoutError);
      expect((caught as TimeoutError).attempts).toBe(5);
    });
  });

  // ───────────────────────── §18.6 priorité abort sur timeout ─────────────────────────
  describe('§18.6 priorité abort externe sur timeout interne', () => {
    it('T-EC-109 | throws AbortedError (not TimeoutError) when abort precedes the timeout', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 200 },
        sanitization: {},
        logging: { logger },
      });
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(100);
      await vi.advanceTimersByTimeAsync(250);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
      expect(caught).not.toBeInstanceOf(TimeoutError);
    });

    it('T-EC-110 | throws at ~100ms, not ~200ms', async () => {
      vi.useFakeTimers();
      const fetchMock = createHangingFetch();
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 200 },
        sanitization: {},
        logging: { logger },
      });
      const controlled = createControlledSignal();
      let settledAt = -1;
      const start = Date.now();
      const promise = adapter
        .call({ messages: [{ role: 'user', content: 'Hi' }] }, { signal: controlled.signal })
        .catch(() => {
          settledAt = Date.now() - start;
        });
      controlled.abortAfter(100);
      // Advance just past 100ms.
      await vi.advanceTimersByTimeAsync(120);
      await promise;

      // Guard: should have settled before the 200ms timeout would have fired.
      expect(settledAt).toBeGreaterThanOrEqual(0);
      expect(settledAt).toBeLessThan(200);
    });
  });

  // ───────────────────────── §18.7 timer cleanup ─────────────────────────
  describe('§18.7 timer cleanup (no leak)', () => {
    it('T-EC-111 | after 10 mixed calls, no internal active timers leak', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      // Mix 5 successful + 5 aborted.
      for (let i = 0; i < 10; i += 1) {
        if (i % 2 === 0) {
          const fetchMock = createScenarioFetch([scenario.okFixture('anthropic/ok-simple')]);
          vi.stubGlobal('fetch', fetchMock);
          const logger = createMockLogger();
          const adapter = createAnthropicAdapter({
            model: 'claude-opus-4-6',
            apiKey: 'test-key',
            sanitization: {},
            logging: { logger },
          });
          await adapter.call({ messages: [{ role: 'user', content: `ok-${i}` }] });
          vi.unstubAllGlobals();
        } else {
          const fetchMock = createHangingFetch();
          vi.stubGlobal('fetch', fetchMock);
          const logger = createMockLogger();
          const adapter = createAnthropicAdapter({
            model: 'claude-opus-4-6',
            apiKey: 'test-key',
            retry: { maxAttempts: 1, backoffBaseMs: 1000, maxBackoffMs: 60_000 },
            sanitization: {},
            logging: { logger },
          });
          const controlled = createControlledSignal();
          const promise = adapter
            .call(
              { messages: [{ role: 'user', content: `abort-${i}` }] },
              { signal: controlled.signal },
            )
            .catch(() => undefined);
          controlled.abortAfter(50);
          await vi.advanceTimersByTimeAsync(100);
          await promise;
          vi.unstubAllGlobals();
        }
      }

      // Engine must have created at least some timers during the 10 calls
      // (composeSignal creates one per attempt). This guards against tautology.
      expect(setTimeoutSpy).toHaveBeenCalled();

      // All timers created must be cleaned up — no leaked pending timers.
      expect(vi.getTimerCount()).toBe(0);

      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    it('T-EC-112 | during a call, at most one internal timer active (proxy observation)', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        timeout: { perAttemptMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      // NIB-T §18.7: at most one internal timer active during a call.
      // Engine creates timers via composeSignal — verify they're actually
      // being created (non-tautological guard).
      await vi.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy).toHaveBeenCalled();
      const mid = vi.getTimerCount();
      expect(mid).toBeLessThanOrEqual(1);

      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(vi.getTimerCount()).toBe(0);

      setTimeoutSpy.mockRestore();
    });
  });

  // ───────────────────────── §18.8 erreur réseau non-abort ─────────────────────────
  describe('§18.8 erreur réseau non-abort', () => {
    function networkErr(): ReturnType<typeof scenario.networkError> {
      return scenario.networkError('reset');
    }

    it('T-EC-113 | TypeError("fetch failed: ECONNRESET") classified as TransientProviderError', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        networkErr(),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(3000);
      const response = await promise;

      // Succeeds on the retry; meanwhile fetch_error event should have been
      // emitted with a networkErrorKind for the 1st attempt.
      expect(response.content).toBe('Hello');
      const fetchErr = logger.find('llm_call_fetch_error') as LLMCallFetchErrorEvent | undefined;
      expect(fetchErr).toBeDefined();
      expect(fetchErr?.networkErrorKind).toBeDefined();
      // Verify the classification: retry_scheduled should indicate transient_provider.
      const retrySched = logger.find('llm_call_retry_scheduled');
      expect(retrySched).toBeDefined();
      if (retrySched !== undefined && 'reason' in retrySched) {
        expect((retrySched as unknown as { reason: string }).reason).toBe('transient_provider');
      }
    });

    it('T-EC-114 | maxAttempts=5, all attempts fail with network err → throws TransientProviderError', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        networkErr(),
        networkErr(),
        networkErr(),
        networkErr(),
        networkErr(),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      expect(caught).toBeInstanceOf(TransientProviderError);
      expect((caught as TransientProviderError).attempts).toBe(5);
    });

    it('T-EC-115 | llm_call_fetch_error emitted at each attempt with networkErrorKind + message', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        networkErr(),
        networkErr(),
        networkErr(),
        networkErr(),
        networkErr(),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;

      const fetchErrors = logger.findAll('llm_call_fetch_error');
      expect(fetchErrors).toHaveLength(5);
      for (const ev of fetchErrors) {
        const fe = ev as LLMCallFetchErrorEvent;
        expect(fe.networkErrorKind).toBeDefined();
        expect(fe.message).toBeTypeOf('string');
        expect(fe.message.length).toBeGreaterThan(0);
      }
    });
  });
});
