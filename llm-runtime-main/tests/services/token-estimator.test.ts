// NIB-T §5 — RED-phase tests for estimateCallTokens.
// Reference: specs/NIB-T-LLMRUNTIME.md §5 (T-TE-01..T-TE-18 + P-TE-a..d).

import { describe, expect, it } from 'vitest';
import type { RateLimitSnapshot } from '../../src/services/throttle-resolver.js';
import { estimateCallTokens } from '../../src/services/token-estimator.js';
import type { LLMMessage } from '../../src/types.js';
import { seededRandom } from '../helpers/seeded-random.js';

describe('token-estimator', () => {
  // ───────────────────────── §5.1 input estimation (UTF-8 bytes / 3.5) ─────────────────────────
  describe('§5.1 input estimation (bytes/3.5 + 1024 default output)', () => {
    it('T-TE-01 | "hello" (5 bytes) → 2 + 1024 = 1026', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: 'hello' }];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1026);
    });

    it('T-TE-02 | empty content → 0 + 1024 = 1024', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: '' }];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1024);
    });

    it('T-TE-03 | 350 "a"s → 100 + 1024 = 1124', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: 'a'.repeat(350) }];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1124);
    });

    it('T-TE-04 | system + user, 7 bytes → 2 + 1024 = 1026', () => {
      const messages: LLMMessage[] = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'user' },
      ];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1026);
    });

    it('T-TE-05 | "café" (é=2 bytes → 5 bytes) → 2 + 1024 = 1026', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: 'café' }];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1026);
    });

    it('T-TE-06 | "日本語" (9 bytes) → 3 + 1024 = 1027', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: '日本語' }];
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1027);
    });
  });

  // ───────────────────────── §5.2 snapshot prioritized for output ─────────────────────────
  describe('§5.2 output from snapshot (priority)', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]; // 2 bytes → ceil(2/3.5)=1

    it('T-TE-07 | snapshot.lastCallOutputTokens=500 → output=500', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 1000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 500,
        state: 'known',
      };
      expect(estimateCallTokens(messages, snapshot, undefined)).toEqual(1 + 500);
    });

    it('T-TE-08 | snapshot=2000 primes over maxTokens=100', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 1000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 2000,
        state: 'known',
      };
      expect(estimateCallTokens(messages, snapshot, 100)).toEqual(1 + 2000);
    });

    it('T-TE-09 | snapshot.lastCallOutputTokens=0 → output=0', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 1000,
        resetTokensAt: 5000,
        lastCallOutputTokens: 0,
        state: 'known',
      };
      expect(estimateCallTokens(messages, snapshot, 500)).toEqual(1 + 0);
    });
  });

  // ───────────────────────── §5.3 fallback on maxTokens ─────────────────────────
  describe('§5.3 output fallback on maxTokens (capped at 4096)', () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'hi' }]; // input = 1

    it('T-TE-10 | snapshot=null, maxTokens=undefined → 1024 (default)', () => {
      expect(estimateCallTokens(messages, null, undefined)).toEqual(1 + 1024);
    });

    it('T-TE-11 | snapshot=null, maxTokens=500 → 500', () => {
      expect(estimateCallTokens(messages, null, 500)).toEqual(1 + 500);
    });

    it('T-TE-12 | snapshot=null, maxTokens=4096 → 4096', () => {
      expect(estimateCallTokens(messages, null, 4096)).toEqual(1 + 4096);
    });

    it('T-TE-13 | snapshot=null, maxTokens=8000 → capped at 4096', () => {
      expect(estimateCallTokens(messages, null, 8000)).toEqual(1 + 4096);
    });

    it('T-TE-14 | snapshot=null, maxTokens=100000 → capped at 4096', () => {
      expect(estimateCallTokens(messages, null, 100000)).toEqual(1 + 4096);
    });

    it('T-TE-15 | state="unknown" → falls back to maxTokens=2000', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 0,
        resetTokensAt: 0,
        lastCallOutputTokens: 500,
        state: 'unknown',
      };
      expect(estimateCallTokens(messages, snapshot, 2000)).toEqual(1 + 2000);
    });

    it('T-TE-16 | state="unknown" ignores lastCallOutputTokens → 500', () => {
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 0,
        resetTokensAt: 0,
        lastCallOutputTokens: 9999,
        state: 'unknown',
      };
      expect(estimateCallTokens(messages, snapshot, 500)).toEqual(1 + 500);
    });
  });

  // ───────────────────────── §5.4 combined ─────────────────────────
  describe('§5.4 combined', () => {
    it('T-TE-17 | 3500 "a"s + snapshot(state=known,lastOut=200) → 1000 + 200 = 1200', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: 'a'.repeat(3500) }];
      const snapshot: RateLimitSnapshot = {
        remainingTokens: 0,
        resetTokensAt: 0,
        lastCallOutputTokens: 200,
        state: 'known',
      };
      expect(estimateCallTokens(messages, snapshot, 500)).toEqual(1200);
    });

    it('T-TE-18 | empty content + null snapshot + maxTokens=0 → 0', () => {
      const messages: LLMMessage[] = [{ role: 'user', content: '' }];
      expect(estimateCallTokens(messages, null, 0)).toEqual(0);
    });
  });

  // ───────────────────────── §5.5 properties ─────────────────────────
  describe('§5.5 properties', () => {
    it('P-TE-a | result >= 0 always', () => {
      const rng = seededRandom(0xfeed);
      for (let i = 0; i < 50; i += 1) {
        const messages = rng.randomMessages(rng.randomInt(0, 5));
        const snapshot: RateLimitSnapshot | null = rng.randomBool()
          ? null
          : {
              remainingTokens: rng.randomInt(0, 10000),
              resetTokensAt: rng.randomInt(0, 10000),
              lastCallOutputTokens: rng.randomInt(0, 5000),
              state: (['known', 'unknown', 'partial'] as const)[rng.randomInt(0, 2)] ?? 'known',
            };
        const maxTokens = rng.randomBool() ? rng.randomInt(0, 5000) : undefined;
        const result = estimateCallTokens(messages, snapshot, maxTokens);
        expect(result).toBeGreaterThanOrEqual(0);
      }
    });

    it('P-TE-b | pure: same inputs ⇒ same output', () => {
      const rng = seededRandom(0x1111);
      for (let i = 0; i < 30; i += 1) {
        const messages = rng.randomMessages(3);
        const snapshot: RateLimitSnapshot | null = rng.randomBool()
          ? null
          : {
              remainingTokens: rng.randomInt(0, 10000),
              resetTokensAt: rng.randomInt(0, 10000),
              lastCallOutputTokens: rng.randomInt(0, 5000),
              state: 'known',
            };
        const maxTokens = rng.randomInt(100, 4000);
        const a = estimateCallTokens(messages, snapshot, maxTokens);
        const b = estimateCallTokens(messages, snapshot, maxTokens);
        expect(a).toEqual(b);
      }
    });

    it('P-TE-c | result is integer', () => {
      const rng = seededRandom(0x2222);
      for (let i = 0; i < 30; i += 1) {
        const messages = rng.randomMessages(rng.randomInt(1, 4));
        const result = estimateCallTokens(messages, null, rng.randomInt(100, 3000));
        expect(Number.isInteger(result)).toEqual(true);
      }
    });

    it('P-TE-d | monotonicity: adding 1 char grows input part by at most 1', () => {
      const rng = seededRandom(0x3333);
      for (let i = 0; i < 30; i += 1) {
        const base = rng.randomString(100);
        const messagesA: LLMMessage[] = [{ role: 'user', content: base }];
        const messagesB: LLMMessage[] = [{ role: 'user', content: `${base}x` }];
        const a = estimateCallTokens(messagesA, null, 0);
        const b = estimateCallTokens(messagesB, null, 0);
        expect(b - a).toBeGreaterThanOrEqual(0);
        expect(b - a).toBeLessThanOrEqual(1);
      }
    });
  });
});
