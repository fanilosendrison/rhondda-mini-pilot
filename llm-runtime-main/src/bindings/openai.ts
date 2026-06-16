// NIB-M-BINDINGS-COMPLETION §4 -- OpenAI Chat Completions binding.

import {
  buildOpenAILikeRequest,
  classifyOpenAILikeError,
  OPENAI_TERMINATION_MAP,
  parseOpenAILikeResponse,
  readOpenAILikeRateLimitHeaders,
} from './_internal/openai-common.js';
import type { ProviderBinding } from './types.js';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export const openaiBinding: ProviderBinding = {
  provider: 'openai',
  buildRequest: (request, config) =>
    buildOpenAILikeRequest(config.endpoint ?? DEFAULT_ENDPOINT, request, config),
  parseResponse: (body) => parseOpenAILikeResponse(body),
  classifyError: (signal) => classifyOpenAILikeError(signal, 'openai'),
  readRateLimitHeaders: (headers, nowMono) => readOpenAILikeRateLimitHeaders(headers, nowMono),
  terminationMap: OPENAI_TERMINATION_MAP,
  quirks: {
    hasRateLimitHeaders: true,
    mayRouteModel: false,
    defaultSanitization: {
      stripThinkingTags: true,
      stripJsonFence: false,
    },
  },
};
