// NIB-M-FACTORIES §4 -- OpenAI adapter factory.

import { openaiBinding } from '../bindings/openai.js';
import type { AdapterConfig, ProviderAdapter } from '../types.js';
import { createCompletionAdapter } from './_internal/create-adapter.js';
import { validateAdapterConfig } from './validate-config.js';

export function createOpenAIAdapter(config: AdapterConfig): ProviderAdapter {
  validateAdapterConfig(config);
  return createCompletionAdapter(config, openaiBinding, 'openai');
}
