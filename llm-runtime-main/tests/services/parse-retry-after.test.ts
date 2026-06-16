// NIB-T §3 — RED-phase tests for parseRetryAfter.
// Reference: specs/NIB-T-LLMRUNTIME.md §3 (T-PA-01..T-PA-22 + P-PA-a, P-PA-b, P-PA-c).
//
// NOTE: HTTP-date tests (T-PA-07..T-PA-12) rely on vi.setSystemTime to fix
// the "now" reference used internally by parseRetryAfter. The stub signature
// currently takes only `headers`, so implementation is expected to consult
// a clock abstraction or `Date.now()` at call-time. If GREEN changes the
// signature to accept a clock parameter explicitly, these tests will need
// to be refined (NIB-T §3 remains the source of truth).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRetryAfter } from '../../src/services/retry-resolver.js';
import { seededRandom } from '../helpers/seeded-random.js';

describe('parse-retry-after', () => {
  // ───────────────────────── §3.1 seconds format ─────────────────────────
  describe('§3.1 seconds format', () => {
    it('T-PA-01 | "0" → 0ms', () => {
      expect(parseRetryAfter({ 'retry-after': '0' })).toEqual(0);
    });

    it('T-PA-02 | "1" → 1000ms', () => {
      expect(parseRetryAfter({ 'retry-after': '1' })).toEqual(1000);
    });

    it('T-PA-03 | "10" → 10000ms', () => {
      expect(parseRetryAfter({ 'retry-after': '10' })).toEqual(10000);
    });

    it('T-PA-04 | "60" → 60000ms', () => {
      expect(parseRetryAfter({ 'retry-after': '60' })).toEqual(60000);
    });

    it('T-PA-05 | "3600" → 3600000ms (1h)', () => {
      expect(parseRetryAfter({ 'retry-after': '3600' })).toEqual(3600000);
    });

    it('T-PA-06 | "120.5" → undefined (non-integer rejected per RFC 7231)', () => {
      expect(parseRetryAfter({ 'retry-after': '120.5' })).toBeUndefined();
    });
  });

  // ───────────────────────── §3.2 HTTP-date format ─────────────────────────
  describe('§3.2 HTTP-date format (RFC 7231)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('T-PA-07 | date 30s in future → 30000ms', () => {
      expect(parseRetryAfter({ 'retry-after': 'Fri, 17 Apr 2026 12:00:30 GMT' })).toEqual(30000);
    });

    it('T-PA-08 | date 1min in future → 60000ms', () => {
      expect(parseRetryAfter({ 'retry-after': 'Fri, 17 Apr 2026 12:01:00 GMT' })).toEqual(60000);
    });

    it('T-PA-09 | date 30s in past → 0', () => {
      expect(parseRetryAfter({ 'retry-after': 'Fri, 17 Apr 2026 11:59:30 GMT' })).toEqual(0);
    });

    it('T-PA-10 | date equal to now → 0 (deltaMs ≤ 0)', () => {
      expect(parseRetryAfter({ 'retry-after': 'Fri, 17 Apr 2026 12:00:00 GMT' })).toEqual(0);
    });

    it('T-PA-11 | date 24h in future → 86400000ms', () => {
      expect(parseRetryAfter({ 'retry-after': 'Sat, 18 Apr 2026 12:00:00 GMT' })).toEqual(86400000);
    });

    it('T-PA-12 | far past date → 0', () => {
      expect(parseRetryAfter({ 'retry-after': 'Wed, 01 Jan 1990 00:00:00 GMT' })).toEqual(0);
    });
  });

  // ───────────────────────── §3.3 degenerate cases ─────────────────────────
  describe('§3.3 degenerate cases', () => {
    it('T-PA-13 | absent header → undefined', () => {
      expect(parseRetryAfter({})).toBeUndefined();
    });

    it('T-PA-14 | uppercase "Retry-After" → undefined (strict lowercase lookup)', () => {
      expect(parseRetryAfter({ 'Retry-After': '10' })).toBeUndefined();
    });

    it('T-PA-15 | empty string → undefined', () => {
      expect(parseRetryAfter({ 'retry-after': '' })).toBeUndefined();
    });

    it('T-PA-16 | garbage string → undefined', () => {
      expect(parseRetryAfter({ 'retry-after': 'garbage-string' })).toBeUndefined();
    });

    it('T-PA-17 | negative value → undefined', () => {
      expect(parseRetryAfter({ 'retry-after': '-5' })).toBeUndefined();
    });

    it('T-PA-18 | mixed garbage → undefined', () => {
      expect(parseRetryAfter({ 'retry-after': 'abc-def-ghi' })).toBeUndefined();
    });

    it('T-PA-19 | "  10  " with whitespace → undefined (strict RFC 7231, no LWS)', () => {
      // NIB-T §3.3 normative decision: reject whitespace-padded values.
      expect(parseRetryAfter({ 'retry-after': '  10  ' })).toBeUndefined();
    });

    it('T-PA-20 | "10.0" float → undefined (RFC 7231 requires integer)', () => {
      expect(parseRetryAfter({ 'retry-after': '10.0' })).toBeUndefined();
    });
  });

  // ───────────────────────── §3.4 field precedence ─────────────────────────
  describe('§3.4 field precedence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('T-PA-21 | unrelated headers ignored', () => {
      expect(
        parseRetryAfter({
          'retry-after': 'Fri, 17 Apr 2026 12:00:30 GMT',
          'x-custom': 'ignored',
        }),
      ).toEqual(30000);
    });

    it('T-PA-22 | only "retry-after" is read (not "retry-after-ms")', () => {
      expect(parseRetryAfter({ 'retry-after': '10', 'retry-after-ms': '99999' })).toEqual(10000);
    });
  });

  // ───────────────────────── §3.5 properties ─────────────────────────
  describe('§3.5 properties', () => {
    it('P-PA-a | idempotent — same input → same output (100 random headers)', () => {
      const rng = seededRandom(0xc0ffee);
      for (let i = 0; i < 100; i += 1) {
        // Mix of valid numbers, garbage strings, absent header.
        const choice = rng.randomInt(0, 3);
        let headers: Record<string, string>;
        if (choice === 0) {
          headers = { 'retry-after': String(rng.randomInt(-10, 3600)) };
        } else if (choice === 1) {
          headers = { 'retry-after': rng.randomString(16) };
        } else if (choice === 2) {
          headers = {};
        } else {
          headers = { 'retry-after': '' };
        }
        const a = parseRetryAfter(headers);
        const b = parseRetryAfter(headers);
        expect(a).toEqual(b);
      }
    });

    it('P-PA-b | does not mutate input headers (frozen object preserved)', () => {
      const headers = Object.freeze({ 'retry-after': '10' });
      expect(() => parseRetryAfter(headers)).not.toThrow();
      expect(headers).toEqual({ 'retry-after': '10' });
    });

    it('P-PA-c | codomain is exactly `number | undefined` (never NaN, null, object)', () => {
      const rng = seededRandom(0x1234);
      for (let i = 0; i < 50; i += 1) {
        const headers: Record<string, string> = rng.randomBool()
          ? { 'retry-after': rng.randomString(10) }
          : { 'retry-after': String(rng.randomInt(0, 100)) };
        const result = parseRetryAfter(headers);
        if (result !== undefined) {
          expect(typeof result).toEqual('number');
          expect(Number.isNaN(result)).toEqual(false);
          expect(Number.isFinite(result)).toEqual(true);
          expect(result).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });
});
