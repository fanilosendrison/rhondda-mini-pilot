// NIB-T §14 — Acceptance tests for the OpenAI Embeddings binding.
// RED phase: source stubs throw "Not implemented".

import { describe, expect, it } from 'vitest';

import { openaiEmbeddingsBinding } from '../../src/bindings/openai-embeddings.js';
import type { BindingConfig, EmbeddingBinding } from '../../src/bindings/types.js';
import {
  InvalidRequestError,
  RateLimitError,
  ResponseParseError,
  TransientProviderError,
} from '../../src/errors/index.js';
import type { ProviderErrorSignal } from '../../src/services/error-classifier-base.js';
import { loadJsonFixture } from '../helpers/fixture-loader.js';

const JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };

function baseConfig(overrides: Partial<BindingConfig> = {}): BindingConfig {
  return {
    model: 'text-embedding-3-small',
    apiKey: 'sk-x',
    ...overrides,
  };
}

function makeSignal(overrides: Partial<ProviderErrorSignal> = {}): ProviderErrorSignal {
  return {
    aborted: false,
    timeout: false,
    headers: {},
    ...overrides,
  };
}

describe('openaiEmbeddingsBinding', () => {
  // ─── §14.1 — buildRequest ──────────────────────────────────────────────

  describe('§14.1 buildRequest', () => {
    it('T-OE-01 | builds POST to /v1/embeddings with model+input+encoding_format', () => {
      const http = openaiEmbeddingsBinding.buildRequest(['a', 'b', 'c'], baseConfig());
      expect(http.url).toBe('https://api.openai.com/v1/embeddings');
      expect(http.headers['authorization']).toBe('Bearer sk-x');
      expect(http.bodyJson).toEqual({
        model: 'text-embedding-3-small',
        input: ['a', 'b', 'c'],
        encoding_format: 'float',
      });
    });

    it('T-OE-02 | empty texts array does not throw (adapter normally skips, but binding is tolerant)', () => {
      expect(() => openaiEmbeddingsBinding.buildRequest([], baseConfig())).not.toThrow();
    });

    it('T-OE-03 | endpoint override replaces URL', () => {
      const http = openaiEmbeddingsBinding.buildRequest(
        ['hello'],
        baseConfig({ endpoint: 'https://custom.proxy/v1/embeddings' }),
      );
      expect(http.url).toBe('https://custom.proxy/v1/embeddings');
    });
  });

  // ─── §14.2 — parseEmbeddings ───────────────────────────────────────────

  describe('§14.2 parseEmbeddings', () => {
    it('T-OE-04 | ok-3-texts returns number[][] of length 3 with preserved order', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai-embeddings/ok-3-texts.json');
      const out = openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS);
      expect(out.length).toBe(3);
      expect(out[0]).toEqual([0.1, 0.2, 0.3]);
      expect(out[1]).toEqual([0.4, 0.5, 0.6]);
      expect(out[2]).toEqual([0.7, 0.8, 0.9]);
    });

    it('T-OE-05 | unsorted data (index 2, 0, 1) is reordered by index', () => {
      const body = {
        object: 'list',
        data: [
          { object: 'embedding', index: 2, embedding: [0.7, 0.8] },
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
          { object: 'embedding', index: 1, embedding: [0.3, 0.4] },
        ],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 6, total_tokens: 6 },
      };
      const out = openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS);
      expect(out[0]).toEqual([0.1, 0.2]);
      expect(out[1]).toEqual([0.3, 0.4]);
      expect(out[2]).toEqual([0.7, 0.8]);
    });

    it('T-OE-06 | ok-empty (data:[]) throws ResponseParseError per spec 3.3 step 2', () => {
      const body = loadJsonFixture<unknown>('provider-responses/openai-embeddings/ok-empty.json');
      expect(() => openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS)).toThrow(
        ResponseParseError,
      );
    });

    it('T-OE-07 | body without data throws ResponseParseError', () => {
      const body = { object: 'list', model: 'text-embedding-3-small' };
      expect(() => openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS)).toThrow(
        ResponseParseError,
      );
    });

    it('T-OE-08 | element missing embedding throws ResponseParseError', () => {
      const body = {
        object: 'list',
        data: [{ object: 'embedding', index: 0 }],
        model: 'text-embedding-3-small',
      };
      expect(() => openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS)).toThrow(
        ResponseParseError,
      );
    });

    it('T-OE-09 | inconsistent dimensions are NOT validated (returned as-is)', () => {
      const body = {
        object: 'list',
        data: [
          { object: 'embedding', index: 0, embedding: [0.1, 0.2] },
          { object: 'embedding', index: 1, embedding: [0.3] },
        ],
        model: 'text-embedding-3-small',
      };
      const out = openaiEmbeddingsBinding.parseEmbeddings(body, JSON_HEADERS);
      expect(out[0]).toEqual([0.1, 0.2]);
      expect(out[1]).toEqual([0.3]);
    });
  });

  // ─── §14.3 — classifyError ─────────────────────────────────────────────

  describe('§14.3 classifyError', () => {
    it('T-OE-10 | status 400 → InvalidRequestError', () => {
      const err = openaiEmbeddingsBinding.classifyError(makeSignal({ status: 400 }));
      expect(err).toBeInstanceOf(InvalidRequestError);
    });

    it('T-OE-11 | status 429 → RateLimitError', () => {
      const err = openaiEmbeddingsBinding.classifyError(makeSignal({ status: 429 }));
      expect(err).toBeInstanceOf(RateLimitError);
    });

    it('T-OE-12 | status 500 → TransientProviderError', () => {
      const err = openaiEmbeddingsBinding.classifyError(makeSignal({ status: 500 }));
      expect(err).toBeInstanceOf(TransientProviderError);
    });
  });

  // ─── §14.4 — readRateLimitHeaders and quirks ───────────────────────────

  describe('§14.4 quirks and terminationMap absence', () => {
    it('T-OE-13 | quirks shape is Pick<ProviderQuirks, "hasRateLimitHeaders"> — no extra fields', () => {
      // Compile-time: EmbeddingBinding.quirks is EmbeddingQuirks (only hasRateLimitHeaders).
      // Runtime: assert the shape has no defaultSanitization or mayRouteModel.
      const quirks = openaiEmbeddingsBinding.quirks as unknown as Record<string, unknown>;
      expect(quirks['hasRateLimitHeaders']).toBeDefined();
      expect(quirks['defaultSanitization']).toBeUndefined();
      expect(quirks['mayRouteModel']).toBeUndefined();
    });

    it('T-OE-14 | quirks.hasRateLimitHeaders === true', () => {
      expect(openaiEmbeddingsBinding.quirks.hasRateLimitHeaders).toBe(true);
    });

    it('T-OE-15 | binding does not expose terminationMap (EmbeddingBinding has no such field)', () => {
      // Compile-time assertion: the public interface must lack terminationMap.
      // Runtime sanity check: casting to any surfaces nothing.
      const asUnknown = openaiEmbeddingsBinding as unknown as Record<string, unknown>;
      expect(asUnknown['terminationMap']).toBeUndefined();

      // Structural TS check: the following assignment compiles because
      // EmbeddingBinding has no `terminationMap` key.
      const _binding: EmbeddingBinding = openaiEmbeddingsBinding;
      void _binding;
    });
  });
});
