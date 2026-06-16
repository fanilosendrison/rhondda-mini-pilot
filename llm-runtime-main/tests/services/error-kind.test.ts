// NIB-T §6 — RED-phase tests for isRetriableKind + contract invariants C-EK-01, C-EK-02.
// Reference: specs/NIB-T-LLMRUNTIME.md §6 (T-EK-01..T-EK-11 + C-EK-01, C-EK-02).

import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  type LLMRuntimeError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from '../../src/errors/index.js';
import {
  ALL_LLM_ERROR_KINDS,
  isRetriableKind,
  type LLMErrorKind,
} from '../../src/services/error-kind.js';

describe('error-kind', () => {
  // ───────────────────────── §6.1 retriable kinds ─────────────────────────
  describe('§6.1 retriable kinds', () => {
    it('T-EK-01 | rate_limit → true', () => {
      expect(isRetriableKind('rate_limit')).toEqual(true);
    });

    it('T-EK-02 | overloaded → true', () => {
      expect(isRetriableKind('overloaded')).toEqual(true);
    });

    it('T-EK-03 | transient_provider → true', () => {
      expect(isRetriableKind('transient_provider')).toEqual(true);
    });

    it('T-EK-04 | timeout → true', () => {
      expect(isRetriableKind('timeout')).toEqual(true);
    });
  });

  // ───────────────────────── §6.2 non-retriable kinds ─────────────────────────
  describe('§6.2 non-retriable kinds', () => {
    it('T-EK-05 | auth → false', () => {
      expect(isRetriableKind('auth')).toEqual(false);
    });

    it('T-EK-06 | invalid_request → false', () => {
      expect(isRetriableKind('invalid_request')).toEqual(false);
    });

    it('T-EK-07 | provider_protocol → false', () => {
      expect(isRetriableKind('provider_protocol')).toEqual(false);
    });

    it('T-EK-08 | response_parse → false', () => {
      expect(isRetriableKind('response_parse')).toEqual(false);
    });

    it('T-EK-09 | aborted → false', () => {
      expect(isRetriableKind('aborted')).toEqual(false);
    });

    it('T-EK-10 | silent_truncation → false', () => {
      expect(isRetriableKind('silent_truncation')).toEqual(false);
    });

    it('T-EK-11 | content_filter → false', () => {
      expect(isRetriableKind('content_filter')).toEqual(false);
    });
  });

  // ───────────────────────── §6.3 contract invariants ─────────────────────────
  describe('§6.3 contract invariants', () => {
    it('C-EK-01 | LLMErrorKind union has exactly 11 values', () => {
      expect(ALL_LLM_ERROR_KINDS.length).toEqual(11);
      // Sanity: unique entries.
      expect(new Set(ALL_LLM_ERROR_KINDS).size).toEqual(11);
    });

    it('C-EK-02 | each LLMRuntimeError subclass has a kind ∈ LLMErrorKind', () => {
      const subclasses: readonly LLMRuntimeError[] = [
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

      const known: ReadonlySet<LLMErrorKind> = new Set<LLMErrorKind>(ALL_LLM_ERROR_KINDS);

      for (const err of subclasses) {
        expect(typeof err.kind).toEqual('string');
        expect(known.has(err.kind)).toEqual(true);
      }
    });
  });
});
