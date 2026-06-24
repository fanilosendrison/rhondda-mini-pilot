import type { LLMResponse, ProviderAdapter } from '@fanilosendrison/llm-runtime';
import {
  OverloadedError,
  RateLimitError,
  TimeoutError,
  TransientProviderError,
} from '@fanilosendrison/llm-runtime';

import { CONFIG } from '../config.js';
import type { Gsm8kItem } from '../domain/types.js';
import { formatDuration, formatErrorKind, sleep, timeLabel, writeErr } from './util.js';

export async function callWithRetries(
  adapter: ProviderAdapter,
  item: Gsm8kItem,
): Promise<LLMResponse> {
  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
    try {
      return await adapter.call({
        messages: [{ role: 'user', content: item.question }],
        temperature: CONFIG.temperature,
      });
    } catch (error) {
      if (!shouldRetry(error) || attempt >= CONFIG.maxAttempts) {
        throw error;
      }

      const delayMs = computeRetryDelayMs(attempt, error);
      writeErr(
        `[${timeLabel()}] Retry ${attempt}/${CONFIG.maxAttempts - 1} pour ${item.itemId} dans ${formatDuration(delayMs)} (${formatErrorKind(error)}).`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error('Retry loop exhausted without an error.');
}

function shouldRetry(error: unknown): boolean {
  if (
    error instanceof RateLimitError ||
    error instanceof TimeoutError ||
    error instanceof OverloadedError
  ) {
    return true;
  }

  if (error instanceof TransientProviderError) {
    return error.networkErrorKind !== undefined || error.status === undefined;
  }

  return false;
}

function computeRetryDelayMs(attempt: number, error: unknown): number {
  const nominal = Math.min(CONFIG.retryBaseMs * 2 ** (attempt - 1), CONFIG.retryMaxMs);
  const jittered = Math.round(nominal * (0.8 + Math.random() * 0.4));
  const retryAfterMs =
    error instanceof RateLimitError || error instanceof OverloadedError
      ? error.retryAfterMs
      : undefined;
  const withRetryAfter = retryAfterMs === undefined ? jittered : Math.max(jittered, retryAfterMs);
  return Math.min(withRetryAfter, CONFIG.retryMaxMs);
}
