import type { LLMResponse } from '@vegacorp/llm-runtime';

import { CONFIG } from '../config.js';
import type { Gsm8kItem, PoolRecord, TokenTotals, TokenUsage } from './types.js';

export function buildPoolRecord(item: Gsm8kItem, draw: number, response: LLMResponse): PoolRecord {
  const input = response.usage.inputTokens ?? 0;
  const output = response.usage.outputTokens ?? 0;
  const total = response.usage.totalTokens ?? input + output;

  return {
    item_id: item.itemId,
    tirage: draw,
    prompt: item.question,
    response: response.content,
    tokens: { input, output, total },
    timestamp: new Date().toISOString(),
  };
}

export function checkpointKey(itemId: string, draw: number): string {
  return `${itemId}:${draw}`;
}

export function countCompletedDraws(itemId: string, completedKeys: ReadonlySet<string>): number {
  let count = 0;
  for (let draw = 1; draw <= CONFIG.drawsPerItem; draw += 1) {
    if (completedKeys.has(checkpointKey(itemId, draw))) count += 1;
  }
  return count;
}

export function countCompletedItems(
  items: readonly Gsm8kItem[],
  completedKeys: ReadonlySet<string>,
): number {
  let count = 0;
  for (const item of items) {
    if (countCompletedDraws(item.itemId, completedKeys) >= CONFIG.drawsPerItem) count += 1;
  }
  return count;
}

export function countCompletedRecords(
  items: readonly Gsm8kItem[],
  completedKeys: ReadonlySet<string>,
): number {
  let count = 0;
  for (const item of items) {
    count += countCompletedDraws(item.itemId, completedKeys);
  }
  return count;
}

export function addTokens(total: TokenTotals, tokens: TokenUsage): void {
  total.input += tokens.input;
  total.output += tokens.output;
  total.total += tokens.total;
}

export function estimateCost(tokens: TokenTotals): number {
  return (
    (tokens.input / 1_000_000) * CONFIG.inputUsdPer1M +
    (tokens.output / 1_000_000) * CONFIG.outputUsdPer1M
  );
}
