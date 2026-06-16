// NIB-M-FACTORIES §3 -- Anthropic adapter factory.

import { anthropicBinding } from '../bindings/anthropic.js';
import type { AdapterConfig, ProviderAdapter } from '../types.js';
import { createCompletionAdapter } from './_internal/create-adapter.js';
import { validateAdapterConfig } from './validate-config.js';

export function createAnthropicAdapter(config: AdapterConfig): ProviderAdapter {
  validateAdapterConfig(config);
  return createCompletionAdapter(config, anthropicBinding, 'anthropic');
}
