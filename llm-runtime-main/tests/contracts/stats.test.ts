// NIB-T §24 — Contract invariants for stats.
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §24.1 increments sur succès, §24.2 usage partiel,
// §24.3 no reset, §24.4 immutabilité, §24.5 stats embedding.

import { describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createOpenAIEmbeddingAdapter } from '../../src/factories/openai-embeddings.js';
import type {
  AdapterConfig,
  AdapterStats,
  EmbeddingAdapterConfig,
  LLMRequest,
} from '../../src/types.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createMockFetch, createScenarioFetch } from '../helpers/mock-fetch.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

function baseConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
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

function okBody(content: string, inputTokens = 10, outputTokens = 20): unknown {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: content }],
    stop_reason: 'end_turn',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ─── §24.1 Incréments sur succès ───────────────────────────────────────────

describe('stats contracts', () => {
  describe('§24.1 increments on success only', () => {
    it('C-ST-01 | 0 calls → all counters at 0', () => {
      const adapter = createAnthropicAdapter(baseConfig());
      expect(adapter.stats.totalCalls).toBe(0);
      expect(adapter.stats.totalInputTokens).toBe(0);
      expect(adapter.stats.totalOutputTokens).toBe(0);
      expect(adapter.stats.totalDurationMs).toBe(0);
    });

    it('C-ST-02 | 1 successful call → counters reflect usage', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: okBody('hi', 10, 20),
        headers: {},
      });
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await adapter.call(REQUEST);
      expect(adapter.stats.totalCalls).toBe(1);
      expect(adapter.stats.totalInputTokens).toBe(10);
      expect(adapter.stats.totalOutputTokens).toBe(20);
      expect(adapter.stats.totalDurationMs).toBeGreaterThanOrEqual(0);
    });

    it('C-ST-03 | 1 fatal failure (401) → no increment', async () => {
      const fetchImpl = createScenarioFetch([scenario.authError()]);
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await adapter.call(REQUEST).catch(() => undefined);
      expect(adapter.stats.totalCalls).toBe(0);
      expect(adapter.stats.totalInputTokens).toBe(0);
      expect(adapter.stats.totalOutputTokens).toBe(0);
    });

    it('C-ST-04 | 1 failure after retry exhaustion → no increment', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
      ]);
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 3, backoffBaseMs: 1, maxBackoffMs: 5 },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      expect(adapter.stats.totalCalls).toBe(0);
    });

    it('C-ST-05 | 2 successes + 1 failure → totalCalls === 2', async () => {
      const fetchImpl = createScenarioFetch([
        { status: 200, body: okBody('a', 5, 10), headers: {} },
        scenario.authError(),
        { status: 200, body: okBody('b', 7, 14), headers: {} },
      ]);
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await adapter.call(REQUEST).catch(() => undefined);
      await adapter.call(REQUEST).catch(() => undefined);
      await adapter.call(REQUEST).catch(() => undefined);
      expect(adapter.stats.totalCalls).toBe(2);
    });
  });

  // ─── §24.2 Usage partiel ────────────────────────────────────────────────

  describe('§24.2 partial usage', () => {
    it('C-ST-06 | success with inputTokens === undefined → totalInputTokens not incremented by NaN', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { output_tokens: 20 }, // input_tokens omitted
        },
        headers: {},
      });
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await adapter.call(REQUEST);
      expect(adapter.stats.totalInputTokens).toBe(0);
      expect(Number.isFinite(adapter.stats.totalInputTokens)).toBe(true);
    });

    it('C-ST-07 | inputTokens === 10 but outputTokens undefined → +=10 on input, output unchanged', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10 },
        },
        headers: {},
      });
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await adapter.call(REQUEST);
      expect(adapter.stats.totalInputTokens).toBe(10);
      expect(adapter.stats.totalOutputTokens).toBe(0);
    });
  });

  // ─── §24.3 Pas de reset ──────────────────────────────────────────────────

  describe('§24.3 no reset', () => {
    it('C-ST-08 | stats exposes no reset() method', () => {
      const adapter = createAnthropicAdapter(baseConfig());
      // typeof a non-existent property is "undefined" — cast via unknown to sidestep
      // the readonly shape when probing for an unlisted key.
      const probe = (adapter.stats as unknown as Record<string, unknown>)['reset'];
      expect(typeof probe).toBe('undefined');
    });

    it('C-ST-09 | each adapter has its own stats (two adapters → two states)', async () => {
      const fetchImpl1 = createMockFetch({
        status: 200,
        body: okBody('a', 3, 5),
        headers: {},
      });
      const fetchImpl2 = createMockFetch({
        status: 200,
        body: okBody('b', 7, 11),
        headers: {},
      });
      const a1 = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl1 } }));
      const a2 = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl2 } }));
      await a1.call(REQUEST);
      expect(a1.stats.totalCalls).toBe(1);
      expect(a2.stats.totalCalls).toBe(0);
      expect(a1.stats).not.toBe(a2.stats);
    });
  });

  // ─── §24.4 Immutabilité observable ───────────────────────────────────────

  describe('§24.4 observable immutability', () => {
    it('C-ST-10 | stats fields are readonly (TS + runtime no-op or throw)', () => {
      const adapter = createAnthropicAdapter(baseConfig());
      const initial = adapter.stats.totalCalls;
      try {
        // @ts-expect-error — totalCalls is readonly on AdapterStats
        adapter.stats.totalCalls = 9_999;
      } catch {
        // Strict mode or frozen: TypeError is acceptable.
      }
      expect(adapter.stats.totalCalls).toBe(initial);
      // Compile-time check: AdapterStats is readonly.
      const _snapshot: Readonly<AdapterStats> = adapter.stats;
      void _snapshot;
    });
  });

  // ─── §24.5 Stats embedding ───────────────────────────────────────────────

  describe('§24.5 embedding stats', () => {
    it('C-ST-11 | EmbeddingAdapter after 3 successful calls → totalCalls === 3, totalDurationMs > 0, input/output tokens === 0', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 2 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const adapter = createOpenAIEmbeddingAdapter(baseEmbConfig());
        await adapter.embed(['a']).catch(() => undefined);
        await adapter.embed(['b']).catch(() => undefined);
        await adapter.embed(['c']).catch(() => undefined);
        expect(adapter.stats.totalCalls).toBe(3);
        expect(adapter.stats.totalDurationMs).toBeGreaterThan(0);
        expect(adapter.stats.totalInputTokens).toBe(0);
        expect(adapter.stats.totalOutputTokens).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('C-ST-12 | EmbeddingAdapter, 1 terminal failure → totalCalls === 0', async () => {
      const adapter = createOpenAIEmbeddingAdapter(baseEmbConfig());
      await adapter.embed(['a']).catch(() => undefined);
      expect(adapter.stats.totalCalls).toBe(0);
    });
  });
});
