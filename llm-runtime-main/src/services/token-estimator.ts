// NIB-M-TOKEN-ESTIMATOR — estimateCallTokens (input UTF-8 bytes / 3.5 + output from snapshot or maxTokens).

import type { LLMMessage } from '../types.js';
import type { RateLimitSnapshot } from './throttle-resolver.js';

const INPUT_BYTES_PER_TOKEN = 3.5;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_TOKENS_CAP = 4096;

const UTF8_ENCODER = new TextEncoder();

function utf8ByteLength(str: string): number {
  return UTF8_ENCODER.encode(str).length;
}

export function estimateCallTokens(
  messages: readonly LLMMessage[],
  snapshot: RateLimitSnapshot | null,
  maxTokens: number | undefined,
): number {
  let inputBytes = 0;
  for (const msg of messages) {
    inputBytes += utf8ByteLength(msg.content);
  }
  const inputTokens = Math.ceil(inputBytes / INPUT_BYTES_PER_TOKEN);

  const useSnapshotOutput = snapshot !== null && snapshot.state !== 'unknown';
  const outputTokens = useSnapshotOutput
    ? snapshot.lastCallOutputTokens
    : Math.min(maxTokens ?? DEFAULT_MAX_TOKENS, MAX_TOKENS_CAP);

  return inputTokens + outputTokens;
}
