// NIB-T §4 — RED-phase tests for resolveThrottleDecision.
// Reference: specs/NIB-T-LLMRUNTIME.md §4 (T-TR-01..T-TR-15 + P-TR-a, P-TR-b, P-TR-c).

import { describe, expect, it } from 'vitest';
import {
  type RateLimitSnapshot,
  resolveThrottleDecision,
  type ThrottleDecision,
} from '../../src/services/throttle-resolver.js';
import { seededRandom } from '../helpers/seeded-random.js';

describe('throttle-resolver', () => {
  // ───────────────────────── §4.1 null or unusable snapshot ─────────────────────────
  describe('§4.1 null or unusable snapshot', () => {
    it('T-TR-01 | null snapshot → no_snapshot', () => {
      const decision = resolveThrottleDecision(null, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'no_snapshot' });
    });

    it('T-TR-02 | null snapshot + estimated=0 → no_snapshot', () => {
      const decision = resolveThrottleDecision(null, 0, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'no_snapshot' });
    });

    it('T-TR-03 | state="unknown" → snapshot_unknown_quality', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 10000,
        resetTokensAt: 2000,
        lastCallOutputTokens: 0,
        state: 'unknown',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'snapshot_unknown_quality' });
    });
  });

  // ───────────────────────── §4.2 sufficient budget ─────────────────────────
  describe('§4.2 sufficient budget', () => {
    it('T-TR-04 | remaining=1000, estimated=500 → budget_sufficient', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 1000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'budget_sufficient' });
    });

    it('T-TR-05 | remaining=500, estimated=500 → budget_sufficient (strict >=)', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 500,
        resetTokensAt: 5000,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'budget_sufficient' });
    });

    it('T-TR-06 | remaining=100000, estimated=1 → budget_sufficient', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 100000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 1, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'budget_sufficient' });
    });
  });

  // ───────────────────────── §4.3 window already reset ─────────────────────────
  describe('§4.3 window already reset', () => {
    it('T-TR-07 | resetAt=500, nowMs=1000 → window_already_reset', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 10,
        resetTokensAt: 500,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'window_already_reset' });
    });

    it('T-TR-08 | resetAt=1000, nowMs=1000 → window_already_reset (strict <=)', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 10,
        resetTokensAt: 1000,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'window_already_reset' });
    });

    it('T-TR-09 | resetAt=999, nowMs=1000 → window_already_reset', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 10,
        resetTokensAt: 999,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'window_already_reset' });
    });
  });

  // ───────────────────────── §4.4 throttle active ─────────────────────────
  describe('§4.4 throttle active', () => {
    it('T-TR-10 | remaining=100<500, reset=5000, now=1000 → throttle waitMs=4000', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 100,
        resetTokensAt: 5000,
        lastCallOutputTokens: 200,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: true, waitMs: 4000, reason: 'budget_insufficient' });
    });

    it('T-TR-11 | remaining=0, reset=60000, now=30000 → throttle waitMs=30000', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 0,
        resetTokensAt: 60000,
        lastCallOutputTokens: 100,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 10, 30000);
      expect(decision).toEqual({ throttle: true, waitMs: 30000, reason: 'budget_insufficient' });
    });

    it('T-TR-12 | remaining=499<500, reset=10500, now=10000 → throttle waitMs=500', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 499,
        resetTokensAt: 10500,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 10000);
      expect(decision).toEqual({ throttle: true, waitMs: 500, reason: 'budget_insufficient' });
    });
  });

  // ───────────────────────── §4.5 priority order ─────────────────────────
  describe('§4.5 priority order', () => {
    it('T-TR-13 | null primes over any numeric evaluation', () => {
      const decision = resolveThrottleDecision(null, 0, 0);
      expect(decision).toEqual({ throttle: false, reason: 'no_snapshot' });
    });

    it('T-TR-14 | state="unknown" primes over sufficient budget', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 10000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 0,
        state: 'unknown',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'snapshot_unknown_quality' });
    });

    it('T-TR-15 | budget_sufficient primes over window_already_reset', () => {
      // state=known + remaining >= estimated + resetAt <= nowMs.
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 1000,
        resetTokensAt: 500, // past
        lastCallOutputTokens: 0,
        state: 'known',
      };
      const decision = resolveThrottleDecision(snapshot, 500, 1000);
      expect(decision).toEqual({ throttle: false, reason: 'budget_sufficient' });
    });
  });

  // ───────────────────────── §4.6 properties ─────────────────────────
  describe('§4.6 properties', () => {
    it('P-TR-a | pure function on 50 random inputs', () => {
      const rng = seededRandom(0xabc123);
      for (let i = 0; i < 50; i += 1) {
        const isNull = rng.randomInt(0, 9) === 0;
        const snapshot: RateLimitSnapshot | null = isNull
          ? null
          : {
              remainingTokens: rng.randomInt(0, 10000),
              resetTokensAt: rng.randomInt(0, 100000),
              lastCallOutputTokens: rng.randomInt(0, 5000),
              state: (['known', 'unknown', 'partial'] as const)[rng.randomInt(0, 2)] ?? 'known',
            };
        const estimated = rng.randomInt(0, 10000);
        const nowMs = rng.randomInt(0, 100000);
        const a = resolveThrottleDecision(snapshot, estimated, nowMs);
        const b = resolveThrottleDecision(snapshot, estimated, nowMs);
        expect(a).toEqual(b);
      }
    });

    it('P-TR-b | throttle=true ⇒ waitMs defined and > 0', () => {
      const rng = seededRandom(0x55aa);
      for (let i = 0; i < 50; i += 1) {
        const snapshot: RateLimitSnapshot = {
          remainingTokens: rng.randomInt(0, 10),
          resetTokensAt: rng.randomInt(5000, 20000),
          lastCallOutputTokens: rng.randomInt(0, 500),
          state: 'known',
        };
        const estimated = rng.randomInt(100, 1000);
        const nowMs = rng.randomInt(0, 4000);
        const decision: ThrottleDecision = resolveThrottleDecision(snapshot, estimated, nowMs);
        if (decision.throttle === true) {
          expect(typeof decision.waitMs).toEqual('number');
          expect(decision.waitMs).toBeGreaterThan(0);
        }
      }
    });

    it('P-TR-c | throttle=false ⇒ no waitMs property', () => {
      const rng = seededRandom(0x77bb);
      for (let i = 0; i < 50; i += 1) {
        const isNull = rng.randomBool();
        const snapshot: RateLimitSnapshot | null = isNull
          ? null
          : {
              remainingTokens: rng.randomInt(1000, 10000),
              resetTokensAt: rng.randomInt(0, 1000),
              lastCallOutputTokens: 0,
              state: 'known',
            };
        const decision: ThrottleDecision = resolveThrottleDecision(snapshot, 10, 5000);
        if (decision.throttle === false) {
          expect('waitMs' in decision).toEqual(false);
        }
      }
    });
  });
});
