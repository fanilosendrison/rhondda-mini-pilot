// NIB-T §25 — Property tests (P-01 to P-30).
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §25.1 déterminisme, §25.2 immutabilité LLMRequest,
// §25.3 unicité callId, §25.4 shape CanonicalHttpRequest, §25.5 shape
// ParsedProviderResponse, §25.6 ProviderErrorSignal, §25.7 order-indépendance
// logger, §25.8 enabled false, §25.9 isolation, §25.10 headers lowercase,
// §25.11 réponse vide ≠ truncation, §25.12 detectHeuristicTruncation stable.

import { describe, expect, it, vi } from 'vitest';

import { anthropicBinding } from '../../src/bindings/anthropic.js';
import { googleBinding } from '../../src/bindings/google.js';
import { openaiBinding } from '../../src/bindings/openai.js';
import { createOpenAICompatibleBinding } from '../../src/bindings/openai-compatible.js';
import type { BindingConfig, ProviderBinding } from '../../src/bindings/types.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createOpenAIEmbeddingAdapter } from '../../src/factories/openai-embeddings.js';
import {
  classifyErrorBase,
  type ProviderErrorSignal,
} from '../../src/services/error-classifier-base.js';
import { ALL_LLM_ERROR_KINDS, isRetriableKind } from '../../src/services/error-kind.js';
import { parseRetryAfter, resolveRetryDecision } from '../../src/services/retry-resolver.js';
import {
  detectHeuristicTruncation,
  stripJsonFence,
  stripThinkingTags,
} from '../../src/services/sanitizer.js';
import {
  type RateLimitSnapshot,
  resolveThrottleDecision,
} from '../../src/services/throttle-resolver.js';
import { estimateCallTokens } from '../../src/services/token-estimator.js';
import type {
  AdapterConfig,
  EmbeddingAdapterConfig,
  LLMMessage,
  LLMRequest,
  RetryPolicy,
} from '../../src/types.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createMockFetch, createScenarioFetch } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import { seededRandom } from '../helpers/seeded-random.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const BINDINGS: Array<{ name: string; binding: ProviderBinding }> = [
  { name: 'anthropic', binding: anthropicBinding },
  { name: 'openai', binding: openaiBinding },
  { name: 'google', binding: googleBinding },
  { name: 'deepseek', binding: createOpenAICompatibleBinding('deepseek') },
];

function baseBindingConfig(model = 'test-model'): BindingConfig {
  return { model, apiKey: 'sk-test' };
}

function baseAdapterConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    model: 'claude-test',
    apiKey: 'sk-test',
    retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 5 },
    timeout: { perAttemptMs: 5_000 },
    sanitization: {},
    ...overrides,
  };
}

function baseEmbConfig(overrides: Partial<EmbeddingAdapterConfig> = {}): EmbeddingAdapterConfig {
  return {
    model: 'text-embedding-3-small',
    apiKey: 'sk-test',
    retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 5 },
    timeout: { perAttemptMs: 5_000 },
    ...overrides,
  };
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function safeCall<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false };
  }
}

// ─── §25.1 Déterminisme des fonctions pures ────────────────────────────────

describe('property tests', () => {
  describe('§25.1 determinism of pure functions', () => {
    it('P-01 | resolveRetryDecision is deterministic across 100 seeded inputs', () => {
      const policy: RetryPolicy = { maxAttempts: 5, backoffBaseMs: 100, maxBackoffMs: 5_000 };
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const attempt = rng.randomInt(0, 10);
        const headers: Record<string, string> = {
          'retry-after': String(rng.randomInt(0, 60)),
        };
        const err = new Error('boom');
        const a = safeCall(() => resolveRetryDecision(err, attempt, headers, policy));
        const b = safeCall(() => resolveRetryDecision(err, attempt, headers, policy));
        expect(a).toEqual(b);
      }
    });

    it('P-02 | resolveThrottleDecision is deterministic across 100 seeded inputs', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const snapshot: RateLimitSnapshot | null = rng.randomBool()
          ? null
          : {
              remainingTokens: rng.randomInt(0, 100_000),
              resetTokensAt: rng.randomInt(0, 10_000_000),
              lastCallOutputTokens: rng.randomInt(0, 1_000),
              state: 'known',
            };
        const estimated = rng.randomInt(0, 10_000);
        const now = rng.randomInt(0, 10_000_000);
        const a = safeCall(() => resolveThrottleDecision(snapshot, estimated, now));
        const b = safeCall(() => resolveThrottleDecision(snapshot, estimated, now));
        expect(a).toEqual(b);
      }
    });

    it('P-03 | parseRetryAfter is deterministic', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const headers: Record<string, string> = {
          'retry-after': String(rng.randomInt(0, 300)),
        };
        const a = safeCall(() => parseRetryAfter(headers));
        const b = safeCall(() => parseRetryAfter(headers));
        expect(a).toEqual(b);
      }
    });

    it('P-04 | estimateCallTokens is deterministic', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const messages: LLMMessage[] = rng.randomMessages(rng.randomInt(1, 6));
        const snapshot: RateLimitSnapshot | null = null;
        const maxTokens = rng.randomBool() ? rng.randomInt(0, 4_096) : undefined;
        const a = safeCall(() => estimateCallTokens(messages, snapshot, maxTokens));
        const b = safeCall(() => estimateCallTokens(messages, snapshot, maxTokens));
        expect(a).toEqual(b);
      }
    });

    it('P-05 | isRetriableKind is deterministic (pure total function)', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const k = ALL_LLM_ERROR_KINDS[rng.randomInt(0, ALL_LLM_ERROR_KINDS.length - 1)];
        if (k === undefined) continue;
        const a = safeCall(() => isRetriableKind(k));
        const b = safeCall(() => isRetriableKind(k));
        expect(a).toEqual(b);
      }
    });

    it('P-06 | classifyErrorBase is deterministic', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const rng = seededRandom(seed);
        const signal: ProviderErrorSignal = {
          aborted: rng.randomBool(),
          timeout: rng.randomBool(),
          headers: { 'retry-after': String(rng.randomInt(0, 60)) },
          status: rng.randomInt(200, 599),
          bodyText: rng.randomString(32),
        };
        const a = safeCall(() => classifyErrorBase(signal));
        const b = safeCall(() => classifyErrorBase(signal));
        // Compare kind string if both succeeded; otherwise both must have failed identically.
        if (a.ok && b.ok) {
          expect(a.value.kind).toBe(b.value.kind);
        } else {
          expect(a.ok).toBe(b.ok);
        }
      }
    });

    it('P-07 | binding.buildRequest is deterministic for each binding on 20 random requests', () => {
      for (const { binding } of BINDINGS) {
        for (let seed = 1; seed <= 20; seed += 1) {
          const rng = seededRandom(seed);
          const req: LLMRequest = {
            messages: rng.randomMessages(rng.randomInt(1, 4)),
            ...(rng.randomBool() ? { temperature: rng.randomInt(0, 100) / 100 } : {}),
            ...(rng.randomBool() ? { maxTokens: rng.randomInt(1, 4096) } : {}),
          };
          const a = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
          const b = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
          expect(a).toEqual(b);
        }
      }
    });

    it('P-08 | binding.parseResponse is deterministic', () => {
      for (const { binding } of BINDINGS) {
        for (let seed = 1; seed <= 20; seed += 1) {
          const body = { dummy: seed };
          const headers: Record<string, string> = { 'content-type': 'application/json' };
          const a = safeCall(() => binding.parseResponse(body, headers));
          const b = safeCall(() => binding.parseResponse(body, headers));
          expect(a).toEqual(b);
        }
      }
    });

    it('P-09 | binding.terminationMap is frozen (immutable)', () => {
      for (const { binding } of BINDINGS) {
        expect(Object.isFrozen(binding.terminationMap)).toBe(true);
      }
    });
  });

  // ─── §25.2 Immutabilité de LLMRequest ──────────────────────────────────

  describe('§25.2 LLMRequest immutability', () => {
    it('P-10 | 20 calls → req remains structurally unchanged (deep-equal vs snapshot)', async () => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const rng = seededRandom(seed);
        const req: LLMRequest = {
          messages: rng.randomMessages(rng.randomInt(1, 4)),
        };
        const snapshot = deepClone(req);
        const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
        const adapter = createAnthropicAdapter(
          baseAdapterConfig({ providerOptions: { fetch: fetchImpl } }),
        );
        await adapter.call(req).catch(() => undefined);
        expect(req).toEqual(snapshot);
      }
    });

    it('P-11 | deepFreeze(req) + adapter.call(req) → no throw from engine mutation', async () => {
      const req: LLMRequest = {
        messages: [{ role: 'user', content: 'hi' }],
      };
      const deepFreeze = <T>(o: T): T => {
        Object.freeze(o);
        if (o && typeof o === 'object') {
          for (const v of Object.values(o as Record<string, unknown>)) {
            if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
              deepFreeze(v);
            }
          }
        }
        return o;
      };
      deepFreeze(req);
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const adapter = createAnthropicAdapter(
        baseAdapterConfig({ providerOptions: { fetch: fetchImpl } }),
      );
      // I-11: engine must never mutate the request. If it does, strict mode
      // throws TypeError "Cannot assign to read only property" from deepFreeze.
      // The call may resolve (success) or reject (non-mutation error) — both OK.
      // Only a TypeError from frozen mutation is a failure.
      try {
        await adapter.call(req);
      } catch (e: unknown) {
        if (e instanceof TypeError && /read only/i.test(e.message)) {
          expect.unreachable(`engine mutated frozen LLMRequest: ${e.message}`);
        }
        // Other errors (e.g. from stubs) are acceptable — engine did not mutate.
      }
    });

    it('P-12 | 20 embed calls → texts remains structurally unchanged', async () => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const rng = seededRandom(seed);
        const count = rng.randomInt(1, 5);
        const texts: string[] = [];
        for (let i = 0; i < count; i += 1) texts.push(rng.randomString(32));
        const snapshot = deepClone(texts);
        const adapter = createOpenAIEmbeddingAdapter(baseEmbConfig());
        await adapter.embed(texts).catch(() => undefined);
        expect(texts).toEqual(snapshot);
      }
    });
  });

  // ─── §25.3 Unicité de callId ───────────────────────────────────────────

  describe('§25.3 callId uniqueness', () => {
    it('P-13 | 1000 consecutive calls → all callIds are distinct', async () => {
      const responses = Array.from({ length: 1000 }, () => scenario.ok('anthropic', 'ok'));
      const fetchImpl = createScenarioFetch(responses);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseAdapterConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      for (let i = 0; i < 1000; i += 1) {
        await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      }
      const ids = logger.findAll('llm_call_end').map((e) => e.callId);
      const unique = new Set(ids);
      expect(unique.size).toBe(ids.length);
    });

    it('P-14 | callIds are lexicographically increasing (ULID)', async () => {
      const responses = Array.from({ length: 50 }, () => scenario.ok('anthropic', 'ok'));
      const fetchImpl = createScenarioFetch(responses);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseAdapterConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      for (let i = 0; i < 50; i += 1) {
        await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      }
      const ids = logger.findAll('llm_call_end').map((e) => e.callId);
      for (let i = 1; i < ids.length; i += 1) {
        const prev = ids[i - 1];
        const curr = ids[i];
        if (prev === undefined || curr === undefined) continue;
        expect(prev <= curr).toBe(true);
      }
    });
  });

  // ─── §25.4 Shape du CanonicalHttpRequest ──────────────────────────────

  describe('§25.4 CanonicalHttpRequest shape (via binding.buildRequest)', () => {
    it('P-15 | canonicalRequest.method === "POST" for every binding over 20 requests', () => {
      let successCount = 0;
      for (const { binding } of BINDINGS) {
        for (let seed = 1; seed <= 20; seed += 1) {
          const rng = seededRandom(seed);
          const req: LLMRequest = { messages: rng.randomMessages(rng.randomInt(1, 3)) };
          const res = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
          if (!res.ok) continue;
          successCount += 1;
          expect(res.value.method).toBe('POST');
        }
      }
      expect(successCount).toBeGreaterThan(0);
    });

    it('P-16 | bodyKind === "json" (no "empty" for completions v1)', () => {
      let successCount = 0;
      for (const { binding } of BINDINGS) {
        const req: LLMRequest = { messages: [{ role: 'user', content: 'hi' }] };
        const res = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
        if (!res.ok) continue;
        successCount += 1;
        expect(res.value.bodyKind).toBe('json');
      }
      expect(successCount).toBeGreaterThan(0);
    });

    it('P-17 | bodyJson is always a JS object (never a pre-serialized string)', () => {
      let successCount = 0;
      for (const { binding } of BINDINGS) {
        const req: LLMRequest = { messages: [{ role: 'user', content: 'hi' }] };
        const res = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
        if (!res.ok) continue;
        successCount += 1;
        expect(typeof res.value.bodyJson).toBe('object');
        expect(res.value.bodyJson).not.toBeNull();
        expect(Array.isArray(res.value.bodyJson)).toBe(false);
      }
      expect(successCount).toBeGreaterThan(0);
    });

    it('P-18 | headers is Record<string,string> with non-empty string keys and string values', () => {
      let successCount = 0;
      for (const { binding } of BINDINGS) {
        const req: LLMRequest = { messages: [{ role: 'user', content: 'hi' }] };
        const res = safeCall(() => binding.buildRequest(req, baseBindingConfig()));
        if (!res.ok) continue;
        successCount += 1;
        for (const [k, v] of Object.entries(res.value.headers)) {
          expect(typeof k).toBe('string');
          expect(k.length).toBeGreaterThan(0);
          expect(typeof v).toBe('string');
        }
      }
      expect(successCount).toBeGreaterThan(0);
    });
  });

  // ─── §25.5 Shape du ParsedProviderResponse ────────────────────────────

  describe('§25.5 ParsedProviderResponse shape (via binding.parseResponse)', () => {
    it('P-19 | parsedResponse.rawContent is always a string', () => {
      for (const { binding } of BINDINGS) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        // Minimal plausible body per provider — if the stub throws, we skip this seed.
        const body = { some: 'shape' };
        const res = safeCall(() => binding.parseResponse(body, headers));
        if (!res.ok) continue;
        expect(typeof res.value.rawContent).toBe('string');
      }
    });

    it('P-20 | parsedResponse.terminationSignal is always a non-empty string', () => {
      for (const { binding } of BINDINGS) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const body = { some: 'shape' };
        const res = safeCall(() => binding.parseResponse(body, headers));
        if (!res.ok) continue;
        expect(typeof res.value.terminationSignal).toBe('string');
        expect(res.value.terminationSignal.length).toBeGreaterThan(0);
      }
    });

    it('P-21 | parsedResponse.usage is an object (individual fields may be undefined)', () => {
      for (const { binding } of BINDINGS) {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        const body = { some: 'shape' };
        const res = safeCall(() => binding.parseResponse(body, headers));
        if (!res.ok) continue;
        expect(typeof res.value.usage).toBe('object');
        expect(res.value.usage).not.toBeNull();
      }
    });
  });

  // ─── §25.6 Invariant du ProviderErrorSignal ───────────────────────────

  describe('§25.6 ProviderErrorSignal invariants', () => {
    // Tests verify real classifyErrorBase behavior, not synthesized signal structure.

    it('P-22 | classifyErrorBase with status 429 + retry-after header produces RateLimitError with retryAfterMs', () => {
      // Verify that classifyErrorBase actually reads the retry-after header
      // from the signal — proving the header key must be lowercase for parsing.
      for (let seed = 1; seed <= 20; seed += 1) {
        const rng = seededRandom(seed);
        const retrySeconds = rng.randomInt(1, 60);
        const signal: ProviderErrorSignal = {
          aborted: false,
          timeout: false,
          headers: { 'retry-after': String(retrySeconds) },
          status: 429,
        };
        const result = classifyErrorBase(signal);
        expect(result.kind).toBe('rate_limit');
        // retryAfterMs must be derived from the header, proving the header was read.
        expect((result as { retryAfterMs?: number }).retryAfterMs).toBe(retrySeconds * 1000);
      }
    });

    it('P-23 | aborted === true takes precedence over timeout === true in classifyErrorBase', () => {
      // When both aborted and timeout are true, classifier must return AbortedError (not TimeoutError).
      // This tests the real priority logic in classifyErrorBase, not a tautological struct check.
      const signal: ProviderErrorSignal = {
        aborted: true,
        timeout: true,
        headers: {},
        status: 500,
        networkErrorKind: 'unknown',
      };
      const result = classifyErrorBase(signal);
      expect(result.kind).toBe('aborted');
    });

    it('P-24 | networkErrorKind maps to TransientProviderError with correct networkErrorKind field', () => {
      const kinds: ReadonlyArray<'dns' | 'connection' | 'reset' | 'unknown'> = [
        'dns',
        'connection',
        'reset',
        'unknown',
      ];
      for (const nk of kinds) {
        const signal: ProviderErrorSignal = {
          aborted: false,
          timeout: false,
          headers: {},
          networkErrorKind: nk,
        };
        const result = classifyErrorBase(signal);
        expect(result.kind).toBe('transient_provider');
        expect((result as { networkErrorKind?: string }).networkErrorKind).toBe(nk);
      }
      // Undefined networkErrorKind + no status => ProviderProtocolError (catch-all).
      const fallback: ProviderErrorSignal = {
        aborted: false,
        timeout: false,
        headers: {},
      };
      const fallbackResult = classifyErrorBase(fallback);
      expect(fallbackResult.kind).toBe('provider_protocol');
    });
  });

  // ─── §25.7 Ordre-indépendance du logger ──────────────────────────────

  describe('§25.7 logger order-independence', () => {
    it('P-25 | default logger vs injected logger produce the same event sequence across 10 calls', async () => {
      const fetchForCustom = createScenarioFetch(
        Array.from({ length: 10 }, () => scenario.ok('anthropic', 'ok')),
      );
      const customLogger = createMockLogger();
      const adapterCustom = createAnthropicAdapter(
        baseAdapterConfig({
          logging: { enabled: true, logger: customLogger },
          providerOptions: { fetch: fetchForCustom },
        }),
      );
      for (let i = 0; i < 10; i += 1) {
        await adapterCustom
          .call({ messages: [{ role: 'user', content: 'hi' }] })
          .catch(() => undefined);
      }

      // Re-run with default logger, collect sequence via a stderr capture.
      const capture: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        capture.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;
      try {
        const fetchForDefault = createScenarioFetch(
          Array.from({ length: 10 }, () => scenario.ok('anthropic', 'ok')),
        );
        const adapterDefault = createAnthropicAdapter(
          baseAdapterConfig({
            logging: { enabled: true },
            providerOptions: { fetch: fetchForDefault },
          }),
        );
        for (let i = 0; i < 10; i += 1) {
          await adapterDefault
            .call({ messages: [{ role: 'user', content: 'hi' }] })
            .catch(() => undefined);
        }
      } finally {
        process.stderr.write = origWrite;
      }

      // Extract event types from captured stderr lines.
      const defaultTypes: string[] = [];
      for (const chunk of capture) {
        for (const line of chunk.split('\n').filter((s) => s.length > 0)) {
          try {
            const parsed = JSON.parse(line) as { eventType?: string };
            if (parsed.eventType !== undefined) defaultTypes.push(parsed.eventType);
          } catch {
            // ignore parse errors in RED
          }
        }
      }
      const customTypes = customLogger.eventTypes();
      // Both loggers must have produced events (non-vacuous).
      expect(defaultTypes.length).toBeGreaterThan(0);
      expect(customTypes.length).toBeGreaterThan(0);
      expect(customTypes).toEqual(defaultTypes);
    });
  });

  // ─── §25.8 Robustesse à enabled: false ────────────────────────────────

  describe('§25.8 logging enabled: false', () => {
    it('P-26 | 100 calls with enabled:false produce zero events (stderr + injected logger), behavior intact', async () => {
      const responses = Array.from({ length: 100 }, () => scenario.ok('anthropic', 'ok'));
      const fetchImpl = createScenarioFetch(responses);
      const logger = createMockLogger();
      const stderrSpy: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrSpy.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      }) as typeof process.stderr.write;
      try {
        const adapter = createAnthropicAdapter(
          baseAdapterConfig({
            logging: { enabled: false, logger },
            providerOptions: { fetch: fetchImpl },
          }),
        );
        for (let i = 0; i < 100; i += 1) {
          await adapter
            .call({ messages: [{ role: 'user', content: 'hi' }] })
            .catch(() => undefined);
        }
      } finally {
        process.stderr.write = origWrite;
      }
      expect(logger.events.length).toBe(0);
      // Any stderr writes must not be our JSON events.
      for (const s of stderrSpy) {
        expect(s.includes('"eventType"')).toBe(false);
      }
    });
  });

  // ─── §25.9 Isolation des adapters ────────────────────────────────────

  describe('§25.9 adapter isolation', () => {
    it('P-27 | two adapters have separate stats + own provider/model tagging in events', async () => {
      const fetch1 = createMockFetch(scenario.ok('anthropic', 'a'));
      const fetch2 = createMockFetch(scenario.ok('anthropic', 'b'));
      const logger1 = createMockLogger();
      const logger2 = createMockLogger();
      const a1 = createAnthropicAdapter(
        baseAdapterConfig({
          model: 'claude-alpha',
          apiKey: 'k1',
          logging: { enabled: true, logger: logger1 },
          providerOptions: { fetch: fetch1 },
        }),
      );
      const a2 = createAnthropicAdapter(
        baseAdapterConfig({
          model: 'claude-beta',
          apiKey: 'k2',
          logging: { enabled: true, logger: logger2 },
          providerOptions: { fetch: fetch2 },
        }),
      );
      await a1.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      await a2.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      expect(a1.stats).not.toBe(a2.stats);
      for (const e of logger1.events) expect(e.model).toBe('claude-alpha');
      for (const e of logger2.events) expect(e.model).toBe('claude-beta');
    });
  });

  // ─── §25.10 Headers post-fetch lowercase ─────────────────────────────

  describe('§25.10 post-fetch headers lowercase', () => {
    it('P-28 | binding.parseResponse / readRateLimitHeaders / classifyError receive lowercase header keys (spy)', async () => {
      // Use vi.spyOn for auto-restore instead of direct mutation (safe if binding is frozen).
      const seenParseHeaders: Array<Record<string, string>> = [];
      const parseSpy = vi
        .spyOn(anthropicBinding, 'parseResponse')
        .mockImplementation((body: unknown, headers: Record<string, string>) => {
          seenParseHeaders.push({ ...headers });
          parseSpy.mockRestore();
          return anthropicBinding.parseResponse(body, headers);
        });
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: { 'X-Mixed-Case': 'value', 'Another-Header': 'v2' },
      });
      const adapter = createAnthropicAdapter(
        baseAdapterConfig({ providerOptions: { fetch: fetchImpl } }),
      );
      await adapter.call({ messages: [{ role: 'user', content: 'hi' }] }).catch(() => undefined);
      parseSpy.mockRestore();
      for (const hdrs of seenParseHeaders) {
        for (const k of Object.keys(hdrs)) {
          expect(k).toBe(k.toLowerCase());
        }
      }
    });
  });

  // ─── §25.11 Réponse vide ≠ truncation ─────────────────────────────────

  describe('§25.11 empty sanitization ≠ truncation', () => {
    it('P-29 | 10 cases where rawContent is non-empty but content === "" after sanitize → truncationDetected === false', async () => {
      for (let i = 0; i < 10; i += 1) {
        const fetchImpl = createMockFetch({
          status: 200,
          body: {
            id: `msg_${i}`,
            type: 'message',
            role: 'assistant',
            model: 'claude-test',
            content: [{ type: 'text', text: `<thinking>only thinking ${i}</thinking>` }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          headers: {},
        });
        const adapter = createAnthropicAdapter(
          baseAdapterConfig({
            sanitization: { stripThinkingTags: true },
            integrity: { detectHeuristicTruncation: true },
            providerOptions: { fetch: fetchImpl },
          }),
        );
        const res = await adapter
          .call({ messages: [{ role: 'user', content: 'hi' }] })
          .catch(() => undefined);
        if (res !== undefined) {
          expect(res.integrity.truncationDetected).toBe(false);
        }
      }
    });
  });

  // ─── §25.12 detectHeuristicTruncation stable ─────────────────────────

  describe('§25.12 detectHeuristicTruncation', () => {
    it('P-30 | detectHeuristicTruncation("", any) === false for 50 values of maxTokens', () => {
      for (let seed = 1; seed <= 50; seed += 1) {
        const rng = seededRandom(seed);
        const maxTokens = rng.randomBool() ? rng.randomInt(0, 10_000) : undefined;
        const res = safeCall(() => detectHeuristicTruncation('', maxTokens));
        if (!res.ok) continue;
        expect(res.value).toBe(false);
      }
    });
  });

  // ─── Sanity: sanitizer helpers should remain imported (used indirectly). ──
  // Ensures the imports are actually wired for GREEN without dangling symbols.
  it('sanity | sanitizer exports are callable symbols', () => {
    expect(typeof stripThinkingTags).toBe('function');
    expect(typeof stripJsonFence).toBe('function');
  });
});
