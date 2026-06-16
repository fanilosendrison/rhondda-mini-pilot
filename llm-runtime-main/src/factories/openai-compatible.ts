// NIB-M-FACTORIES §4 -- OpenAI-compatible adapter factory (parameterized).

import { createOpenAICompatibleBinding } from '../bindings/openai-compatible.js';
import type { OpenAICompatibleProvider } from '../bindings/types.js';
import { InvalidRequestError } from '../errors/index.js';
import type { AdapterConfig, ProviderAdapter } from '../types.js';
import { createCompletionAdapter } from './_internal/create-adapter.js';
import { validateAdapterConfig } from './validate-config.js';

export interface OpenAICompatibleAdapterConfig extends AdapterConfig {
  readonly provider: OpenAICompatibleProvider;
}

const ALLOWED: ReadonlySet<OpenAICompatibleProvider> = new Set<OpenAICompatibleProvider>([
  'deepseek',
  'mistral',
  'groq',
  'together',
  'ollama',
]);

export function createOpenAICompatibleAdapter(
  config: OpenAICompatibleAdapterConfig,
): ProviderAdapter {
  validateAdapterConfig(config);
  if (!ALLOWED.has(config.provider)) {
    throw new InvalidRequestError({
      message: `unsupported openai-compatible provider: ${String(config.provider)}`,
    });
  }
  const binding = createOpenAICompatibleBinding(config.provider);
  return createCompletionAdapter(config, binding, config.provider);
}
