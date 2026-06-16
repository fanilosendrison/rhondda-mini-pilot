// NIB-T §15 — RED-phase acceptance + property tests for executeCall happy-path.
// Reference: specs/NIB-T-LLMRUNTIME.md §15 (T-EC-01..T-EC-24 + P-EC-a, P-EC-b).
//
// Tests exercise the engine via public adapter factories (Layer 1 composition
// over Layer 2). fetch is stubbed via vi.stubGlobal to keep tests
// provider-agnostic (factories do not expose a fetchImpl hook publicly).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAnthropicAdapter } from '../../src/factories/anthropic.js';
import { createGoogleAdapter } from '../../src/factories/google.js';
import { createOpenAIAdapter } from '../../src/factories/openai.js';
import { createOpenAICompatibleAdapter } from '../../src/factories/openai-compatible.js';
import type { LLMCallEndEvent, LLMCallSanitizedEvent, LLMRequest } from '../../src/types.js';
import { deepFreeze } from '../helpers/deep-freeze.js';
import { eventAssertions } from '../helpers/event-assertions.js';
import { scenario } from '../helpers/fetch-scenario.js';
import { loadJsonFixture } from '../helpers/fixture-loader.js';
import { createMockFetch, createScenarioFetch, type MockResponse } from '../helpers/mock-fetch.js';
import { createMockLogger } from '../helpers/mock-logger.js';

const ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

describe('executeCall — happy path (§15)', () => {
  beforeEach(() => {
    // per-test stubs; nothing global yet.
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ───────────────────────── §15.1 Anthropic succès simple ─────────────────────────
  describe('§15.1 Anthropic succès simple', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      request: LLMRequest;
    } {
      const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'Hello' }],
      };
      return { logger, adapter, request };
    }

    it('T-EC-01 | response shape — content, termination, attemptCount, ULID callId, provider, model', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.content).toBe('Hello');
      expect(response.termination).toBe('completed');
      expect(response.attemptCount).toBe(1);
      expect(response.durationMs).toBeGreaterThanOrEqual(0);
      expect(response.callId).toMatch(ULID_REGEX);
      expect(response.provider).toBe('anthropic');
      expect(response.model).toBe('claude-opus-4-6');
    });

    it('T-EC-02 | exactly 3 events in order: start, attempt_start, end (success)', async () => {
      const { logger, adapter, request } = setup();
      await adapter.call(request);

      eventAssertions.sequenceMatches(logger.events, [
        'llm_call_start',
        'llm_call_attempt_start',
        'llm_call_end',
      ]);
      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent).toBeDefined();
      expect(endEvent?.success).toBe(true);
    });

    it('T-EC-03 | all events share the same callId (correlation)', async () => {
      const { logger, adapter, request } = setup();
      await adapter.call(request);

      eventAssertions.allSameCallId(logger.events);
    });

    it('T-EC-04 | llm_call_end success=true, attemptCount=1, termination=completed, no errorKind', async () => {
      const { logger, adapter, request } = setup();
      await adapter.call(request);

      const endEvent = logger.find('llm_call_end') as LLMCallEndEvent | undefined;
      expect(endEvent).toBeDefined();
      expect(endEvent?.success).toBe(true);
      expect(endEvent?.attemptCount).toBe(1);
      expect(endEvent?.termination).toBe('completed');
      expect(endEvent?.errorKind).toBeUndefined();
    });

    it('T-EC-05 | response.startedAt and endedAt ISO 8601 with endedAt >= startedAt', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.startedAt).toMatch(ISO_REGEX);
      expect(response.endedAt).toMatch(ISO_REGEX);
      expect(Date.parse(response.endedAt)).toBeGreaterThanOrEqual(Date.parse(response.startedAt));
    });
  });

  // ───────────────────────── §15.2 OpenAI succès avec sanitization ─────────────────────────
  describe('§15.2 OpenAI succès avec sanitization (JSON fence)', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAIAdapter>;
      request: LLMRequest;
    } {
      const body = {
        id: 'chatcmpl-fence-001',
        object: 'chat.completion',
        created: 1730000000,
        model: 'gpt-4o-2024-08-06',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '```json\n{"a":1}\n```',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
      };
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createOpenAIAdapter({
        model: 'gpt-4o',
        apiKey: 'test-key',
        sanitization: { stripJsonFence: true },
        logging: { logger },
      });
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'give me json' }],
      };
      return { logger, adapter, request };
    }

    it('T-EC-06 | rawContent preserves the fenced content', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.rawContent).toBe('```json\n{"a":1}\n```');
    });

    it('T-EC-07 | content is stripped of the JSON fence', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.content).toBe('{"a":1}');
    });

    it('T-EC-08 | sanitization info reports jsonFenceRemoved=true, thinkingTagsRemoved=false', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.sanitization).toEqual({
        thinkingTagsRemoved: false,
        jsonFenceRemoved: true,
      });
    });

    it('T-EC-09 | llm_call_sanitized event emitted with correct flags', async () => {
      const { logger, adapter, request } = setup();
      await adapter.call(request);

      const sanitized = logger.find('llm_call_sanitized') as LLMCallSanitizedEvent | undefined;
      expect(sanitized).toBeDefined();
      expect(sanitized?.jsonFenceRemoved).toBe(true);
      expect(sanitized?.thinkingTagsRemoved).toBe(false);
    });
  });

  // ───────────────────────── §15.3 DeepSeek R1 thinking tags ─────────────────────────
  describe('§15.3 DeepSeek R1 avec thinking tags', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createOpenAICompatibleAdapter>;
      request: LLMRequest;
    } {
      const body = {
        id: 'chatcmpl-ds-001',
        object: 'chat.completion',
        created: 1730000000,
        model: 'deepseek-r1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<think>reasoning</think>final',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
      };
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createOpenAICompatibleAdapter({
        provider: 'deepseek',
        model: 'deepseek-r1',
        apiKey: 'test-key',
        endpoint: 'https://api.deepseek.com/v1/chat/completions',
        sanitization: {},
        logging: { logger },
      });
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'think' }],
      };
      return { logger, adapter, request };
    }

    it('T-EC-10 | rawContent preserves the <think>…</think> block', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.rawContent).toBe('<think>reasoning</think>final');
    });

    it('T-EC-11 | content is stripped of the <think> block (deepseek default)', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.content).toBe('final');
    });

    it('T-EC-12 | sanitization thinkingTagsRemoved=true, jsonFenceRemoved=false', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.sanitization).toEqual({
        thinkingTagsRemoved: true,
        jsonFenceRemoved: false,
      });
    });
  });

  // ───────────────────────── §15.4 content vide après sanitization ─────────────────────────
  describe('§15.4 content vide après sanitization', () => {
    function setup(): {
      logger: ReturnType<typeof createMockLogger>;
      adapter: ReturnType<typeof createAnthropicAdapter>;
      request: LLMRequest;
    } {
      const body = {
        id: 'msg_empty_001',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: '<think>only thinking</think>' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      };
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: { stripThinkingTags: true },
        logging: { logger },
      });
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'empty' }],
      };
      return { logger, adapter, request };
    }

    it('T-EC-13 | rawContent is non-empty (original preserved)', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.rawContent).toBe('<think>only thinking</think>');
    });

    it('T-EC-14 | content is empty string after strip', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.content).toBe('');
    });

    it('T-EC-15 | integrity.truncationDetected === false (empty != truncation)', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.integrity.truncationDetected).toBe(false);
    });

    it('T-EC-16 | llm_call_sanitized carries rawContentPreview (controlled exception)', async () => {
      const { logger, adapter, request } = setup();
      await adapter.call(request);

      const sanitized = logger.find('llm_call_sanitized') as LLMCallSanitizedEvent | undefined;
      expect(sanitized).toBeDefined();
      expect(sanitized?.rawContentPreview).toBeDefined();
    });

    it('T-EC-17 | termination === "completed" (normal mapping)', async () => {
      const { adapter, request } = setup();
      const response = await adapter.call(request);

      expect(response.termination).toBe('completed');
    });
  });

  // ───────────────────────── §15.5 override temperature + maxTokens ─────────────────────────
  describe('§15.5 override temperature et maxTokens', () => {
    it('T-EC-18 | fetch body contains temperature=0.2 and max_tokens=500 (Anthropic)', async () => {
      const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.2,
        maxTokens: 500,
      });

      expect(mockFetch.calls).toHaveLength(1);
      const firstCall = mockFetch.calls[0];
      expect(firstCall).toBeDefined();
      const body = firstCall?.body as Record<string, unknown> | undefined;
      expect(body).toBeDefined();
      expect(body?.['temperature']).toBe(0.2);
      expect(body?.['max_tokens']).toBe(500);
    });
  });

  // ───────────────────────── §15.6 usage + stats ─────────────────────────
  describe('§15.6 usage capturé et stats incrémentées', () => {
    it('T-EC-19 | Anthropic usage mapped: inputTokens=10, outputTokens=5, totalTokens=15', async () => {
      const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
      expect(response.usage.totalTokens).toBe(15);
    });

    it('T-EC-20 | 3 consecutive success calls aggregate stats', async () => {
      const bodies: MockResponse[] = [
        scenario.okFixture('anthropic/ok-simple'),
        scenario.okFixture('anthropic/ok-simple'),
        scenario.okFixture('anthropic/ok-simple'),
      ];
      const mockFetch = createScenarioFetch(bodies);
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const req: LLMRequest = { messages: [{ role: 'user', content: 'Hi' }] };
      await adapter.call(req);
      await adapter.call(req);
      await adapter.call(req);

      expect(adapter.stats.totalCalls).toBe(3);
      // ok-simple fixture: input=10, output=5 → aggregated across 3 calls.
      expect(adapter.stats.totalInputTokens).toBe(30);
      expect(adapter.stats.totalOutputTokens).toBe(15);
    });
  });

  // ───────────────────────── §15.7 LLMRequest immutable ─────────────────────────
  describe('§15.7 LLMRequest immutable (I-10)', () => {
    it('T-EC-21 | deepFreeze(request) before adapter.call(request) does not throw', async () => {
      const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
      vi.stubGlobal('fetch', mockFetch);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      const request = deepFreeze<LLMRequest>({
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.5,
      });

      await expect(adapter.call(request)).resolves.toBeDefined();
    });

    it('T-EC-22 | request is structurally unchanged after call (deep compare)', async () => {
      const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
      vi.stubGlobal('fetch', mockFetch);
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger: createMockLogger() },
      });
      const request: LLMRequest = {
        messages: [{ role: 'user', content: 'Hi' }],
        temperature: 0.5,
        maxTokens: 100,
      };
      const snapshot = JSON.parse(JSON.stringify(request)) as LLMRequest;

      await adapter.call(request);

      expect(request).toEqual(snapshot);
    });
  });

  // ───────────────────────── §15.8 providerResponseId, providerModel ─────────────────────────
  describe('§15.8 providerResponseId et providerModel', () => {
    it('T-EC-23 | OpenAI body id=chatcmpl-abc123 → providerModel reflected from body.model', async () => {
      const body = {
        id: 'chatcmpl-abc123',
        object: 'chat.completion',
        created: 1730000000,
        model: 'gpt-4o-2024-08-06',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hi' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createOpenAIAdapter({
        model: 'gpt-4o',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.providerModel).toBe('gpt-4o-2024-08-06');
      expect(response.providerResponseId).toBe('chatcmpl-abc123');
    });

    it('T-EC-24 | Gemini body without modelVersion → providerModel undefined (no fabrication)', async () => {
      const body = {
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
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createGoogleAdapter({
        model: 'gemini-2.0-flash',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const response = await adapter.call({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(response.providerModel).toBeUndefined();
    });
  });

  // ───────────────────────── §15.9 Properties ─────────────────────────
  describe('§15.9 properties', () => {
    it('P-EC-a | deterministic binding + fixed fetch → same response across 3 runs per request variant', async () => {
      // Use multiple request contents to avoid tautology with a single constant fixture.
      const contents = ['Hello', 'Tell me a joke', 'What is 2+2?', 'Summarize this'];
      const runOnce = async (
        userContent: string,
      ): Promise<{ content: string; provider: string; model: string }> => {
        const mockFetch = createMockFetch(scenario.okFixture('anthropic/ok-simple'));
        vi.stubGlobal('fetch', mockFetch);
        const adapter = createAnthropicAdapter({
          model: 'claude-opus-4-6',
          apiKey: 'test-key',
          sanitization: {},
          logging: { logger: createMockLogger() },
        });
        const req = deepFreeze<LLMRequest>({
          messages: [{ role: 'user', content: userContent }],
        });
        const response = await adapter.call(req);
        vi.unstubAllGlobals();
        return {
          content: response.content,
          provider: response.provider,
          model: response.model,
        };
      };
      for (const userContent of contents) {
        const a = await runOnce(userContent);
        const b = await runOnce(userContent);
        const c = await runOnce(userContent);
        expect(a).toEqual(b);
        expect(b).toEqual(c);
      }
    });

    it('P-EC-b | response.callId unique across 100 consecutive calls (ULID + strictly increasing clock)', async () => {
      const body = loadJsonFixture<unknown>('provider-responses/anthropic/ok-simple.json');
      const mockFetch = createMockFetch({ status: 200, body });
      vi.stubGlobal('fetch', mockFetch);
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter({
        model: 'claude-opus-4-6',
        apiKey: 'test-key',
        sanitization: {},
        logging: { logger },
      });
      const seen = new Set<string>();
      for (let i = 0; i < 100; i += 1) {
        const response = await adapter.call({
          messages: [{ role: 'user', content: `msg-${i}` }],
        });
        expect(response.callId).toMatch(ULID_REGEX);
        expect(seen.has(response.callId)).toBe(false);
        seen.add(response.callId);
      }

      expect(seen.size).toBe(100);
    });
  });
});
