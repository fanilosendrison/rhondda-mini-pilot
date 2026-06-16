// NIB-T §21 — Contract invariants for the error taxonomy.
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §21.1 structure, §21.2 sérialisation, §21.3 enrichissement,
// §21.4 cause, §21.5 champs spécifiques.

import { describe, expect, it, vi } from 'vitest';

import {
  AbortedError,
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  LLMRuntimeError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from '../../src/errors/index.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import {
  ALL_LLM_ERROR_KINDS,
  isRetriableKind,
  type LLMErrorKind,
} from '../../src/services/error-kind.js';
import type { AdapterConfig, LLMRequest } from '../../src/types.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createScenarioFetch } from '../helpers/mock-fetch.js';

import { createControlledSignal } from '../helpers/mock-signal.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ALL_SUBCLASSES = [
  { name: 'AuthError', Ctor: AuthError, kind: 'auth' },
  { name: 'InvalidRequestError', Ctor: InvalidRequestError, kind: 'invalid_request' },
  { name: 'RateLimitError', Ctor: RateLimitError, kind: 'rate_limit' },
  { name: 'OverloadedError', Ctor: OverloadedError, kind: 'overloaded' },
  { name: 'TransientProviderError', Ctor: TransientProviderError, kind: 'transient_provider' },
  { name: 'ProviderProtocolError', Ctor: ProviderProtocolError, kind: 'provider_protocol' },
  { name: 'ResponseParseError', Ctor: ResponseParseError, kind: 'response_parse' },
  { name: 'TimeoutError', Ctor: TimeoutError, kind: 'timeout' },
  { name: 'AbortedError', Ctor: AbortedError, kind: 'aborted' },
  { name: 'SilentTruncationError', Ctor: SilentTruncationError, kind: 'silent_truncation' },
  { name: 'ContentFilterError', Ctor: ContentFilterError, kind: 'content_filter' },
] as const;

function baseConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    model: 'claude-test',
    apiKey: 'sk-test',
    retry: { maxAttempts: 1, backoffBaseMs: 10, maxBackoffMs: 100 },
    timeout: { perAttemptMs: 5_000 },
    sanitization: {},
    ...overrides,
  };
}

const SIMPLE_REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

// ─── §21.1 Structure de la taxonomie ───────────────────────────────────────

describe('errors contracts', () => {
  describe('§21.1 structure', () => {
    it('C-ER-01 | each of the 11 subclasses extends LLMRuntimeError', () => {
      for (const { Ctor } of ALL_SUBCLASSES) {
        const instance = new Ctor();
        expect(instance).toBeInstanceOf(LLMRuntimeError);
      }
    });

    it('C-ER-02 | LLMRuntimeError extends Error', () => {
      const instance = new AuthError();
      expect(instance).toBeInstanceOf(Error);
    });

    it('C-ER-03 | each concrete instance has a kind in LLMErrorKind', () => {
      for (const { Ctor } of ALL_SUBCLASSES) {
        const instance = new Ctor();
        expect(typeof instance.kind).toBe('string');
        expect(ALL_LLM_ERROR_KINDS).toContain(instance.kind);
      }
    });

    it('C-ER-04 | kind is readonly (TS + runtime mutation is no-op or throws)', () => {
      const err = new AuthError();
      const original = err.kind;
      try {
        // @ts-expect-error — kind is declared readonly in the public surface.
        err.kind = 'x';
      } catch {
        // Strict mode or frozen: TypeError is acceptable.
      }
      // Observable value must remain the original kind, regardless of mode.
      expect(err.kind).toBe(original);
    });

    it('C-ER-05 | isRetriableKind === true for retriable kinds', () => {
      const retriable: LLMErrorKind[] = [
        'rate_limit',
        'overloaded',
        'transient_provider',
        'timeout',
      ];
      for (const kind of retriable) {
        expect(isRetriableKind(kind)).toBe(true);
      }
    });

    it('C-ER-06 | isRetriableKind === false for the 7 non-retriable kinds', () => {
      const fatal: LLMErrorKind[] = [
        'auth',
        'invalid_request',
        'provider_protocol',
        'response_parse',
        'aborted',
        'silent_truncation',
        'content_filter',
      ];
      for (const kind of fatal) {
        expect(isRetriableKind(kind)).toBe(false);
      }
    });
  });

  // ─── §21.2 Sérialisation ─────────────────────────────────────────────────

  describe('§21.2 serialization', () => {
    it('C-ER-07 | JSON.stringify produces object with expected fields', () => {
      for (const { Ctor } of ALL_SUBCLASSES) {
        const instance = new Ctor({ message: 'something went wrong' });
        const json = JSON.stringify(instance);
        expect(() => JSON.parse(json)).not.toThrow();
        // At minimum, serialized output should preserve callId/provider/model if set.
        const withContext = new Ctor({
          message: 'test',
          callId: 'TEST_CALL_ID',
          provider: 'anthropic',
          model: 'test-model',
        });
        const parsedCtx = JSON.parse(JSON.stringify(withContext)) as Record<string, unknown>;
        expect(parsedCtx['callId']).toBe('TEST_CALL_ID');
        expect(parsedCtx['provider']).toBe('anthropic');
        expect(parsedCtx['model']).toBe('test-model');
      }
    });

    it('C-ER-08 | error.name is the class name', () => {
      for (const { Ctor, name } of ALL_SUBCLASSES) {
        const instance = new Ctor();
        expect(instance.name).toBe(name);
      }
    });

    it('C-ER-09 | error.message is a non-empty string', () => {
      for (const { Ctor } of ALL_SUBCLASSES) {
        const instance = new Ctor();
        expect(typeof instance.message).toBe('string');
        expect(instance.message.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── §21.3 Enrichissement au throw ───────────────────────────────────────

  describe('§21.3 enrichment on throw', () => {
    it('C-ER-10 | InvalidRequestError (empty messages) enriched with callId, provider, model, attempts=0', async () => {
      const adapter = createAnthropicAdapter(baseConfig());
      const emptyRequest: LLMRequest = { messages: [] };
      try {
        await adapter.call(emptyRequest);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidRequestError);
        const err = e as InvalidRequestError;
        expect(typeof err.callId).toBe('string');
        expect(err.provider).toBe(adapter.provider);
        expect(err.model).toBe(adapter.model);
        expect(err.attempts).toBe(0);
      }
    });

    it('C-ER-11 | TransientProviderError after 5 × 500 has attempts === 5', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
      ]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 5 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TransientProviderError);
        const err = e as TransientProviderError;
        expect(typeof err.callId).toBe('string');
        expect(err.attempts).toBe(5);
      }
    });

    it('C-ER-12 | AuthError (401 at first attempt) has attempts === 1', async () => {
      const fetchImpl = createScenarioFetch([scenario.authError()]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AuthError);
        expect((e as AuthError).attempts).toBe(1);
      }
    });

    it('C-ER-13 | AbortedError (signal already aborted) has attempts === 0', async () => {
      const ctrl = createControlledSignal();
      ctrl.abort(new Error('pre-aborted'));
      const adapter = createAnthropicAdapter(baseConfig());
      try {
        await adapter.call(SIMPLE_REQUEST, { signal: ctrl.signal });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AbortedError);
        expect((e as AbortedError).attempts).toBe(0);
      }
    });

    it('C-ER-14 | AbortedError (abort during retry sleep on attempt 2) has attempts === 2', async () => {
      // Use fake timers to avoid CI flakiness from real-time scheduling.
      vi.useFakeTimers();
      // 3 server errors so the engine retries. backoffBaseMs: 500 means:
      //   sleep after attempt 0 = 500ms, sleep after attempt 1 = 1000ms.
      // Abort at 600ms fires during the 1000ms sleep (starting at ~500ms),
      // when attempt === 2 in the loop — i.e. 2 completed attempts.
      const fetchImpl = createScenarioFetch([
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.ok('anthropic', 'ok'),
      ]);
      const ctrl = createControlledSignal();
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 5, backoffBaseMs: 500, maxBackoffMs: 5_000 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      // Abort fires during the retry sleep after attempt 1 (sleep = 1000ms,
      // starting at ~500ms mark). At that point attempt === 2 in the loop.
      ctrl.abortAfter(600, new Error('user cancel during sleep'));
      const promise = adapter
        .call(SIMPLE_REQUEST, { signal: ctrl.signal })
        .catch((e: unknown) => e);
      // Advance past the abort time (600ms) to trigger the abort during retry sleep.
      await vi.advanceTimersByTimeAsync(700);
      const e = await promise;
      expect(e).toBeInstanceOf(AbortedError);
      expect((e as AbortedError).attempts).toBe(2);
      vi.useRealTimers();
    });

    it('C-ER-15 | TimeoutError (4 timeouts of 100ms, maxAttempts 4) has attempts === 4, timeoutMs === 100', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.timeout(10_000),
        scenario.timeout(10_000),
        scenario.timeout(10_000),
        scenario.timeout(10_000),
      ]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 4, backoffBaseMs: 1, maxBackoffMs: 5 },
          timeout: { perAttemptMs: 100 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TimeoutError);
        const err = e as TimeoutError;
        expect(err.attempts).toBe(4);
        expect(err.timeoutMs).toBe(100);
      }
    });
  });

  // ─── §21.4 Préservation du cause ─────────────────────────────────────────

  describe('§21.4 cause preservation', () => {
    it('C-ER-16 | network fetch error (TypeError) preserved in cause', async () => {
      const fetchImpl = createScenarioFetch([scenario.networkError('dns')]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(LLMRuntimeError);
        const err = e as LLMRuntimeError;
        expect(err.cause).toBeInstanceOf(Error);
        expect(String((err.cause as Error).message)).toContain('dns');
      }
    });

    it('C-ER-17 | abort with custom reason preserves cause.message', async () => {
      const ctrl = createControlledSignal();
      const customReason = new Error('user cancelled');
      ctrl.abort(customReason);
      const adapter = createAnthropicAdapter(baseConfig());
      try {
        await adapter.call(SIMPLE_REQUEST, { signal: ctrl.signal });
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(AbortedError);
        const err = e as AbortedError;
        expect(err.cause).toBeDefined();
        expect((err.cause as Error).message).toBe('user cancelled');
      }
    });

    it('C-ER-18 | ResponseParseError on malformed JSON exposes parse details in cause', async () => {
      const fetchImpl = createScenarioFetch([
        { status: 200, body: 'not-json-at-all', headers: { 'content-type': 'text/html' } },
      ]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(ResponseParseError);
        const err = e as ResponseParseError;
        expect(err.cause).toBeDefined();
      }
    });
  });

  // ─── §21.5 Champs spécifiques ────────────────────────────────────────────

  describe('§21.5 subclass-specific fields', () => {
    it('C-ER-19 | RateLimitError with 429 + retry-after has retryAfterMs === parsed value', async () => {
      const fetchImpl = createScenarioFetch([scenario.rateLimit(3)]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(RateLimitError);
        const err = e as RateLimitError;
        expect(err.retryAfterMs).toBe(3_000);
      }
    });

    it('C-ER-20 | TimeoutError has timeoutMs defined in ms', async () => {
      const fetchImpl = createScenarioFetch([scenario.timeout(10_000)]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
          timeout: { perAttemptMs: 250 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      try {
        await adapter.call(SIMPLE_REQUEST);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(TimeoutError);
        expect(typeof (e as TimeoutError).timeoutMs).toBe('number');
        expect((e as TimeoutError).timeoutMs).toBe(250);
      }
    });
  });
});
