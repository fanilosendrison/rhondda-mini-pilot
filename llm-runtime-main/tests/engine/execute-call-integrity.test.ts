// NIB-T §19 — RED-phase acceptance tests for executeCall integrity.
// Reference: specs/NIB-T-LLMRUNTIME.md §19 (T-EC-120..T-EC-141).
//
// Exercises IntegrityPolicy enforcement: silent JSON truncation detection,
// explicit max_tokens, unknown termination handling (soft vs strict), and
// modelMismatch predicates. fetch is stubbed via vi.stubGlobal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderProtocolError, SilentTruncationError } from '../../src/errors/index.js';
import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createOpenAIAdapter } from '../../src/factories/openai.js';
import type { LLMCallUnknownTerminationEvent } from '../../src/types.js';
import { createMockFetch, createScenarioFetch } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';

// ─────────────────── Anthropic-shaped bodies used repeatedly ───────────────────

function anthropicBody(text: string, stopReason: string = 'end_turn'): unknown {
  return {
    id: 'msg_integ_001',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-6-20260301',
    content: [{ type: 'text', text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 10 },
  };
}

function openaiBody(content: string, model: string, finish: string = 'stop'): unknown {
  return {
    id: 'chatcmpl-integ-001',
    object: 'chat.completion',
    created: 1730000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
  };
}

describe('executeCall — integrity (§19)', () => {
  beforeEach(() => {
    // nothing
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §19.1 truncation détectée — not fail ─────────────────────────
  describe('§19.1 truncation détectée mais not-fail (diagnostic)', () => {
    function setup(): ReturnType<typeof createAnthropicAdapter> {
      const fetchMock = createMockFetch({
        status: 200,
        body: anthropicBody('{ "a": 1, "b": 2'),
      });
      vi.stubGlobal('fetch', fetchMock);
      return createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        integrity: {
          detectHeuristicTruncation: true,
          failOnSilentTruncation: false,
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
    }

    it('T-EC-120 | response.integrity.truncationDetected === true', async () => {
      const adapter = setup();
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.integrity.truncationDetected).toBe(true);
    });

    it('T-EC-121 | response.integrity.truncationMode === "heuristic_json_unclosed"', async () => {
      const adapter = setup();
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.integrity.truncationMode).toBe('heuristic_json_unclosed');
    });

    it('T-EC-122 | no throw (diagnostic only)', async () => {
      const adapter = setup();
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });

  // ───────────────────────── §19.2 truncation + fail strict ─────────────────────────
  describe('§19.2 truncation détectée + failOnSilentTruncation=true', () => {
    function setup(): ReturnType<typeof createAnthropicAdapter> {
      const fetchMock = createMockFetch({
        status: 200,
        body: anthropicBody('{ "a": 1, "b": 2'),
      });
      vi.stubGlobal('fetch', fetchMock);
      return createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        integrity: {
          detectHeuristicTruncation: true,
          failOnSilentTruncation: true,
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
    }

    it('T-EC-123 | throws SilentTruncationError with attempts=1', async () => {
      const adapter = setup();
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(SilentTruncationError);
      expect((caught as SilentTruncationError).attempts).toBe(1);
    });

    it('T-EC-124 | no retry (fatal)', async () => {
      const fetchMock = createScenarioFetch([
        { status: 200, body: anthropicBody('{ "a": 1, "b": 2') },
      ]);
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        retry: { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 },
        integrity: {
          detectHeuristicTruncation: true,
          failOnSilentTruncation: true,
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      expect(fetchMock.calls).toHaveLength(1);
    });
  });

  // ───────────────────────── §19.3 explicit max_tokens ─────────────────────────
  describe('§19.3 truncation explicite max_tokens', () => {
    function setup(failOnSilentTruncation: boolean): ReturnType<typeof createAnthropicAdapter> {
      const fetchMock = createMockFetch({
        status: 200,
        body: anthropicBody('partial output', 'max_tokens'),
      });
      vi.stubGlobal('fetch', fetchMock);
      return createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        integrity: {
          detectHeuristicTruncation: true,
          failOnSilentTruncation,
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
    }

    it('T-EC-125 | response.integrity.truncationDetected === true', async () => {
      const adapter = setup(false);
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.integrity.truncationDetected).toBe(true);
    });

    it('T-EC-126 | response.integrity.truncationMode === "explicit_max_tokens"', async () => {
      const adapter = setup(false);
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.integrity.truncationMode).toBe('explicit_max_tokens');
    });

    it('T-EC-127 | response.termination === "max_tokens"', async () => {
      const adapter = setup(false);
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.termination).toBe('max_tokens');
    });

    it('T-EC-128 | no throw even with failOnSilentTruncation=true (explicit, not silent)', async () => {
      const adapter = setup(true);
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });

  // ───────────────────────── §19.4 terminationSignal inconnu (soft) ─────────────────────────
  describe('§19.4 terminationSignal inconnu (soft, default)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
    } {
      const fetchMock = createMockFetch({
        status: 200,
        body: anthropicBody('Hi', 'foo_unknown'),
      });
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        integrity: { failOnUnknownTermination: false },
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter };
    }

    it('T-EC-129 | response.termination === "unknown"', async () => {
      const { adapter } = setup();
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.termination).toBe('unknown');
    });

    it('T-EC-130 | llm_call_unknown_termination event emitted with rawSignal="foo_unknown"', async () => {
      const { logger, adapter } = setup();
      await adapter.call({ messages: [{ role: 'user', content: 'Hi' }] });

      const event = logger.find('llm_call_unknown_termination') as
        | LLMCallUnknownTerminationEvent
        | undefined;
      expect(event).toBeDefined();
      expect(event?.rawSignal).toBe('foo_unknown');
    });

    it('T-EC-131 | no throw (soft mode)', async () => {
      const { adapter } = setup();
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });

  // ───────────────────────── §19.5 terminationSignal inconnu (strict) ─────────────────────────
  describe('§19.5 terminationSignal inconnu (strict)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
    } {
      const fetchMock = createMockFetch({
        status: 200,
        body: anthropicBody('Hi', 'foo_unknown'),
      });
      vi.stubGlobal('fetch', fetchMock);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        integrity: { failOnUnknownTermination: true },
        sanitization: {},
        logging: { logger },
      });
      return { logger, adapter };
    }

    it('T-EC-132 | throws ProviderProtocolError, attempts=1', async () => {
      const { adapter } = setup();
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(ProviderProtocolError);
      expect((caught as ProviderProtocolError).attempts).toBe(1);
    });

    it('T-EC-133 | llm_call_unknown_termination emitted before llm_call_end', async () => {
      const { logger, adapter } = setup();
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch(() => undefined);

      expect(logger.find('llm_call_unknown_termination')).toBeDefined();
      // Verify event ordering: unknown_termination must appear before call_end.
      const types = logger.events.map((e: { eventType: string }) => e.eventType);
      const unknownIdx = types.indexOf('llm_call_unknown_termination');
      const endIdx = types.indexOf('llm_call_end');
      expect(unknownIdx).toBeGreaterThanOrEqual(0);
      expect(endIdx).toBeGreaterThanOrEqual(0);
      expect(unknownIdx).toBeLessThan(endIdx);
    });
  });

  // ───────────────────────── §19.6 modelMismatch avec mayRouteModel (skip) ─────────────────────────
  describe('§19.6 modelMismatch — Anthropic (mayRouteModel=true), failOnModelMismatch=false', () => {
    it('T-EC-134 | response.providerModel === response body.model (aliasing authorized)', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'msg_alias_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4',
        apiKey: 'test-key',
        integrity: { failOnModelMismatch: false },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.providerModel).toBe('claude-opus-4-6-20260301');
    });

    it('T-EC-135 | no throw (aliasing authorized by binding)', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'msg_alias_2',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4',
        apiKey: 'test-key',
        integrity: { failOnModelMismatch: false },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });

  // ───────────────────────── §19.7 modelMismatch failOnModelMismatch=true ─────────────────────────
  describe('§19.7 modelMismatch failOnModelMismatch=true', () => {
    it('T-EC-136 | Anthropic (mayRouteModel=true) → no throw even with failOnModelMismatch=true', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'msg_alias_3',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4',
        apiKey: 'test-key',
        integrity: { failOnModelMismatch: true },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });

    it('T-EC-137 | OpenAI (mayRouteModel=false) with mismatch → throws ProviderProtocolError', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: openaiBody('Hi', 'gpt-4o-2024-08-06'),
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createOpenAIAdapter({
        model: 'gpt-4o-mini', // not what the response returns
        apiKey: 'test-key',
        integrity: { failOnModelMismatch: true },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(ProviderProtocolError);
    });
  });

  // ───────────────────────── §19.8 modelMismatch predicate ─────────────────────────
  describe('§19.8 modelMismatch avec predicate custom', () => {
    it('T-EC-138 | Anthropic + strict predicate → throws ProviderProtocolError (predicate trumps mayRouteModel)', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'msg_mismatch',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-20260301',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4',
        apiKey: 'test-key',
        integrity: {
          failOnModelMismatch: true,
          modelMismatchPredicate: (req, res) => req !== res,
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      let caught: unknown;
      await adapter
        .call({
          messages: [{ role: 'user', content: 'Hi' }],
        })
        .catch((err: unknown) => {
          caught = err;
        });

      expect(caught).toBeInstanceOf(ProviderProtocolError);
    });

    it('T-EC-139 | alias-accepting predicate → no throw', async () => {
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'msg_alias_ok',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-6-xyz',
          content: [{ type: 'text', text: 'Hi' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4',
        apiKey: 'test-key',
        integrity: {
          failOnModelMismatch: true,
          modelMismatchPredicate: (req, res) => !res.startsWith(req),
        },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });

  // ───────────────────────── §19.9 providerModel absent ─────────────────────────
  describe('§19.9 providerModel absent', () => {
    function setup(failOnModelMismatch: boolean): ReturnType<typeof createOpenAIAdapter> {
      // OpenAI body without a `model` field.
      const fetchMock = createMockFetch({
        status: 200,
        body: {
          id: 'chatcmpl_no_model',
          object: 'chat.completion',
          created: 1730000000,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Hi' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
      vi.stubGlobal('fetch', fetchMock);
      return createOpenAIAdapter({
        model: 'gpt-4o',
        apiKey: 'test-key',
        integrity: { failOnModelMismatch },
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
    }

    it('T-EC-140 | response.providerModel === undefined', async () => {
      const adapter = setup(false);
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.providerModel).toBeUndefined();
    });

    it('T-EC-141 | mismatch check skipped silently (no throw, even with failOnModelMismatch=true)', async () => {
      const adapter = setup(true);
      await expect(
        adapter.call({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).resolves.toMatchObject({ termination: expect.any(String) });
    });
  });
});
