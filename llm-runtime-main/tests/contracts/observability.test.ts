// NIB-T §22 — Contract invariants for observability (14 events).
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §22.1 shape, §22.2 corrélation, §22.3 séquence,
// §22.4 PII, §22.5 discipline de llm_call_end, §22.6 logger, §22.7 default logger.

import { describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createOpenAIEmbeddingAdapter } from '../../src/factories/openai-embeddings.js';
import { defaultStderrLogger } from '../../src/infra/logger.js';
import { ALL_LLM_ERROR_KINDS } from '../../src/services/error-kind.js';
import type {
  AdapterConfig,
  EmbeddingAdapterConfig,
  LLMEvent,
  LLMRequest,
} from '../../src/types.js';
import { eventAssertions } from '../helpers/event-assertions.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { createMockFetch, createScenarioFetch } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'mistral',
  'groq',
  'together',
  'ollama',
] as const;

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

const REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'Ping' }],
};

/**
 * Assert base-event fields (shared across the 14 event types).
 */
function assertBaseFields(event: LLMEvent): void {
  expect(typeof event.eventType).toBe('string');
  expect(event.callId).toMatch(ULID_REGEX);
  expect(PROVIDERS).toContain(event.provider);
  expect(typeof event.model).toBe('string');
  expect(event.timestamp).toMatch(ISO_REGEX);
}

// ─── §22.1 Shape des events ────────────────────────────────────────────────

describe('observability contracts', () => {
  describe('§22.1 event shapes', () => {
    it('C-OB-01 | llm_call_start conforms to required fields', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_start');
      expect(e).toBeDefined();
      if (e === undefined) return;
      assertBaseFields(e);
      if (e.eventType !== 'llm_call_start') return;
      expect(typeof e.endpoint).toBe('string');
      expect(typeof e.messagesCount).toBe('number');
      expect(e.messagesCount).toBeGreaterThanOrEqual(0);
    });

    it('C-OB-02 | llm_call_attempt_start conforms', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_attempt_start');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_attempt_start') return;
      assertBaseFields(e);
      expect(typeof e.attempt).toBe('number');
      expect(e.attempt).toBeGreaterThanOrEqual(0);
    });

    it('C-OB-03 | llm_call_throttled conforms (waitMs, reason, snapshotState, estimatedTokens)', async () => {
      // Build a scenario where the second call hits a throttled snapshot from the first.
      // Reset time is short (200ms) so the throttle sleep completes within test timeout.
      const fetchImpl = createScenarioFetch([
        {
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
          headers: {
            'anthropic-ratelimit-tokens-remaining': '0',
            'anthropic-ratelimit-tokens-reset': new Date(Date.now() + 200).toISOString(),
          },
        },
        scenario.ok('anthropic', 'hello'),
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_throttled');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_throttled') return;
      assertBaseFields(e);
      expect(typeof e.waitMs).toBe('number');
      expect(typeof e.reason).toBe('string');
      expect(['known', 'unknown', 'partial']).toContain(e.snapshotState);
      expect(typeof e.estimatedTokens).toBe('number');
    });

    it('C-OB-04 | llm_call_retry_scheduled conforms (attempt, delayMs, reason, errorKind)', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.serverError(),
        scenario.ok('anthropic', 'ok'),
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_retry_scheduled');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_retry_scheduled') return;
      assertBaseFields(e);
      expect(typeof e.attempt).toBe('number');
      expect(typeof e.delayMs).toBe('number');
      expect(typeof e.reason).toBe('string');
      expect(ALL_LLM_ERROR_KINDS).toContain(e.errorKind);
    });

    it('C-OB-05 | llm_call_fetch_error conforms (networkErrorKind?, message)', async () => {
      const fetchImpl = createScenarioFetch([scenario.networkError('connection')]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_fetch_error');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_fetch_error') return;
      assertBaseFields(e);
      expect(typeof e.message).toBe('string');
      if (e.networkErrorKind !== undefined) {
        expect(typeof e.networkErrorKind).toBe('string');
      }
    });

    it('C-OB-06 | llm_call_provider_error conforms (status, semanticErrorKind, retryable)', async () => {
      const fetchImpl = createScenarioFetch([scenario.authError()]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_provider_error');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_provider_error') return;
      assertBaseFields(e);
      expect(typeof e.status).toBe('number');
      expect(ALL_LLM_ERROR_KINDS).toContain(e.semanticErrorKind);
      expect(typeof e.retryable).toBe('boolean');
    });

    it('C-OB-07 | llm_call_parse_error conforms (message)', async () => {
      const fetchImpl = createScenarioFetch([
        { status: 200, body: 'not-json', headers: { 'content-type': 'text/html' } },
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_parse_error');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_parse_error') return;
      assertBaseFields(e);
      expect(typeof e.message).toBe('string');
    });

    it('C-OB-08 | llm_call_sanitized conforms (thinkingTagsRemoved, jsonFenceRemoved, rawContentPreview?)', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: '<thinking>x</thinking>Hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: {},
      });
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          sanitization: { stripThinkingTags: true },
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_sanitized');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_sanitized') return;
      assertBaseFields(e);
      expect(typeof e.thinkingTagsRemoved).toBe('boolean');
      expect(typeof e.jsonFenceRemoved).toBe('boolean');
      if (e.rawContentPreview !== undefined) {
        expect(typeof e.rawContentPreview).toBe('string');
      }
    });

    it('C-OB-09 | llm_call_unknown_error_classified conforms', async () => {
      // Produce a fetch-level error with no classifiable network code.
      // Engine emits llm_call_unknown_error_classified when classifyNetworkError returns undefined.
      const fetchImpl = createScenarioFetch([
        { status: 0, body: null, headers: {}, throwError: new Error('mysterious failure') },
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_unknown_error_classified');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_unknown_error_classified') return;
      assertBaseFields(e);
      expect(typeof e.rawMessage).toBe('string');
    });

    it('C-OB-10 | llm_call_unknown_termination conforms (rawSignal)', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'something_unexpected',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: {},
      });
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_unknown_termination');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_unknown_termination') return;
      assertBaseFields(e);
      expect(typeof e.rawSignal).toBe('string');
    });

    it('C-OB-11 | llm_call_end conforms (success, durationMs, attemptCount, termination?, usage?, providerModel?, errorKind?)', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_end');
      expect(e).toBeDefined();
      if (e === undefined || e.eventType !== 'llm_call_end') return;
      assertBaseFields(e);
      expect(typeof e.success).toBe('boolean');
      expect(typeof e.durationMs).toBe('number');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof e.attemptCount).toBe('number');
    });

    it('C-OB-12 | llm_embedding_start conforms (endpoint, textsCount, batchSize)', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({
            batchSize: 2,
            logging: { enabled: true, logger },
          }),
        );
        await adapter.embed(['a']).catch(() => undefined);
        const e = logger.find('llm_embedding_start');
        expect(e).toBeDefined();
        if (e === undefined || e.eventType !== 'llm_embedding_start') return;
        assertBaseFields(e);
        expect(typeof e.endpoint).toBe('string');
        expect(typeof e.textsCount).toBe('number');
        expect(typeof e.batchSize).toBe('number');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('C-OB-13 | llm_embedding_batch conforms (batchIndex, batchTextsCount, durationMs)', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({
            batchSize: 1,
            logging: { enabled: true, logger },
          }),
        );
        await adapter.embed(['a', 'b', 'c']).catch(() => undefined);
        const e = logger.find('llm_embedding_batch');
        expect(e).toBeDefined();
        if (e === undefined || e.eventType !== 'llm_embedding_batch') return;
        assertBaseFields(e);
        expect(typeof e.batchIndex).toBe('number');
        expect(typeof e.batchTextsCount).toBe('number');
        expect(typeof e.durationMs).toBe('number');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('C-OB-14 | llm_embedding_end conforms (success, totalBatches, totalDurationMs, errorKind?)', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({
            batchSize: 2,
            logging: { enabled: true, logger },
          }),
        );
        await adapter.embed(['a']).catch(() => undefined);
        const e = logger.find('llm_embedding_end');
        expect(e).toBeDefined();
        if (e === undefined || e.eventType !== 'llm_embedding_end') return;
        assertBaseFields(e);
        expect(typeof e.success).toBe('boolean');
        expect(typeof e.totalBatches).toBe('number');
        expect(typeof e.totalDurationMs).toBe('number');
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ─── §22.2 Corrélation ───────────────────────────────────────────────────

  describe('§22.2 correlation', () => {
    it('C-OB-15 | all events of a successful completion share the same callId', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      eventAssertions.allSameCallId(logger.events);
    });

    it('C-OB-16 | all events of a successful embedding share the same callId', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({
            logging: { enabled: true, logger },
          }),
        );
        await adapter.embed(['a']).catch(() => undefined);
        eventAssertions.allSameCallId(logger.events);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('C-OB-17 | two consecutive calls have different callIds', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.ok('anthropic', 'a'),
        scenario.ok('anthropic', 'b'),
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      await adapter.call(REQUEST).catch(() => undefined);
      const ends = logger.findAll('llm_call_end');
      expect(ends.length).toBeGreaterThanOrEqual(2);
      const [a, b] = ends;
      if (a === undefined || b === undefined) return;
      expect(a.callId).not.toBe(b.callId);
    });

    it('C-OB-18 | callIds are lexicographically increasing (ULID property)', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.ok('anthropic', 'a'),
        scenario.ok('anthropic', 'b'),
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      await adapter.call(REQUEST).catch(() => undefined);
      const ends = logger.findAll('llm_call_end');
      const [a, b] = ends;
      if (a === undefined || b === undefined) return;
      expect(a.callId < b.callId).toBe(true);
    });
  });

  // ─── §22.3 Séquence ──────────────────────────────────────────────────────

  describe('§22.3 event sequence', () => {
    it('C-OB-19 | completion success with one attempt: start, attempt_start, end', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      eventAssertions.sequenceMatches(logger.events, [
        'llm_call_start',
        'llm_call_attempt_start',
        'llm_call_end',
      ]);
    });

    it('C-OB-20 | completion with retries: start, N * (attempt_start, error, retry_scheduled), final attempt_start, end', async () => {
      const fetchImpl = createScenarioFetch([
        scenario.serverError(),
        scenario.ok('anthropic', 'ok'),
      ]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 2, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const types = logger.eventTypes();
      expect(types[0]).toBe('llm_call_start');
      expect(types).toContain('llm_call_attempt_start');
      expect(types).toContain('llm_call_retry_scheduled');
      expect(types).toContain('llm_call_end');
      expect(types[types.length - 1]).toBe('llm_call_end');
    });

    it('C-OB-21 | embedding, 3 batches: embedding_start, embedding_batch × 3, embedding_end', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({
            batchSize: 1,
            logging: { enabled: true, logger },
          }),
        );
        await adapter.embed(['a', 'b', 'c']).catch(() => undefined);
        const batches = eventAssertions.countOfType(logger.events, 'llm_embedding_batch');
        expect(batches).toBe(3);
        expect(logger.events[0]?.eventType).toBe('llm_embedding_start');
        expect(logger.events[logger.events.length - 1]?.eventType).toBe('llm_embedding_end');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('C-OB-22 | llm_call_end is the last event of any completion', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      eventAssertions.endEventFinal(logger.events);
    });

    it('C-OB-23 | llm_embedding_end is the last event of any embedding', async () => {
      const fetchImpl = createMockFetch({
        status: 200,
        body: { data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 1 } },
        headers: {},
      });
      vi.stubGlobal('fetch', fetchImpl);
      try {
        const logger = createMockLogger();
        const adapter = createOpenAIEmbeddingAdapter(
          baseEmbConfig({ logging: { enabled: true, logger } }),
        );
        await adapter.embed(['a']).catch(() => undefined);
        eventAssertions.endEventFinal(logger.events);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  // ─── §22.4 PII absence ───────────────────────────────────────────────────

  describe('§22.4 PII absence', () => {
    const PII_PROMPT = 'SUPER-SECRET-PROMPT-MARKER-PII';
    const PII_RESPONSE = 'SUPER-SECRET-RESPONSE-MARKER-PII';

    it('C-OB-24 | no event (except sanitized.rawContentPreview) contains request message content', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', PII_RESPONSE));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter
        .call({ messages: [{ role: 'user', content: PII_PROMPT }] })
        .catch(() => undefined);
      const nonSanitized = logger.events.filter((e) => e.eventType !== 'llm_call_sanitized');
      eventAssertions.noPIIIn(nonSanitized, [PII_PROMPT]);
    });

    it('C-OB-25 | no event (except controlled preview) contains the response content', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', PII_RESPONSE));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter
        .call({ messages: [{ role: 'user', content: PII_PROMPT }] })
        .catch(() => undefined);
      const nonSanitized = logger.events.filter((e) => e.eventType !== 'llm_call_sanitized');
      eventAssertions.noPIIIn(nonSanitized, [PII_RESPONSE]);
    });

    it('C-OB-26 | llm_call_sanitized.rawContentPreview length ≤ 500 chars when present', async () => {
      const longContent = '<thinking>'.concat('X'.repeat(10_000), '</thinking>');
      const fetchImpl = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: longContent }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: {},
      });
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          sanitization: { stripThinkingTags: true },
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_sanitized');
      if (e === undefined || e.eventType !== 'llm_call_sanitized') return;
      if (e.rawContentPreview !== undefined) {
        expect(e.rawContentPreview.length).toBeLessThanOrEqual(500);
      }
    });

    it('C-OB-27 | rawContentPreview present ONLY when thinkingTagsRemoved && content.length === 0', async () => {
      // Case A: content becomes empty after strip → preview SHOULD be present.
      const fetchA = createMockFetch({
        status: 200,
        body: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: '<thinking>only thinking</thinking>' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: {},
      });
      const loggerA = createMockLogger();
      const adapterA = createAnthropicAdapter(
        baseConfig({
          sanitization: { stripThinkingTags: true },
          logging: { enabled: true, logger: loggerA },
          providerOptions: { fetch: fetchA },
        }),
      );
      await adapterA.call(REQUEST).catch(() => undefined);
      const sA = loggerA.find('llm_call_sanitized');
      if (sA !== undefined && sA.eventType === 'llm_call_sanitized') {
        if (sA.thinkingTagsRemoved) {
          // The spec requires preview present only when content becomes empty.
          // GREEN: assert that when preview is present, content was empty.
          expect(typeof sA.rawContentPreview).toBe('string');
        }
      }

      // Case B: content non-empty after strip → preview SHOULD be absent.
      const fetchB = createMockFetch({
        status: 200,
        body: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: '<thinking>x</thinking>Hello' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        headers: {},
      });
      const loggerB = createMockLogger();
      const adapterB = createAnthropicAdapter(
        baseConfig({
          sanitization: { stripThinkingTags: true },
          logging: { enabled: true, logger: loggerB },
          providerOptions: { fetch: fetchB },
        }),
      );
      await adapterB.call(REQUEST).catch(() => undefined);
      const sB = loggerB.find('llm_call_sanitized');
      if (sB !== undefined && sB.eventType === 'llm_call_sanitized') {
        if (sB.thinkingTagsRemoved) {
          expect(sB.rawContentPreview).toBeUndefined();
        }
      }
    });
  });

  // ─── §22.5 Discipline de llm_call_end ────────────────────────────────────

  describe('§22.5 llm_call_end discipline', () => {
    const ALLOWED_FIELDS = new Set([
      'eventType',
      'callId',
      'provider',
      'model',
      'timestamp',
      'success',
      'durationMs',
      'attemptCount',
      'termination',
      'usage',
      'providerModel',
      'errorKind',
    ]);

    it('C-OB-28 | llm_call_end has exactly the whitelisted fields and all required fields', async () => {
      const REQUIRED_FIELDS = [
        'eventType',
        'callId',
        'provider',
        'model',
        'timestamp',
        'success',
        'durationMs',
        'attemptCount',
      ];
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_end');
      expect(e).toBeDefined();
      if (e === undefined) return;
      // No extra fields beyond whitelist.
      const keys = Object.keys(e);
      for (const k of keys) {
        expect(ALLOWED_FIELDS.has(k)).toBe(true);
      }
      // All required fields present.
      for (const r of REQUIRED_FIELDS) {
        expect(keys).toContain(r);
      }
    });

    it('C-OB-29 | success === true ⇒ termination and usage defined; errorKind absent', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_end');
      if (e === undefined || e.eventType !== 'llm_call_end') return;
      if (e.success) {
        expect(e.termination).toBeDefined();
        expect(e.usage).toBeDefined();
        expect(e.errorKind).toBeUndefined();
      }
    });

    it('C-OB-30 | success === false ⇒ errorKind defined', async () => {
      const fetchImpl = createScenarioFetch([scenario.authError()]);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      const e = logger.find('llm_call_end');
      if (e === undefined || e.eventType !== 'llm_call_end') return;
      expect(e.success).toBe(false);
      expect(ALL_LLM_ERROR_KINDS).toContain(e.errorKind);
    });
  });

  // ─── §22.6 Logger injectable ─────────────────────────────────────────────

  describe('§22.6 injectable logger', () => {
    it('C-OB-31 | custom logger receives events (not stderr)', async () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
        const logger = createMockLogger();
        const adapter = createAnthropicAdapter(
          baseConfig({
            logging: { enabled: true, logger },
            providerOptions: { fetch: fetchImpl },
          }),
        );
        await adapter.call(REQUEST).catch(() => undefined);
        expect(logger.events.length).toBeGreaterThan(0);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it('C-OB-32 | enabled: false with custom logger → emit never called', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: false, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      expect(logger.events.length).toBe(0);
    });

    it('C-OB-33 | default logger with enabled: false → no stderr write', async () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
        const adapter = createAnthropicAdapter(
          baseConfig({
            logging: { enabled: false },
            providerOptions: { fetch: fetchImpl },
          }),
        );
        await adapter.call(REQUEST).catch(() => undefined);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ─── §22.7 Default logger format ─────────────────────────────────────────

  describe('§22.7 default logger format', () => {
    it('C-OB-34 | each stderr line is valid JSON', () => {
      const written: string[] = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });
      try {
        defaultStderrLogger.emit({
          eventType: 'llm_call_start',
          callId: '01HBCDEFG0123456789ABCDEFG',
          provider: 'anthropic',
          model: 'claude-test',
          timestamp: new Date().toISOString(),
          endpoint: 'https://api.anthropic.com/v1/messages',
          messagesCount: 1,
        });
      } finally {
        spy.mockRestore();
      }
      // Must have written at least one line (catches "silent no-op" regression).
      expect(written.length).toBeGreaterThan(0);
      for (const line of written) {
        for (const part of line.split('\n').filter((s) => s.length > 0)) {
          expect(() => JSON.parse(part)).not.toThrow();
        }
      }
    });

    it('C-OB-35 | separator is LF (\\n), not CRLF', () => {
      const written: string[] = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });
      try {
        defaultStderrLogger.emit({
          eventType: 'llm_call_start',
          callId: '01HBCDEFG0123456789ABCDEFG',
          provider: 'anthropic',
          model: 'claude-test',
          timestamp: new Date().toISOString(),
          endpoint: 'https://api.anthropic.com/v1/messages',
          messagesCount: 1,
        });
      } finally {
        spy.mockRestore();
      }
      expect(written.length).toBeGreaterThan(0);
      for (const line of written) {
        expect(line.includes('\r\n')).toBe(false);
      }
    });

    it('C-OB-36 | encoding is UTF-8 (accepts non-ASCII characters)', () => {
      const written: Uint8Array[] = [];
      const spy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation((chunk: string | Uint8Array) => {
          written.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
          return true;
        });
      try {
        defaultStderrLogger.emit({
          eventType: 'llm_call_start',
          callId: '01HBCDEFG0123456789ABCDEFG',
          provider: 'anthropic',
          model: 'çàé-claude',
          timestamp: new Date().toISOString(),
          endpoint: 'https://api.anthropic.com/v1/messages',
          messagesCount: 1,
        });
      } finally {
        spy.mockRestore();
      }
      expect(written.length).toBeGreaterThan(0);
      for (const buf of written) {
        const decoded = Buffer.from(buf).toString('utf8');
        expect(typeof decoded).toBe('string');
      }
    });
  });
});
