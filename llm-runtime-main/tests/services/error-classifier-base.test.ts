// NIB-T §9 — RED-phase tests for classifyErrorBase.
// Reference: specs/NIB-T-LLMRUNTIME.md §9 (T-CL-01..T-CL-25 + P-CL-a, P-CL-b, P-CL-c).

import { describe, expect, it } from 'vitest';
import {
  AbortedError,
  AuthError,
  InvalidRequestError,
  LLMRuntimeError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  TimeoutError,
  TransientProviderError,
} from '../../src/errors/index.js';
import {
  classifyErrorBase,
  type NetworkErrorKind,
  type ProviderErrorSignal,
} from '../../src/services/error-classifier-base.js';
import { seededRandom } from '../helpers/seeded-random.js';

describe('error-classifier-base', () => {
  // ───────────────────────── §9.1 priority (1) aborted ─────────────────────────
  describe('§9.1 priority (1) aborted', () => {
    it('T-CL-01 | aborted=true only → AbortedError', () => {
      const err = classifyErrorBase({ aborted: true, timeout: false, headers: {} });
      expect(err).toBeInstanceOf(AbortedError);
    });

    it('T-CL-02 | aborted+timeout → AbortedError (aborted primes)', () => {
      const err = classifyErrorBase({ aborted: true, timeout: true, headers: {} });
      expect(err).toBeInstanceOf(AbortedError);
    });

    it('T-CL-03 | aborted+status=500 → AbortedError (aborted primes over HTTP)', () => {
      const err = classifyErrorBase({ aborted: true, timeout: false, status: 500, headers: {} });
      expect(err).toBeInstanceOf(AbortedError);
    });
  });

  // ───────────────────────── §9.2 priority (2) timeout ─────────────────────────
  describe('§9.2 priority (2) timeout', () => {
    it('T-CL-04 | timeout=true only → TimeoutError', () => {
      const err = classifyErrorBase({ aborted: false, timeout: true, headers: {} });
      expect(err).toBeInstanceOf(TimeoutError);
    });

    it('T-CL-05 | timeout+status=500 → TimeoutError (timeout primes over HTTP)', () => {
      const err = classifyErrorBase({ aborted: false, timeout: true, status: 500, headers: {} });
      expect(err).toBeInstanceOf(TimeoutError);
    });
  });

  // ───────────────────────── §9.3 priority (3) network error ─────────────────────────
  describe('§9.3 priority (3) network error', () => {
    const netKinds: readonly NetworkErrorKind[] = ['dns', 'connection', 'reset', 'unknown'];
    const ids: Record<NetworkErrorKind, string> = {
      dns: 'T-CL-06',
      connection: 'T-CL-07',
      reset: 'T-CL-08',
      unknown: 'T-CL-09',
    };

    for (const kind of netKinds) {
      it(`${ids[kind]} | networkErrorKind="${kind}" → TransientProviderError`, () => {
        const err = classifyErrorBase({
          aborted: false,
          timeout: false,
          networkErrorKind: kind,
          headers: {},
        });
        expect(err).toBeInstanceOf(TransientProviderError);
      });
    }
  });

  // ───────────────────────── §9.4 priority (4) HTTP status mapping ─────────────────────────
  describe('§9.4 priority (4) HTTP status mapping', () => {
    const mapping: ReadonlyArray<[string, number, new (...args: never[]) => LLMRuntimeError]> = [
      ['T-CL-10', 400, InvalidRequestError],
      ['T-CL-11', 401, AuthError],
      ['T-CL-12', 403, AuthError],
      ['T-CL-13', 404, InvalidRequestError],
      ['T-CL-14', 429, RateLimitError],
      ['T-CL-15', 500, TransientProviderError],
      ['T-CL-16', 502, TransientProviderError],
      ['T-CL-17', 503, TransientProviderError],
      ['T-CL-18', 529, OverloadedError],
      ['T-CL-19', 418, TransientProviderError],
      ['T-CL-20', 504, TransientProviderError],
    ];

    for (const [id, status, ClassCtor] of mapping) {
      it(`${id} | status=${status} → ${ClassCtor.name}`, () => {
        const err = classifyErrorBase({ aborted: false, timeout: false, status, headers: {} });
        expect(err).toBeInstanceOf(ClassCtor);
      });
    }
  });

  // ───────────────────────── §9.5 priority (5) defensive fallback ─────────────────────────
  describe('§9.5 priority (5) fallback', () => {
    it('T-CL-21 | no discriminant field → ProviderProtocolError', () => {
      const err = classifyErrorBase({ aborted: false, timeout: false, headers: {} });
      expect(err).toBeInstanceOf(ProviderProtocolError);
    });
  });

  // ───────────────────────── §9.6 enrichment via headers / timeoutMs ─────────────────────────
  describe('§9.6 enrichment', () => {
    it('T-CL-22 | status=429 + retry-after=10 → RateLimitError.retryAfterMs=10000', () => {
      const err = classifyErrorBase({
        aborted: false,
        timeout: false,
        status: 429,
        headers: { 'retry-after': '10' },
        bodyText: 'rate limited',
      });
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toEqual(10000);
    });

    it('T-CL-23 | status=429 + no retry-after → RateLimitError.retryAfterMs=undefined', () => {
      const err = classifyErrorBase({
        aborted: false,
        timeout: false,
        status: 429,
        headers: {},
        bodyText: 'rate limited',
      });
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeUndefined();
    });

    it('T-CL-24 | status=400 + bodyText → InvalidRequestError.message traceable', () => {
      const err = classifyErrorBase({
        aborted: false,
        timeout: false,
        status: 400,
        bodyText: 'malformed payload',
        headers: {},
      });
      expect(err).toBeInstanceOf(InvalidRequestError);
      // Message must be non-empty (trace of bodyText is expected, exact format
      // calibrated in GREEN).
      expect(typeof err.message).toEqual('string');
      expect(err.message.length).toBeGreaterThan(0);
    });

    it('T-CL-25 | timeout=true + timeoutMs=120000 → TimeoutError.timeoutMs=120000', () => {
      // NOTE: NIB-T §9.6 T-CL-25 — if the classifier does not receive timeoutMs
      // context, this test is deferred to engine-level (§18). For now we assert
      // that when the context IS provided, it is surfaced on the error.
      const err = classifyErrorBase({
        aborted: false,
        timeout: true,
        timeoutMs: 120000,
        headers: {},
      });
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).timeoutMs).toEqual(120000);
    });
  });

  // ───────────────────────── §9.7 properties ─────────────────────────
  describe('§9.7 properties', () => {
    function makeRandomSignal(rng: ReturnType<typeof seededRandom>): ProviderErrorSignal {
      const aborted = rng.randomInt(0, 9) === 0;
      const timeout = rng.randomInt(0, 9) === 0;
      const hasStatus = rng.randomBool();
      const hasNet = rng.randomBool();
      const statuses = [400, 401, 403, 404, 418, 429, 500, 502, 503, 504, 529] as const;
      const netKinds: readonly NetworkErrorKind[] = ['dns', 'connection', 'reset', 'unknown'];

      const headers: Record<string, string> = rng.randomBool()
        ? { 'retry-after': String(rng.randomInt(0, 60)) }
        : {};

      const signal: {
        aborted: boolean;
        timeout: boolean;
        headers: Record<string, string>;
        status?: number;
        networkErrorKind?: NetworkErrorKind;
      } = {
        aborted,
        timeout,
        headers,
      };
      if (hasStatus) {
        signal.status = statuses[rng.randomInt(0, statuses.length - 1)] ?? 500;
      }
      if (hasNet && !hasStatus) {
        signal.networkErrorKind = netKinds[rng.randomInt(0, netKinds.length - 1)] ?? 'unknown';
      }
      return signal as ProviderErrorSignal;
    }

    it('P-CL-a | pure function on 50 random signals', () => {
      const rng = seededRandom(0x9876);
      for (let i = 0; i < 50; i += 1) {
        const sig = makeRandomSignal(rng);
        const a = classifyErrorBase(sig);
        const b = classifyErrorBase(sig);
        expect(a.constructor).toEqual(b.constructor);
        expect(a.kind).toEqual(b.kind);
      }
    });

    it('P-CL-b | result is always LLMRuntimeError instance', () => {
      const rng = seededRandom(0x5432);
      for (let i = 0; i < 50; i += 1) {
        const sig = makeRandomSignal(rng);
        const result = classifyErrorBase(sig);
        expect(result).toBeInstanceOf(LLMRuntimeError);
      }
    });

    it('P-CL-c | never throws — always returns an error', () => {
      const rng = seededRandom(0x1357);
      for (let i = 0; i < 50; i += 1) {
        const sig = makeRandomSignal(rng);
        expect(() => classifyErrorBase(sig)).not.toThrow();
      }
    });
  });
});
