// Adapter stats helpers — mutable internal counter, read-only external view.

import type { AdapterStats } from '../types.js';

interface MutableStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
}

export function createStats(): MutableStats {
  return {
    totalCalls: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalDurationMs: 0,
  };
}

export function readOnlyView(source: MutableStats): AdapterStats {
  // Getter-only exposure: writes throw in strict mode (caught by consumers or
  // ignored silently when wrapped in try/catch). Satisfies C-ST-10.
  return Object.defineProperties(
    {},
    {
      totalCalls: { get: (): number => source.totalCalls, enumerable: true },
      totalInputTokens: { get: (): number => source.totalInputTokens, enumerable: true },
      totalOutputTokens: { get: (): number => source.totalOutputTokens, enumerable: true },
      totalDurationMs: { get: (): number => source.totalDurationMs, enumerable: true },
    },
  ) as AdapterStats;
}
