// NIB-T §27.8 — deterministic pseudo-random for property tests.
// Test-time utility (not production code). Uses mulberry32 LCG.

import type { LLMMessage, LLMRole } from '../../src/types.js';

export interface SeededRandom {
  randomString(maxLen: number): string;
  randomInt(min: number, max: number): number;
  randomBool(): boolean;
  randomMessages(count: number): LLMMessage[];
}

// mulberry32: 32-bit LCG, simple and deterministic.
function makeMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
const ROLES: readonly LLMRole[] = ['system', 'user', 'assistant'] as const;

export function seededRandom(seed: number): SeededRandom {
  const next = makeMulberry32(seed);

  function randomInt(min: number, max: number): number {
    if (max < min) {
      throw new Error(`seededRandom.randomInt: max (${max}) < min (${min})`);
    }
    const span = max - min + 1;
    return min + Math.floor(next() * span);
  }

  function randomBool(): boolean {
    return next() < 0.5;
  }

  function randomString(maxLen: number): string {
    if (maxLen <= 0) return '';
    const len = randomInt(0, maxLen);
    let out = '';
    for (let i = 0; i < len; i += 1) {
      const idx = Math.floor(next() * ALPHABET.length);
      out += ALPHABET.charAt(idx);
    }
    return out;
  }

  function randomMessages(count: number): LLMMessage[] {
    const out: LLMMessage[] = [];
    for (let i = 0; i < count; i += 1) {
      const roleIdx = Math.floor(next() * ROLES.length);
      // Fallback unreachable at runtime; satisfies TS strict indexing.
      const role = ROLES[roleIdx] ?? 'user';
      out.push({
        role,
        content: randomString(64),
      });
    }
    return out;
  }

  return {
    randomString,
    randomInt,
    randomBool,
    randomMessages,
  };
}
