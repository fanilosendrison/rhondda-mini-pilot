// NIB-M-FACTORIES §6 — OpenAI Embeddings adapter factory.

import { openaiEmbeddingsBinding } from '../bindings/openai-embeddings.js';
import { executeEmbedding } from '../engine/execute-embedding.js';
import { createCallId } from '../infra/call-id.js';
import { defaultClock } from '../infra/clock.js';
import { resolveLogger } from '../infra/logger.js';
import { createStats, readOnlyView } from '../infra/stats.js';
import type { EmbeddingAdapter, EmbeddingAdapterConfig } from '../types.js';
import { validateEmbeddingAdapterConfig } from './validate-config.js';

export function createOpenAIEmbeddingAdapter(config: EmbeddingAdapterConfig): EmbeddingAdapter {
  validateEmbeddingAdapterConfig(config);
  const { logging, ...cloneable } = config;
  const frozenConfig: EmbeddingAdapterConfig = {
    ...structuredClone(cloneable),
    ...(logging !== undefined ? { logging: { ...logging } } : {}),
  };
  const logger = resolveLogger(frozenConfig.logging);
  const stats = createStats();

  async function embed(
    texts: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    const { embeddings, delta } = await executeEmbedding(texts, options?.signal, {
      binding: openaiEmbeddingsBinding,
      config: frozenConfig,
      provider: 'openai',
      clock: defaultClock,
      logger,
      createCallId,
    });
    if (delta.succeeded) {
      stats.totalCalls += 1;
      stats.totalDurationMs += delta.durationMs;
    }
    return embeddings;
  }

  return {
    provider: 'openai',
    model: frozenConfig.model,
    stats: readOnlyView(stats),
    embed,
  };
}
