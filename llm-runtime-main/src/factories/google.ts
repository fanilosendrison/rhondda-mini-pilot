// NIB-M-FACTORIES §5 -- Google Gemini adapter factory.

import { googleBinding } from '../bindings/google.js';
import type { AdapterConfig, ProviderAdapter } from '../types.js';
import { createCompletionAdapter } from './_internal/create-adapter.js';
import { validateAdapterConfig } from './validate-config.js';

export function createGoogleAdapter(config: AdapterConfig): ProviderAdapter {
  validateAdapterConfig(config);
  return createCompletionAdapter(config, googleBinding, 'google');
}
