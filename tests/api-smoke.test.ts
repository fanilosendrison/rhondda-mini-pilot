import 'dotenv/config';

import type { LLMResponse } from '@fanilosendrison/llm-runtime';
import { createOpenAIAdapter } from '@fanilosendrison/llm-runtime';
import { describe, expect, it } from 'vitest';

const API_KEY = process.env.OPENAI_API_KEY?.trim();
const MODEL = 'gpt-5.4-mini';

describe('API smoke test — gpt-5.4-mini', () => {
  it.skipIf(!API_KEY)(
    'sends a GSM8K-style question and receives a well-formed response',
    { timeout: 60_000 },
    async () => {
      const adapter = createOpenAIAdapter({
        // biome-ignore lint/style/noNonNullAssertion: guarded by it.skipIf(!API_KEY)
        apiKey: API_KEY!,
        model: MODEL,
        retry: { maxAttempts: 2, backoffBaseMs: 500, maxBackoffMs: 5_000 },
        timeout: { perAttemptMs: 30_000 },
        sanitization: { stripThinkingTags: true, stripJsonFence: false },
      });

      const question =
        'Natalia sold clips to 48 of her friends in April, and then she sold half as many clips in May. How many clips did Natalia sell altogether in April and May?';

      const response: LLMResponse = await adapter.call({
        messages: [{ role: 'user', content: question }],
        temperature: 0.7,
      });

      // ── Shape assertions ──
      expect(response.provider).toBe('openai');
      expect(response.model).toBe(MODEL);
      expect(response.content).toBeTruthy();
      expect(response.content.length).toBeGreaterThan(0);
      expect(response.termination).toBe('completed');
      expect(response.attemptCount).toBeGreaterThanOrEqual(1);
      expect(response.durationMs).toBeGreaterThan(0);

      // ── Usage tokens should be reported ──
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(response.usage.outputTokens).toBeGreaterThan(0);

      // ── Sanity: the answer should mention "72" (48 + 24) ──
      expect(response.content).toContain('72');

      // ── Log summary for visual inspection ──
      const log = (line: string) => process.stdout.write(`${line}\n`);
      log('─── API smoke test result ───');
      log(`  Model:       ${response.model}`);
      log(`  Tokens in:   ${response.usage.inputTokens}`);
      log(`  Tokens out:  ${response.usage.outputTokens}`);
      log(`  Duration:    ${response.durationMs}ms`);
      log(`  Termination: ${response.termination}`);
      log(`  Answer (first 200 chars): ${response.content.slice(0, 200)}`);
      log('────────────────────────────');
    },
  );
});
