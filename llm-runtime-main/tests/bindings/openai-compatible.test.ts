// NIB-T §12 — Acceptance tests for the OpenAI-compatible factory binding.
// RED phase: source stubs throw "Not implemented".

import { describe, expect, it } from 'vitest';

import { createOpenAICompatibleBinding } from '../../src/bindings/openai-compatible.js';
import type { BindingConfig } from '../../src/bindings/types.js';
import { createMockClock } from '../helpers/mock-clock.js';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function cfg(overrides: Partial<BindingConfig> = {}): BindingConfig {
  return {
    model: 'generic',
    apiKey: 'x',
    ...overrides,
  };
}

describe('createOpenAICompatibleBinding', () => {
  // ─── §12.1 — provider identification (reflected in buildRequest URL) ───

  describe('§12.1 provider identification via buildRequest URL', () => {
    it('T-OC-01 | deepseek factory uses deepseek default endpoint', () => {
      const binding = createOpenAICompatibleBinding('deepseek');
      const http = binding.buildRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        cfg({ model: 'deepseek-chat' }),
      );
      expect(http.url).toContain('api.deepseek.com');
    });

    it('T-OC-02 | mistral factory uses mistral default endpoint', () => {
      const binding = createOpenAICompatibleBinding('mistral');
      const http = binding.buildRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        cfg({ model: 'mistral-large' }),
      );
      expect(http.url).toContain('api.mistral.ai');
    });

    it('T-OC-03 | groq factory uses groq default endpoint', () => {
      const binding = createOpenAICompatibleBinding('groq');
      const http = binding.buildRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        cfg({ model: 'llama-3' }),
      );
      expect(http.url).toContain('api.groq.com');
    });

    it('T-OC-04 | together factory uses together default endpoint', () => {
      const binding = createOpenAICompatibleBinding('together');
      const http = binding.buildRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        cfg({ model: 'mixtral' }),
      );
      expect(http.url).toContain('api.together.xyz');
    });

    it('T-OC-05 | ollama factory uses localhost default endpoint', () => {
      const binding = createOpenAICompatibleBinding('ollama');
      const http = binding.buildRequest(
        { messages: [{ role: 'user', content: 'hi' }] },
        cfg({ model: 'llama3' }),
      );
      expect(http.url).toContain('localhost:11434');
    });
  });

  // ─── §12.2 — DeepSeek R1 (thinking tags visible in content) ────────────

  describe('§12.2 DeepSeek R1 thinking tags visible in rawContent', () => {
    it('T-OC-06 | content with <think> tags is preserved verbatim (engine will strip)', () => {
      const binding = createOpenAICompatibleBinding('deepseek');
      const body = {
        id: 'chatcmpl-deepseek-0001',
        model: 'deepseek-r1',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '<think>long reasoning</think>final answer',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const parsed = binding.parseResponse(body, JSON_HEADERS);
      expect(parsed.rawContent).toBe('<think>long reasoning</think>final answer');
    });
  });

  // ─── §12.3 — Together custom rate-limit headers ─────────────────────────

  describe('§12.3 Together x-tokenlimit-* headers', () => {
    it('T-OC-07 | together binding reads x-tokenlimit-remaining + x-tokenlimit-reset', () => {
      const binding = createOpenAICompatibleBinding('together');
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers: Record<string, string> = {
        'x-tokenlimit-remaining': '5000',
        'x-tokenlimit-reset': '30',
      };
      const snapshot = binding.readRateLimitHeaders(headers, clock.nowMono(), clock.nowWall());
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error('unreachable');
      expect(snapshot.remainingTokens).toBe(5000);
      expect(snapshot.state).toBe('known');
    });

    it('T-OC-08 | same headers but groq binding → null (groq uses x-ratelimit-*)', () => {
      const binding = createOpenAICompatibleBinding('groq');
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers: Record<string, string> = {
        'x-tokenlimit-remaining': '5000',
        'x-tokenlimit-reset': '30',
      };
      const snapshot = binding.readRateLimitHeaders(headers, clock.nowMono(), clock.nowWall());
      expect(snapshot).toBeNull();
    });
  });

  // ─── §12.4 — Ollama (no rate-limit) ────────────────────────────────────

  describe('§12.4 Ollama no rate-limit', () => {
    it('T-OC-09 | empty headers with ollama → null', () => {
      const binding = createOpenAICompatibleBinding('ollama');
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const snapshot = binding.readRateLimitHeaders({}, clock.nowMono(), clock.nowWall());
      expect(snapshot).toBeNull();
    });

    it('T-OC-10 | ollama quirks.hasRateLimitHeaders === false', () => {
      const binding = createOpenAICompatibleBinding('ollama');
      expect(binding.quirks.hasRateLimitHeaders).toBe(false);
    });
  });

  // ─── §12.5 — Mistral (no reset header → partial snapshot) ──────────────

  describe('§12.5 Mistral no reset header', () => {
    it('T-OC-11 | mistral with only remaining (no reset) yields partial snapshot with 60s fallback', () => {
      const binding = createOpenAICompatibleBinding('mistral');
      const clock = createMockClock('2026-04-17T12:00:00Z', 1000);
      const headers: Record<string, string> = {
        'x-ratelimit-remaining-tokens': '1000',
      };
      const snapshot = binding.readRateLimitHeaders(headers, clock.nowMono(), clock.nowWall());
      expect(snapshot).not.toBeNull();
      if (snapshot === null) throw new Error('unreachable');
      expect(snapshot.state).toBe('partial');
      expect(snapshot.resetTokensAt).toBe(61000); // nowMono (1000) + 60000
    });
  });

  // ─── §12.6 — Per-provider quirks ───────────────────────────────────────

  describe('§12.6 per-provider quirks', () => {
    it('T-OC-12 | deepseek quirks', () => {
      const b = createOpenAICompatibleBinding('deepseek');
      expect(b.quirks.hasRateLimitHeaders).toBe(true);
      expect(b.quirks.defaultSanitization.stripThinkingTags).toBe(true);
      expect(b.quirks.defaultSanitization.stripJsonFence).toBe(false);
    });

    it('T-OC-13 | mistral quirks', () => {
      const b = createOpenAICompatibleBinding('mistral');
      expect(b.quirks.hasRateLimitHeaders).toBe(true);
      expect(b.quirks.defaultSanitization.stripThinkingTags).toBe(true);
      expect(b.quirks.defaultSanitization.stripJsonFence).toBe(false);
    });

    it('T-OC-14 | groq quirks', () => {
      const b = createOpenAICompatibleBinding('groq');
      expect(b.quirks.hasRateLimitHeaders).toBe(true);
      expect(b.quirks.defaultSanitization.stripThinkingTags).toBe(true);
      expect(b.quirks.defaultSanitization.stripJsonFence).toBe(false);
    });

    it('T-OC-15 | together quirks', () => {
      const b = createOpenAICompatibleBinding('together');
      expect(b.quirks.hasRateLimitHeaders).toBe(true);
      expect(b.quirks.defaultSanitization.stripThinkingTags).toBe(true);
      expect(b.quirks.defaultSanitization.stripJsonFence).toBe(false);
    });

    it('T-OC-16 | ollama quirks', () => {
      const b = createOpenAICompatibleBinding('ollama');
      expect(b.quirks.hasRateLimitHeaders).toBe(false);
      expect(b.quirks.defaultSanitization.stripThinkingTags).toBe(true);
      expect(b.quirks.defaultSanitization.stripJsonFence).toBe(false);
    });

    it('T-OC-10/16 distinctness | ollama is the only provider with hasRateLimitHeaders=false', () => {
      const providers = ['deepseek', 'mistral', 'groq', 'together', 'ollama'] as const;
      const bindings = providers.map((p) => ({
        provider: p,
        binding: createOpenAICompatibleBinding(p),
      }));
      const withRateLimit = bindings.filter((b) => b.binding.quirks.hasRateLimitHeaders);
      const withoutRateLimit = bindings.filter((b) => !b.binding.quirks.hasRateLimitHeaders);
      // deepseek, mistral, groq, together have rate-limit headers; ollama does not.
      expect(withRateLimit.map((b) => b.provider)).toEqual([
        'deepseek',
        'mistral',
        'groq',
        'together',
      ]);
      expect(withoutRateLimit.map((b) => b.provider)).toEqual(['ollama']);
    });
  });
});
