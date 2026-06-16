// NIB-T §20 — RED-phase acceptance + property tests for executeEmbedding.
// Reference: specs/NIB-T-LLMRUNTIME.md §20 (T-EE-01..T-EE-30 + P-EE-a,b,c).
//
// Tests exercise the embedding engine via createOpenAIEmbeddingAdapter with a
// stubbed global fetch. Emphasis: batching, order preservation, empty-input
// skip, fatal-on-batch-failure, retry per batch, and abort semantics.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AbortedError, TransientProviderError } from '../../src/errors/index.js';
import { createOpenAIEmbeddingAdapter } from '../../src/factories/openai-embeddings.js';
import type { LLMEmbeddingBatchEvent, LLMEmbeddingEndEvent } from '../../src/types.js';
import { eventAssertions } from '../helpers/event-assertions.js';
import { scenario } from '../helpers/fetch-scenario.js';
import {
  createMockFetch,
  createScenarioFetch,
  type MockFetchCall,
  type MockResponse,
} from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';
import { createControlledSignal } from '../helpers/mock-signal.js';

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EMBEDDING_DIM = 3;

function embeddingsBody(
  vectors: readonly number[][],
  model: string = 'text-embedding-3-small',
): unknown {
  return {
    object: 'list',
    data: vectors.map((vec, idx) => ({
      object: 'embedding',
      index: idx,
      embedding: vec,
    })),
    model,
    usage: {
      prompt_tokens: vectors.length,
      total_tokens: vectors.length,
    },
  };
}

function buildAdapter(options: {
  logger: ReturnType<typeof createMockLogger>;
  batchSize?: number;
}): ReturnType<typeof createOpenAIEmbeddingAdapter> {
  const config: Parameters<typeof createOpenAIEmbeddingAdapter>[0] = {
    model: 'text-embedding-3-small',
    apiKey: 'test-key',
    logging: { logger: options.logger },
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
  };
  return createOpenAIEmbeddingAdapter(config);
}

describe('executeEmbedding — (§20)', () => {
  beforeEach(() => {
    // nothing
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §20.1 succès simple ─────────────────────────
  describe('§20.1 succès simple', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
      fetchMock: ReturnType<typeof createMockFetch>;
    } {
      const fetchMock = createMockFetch(scenario.okFixture('openai-embeddings/ok-3-texts'));
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = buildAdapter({ logger });
      return { logger, adapter, fetchMock };
    }

    it('T-EE-01 | result.length === 3 (one vector per input)', async () => {
      const { adapter } = setup();
      const result = await adapter.embed(['a', 'b', 'c']);

      expect(result).toHaveLength(3);
    });

    it('T-EE-02 | each vector has the expected dimension (3 in the fixture)', async () => {
      const { adapter } = setup();
      const result = await adapter.embed(['a', 'b', 'c']);

      for (const vec of result) {
        expect(vec).toHaveLength(EMBEDDING_DIM);
      }
    });

    it('T-EE-03 | mockFetch.calls.length === 1 (single batch)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed(['a', 'b', 'c']);

      expect(fetchMock.calls).toHaveLength(1);
    });

    it('T-EE-04 | events in order: llm_embedding_start, llm_embedding_batch(0), llm_embedding_end(success)', async () => {
      const { logger, adapter } = setup();
      await adapter.embed(['a', 'b', 'c']);

      eventAssertions.sequenceMatches(logger.events, [
        'llm_embedding_start',
        'llm_embedding_batch',
        'llm_embedding_end',
      ]);
      const batchEvent = logger.find('llm_embedding_batch') as LLMEmbeddingBatchEvent | undefined;
      expect(batchEvent?.batchIndex).toBe(0);
      const endEvent = logger.find('llm_embedding_end') as LLMEmbeddingEndEvent | undefined;
      expect(endEvent?.success).toBe(true);
    });

    it('T-EE-05 | all events share the same callId (ULID)', async () => {
      const { logger, adapter } = setup();
      await adapter.embed(['a', 'b', 'c']);

      eventAssertions.allSameCallId(logger.events);
      const first = logger.events[0];
      expect(first?.callId).toMatch(ULID_REGEX);
    });
  });

  // ───────────────────────── §20.2 texts vide — skip ─────────────────────────
  describe('§20.2 texts vide → skip appel', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
      fetchMock: ReturnType<typeof createMockFetch>;
    } {
      const fetchMock = createMockFetch(scenario.okFixture('openai-embeddings/ok-empty'));
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = buildAdapter({ logger });
      return { logger, adapter, fetchMock };
    }

    it('T-EE-06 | result === []', async () => {
      const { adapter } = setup();
      const result = await adapter.embed([]);

      expect(result).toEqual([]);
    });

    it('T-EE-07 | mockFetch.calls.length === 0 (no network call)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed([]);

      expect(fetchMock.calls).toHaveLength(0);
    });

    it('T-EE-08 | events: llm_embedding_start + llm_embedding_end only, no llm_embedding_batch', async () => {
      const { logger, adapter } = setup();
      await adapter.embed([]);

      eventAssertions.sequenceMatches(logger.events, ['llm_embedding_start', 'llm_embedding_end']);
    });
  });

  // ───────────────────────── §20.3 batching ─────────────────────────
  describe('§20.3 batching (250 texts, batchSize=100)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      const batch0 = Array.from({ length: 100 }, (_, i) => [i, i + 1, i + 2]);
      const batch1 = Array.from({ length: 100 }, (_, i) => [100 + i, 101 + i, 102 + i]);
      const batch2 = Array.from({ length: 50 }, (_, i) => [200 + i, 201 + i, 202 + i]);
      const fetchMock = createScenarioFetch([
        { status: 200, body: embeddingsBody(batch0) },
        { status: 200, body: embeddingsBody(batch1) },
        { status: 200, body: embeddingsBody(batch2) },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = buildAdapter({ logger, batchSize: 100 });
      return { logger, adapter, fetchMock };
    }

    const texts = Array.from({ length: 250 }, (_, i) => `text-${i}`);

    it('T-EE-09 | mockFetch.calls.length === 3 (100 + 100 + 50)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed(texts);

      expect(fetchMock.calls).toHaveLength(3);
    });

    function readInput(call: MockFetchCall): readonly string[] {
      const body = call.body as { input?: readonly string[] } | undefined;
      return body?.input ?? [];
    }

    it('T-EE-10 | batch 0 input === texts.slice(0, 100)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed(texts);
      const c0 = fetchMock.calls[0];
      expect(c0).toBeDefined();
      expect(readInput(c0 as MockFetchCall)).toEqual(texts.slice(0, 100));
    });

    it('T-EE-11 | batch 1 input === texts.slice(100, 200)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed(texts);
      const c1 = fetchMock.calls[1];
      expect(c1).toBeDefined();
      expect(readInput(c1 as MockFetchCall)).toEqual(texts.slice(100, 200));
    });

    it('T-EE-12 | batch 2 input === texts.slice(200, 250) (50 elements)', async () => {
      const { adapter, fetchMock } = setup();
      await adapter.embed(texts);
      const c2 = fetchMock.calls[2];
      expect(c2).toBeDefined();
      expect(readInput(c2 as MockFetchCall)).toEqual(texts.slice(200, 250));
    });

    it('T-EE-13 | result.length === 250', async () => {
      const { adapter } = setup();
      const result = await adapter.embed(texts);

      expect(result).toHaveLength(250);
    });

    it('T-EE-14 | result[i] corresponds to the vector for texts[i] (order preserved across batches)', async () => {
      const { adapter } = setup();
      const result = await adapter.embed(texts);

      // The mock returns for index i a vector starting with [i, i+1, i+2].
      for (let i = 0; i < 250; i += 1) {
        expect(result[i]).toEqual([i, i + 1, i + 2]);
      }
    });

    it('T-EE-15 | 3 llm_embedding_batch events (batchIndex 0, 1, 2)', async () => {
      const { logger, adapter } = setup();
      await adapter.embed(texts);

      const batches = logger.findAll('llm_embedding_batch') as LLMEmbeddingBatchEvent[];
      expect(batches).toHaveLength(3);
      expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
    });
  });

  // ───────────────────────── §20.4 ordre préservé ─────────────────────────
  describe('§20.4 ordre préservé avec batchSize=2', () => {
    it('T-EE-16 | result[i] corresponds to texts[i] across batches ["a","b","c","d","e"], bs=2', async () => {
      const texts = ['a', 'b', 'c', 'd', 'e'];
      const vecFor = (t: string): number[] => [t.charCodeAt(0), 0, 0];

      const batch0 = texts.slice(0, 2).map(vecFor);
      const batch1 = texts.slice(2, 4).map(vecFor);
      const batch2 = texts.slice(4, 5).map(vecFor);

      const fetchMock = createScenarioFetch([
        { status: 200, body: embeddingsBody(batch0) },
        { status: 200, body: embeddingsBody(batch1) },
        { status: 200, body: embeddingsBody(batch2) },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const adapter = buildAdapter({
        logger: createMockLogger(),
        batchSize: 2,
      });
      const result = await adapter.embed(texts);

      for (let i = 0; i < texts.length; i += 1) {
        expect(result[i]).toEqual(vecFor(texts[i] as string));
      }
    });
  });

  // ───────────────────────── §20.5 échec dans un batch = échec global ─────────────────────────
  describe('§20.5 batch échec → échec global (pas de partiels)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
      fetchMock: ReturnType<typeof createScenarioFetch>;
    } {
      // 3 batches: batch 0 succeeds, batch 1 fails with 5× 500, batch 2 never
      // called.
      const batch0 = Array.from({ length: 2 }, (_, i) => [i, i + 1, i + 2]);
      const fetchMock = createScenarioFetch([
        { status: 200, body: embeddingsBody(batch0) },
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        scenario.serverError(),
        // batch 2 responses (never reached):
        { status: 200, body: embeddingsBody(batch0) },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createOpenAIEmbeddingAdapter({
        model: 'text-embedding-3-small',
        apiKey: 'test-key',
        batchSize: 2,
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        logging: { logger },
      });
      return { logger, adapter, fetchMock };
    }

    async function runToFailure(
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>,
    ): Promise<unknown> {
      let caught: unknown;
      const promise = adapter.embed(['a', 'b', 'c', 'd', 'e']).catch((err: unknown) => {
        caught = err;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await promise;
      return caught;
    }

    it('T-EE-17 | throws TransientProviderError after retries exhausted on failing batch', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const err = await runToFailure(adapter);

      expect(err).toBeInstanceOf(TransientProviderError);
    });

    it('T-EE-18 | batch 2 is never fetched', async () => {
      vi.useFakeTimers();
      const { adapter, fetchMock } = setup();
      await runToFailure(adapter);

      // batch 0 (1 fetch) + batch 1 (5 failed fetches) = 6 total; batch 2 not
      // invoked.
      expect(fetchMock.calls).toHaveLength(6);
    });

    it('T-EE-19 | llm_embedding_end success=false, errorKind=transient_provider', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await runToFailure(adapter);

      const endEvent = logger.find('llm_embedding_end') as LLMEmbeddingEndEvent | undefined;
      expect(endEvent?.success).toBe(false);
      expect(endEvent?.errorKind).toBe('transient_provider');
    });

    it('T-EE-20 | error.attempts === 5 (retry budget exhausted on batch 1)', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const err = (await runToFailure(adapter)) as TransientProviderError;

      expect(err.attempts).toBe(5);
    });

    it('T-EE-21 | batches 0 and 1 emit llm_embedding_batch; batch 2 does not', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      await runToFailure(adapter);

      // NIB-M-EXECUTE-EMBEDDING §3.5.8: llm_embedding_batch fires at the START
      // of each attempt. Scenario: batch 0 succeeds once, batch 1 retried 5x, batch 2 never fires.
      const batches = logger.findAll('llm_embedding_batch') as LLMEmbeddingBatchEvent[];
      const indices = batches.map((b) => b.batchIndex).sort();
      expect(indices.filter((i) => i === 0).length).toBeGreaterThanOrEqual(1);
      expect(indices.filter((i) => i === 1).length).toBeGreaterThanOrEqual(1);
      expect(indices).not.toContain(2);
    });
  });

  // ───────────────────────── §20.6 abort pendant embedding ─────────────────────────
  describe('§20.6 abort pendant embedding', () => {
    it('T-EE-22 | throws AbortedError when signal aborts during 2nd batch', async () => {
      vi.useFakeTimers();
      const batch0 = [
        [0, 1, 2],
        [3, 4, 5],
      ];
      // Batch 1: response delayed long enough that the abort fires first.
      const responses: MockResponse[] = [
        { status: 200, body: embeddingsBody(batch0) },
        {
          status: 200,
          body: embeddingsBody([
            [6, 7, 8],
            [9, 10, 11],
          ]),
          delayMs: 10_000,
        },
      ];
      const fetchMock = createScenarioFetch(responses);
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createOpenAIEmbeddingAdapter({
        model: 'text-embedding-3-small',
        apiKey: 'test-key',
        batchSize: 2,
        logging: { logger: createMockLogger() },
      });
      const controlled = createControlledSignal();
      let caught: unknown;
      const promise = adapter
        .embed(['a', 'b', 'c', 'd'], { signal: controlled.signal })
        .catch((err: unknown) => {
          caught = err;
        });
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      expect(caught).toBeInstanceOf(AbortedError);
    });

    it('T-EE-23 | completed batches still emit their llm_embedding_batch events', async () => {
      vi.useFakeTimers();
      const batch0 = [
        [0, 1, 2],
        [3, 4, 5],
      ];
      const responses: MockResponse[] = [
        { status: 200, body: embeddingsBody(batch0) },
        {
          status: 200,
          body: embeddingsBody([
            [6, 7, 8],
            [9, 10, 11],
          ]),
          delayMs: 10_000,
        },
      ];
      const fetchMock = createScenarioFetch(responses);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createOpenAIEmbeddingAdapter({
        model: 'text-embedding-3-small',
        apiKey: 'test-key',
        batchSize: 2,
        logging: { logger },
      });
      const controlled = createControlledSignal();
      const promise = adapter
        .embed(['a', 'b', 'c', 'd'], { signal: controlled.signal })
        .catch(() => undefined);
      controlled.abortAfter(500);
      await vi.advanceTimersByTimeAsync(15_000);
      await promise;

      const batchEvents = logger.findAll('llm_embedding_batch') as LLMEmbeddingBatchEvent[];
      // At least batch 0 should have been emitted (completed before abort).
      expect(batchEvents.length).toBeGreaterThanOrEqual(1);
      expect(batchEvents[0]?.batchIndex).toBe(0);
    });
  });

  // ───────────────────────── §20.7 retry par batch ─────────────────────────
  describe('§20.7 retry par batch (500 puis 200)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
    } {
      const vecs = [
        [0, 1, 2],
        [3, 4, 5],
      ];
      const fetchMock = createScenarioFetch([
        scenario.serverError(),
        { status: 200, body: embeddingsBody(vecs) },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createOpenAIEmbeddingAdapter({
        model: 'text-embedding-3-small',
        apiKey: 'test-key',
        batchSize: 2,
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        logging: { logger },
      });
      return { logger, adapter };
    }

    it('T-EE-24 | batch is retried; success on 2nd attempt', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.embed(['a', 'b']);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result).toHaveLength(2);
    });

    it('T-EE-25 | result contains the expected vectors', async () => {
      vi.useFakeTimers();
      const { adapter } = setup();
      const promise = adapter.embed(['a', 'b']);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result[0]).toEqual([0, 1, 2]);
      expect(result[1]).toEqual([3, 4, 5]);
    });

    it('T-EE-26 | llm_embedding_retry_scheduled emitted (NIB-M-EXECUTE-EMBEDDING §3.5.5)', async () => {
      vi.useFakeTimers();
      const { logger, adapter } = setup();
      const promise = adapter.embed(['a', 'b']);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      expect(logger.find('llm_embedding_retry_scheduled')).toBeDefined();
    });
  });

  // ───────────────────────── §20.8 stats ─────────────────────────
  describe('§20.8 stats embedding', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIEmbeddingAdapter>;
    } {
      const vecs = [[0, 1, 2]];
      const fetchMock = createScenarioFetch([
        { status: 200, body: embeddingsBody(vecs) },
        { status: 200, body: embeddingsBody(vecs) },
        { status: 200, body: embeddingsBody(vecs) },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = buildAdapter({ logger });
      return { logger, adapter };
    }

    it('T-EE-27 | adapter.stats.totalCalls === 3 after 3 successes', async () => {
      const { adapter } = setup();
      await adapter.embed(['a']);
      await adapter.embed(['a']);
      await adapter.embed(['a']);

      expect(adapter.stats.totalCalls).toBe(3);
    });

    it('T-EE-28 | adapter.stats.totalDurationMs > 0', async () => {
      const { adapter } = setup();
      await adapter.embed(['a']);
      await adapter.embed(['a']);
      await adapter.embed(['a']);

      expect(adapter.stats.totalDurationMs).toBeGreaterThan(0);
    });

    it('T-EE-29 | adapter.stats.totalInputTokens === 0 (v1 convention)', async () => {
      const { adapter } = setup();
      await adapter.embed(['a']);
      await adapter.embed(['a']);
      await adapter.embed(['a']);

      expect(adapter.stats.totalInputTokens).toBe(0);
    });

    it('T-EE-30 | adapter.stats.totalOutputTokens === 0 (v1 convention)', async () => {
      const { adapter } = setup();
      await adapter.embed(['a']);
      await adapter.embed(['a']);
      await adapter.embed(['a']);

      expect(adapter.stats.totalOutputTokens).toBe(0);
    });
  });

  // ───────────────────────── §20.9 properties ─────────────────────────
  describe('§20.9 properties', () => {
    it('P-EE-a | embed(texts) returns an array of the same length as texts on success', async () => {
      for (const n of [1, 3, 7, 11]) {
        const vecs = Array.from({ length: n }, (_, i) => [i, i + 1, i + 2]);
        const fetchMock = createMockFetch({
          status: 200,
          body: embeddingsBody(vecs),
        });
        vi.stubGlobal('fetch', fetchMock);
        const adapter = buildAdapter({
          logger: createMockLogger(),
          batchSize: 100,
        });
        const texts = Array.from({ length: n }, (_, i) => `t-${i}`);
        const result = await adapter.embed(texts);

        expect(result).toHaveLength(n);
        vi.unstubAllGlobals();
      }
    });

    it('P-EE-b | vector order is deterministic and matches input order (anti-shuffle)', async () => {
      const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const vecs = texts.map((t, i) => [t.charCodeAt(0), i, 0]);
      const fetchMock = createMockFetch({
        status: 200,
        body: embeddingsBody(vecs),
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = buildAdapter({
        logger: createMockLogger(),
        batchSize: 100,
      });
      const result = await adapter.embed(texts);

      for (let i = 0; i < texts.length; i += 1) {
        const t = texts[i];
        expect(result[i]).toEqual([t?.charCodeAt(0) ?? 0, i, 0]);
      }
    });

    it('P-EE-c | embed([]) returns [] without any network call, regardless of config', async () => {
      const configurations: Array<{ batchSize?: number }> = [
        {},
        { batchSize: 1 },
        { batchSize: 100 },
        { batchSize: 1000 },
      ];
      for (const extra of configurations) {
        const fetchMock = createMockFetch(scenario.okFixture('openai-embeddings/ok-empty'));
        vi.stubGlobal('fetch', fetchMock);
        const adapter = buildAdapter({
          logger: createMockLogger(),
          ...extra,
        });
        const result = await adapter.embed([]);

        expect(result).toEqual([]);
        expect(fetchMock.calls).toHaveLength(0);
        vi.unstubAllGlobals();
      }
    });
  });
});
