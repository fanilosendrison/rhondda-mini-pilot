// NIB-T §16 — RED-phase acceptance + property tests for executeCall retry.
// Reference: specs/NIB-T-LLMRUNTIME.md §16 (T-EC-30..T-EC-61 + P-EC-c).
//
// fetch is stubbed globally; we use createScenarioFetch to program a suite of
// HTTP responses (e.g. [429, 200]) and assert the engine's retry behaviour via
// the public adapter surface + the in-memory logger.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthError, ResponseParseError, TransientProviderError } from '../../src/errors/index.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import type {
  LLMCallEndEvent,
  LLMCallProviderErrorEvent,
  LLMCallRetryScheduledEvent,
  LLMRequest,
  RetryPolicy,
} from '../../src/types.js';
import { deepFreeze } from '../helpers/deep-freeze.js';
import { eventAssertions } from '../helpers/event-assertions.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createScenarioFetch, type MockResponse } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  backoffBaseMs: 2000,
  maxBackoffMs: 60_000,
};

describe('executeCall — retry (§16)', () => {
  beforeEach(() => {
    // nothing global
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §16.1 429 → 200 ─────────────────────────
  describe('§16.1 retry sur 429 puis succès', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const fetchMock = createScenarioFetch([
        scenario.rateLimit(1),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-30 | response returned with content from the 2nd response', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.content).toBe('Hello');
    });

    it('T-EC-31 | response.attemptCount === 2', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
    });

    it('T-EC-32 | mockFetch.calls.length === 2', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(fetchMock.calls).toHaveLength(2);
    });

    it('T-EC-33 | event sequence: start, attempt_start(0), provider_error(429, retryable), retry_scheduled(1, 1000ms), attempt_start(1), end(success)', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      eventAssertions.sequenceMatches(logger.events, [
        'llm_call_start',
        'llm_call_attempt_start',
        'llm_call_provider_error',
        'llm_call_retry_scheduled',
        'llm_call_attempt_start',
        'llm_call_end',
      ]);
      // Verify attempt fields on attempt_start events.
      const attemptStarts = logger.findAll('llm_call_attempt_start');
      expect(attemptStarts.map((e) => (e as unknown as { attempt: number }).attempt)).toEqual([
        0, 1,
      ]);

      const providerErr = logger.find('llm_call_provider_error') as
        | LLMCallProviderErrorEvent
        | undefined;
      expect(providerErr?.status).toBe(429);
      expect(providerErr?.retryable).toBe(true);

      const retryScheduled = logger.find('llm_call_retry_scheduled') as
        | LLMCallRetryScheduledEvent
        | undefined;
      expect(retryScheduled?.attempt).toBe(1);
      expect(retryScheduled?.delayMs).toBe(1000);
      expect(retryScheduled?.reason).toBe('transient_rate_limit');

      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent?.success).toBe(true);
      expect(endEvent?.attemptCount).toBe(2);
    });

    it('T-EC-34 | retry sleep lasts ~1000ms (Retry-After header "1")', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      // Drain microtasks so the first fetch resolves and scheduler arms the timer.
      await vi.advanceTimersByTimeAsync(0);
      // Before the timer fires, only 1 fetch should have happened.
      expect(fetchMock.calls.length).toBeLessThanOrEqual(1);
      // Advance by just under 1 second: still only 1 fetch.
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchMock.calls).toHaveLength(1);
      // Advance past the 1-second mark: 2nd fetch fires.
      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(fetchMock.calls).toHaveLength(2);
    });
  });

  // ───────────────────────── §16.2 500 → 200, backoff ─────────────────────────
  describe('§16.2 retry sur 500 puis 200 (backoff 2000ms)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
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
      return { logger, adapter, fetchMock };
    }

    it('T-EC-35 | response.attemptCount === 2, success', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
      expect(response.content).toBe('Hello');
    });

    it('T-EC-36 | delay between fetches is 2000ms (backoff 2000*2^0)', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchMock.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2);
      await promise;
      expect(fetchMock.calls).toHaveLength(2);
    });

    it('T-EC-37 | retry_scheduled.reason === "transient_provider", delayMs === 2000', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const retryScheduled = logger.find('llm_call_retry_scheduled') as
        | LLMCallRetryScheduledEvent
        | undefined;
      expect(retryScheduled).toBeDefined();
      expect(retryScheduled?.reason).toBe('transient_provider');
      expect(retryScheduled?.delayMs).toBe(2000);
    });
  });

  // ───────────────────────── §16.3 retry épuisé → throw ─────────────────────────
  describe('§16.3 retries multiples épuisés puis throw', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
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
      return { logger, adapter, fetchMock };
    }

    async function runToExhaustion(
      adapter: ReturnType<typeof createAnthropicAdapter>,
    ): Promise<unknown> {
      let caught: unknown;
      const promise = adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });
      // 4 retry sleeps between 5 attempts: 2000, 4000, 8000, 16000 = 30_000ms.
      await vi.advanceTimersByTimeAsync(30_000);
      await promise;
      return caught;
    }

    it('T-EC-38 | adapter.call throws TransientProviderError', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const err = await runToExhaustion(adapter);

      expect(err).toBeInstanceOf(TransientProviderError);
    });

    it('T-EC-39 | error.attempts === 5', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const err = (await runToExhaustion(adapter)) as TransientProviderError;

      expect(err.attempts).toBe(5);
    });

    it('T-EC-40 | error.callId defined and matches events', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const err = (await runToExhaustion(adapter)) as TransientProviderError;

      expect(err.callId).toBeDefined();
      expect(err.callId).toBeTypeOf('string');
      const startEvent = logger.find('llm_call_start');
      expect(startEvent?.callId).toBe(err.callId);
    });

    it('T-EC-41 | error.provider === "anthropic", error.model === "claude-opus-4-6"', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const err = (await runToExhaustion(adapter)) as TransientProviderError;

      expect(err.provider).toBe('anthropic');
      expect(err.model).toBe('claude-opus-4-6');
    });

    it('T-EC-42 | mockFetch.calls.length === 5', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      await runToExhaustion(adapter);

      expect(fetchMock.calls).toHaveLength(5);
    });

    it('T-EC-43 | 4 retry_scheduled events emitted with attempt progression [1,2,3,4]', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await runToExhaustion(adapter);

      const retries = logger.findAll('llm_call_retry_scheduled');
      expect(retries).toHaveLength(4);
      // Verify attempt field progresses from 1 to 4 (retry after attempt N).
      expect(retries.map((e) => (e as unknown as { attempt: number }).attempt)).toEqual([
        1, 2, 3, 4,
      ]);
    });

    it('T-EC-44 | llm_call_end success=false, errorKind=transient_provider, attemptCount=5', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await runToExhaustion(adapter);

      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent).toBeDefined();
      expect(endEvent?.success).toBe(false);
      expect(endEvent?.errorKind).toBe('transient_provider');
      expect(endEvent?.attemptCount).toBe(5);
    });

    it('T-EC-45 | adapter.stats.totalCalls === 0 (failure does not increment)', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      await runToExhaustion(adapter);

      expect(adapter.stats.totalCalls).toBe(0);
    });
  });

  // ───────────────────────── §16.4 erreur fatale 401 ─────────────────────────
  describe('§16.4 erreur fatale, pas de retry', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const fetchMock = createScenarioFetch([scenario.authError()]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-46 | throws AuthError, error.attempts === 1', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(AuthError);
      expect((caught as AuthError).attempts).toBe(1);
    });

    it('T-EC-47 | mockFetch.calls.length === 1 (no retry)', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      expect(fetchMock.calls).toHaveLength(1);
    });

    it('T-EC-48 | retry_scheduled never emitted', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      eventAssertions.noRetryScheduled(logger.events);
    });

    it('T-EC-49 | llm_call_end success=false, errorKind=auth', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent?.success).toBe(false);
      expect(endEvent?.errorKind).toBe('auth');
    });
  });

  // ───────────────────────── §16.5 429 HTTP-date ─────────────────────────
  describe('§16.5 429 avec Retry-After HTTP-date', () => {
    it('T-EC-50 | delay computed ~5000ms (diff wall-clock)', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17T12:00:00Z'));
      const fetchMock = createScenarioFetch([
        {
          status: 429,
          body: { error: 'rate limited' },
          headers: { 'retry-after': 'Fri, 17 Apr 2026 12:00:05 GMT' },
        },
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      // Advance enough for the 5-second retry gap.
      await vi.advanceTimersByTimeAsync(5000);
      await promise;

      const retryScheduled = logger.find('llm_call_retry_scheduled') as
        | LLMCallRetryScheduledEvent
        | undefined;
      expect(retryScheduled).toBeDefined();
      // Accept a small tolerance window around 5000ms.
      expect(retryScheduled?.delayMs).toBeGreaterThanOrEqual(4500);
      expect(retryScheduled?.delayMs).toBeLessThanOrEqual(5500);
    });

    it('T-EC-51 | success on 2nd call', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17T12:00:00Z'));
      const fetchMock = createScenarioFetch([
        {
          status: 429,
          body: { error: 'rate limited' },
          headers: { 'retry-after': 'Fri, 17 Apr 2026 12:00:05 GMT' },
        },
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(5000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
      expect(response.content).toBe('Hello');
    });
  });

  // ───────────────────────── §16.6 ResponseParseError fatale ─────────────────────────
  describe('§16.6 ResponseParseError fatale (HTML body)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      // Body non-JSON : we emulate this by supplying a string body with
      // non-JSON content. The mock-fetch helper JSON.stringifies the body, so
      // we hand it a scenario that *returns* a response with a plain-text body
      // via the throwError escape hatch would not work; instead craft a raw
      // MockResponse where body is a string that won't parse as meaningful
      // JSON (it still gets stringified to `"<html>500 error</html>"`).
      const badBody: MockResponse = {
        status: 200,
        // intentionally not an object: the adapter should see a payload that
        // fails provider-shape parsing (missing required fields), triggering
        // ResponseParseError classification.
        body: '<html>500 error</html>',
        headers: { 'content-type': 'text/html' },
      };
      const fetchMock = createScenarioFetch([badBody]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-52 | throws ResponseParseError, error.attempts === 1', async () => {
      const { adapter } = setup();
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(ResponseParseError);
      expect((caught as ResponseParseError).attempts).toBe(1);
    });

    it('T-EC-53 | llm_call_parse_error event emitted', async () => {
      const { logger, adapter } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      expect(logger.find('llm_call_parse_error')).toBeDefined();
    });

    it('T-EC-54 | no retry (fatal)', async () => {
      const { adapter, fetchMock, logger } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      expect(fetchMock.calls).toHaveLength(1);
      eventAssertions.noRetryScheduled(logger.events);
    });
  });

  // ───────────────────────── §16.7 erreur inconnue → transient_unknown ─────────────────────────
  describe('§16.7 erreur inconnue classifiée transient_unknown', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const fetchMock = createScenarioFetch([
        {
          status: 0,
          body: null,
          headers: {},
          throwError: new Error('weird thing'),
        },
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    it('T-EC-55 | success on 2nd attempt', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
      expect(response.content).toBe('Hello');
    });

    it('T-EC-56 | llm_call_unknown_error_classified emitted with rawMessage="weird thing"', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const unknownEvent = logger.find('llm_call_unknown_error_classified');
      expect(unknownEvent).toBeDefined();
      expect(unknownEvent).toMatchObject({ rawMessage: 'weird thing' });
    });

    it('T-EC-57 | retry_scheduled.reason === "transient_unknown"', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const retryScheduled = logger.find('llm_call_retry_scheduled') as
        | LLMCallRetryScheduledEvent
        | undefined;
      expect(retryScheduled?.reason).toBe('transient_unknown');
    });
  });

  // ───────────────────────── §16.8 429 invalide le snapshot throttle ─────────────────────────
  describe('§16.8 429 invalide le snapshot throttle', () => {
    it('T-EC-58 | after 429 without rate-limit headers, internal snapshot becomes "unknown"', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.rateLimit(0),
        scenario.okFixture('anthropic/ok-simple'),
        // Third response for follow-up call to verify snapshot invalidation.
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
      // Verify snapshot invalidation: follow-up call should NOT emit
      // llm_call_throttled because 429 without rate-limit headers
      // invalidates the snapshot to "unknown".
      const followupPromise = adapter.call({
        messages: [{ role: 'user', content: 'followup' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await followupPromise.catch(() => undefined);
      expect(logger.find('llm_call_throttled')).toBeUndefined();
    });

    it('T-EC-59 | next call does not emit llm_call_throttled (snapshot state unknown)', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        scenario.rateLimit(0),
        scenario.okFixture('anthropic/ok-simple'),
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      // First request: 429 then 200; snapshot becomes "unknown" after 429
      // with no exploitable headers.
      const p1 = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      await p1;
      logger.reset();

      // Second request: should NOT emit a throttled event even if internal
      // budget tracking would otherwise fire — because state is "unknown".
      const p2 = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(0);
      await p2;

      expect(logger.find('llm_call_throttled')).toBeUndefined();
    });

    it('T-EC-60 | 429 with exploitable rate-limit headers updates the snapshot (not invalidated)', async () => {
      vi.useFakeTimers();
      const fetchMock = createScenarioFetch([
        {
          status: 429,
          body: { error: 'rate limited' },
          headers: {
            'retry-after': '1',
            'anthropic-ratelimit-input-tokens-remaining': '5000',
            'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 30_000).toISOString(),
          },
        },
        scenario.okFixture('anthropic/ok-simple'),
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      const promise = adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });
      await vi.advanceTimersByTimeAsync(2000);
      const response = await promise;

      expect(response.attemptCount).toBe(2);
      // Proxy: if snapshot were invalidated, subsequent behaviour would
      // differ — not asserting the internal state directly (not observable)
      // but verifying the retry completed with the header-informed delay.
      const retryScheduled = logger.find('llm_call_retry_scheduled') as
        | LLMCallRetryScheduledEvent
        | undefined;
      expect(retryScheduled?.delayMs).toBe(1000);
    });
  });

  // ───────────────────────── §16.9 enrichissement erreurs ─────────────────────────
  describe('§16.9 enrichissement des erreurs (engine overrides binding values)', () => {
    it('T-EC-61 | engine overwrites provider/model/callId/attempts on any error before propagating', async () => {
      // We simulate a binding throw via a 401 response (classifier will emit
      // an AuthError) and verify the engine stamps the real provider+model.
      const fetchMock = createScenarioFetch([scenario.authError()]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: DEFAULT_RETRY,
        sanitization: {},
        logging: { logger },
      });
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(AuthError);
      const err = caught as AuthError;
      expect(err.provider).toBe('anthropic');
      expect(err.model).toBe('claude-opus-4-6');
      expect(err.callId).toBeTypeOf('string');
      expect(err.attempts).toBe(1);
    });
  });

  // ───────────────────────── §16.10 Property ─────────────────────────
  describe('§16.10 properties', () => {
    it('P-EC-c | on scenario [200], no retry_scheduled event emitted (10 request variations)', async () => {
      const variations: LLMRequest[] = Array.from({ length: 10 }, (_, i) =>
        deepFreeze<LLMRequest>({
          messages: [{ role: 'user', content: `prompt-${i}` }],
          temperature: i / 20,
          maxTokens: 100 + i * 10,
        }),
      );
      for (const request of variations) {
        const fetchMock = createScenarioFetch([scenario.okFixture('anthropic/ok-simple')]);
        vi.stubGlobal('fetch', fetchMock);
        const logger = createMockLogger();
        const adapter = createAnthropicAdapter({
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          retry: DEFAULT_RETRY,
          sanitization: {},
          logging: { logger },
        });
        await adapter.call(request);

        eventAssertions.noRetryScheduled(logger.events);
        vi.unstubAllGlobals();
      }
    });
  });
});
