// NIB-T §26 — Global contract invariants (cross-cutting).
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §26.1 surface publique, §26.2 factories, §26.3 ProviderLongId
// fermé, §26.4 deps, §26.5 fail-closed, §26.6 factories figent la config, §26.7 moteur unique.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
} from '../src/errors/index.js';
import { createAnthropicAdapter } from '../src/factories/anthropic.js';
import { createGoogleAdapter } from '../src/factories/google.js';
import { createOpenAIAdapter } from '../src/factories/openai.js';
import { createOpenAICompatibleAdapter } from '../src/factories/openai-compatible.js';
import { createOpenAIEmbeddingAdapter } from '../src/factories/openai-embeddings.js';
import type { AdapterConfig, EmbeddingAdapterConfig, LLMRequest } from '../src/types.js';
import { ALL_PROVIDER_LONG_IDS } from '../src/types.js';
import { scenario } from './helpers/fetch-scenario.js';
import { createMockFetch, createScenarioFetch } from './helpers/mock-fetch.js';
import { createMockLogger } from './helpers/mock-logger.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

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
    ...overrides,
  };
}

const REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

// ─── §26.1 Surface publique ────────────────────────────────────────────────

describe('global contract', () => {
  describe('§26.1 public surface', () => {
    it('C-GL-01 | module exports the documented public symbols', async () => {
      const mod = (await import('../src/index.js')) as Record<string, unknown>;
      const expected = [
        // Error classes
        'LLMRuntimeError',
        'AuthError',
        'InvalidRequestError',
        'RateLimitError',
        'OverloadedError',
        'TransientProviderError',
        'ProviderProtocolError',
        'ResponseParseError',
        'TimeoutError',
        'AbortedError',
        'SilentTruncationError',
        'ContentFilterError',
        // Factories
        'createAnthropicAdapter',
        'createOpenAIAdapter',
        'createOpenAICompatibleAdapter',
        'createGoogleAdapter',
        'createOpenAIEmbeddingAdapter',
        // Helpers / utils
        'buildSimplePrompt',
        'isRetriableKind',
        'ALL_LLM_ERROR_KINDS',
      ];
      for (const k of expected) {
        expect(mod[k], `missing export "${k}"`).toBeDefined();
      }
      // Bijective check: no extra unexpected exports.
      const extras = Object.keys(mod).filter((k) => !expected.includes(k));
      expect(extras, 'unexpected extra exports found').toEqual([]);
    });

    it('C-GL-02 | module does NOT export internals', async () => {
      const mod = (await import('../src/index.js')) as Record<string, unknown>;
      const forbidden = [
        'executeCall',
        'executeEmbedding',
        'CanonicalHttpRequest',
        'ParsedProviderResponse',
        'ProviderErrorSignal',
        'RateLimitSnapshot',
        'ProviderBinding',
        'EmbeddingBinding',
        'ProviderQuirks',
        'clock',
        'defaultClock',
        'ulid',
        'createCallId',
      ];
      for (const k of forbidden) {
        expect(mod[k], `unexpected export "${k}"`).toBeUndefined();
      }
    });

    it('C-GL-03 | the 11 subclasses are all instanceof LLMRuntimeError', () => {
      const instances = [
        new AuthError(),
        new InvalidRequestError(),
        new RateLimitError(),
        new OverloadedError(),
        new TransientProviderError(),
        new ProviderProtocolError(),
        new ResponseParseError(),
        new TimeoutError(),
        new AbortedError(),
        new SilentTruncationError(),
        new ContentFilterError(),
      ];
      for (const inst of instances) {
        expect(inst).toBeInstanceOf(LLMRuntimeError);
      }
    });
  });

  // ─── §26.2 Factories ─────────────────────────────────────────────────────

  describe('§26.2 factories produce valid adapters', () => {
    it('C-GL-04 | createAnthropicAdapter → provider === "anthropic"', () => {
      const a = createAnthropicAdapter(baseConfig());
      expect(a.provider).toBe('anthropic');
      expect(typeof a.model).toBe('string');
      expect(typeof a.call).toBe('function');
      expect(a.stats).toBeDefined();
    });

    it('C-GL-05 | createOpenAIAdapter → provider === "openai"', () => {
      const a = createOpenAIAdapter(baseConfig());
      expect(a.provider).toBe('openai');
      expect(typeof a.call).toBe('function');
    });

    it('C-GL-06 | createOpenAICompatibleAdapter (deepseek) → provider === "deepseek"', () => {
      const a = createOpenAICompatibleAdapter({ ...baseConfig(), provider: 'deepseek' });
      expect(a.provider).toBe('deepseek');
    });

    it('C-GL-07 | createOpenAICompatibleAdapter (mistral) → provider === "mistral"', () => {
      const a = createOpenAICompatibleAdapter({ ...baseConfig(), provider: 'mistral' });
      expect(a.provider).toBe('mistral');
    });

    it('C-GL-08 | createOpenAICompatibleAdapter (groq) → provider === "groq"', () => {
      const a = createOpenAICompatibleAdapter({ ...baseConfig(), provider: 'groq' });
      expect(a.provider).toBe('groq');
    });

    it('C-GL-09 | createOpenAICompatibleAdapter (together) → provider === "together"', () => {
      const a = createOpenAICompatibleAdapter({ ...baseConfig(), provider: 'together' });
      expect(a.provider).toBe('together');
    });

    it('C-GL-10 | createOpenAICompatibleAdapter (ollama) → provider === "ollama"', () => {
      const a = createOpenAICompatibleAdapter({ ...baseConfig(), provider: 'ollama' });
      expect(a.provider).toBe('ollama');
    });

    it('C-GL-11 | createGoogleAdapter → provider === "google"', () => {
      const a = createGoogleAdapter(baseConfig());
      expect(a.provider).toBe('google');
    });

    it('C-GL-12 | createOpenAIEmbeddingAdapter → EmbeddingAdapter with embed (function), provider === "openai"', () => {
      const a = createOpenAIEmbeddingAdapter(baseEmbConfig());
      expect(a.provider).toBe('openai');
      expect(typeof a.embed).toBe('function');
      expect(a.stats).toBeDefined();
    });
  });

  // ─── §26.3 ProviderLongId fermé ──────────────────────────────────────────

  describe('§26.3 ProviderLongId closed union', () => {
    it('C-GL-13 | ALL_PROVIDER_LONG_IDS has exactly 8 values', () => {
      expect(ALL_PROVIDER_LONG_IDS.length).toBe(8);
      expect([...ALL_PROVIDER_LONG_IDS].sort()).toEqual(
        [
          'anthropic',
          'openai',
          'google',
          'deepseek',
          'mistral',
          'groq',
          'together',
          'ollama',
        ].sort(),
      );
    });

    it('C-GL-14 | createOpenAICompatibleAdapter with unknown provider is refused (TS + runtime throw)', () => {
      let caught: unknown;
      try {
        createOpenAICompatibleAdapter({
          ...baseConfig(),
          // @ts-expect-error — "unknown-xyz" is not assignable to OpenAICompatibleProvider
          provider: 'unknown-xyz',
        });
      } catch (e) {
        caught = e;
      }
      // Must throw, and either TypeError (TS runtime) or an LLMRuntimeError subclass
      // (validation at factory boundary — cf. NIB-T §26.3 C-GL-14).
      expect(caught).toBeDefined();
      const ok = caught instanceof TypeError || caught instanceof LLMRuntimeError;
      expect(ok).toBe(true);
    });
  });

  // ─── §26.4 Dependencies ──────────────────────────────────────────────────

  describe('§26.4 no official SDK runtime dependencies', () => {
    it('C-GL-15 | package.json dependencies contains exactly {ulid, ai-json-safe-parse}', () => {
      const raw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
      const deps = Object.keys(pkg.dependencies ?? {}).sort();
      expect(deps).toEqual(['ai-json-safe-parse', 'ulid']);
    });

    it('C-GL-16 | no official provider SDK / HTTP client in dependencies', () => {
      const raw = readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
      const deps = pkg.dependencies ?? {};
      const forbidden = [
        '@anthropic-ai/sdk',
        'openai',
        '@google/generative-ai',
        'axios',
        'node-fetch',
        'undici',
      ];
      for (const f of forbidden) {
        expect(deps[f], `forbidden runtime dep "${f}"`).toBeUndefined();
      }
    });
  });

  // ─── §26.5 Fail-closed ───────────────────────────────────────────────────

  describe('§26.5 fail-closed', () => {
    it('C-GL-17 | empty messages → throws InvalidRequestError', async () => {
      const adapter = createAnthropicAdapter(baseConfig());
      await expect(adapter.call({ messages: [] })).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it('C-GL-18 | 2 system messages → throws InvalidRequestError', async () => {
      const adapter = createAnthropicAdapter(baseConfig());
      await expect(
        adapter.call({
          messages: [
            { role: 'system', content: 'one' },
            { role: 'system', content: 'two' },
            { role: 'user', content: 'hi' },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it('C-GL-19 | non-alternating messages (2 user in a row) → accepted per NIB-T decision', async () => {
      // Per spec: the runtime does NOT enforce strict alternation; it forwards
      // to the binding. Here we only assert we don't throw InvalidRequestError
      // preemptively; a downstream provider-error outcome is acceptable.
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      try {
        await adapter.call({
          messages: [
            { role: 'user', content: 'one' },
            { role: 'user', content: 'two' },
          ],
        });
      } catch (e) {
        // Only forbid preemptive InvalidRequestError.
        expect(e).not.toBeInstanceOf(InvalidRequestError);
      }
    });

    it('C-GL-20 | 200 with empty body → throws ResponseParseError', async () => {
      const fetchImpl = createScenarioFetch([
        { status: 200, body: '', headers: { 'content-type': 'application/json' } },
      ]);
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await expect(adapter.call(REQUEST)).rejects.toBeInstanceOf(ResponseParseError);
    });

    it('C-GL-21 | 200 with text/html body (not JSON) → throws ResponseParseError', async () => {
      const fetchImpl = createScenarioFetch([
        {
          status: 200,
          body: '<html>not json</html>',
          headers: { 'content-type': 'text/html' },
        },
      ]);
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      await expect(adapter.call(REQUEST)).rejects.toBeInstanceOf(ResponseParseError);
    });
  });

  // ─── §26.6 Factories freeze config ───────────────────────────────────────

  describe('§26.6 factories freeze config', () => {
    it('C-GL-22 | mutating the config object after creation does not change adapter behavior', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const cfg = baseConfig({
        retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
        providerOptions: { fetch: fetchImpl },
      });
      const adapter = createAnthropicAdapter(cfg);
      const originalModel = adapter.model;
      // Mutate the config object post-creation.
      (cfg as unknown as { model: string }).model = 'different-model';
      expect(adapter.model).toBe(originalModel);
      await adapter.call(REQUEST).catch(() => undefined);
      // Stats/behavior must reflect the snapshotted config (adapter.model unchanged).
      expect(adapter.model).toBe(originalModel);
    });

    it('C-GL-23 | adapter.model is readonly (TS)', () => {
      const adapter = createAnthropicAdapter(baseConfig());
      // @ts-expect-error — model is readonly on ProviderAdapter
      adapter.model = 'mutated';
      // Compile-time assertion is primary; runtime value may or may not mutate
      // depending on whether the factory froze the object. Either is acceptable
      // per spec (the TS-level guarantee is the binding contract).
      expect(typeof adapter.model).toBe('string');
    });

    it('C-GL-24 | adapter.provider is readonly (TS)', () => {
      const adapter = createAnthropicAdapter(baseConfig());
      // @ts-expect-error — provider is readonly on ProviderAdapter
      adapter.provider = 'openai';
      expect(typeof adapter.provider).toBe('string');
    });
  });

  // ─── §26.7 Moteur unique ─────────────────────────────────────────────────

  describe('§26.7 single engine', () => {
    it('C-GL-25 | same scenario (5 × 500) across 4 adapters → same event sequence + same error class', async () => {
      const buildFetch = (): ReturnType<typeof createScenarioFetch> =>
        createScenarioFetch([
          scenario.serverError(),
          scenario.serverError(),
          scenario.serverError(),
          scenario.serverError(),
          scenario.serverError(),
        ]);

      const runs: Array<{ types: string[]; error: unknown }> = [];

      const anthLogger = createMockLogger();
      const anth = createAnthropicAdapter(
        baseConfig({
          retry: { maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger: anthLogger },
          providerOptions: { fetch: buildFetch() },
        }),
      );
      runs.push({
        types: anthLogger.eventTypes(),
        error: await anth.call(REQUEST).catch((e) => e),
      });
      runs[0] = { ...runs[0]!, types: anthLogger.eventTypes() };

      const oaiLogger = createMockLogger();
      const oai = createOpenAIAdapter(
        baseConfig({
          model: 'gpt-test',
          retry: { maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger: oaiLogger },
          providerOptions: { fetch: buildFetch() },
        }),
      );
      runs.push({
        types: oaiLogger.eventTypes(),
        error: await oai.call(REQUEST).catch((e) => e),
      });
      runs[1] = { ...runs[1]!, types: oaiLogger.eventTypes() };

      const gLogger = createMockLogger();
      const g = createGoogleAdapter(
        baseConfig({
          model: 'gemini-test',
          retry: { maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger: gLogger },
          providerOptions: { fetch: buildFetch() },
        }),
      );
      runs.push({
        types: gLogger.eventTypes(),
        error: await g.call(REQUEST).catch((e) => e),
      });
      runs[2] = { ...runs[2]!, types: gLogger.eventTypes() };

      const dsLogger = createMockLogger();
      const ds = createOpenAICompatibleAdapter({
        ...baseConfig({
          model: 'deepseek-test',
          retry: { maxAttempts: 5, backoffBaseMs: 1, maxBackoffMs: 5 },
          logging: { enabled: true, logger: dsLogger },
          providerOptions: { fetch: buildFetch() },
        }),
        provider: 'deepseek',
      });
      runs.push({
        types: dsLogger.eventTypes(),
        error: await ds.call(REQUEST).catch((e) => e),
      });
      runs[3] = { ...runs[3]!, types: dsLogger.eventTypes() };

      // All 4 adapters must produce the same event sequence and throw TransientProviderError.
      const [ref, ...rest] = runs;
      if (ref === undefined) return;
      for (const r of rest) {
        expect(r.types).toEqual(ref.types);
      }
      for (const r of runs) {
        expect(r.error).toBeInstanceOf(TransientProviderError);
      }
    });
  });
});
