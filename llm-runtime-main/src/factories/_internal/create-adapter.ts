// Shared completion adapter scaffold for all providers.
// Extracts the common factory pattern: config clone + executeCall wiring +
// stats accumulation + adapter shape. Each public factory just parameterizes
// binding + provider + config validation.

import type { ProviderBinding } from '../../bindings/types.js';
import { executeCall } from '../../engine/execute-call.js';
import { createCallId } from '../../infra/call-id.js';
import { defaultClock } from '../../infra/clock.js';
import { resolveLogger } from '../../infra/logger.js';
import { createStats, readOnlyView } from '../../infra/stats.js';
import type { RateLimitSnapshot } from '../../services/throttle-resolver.js';
import type {
  AdapterConfig,
  LLMRequest,
  LLMResponse,
  ProviderAdapter,
  ProviderLongId,
} from '../../types.js';

export function createCompletionAdapter(
  config: AdapterConfig,
  binding: ProviderBinding,
  provider: ProviderLongId,
): ProviderAdapter {
  // Deep clone config to prevent caller mutation (I-8). Fields that may contain
  // non-cloneable values (functions) are shallow-copied instead.
  const { providerOptions, logging, integrity, ...cloneable } = config;
  const frozenConfig: AdapterConfig = {
    ...structuredClone(cloneable),
    ...(integrity !== undefined ? { integrity: { ...integrity } } : {}),
    ...(logging !== undefined ? { logging: { ...logging } } : {}),
    ...(providerOptions !== undefined ? { providerOptions: { ...providerOptions } } : {}),
  };
  const logger = resolveLogger(frozenConfig.logging);
  const stats = createStats();
  let snapshot: RateLimitSnapshot | null = null;

  async function call(
    request: LLMRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LLMResponse> {
    const { response, delta } = await executeCall(request, options?.signal, {
      binding,
      config: frozenConfig,
      provider,
      clock: defaultClock,
      logger,
      createCallId,
      getSnapshot: () => snapshot,
      setSnapshot: (s) => {
        snapshot = s;
      },
    });
    if (delta.succeeded) {
      stats.totalCalls += 1;
      if (delta.inputTokens !== undefined) stats.totalInputTokens += delta.inputTokens;
      if (delta.outputTokens !== undefined) stats.totalOutputTokens += delta.outputTokens;
      stats.totalDurationMs += delta.durationMs;
    }
    return response;
  }

  return {
    provider,
    model: frozenConfig.model,
    stats: readOnlyView(stats),
    call,
  };
}
