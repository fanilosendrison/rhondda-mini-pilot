// NIB-T §2 — RED-phase acceptance + property tests for resolveRetryDecision.
// Reference: specs/NIB-T-LLMRUNTIME.md §2 (T-RR-01..T-RR-36 + P-RR-a, P-RR-b).

import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from '../../src/errors/index.js';
import { type RetryDecision, resolveRetryDecision } from '../../src/services/retry-resolver.js';
import type { RetryPolicy } from '../../src/types.js';
import { seededRandom } from '../helpers/seeded-random.js';

const DEFAULT_POLICY: RetryPolicy = {
  maxAttempts: 5,
  backoffBaseMs: 2000,
  maxBackoffMs: 60000,
};

describe('retry-resolver', () => {
  // ───────────────────────── §2.1 Fatal errors — never retried ─────────────────────────
  describe('§2.1 fatal errors (never retried)', () => {
    const fatalCases: ReadonlyArray<{
      id: string;
      description: string;
      make: () => Error;
      reason: string;
    }> = [
      {
        id: 'T-RR-01',
        description: 'AuthError never retried',
        make: () => new AuthError(),
        reason: 'fatal_auth',
      },
      {
        id: 'T-RR-02',
        description: 'InvalidRequestError never retried',
        make: () => new InvalidRequestError(),
        reason: 'fatal_invalid_request',
      },
      {
        id: 'T-RR-03',
        description: 'ResponseParseError never retried',
        make: () => new ResponseParseError(),
        reason: 'fatal_parse_error',
      },
      {
        id: 'T-RR-04',
        description: 'ContentFilterError never retried',
        make: () => new ContentFilterError(),
        reason: 'fatal_content_filter',
      },
      {
        id: 'T-RR-05',
        description: 'AbortedError never retried',
        make: () => new AbortedError(),
        reason: 'fatal_aborted',
      },
      {
        id: 'T-RR-06',
        description: 'ProviderProtocolError never retried',
        make: () => new ProviderProtocolError(),
        reason: 'fatal_protocol',
      },
      {
        id: 'T-RR-07',
        description: 'SilentTruncationError never retried',
        make: () => new SilentTruncationError(),
        reason: 'fatal_truncation',
      },
    ];

    for (const { id, description, make, reason } of fatalCases) {
      for (const attempt of [0, 2, 4]) {
        it(`${id} | ${description} (attempt=${attempt})`, () => {
          const decision = resolveRetryDecision(make(), attempt, {}, DEFAULT_POLICY);
          expect(decision).toEqual({ retry: false, reason });
        });
      }
    }
  });

  // ───────────────────────── §2.2 Retriable with budget ─────────────────────────
  describe('§2.2 retriable errors with budget available', () => {
    it('T-RR-08 | RateLimitError attempt=0 → backoff 2000ms', () => {
      const decision = resolveRetryDecision(new RateLimitError(), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_rate_limit' });
    });

    it('T-RR-09 | RateLimitError attempt=1 → backoff 4000ms', () => {
      const decision = resolveRetryDecision(new RateLimitError(), 1, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 4000, reason: 'transient_rate_limit' });
    });

    it('T-RR-10 | RateLimitError attempt=3 → backoff 16000ms', () => {
      const decision = resolveRetryDecision(new RateLimitError(), 3, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 16000, reason: 'transient_rate_limit' });
    });

    it('T-RR-11 | RateLimitError retry-after=10 → 10000ms', () => {
      const decision = resolveRetryDecision(
        new RateLimitError(),
        0,
        { 'retry-after': '10' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 10000, reason: 'transient_rate_limit' });
    });

    it('T-RR-12 | RateLimitError retry-after=3 primes over backoff', () => {
      const decision = resolveRetryDecision(
        new RateLimitError(),
        2,
        { 'retry-after': '3' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 3000, reason: 'transient_rate_limit' });
    });

    it('T-RR-13 | OverloadedError attempt=0 → 2000ms', () => {
      const decision = resolveRetryDecision(new OverloadedError(), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_overloaded' });
    });

    it('T-RR-14 | OverloadedError retry-after=7 → 7000ms', () => {
      const decision = resolveRetryDecision(
        new OverloadedError(),
        1,
        { 'retry-after': '7' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 7000, reason: 'transient_overloaded' });
    });

    it('T-RR-15 | TransientProviderError attempt=0 → 2000ms', () => {
      const decision = resolveRetryDecision(new TransientProviderError(), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_provider' });
    });

    it('T-RR-16 | TransientProviderError attempt=3 → 16000ms', () => {
      const decision = resolveRetryDecision(new TransientProviderError(), 3, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 16000, reason: 'transient_provider' });
    });

    it('T-RR-17 | TimeoutError attempt=0 → 2000ms', () => {
      const decision = resolveRetryDecision(new TimeoutError(), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_timeout' });
    });

    it('T-RR-18 | TimeoutError ignores retry-after (always backoff)', () => {
      const decision = resolveRetryDecision(
        new TimeoutError(),
        2,
        { 'retry-after': '999' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 8000, reason: 'transient_timeout' });
    });
  });

  // ───────────────────────── §2.3 Budget exhausted ─────────────────────────
  describe('§2.3 budget exhausted', () => {
    it('T-RR-19 | RateLimitError attempt=4 maxAttempts=5 → exhausted', () => {
      const decision = resolveRetryDecision(new RateLimitError(), 4, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-20 | OverloadedError attempt=4 maxAttempts=5 → exhausted', () => {
      const decision = resolveRetryDecision(new OverloadedError(), 4, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-21 | TransientProviderError attempt=4 maxAttempts=5 → exhausted', () => {
      const decision = resolveRetryDecision(new TransientProviderError(), 4, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-22 | TimeoutError attempt=4 maxAttempts=5 → exhausted', () => {
      const decision = resolveRetryDecision(new TimeoutError(), 4, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-23 | RateLimitError attempt=0 maxAttempts=1 → exhausted (budget 1 = no retry)', () => {
      const policy: RetryPolicy = { maxAttempts: 1, backoffBaseMs: 2000, maxBackoffMs: 60000 };
      const decision = resolveRetryDecision(new RateLimitError(), 0, {}, policy);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-24 | TransientProviderError attempt=5 (beyond) → exhausted', () => {
      const decision = resolveRetryDecision(new TransientProviderError(), 5, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });
  });

  // ───────────────────────── §2.4 Unclassified errors ─────────────────────────
  describe('§2.4 transient_unknown (unclassified)', () => {
    it('T-RR-25 | unknown Error attempt=0 → 2000ms transient_unknown', () => {
      const decision = resolveRetryDecision(new Error('weird'), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_unknown' });
    });

    it('T-RR-26 | unknown Error attempt=2 → 8000ms transient_unknown', () => {
      const decision = resolveRetryDecision(new Error('weird'), 2, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 8000, reason: 'transient_unknown' });
    });

    it('T-RR-27 | unknown Error attempt=4 → exhausted (budget primes)', () => {
      const decision = resolveRetryDecision(new Error('weird'), 4, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: false, reason: 'retry_exhausted' });
    });

    it('T-RR-28 | TypeError "fetch failed" attempt=0 → transient_unknown', () => {
      const decision = resolveRetryDecision(new TypeError('fetch failed'), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_unknown' });
    });
  });

  // ───────────────────────── §2.5 Backoff cap ─────────────────────────
  describe('§2.5 backoff cap', () => {
    it('T-RR-29 | TransientProviderError attempt=5 → capped at 60000', () => {
      const policy: RetryPolicy = { maxAttempts: 10, backoffBaseMs: 2000, maxBackoffMs: 60000 };
      const decision = resolveRetryDecision(new TransientProviderError(), 5, {}, policy);
      expect(decision).toEqual({ retry: true, delayMs: 60000, reason: 'transient_provider' });
    });

    it('T-RR-30 | TransientProviderError attempt=6 → still capped at 60000', () => {
      const policy: RetryPolicy = { maxAttempts: 10, backoffBaseMs: 2000, maxBackoffMs: 60000 };
      const decision = resolveRetryDecision(new TransientProviderError(), 6, {}, policy);
      expect(decision).toEqual({ retry: true, delayMs: 60000, reason: 'transient_provider' });
    });

    it('T-RR-31 | TransientProviderError attempt=0 base=500 cap=3000 → 500', () => {
      const policy: RetryPolicy = { maxAttempts: 3, backoffBaseMs: 500, maxBackoffMs: 3000 };
      const decision = resolveRetryDecision(new TransientProviderError(), 0, {}, policy);
      expect(decision).toEqual({ retry: true, delayMs: 500, reason: 'transient_provider' });
    });

    it('T-RR-32 | TransientProviderError attempt=2 base=500 cap=3000 → 2000', () => {
      const policy: RetryPolicy = { maxAttempts: 5, backoffBaseMs: 500, maxBackoffMs: 3000 };
      const decision = resolveRetryDecision(new TransientProviderError(), 2, {}, policy);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_provider' });
    });
  });

  // ───────────────────────── §2.6 Retry-After invalid or absent ─────────────────────────
  describe('§2.6 invalid or absent Retry-After', () => {
    it('T-RR-33 | RateLimitError retry-after="not-a-number" → fallback backoff', () => {
      const decision = resolveRetryDecision(
        new RateLimitError(),
        0,
        { 'retry-after': 'not-a-number' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_rate_limit' });
    });

    it('T-RR-34 | RateLimitError retry-after="-5" → fallback backoff', () => {
      const decision = resolveRetryDecision(
        new RateLimitError(),
        0,
        { 'retry-after': '-5' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_rate_limit' });
    });

    it('T-RR-35 | RateLimitError retry-after="" → fallback backoff', () => {
      const decision = resolveRetryDecision(
        new RateLimitError(),
        0,
        { 'retry-after': '' },
        DEFAULT_POLICY,
      );
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_rate_limit' });
    });

    it('T-RR-36 | RateLimitError no retry-after → fallback backoff', () => {
      const decision = resolveRetryDecision(new RateLimitError(), 0, {}, DEFAULT_POLICY);
      expect(decision).toEqual({ retry: true, delayMs: 2000, reason: 'transient_rate_limit' });
    });
  });

  // ───────────────────────── §2.7 Properties ─────────────────────────
  describe('§2.7 properties', () => {
    it('P-RR-a | pure function: same inputs ⇒ same result (50 iterations)', () => {
      const rng = seededRandom(0xdeadbeef);
      const errorFactories: ReadonlyArray<() => Error> = [
        () => new RateLimitError(),
        () => new OverloadedError(),
        () => new TransientProviderError(),
        () => new TimeoutError(),
        () => new AuthError(),
        () => new Error('unknown'),
      ];

      for (let i = 0; i < 50; i += 1) {
        const makeErr = errorFactories[rng.randomInt(0, errorFactories.length - 1)];
        if (!makeErr) continue;
        const attempt = rng.randomInt(0, 5);
        const policy: RetryPolicy = {
          maxAttempts: rng.randomInt(1, 10),
          backoffBaseMs: rng.randomInt(100, 5000),
          maxBackoffMs: rng.randomInt(5000, 120000),
        };
        const headers: Record<string, string> = rng.randomBool()
          ? { 'retry-after': String(rng.randomInt(0, 30)) }
          : {};

        const err = makeErr();
        const a: RetryDecision = resolveRetryDecision(err, attempt, headers, policy);
        const b: RetryDecision = resolveRetryDecision(err, attempt, headers, policy);
        expect(a).toEqual(b);
      }
    });

    it('P-RR-b | fatal decisions are independent of policy and headers', () => {
      const fatalFactories: ReadonlyArray<[() => Error, string]> = [
        [() => new AuthError(), 'fatal_auth'],
        [() => new InvalidRequestError(), 'fatal_invalid_request'],
        [() => new ResponseParseError(), 'fatal_parse_error'],
        [() => new ContentFilterError(), 'fatal_content_filter'],
        [() => new AbortedError(), 'fatal_aborted'],
        [() => new ProviderProtocolError(), 'fatal_protocol'],
        [() => new SilentTruncationError(), 'fatal_truncation'],
      ];

      const policies: readonly RetryPolicy[] = [
        { maxAttempts: 1, backoffBaseMs: 100, maxBackoffMs: 1000 },
        { maxAttempts: 3, backoffBaseMs: 500, maxBackoffMs: 5000 },
        { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60000 },
        { maxAttempts: 10, backoffBaseMs: 1000, maxBackoffMs: 30000 },
        { maxAttempts: 20, backoffBaseMs: 250, maxBackoffMs: 10000 },
      ];

      const headerSets: ReadonlyArray<Record<string, string>> = [
        {},
        { 'retry-after': '10' },
        { 'retry-after': '99999' },
        { 'retry-after': 'garbage' },
        { 'retry-after': '-1', 'x-custom': 'v' },
      ];

      for (const [make, reason] of fatalFactories) {
        for (const policy of policies) {
          for (const headers of headerSets) {
            for (const attempt of [0, 1, 3]) {
              const decision = resolveRetryDecision(make(), attempt, headers, policy);
              expect(decision).toEqual({ retry: false, reason });
            }
          }
        }
      }
    });
  });
});
