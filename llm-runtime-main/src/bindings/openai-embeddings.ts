// NIB-M-BINDING-EMBEDDING — OpenAI Embeddings binding.

import { ResponseParseError } from '../errors/index.js';
import {
  classifyOpenAILikeError,
  coerceBodyToObject,
  readOpenAILikeRateLimitHeaders,
} from './_internal/openai-common.js';
import type { CanonicalHttpRequest, EmbeddingBinding } from './types.js';

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/embeddings';

function buildRequest(
  texts: readonly string[],
  config: { model: string; apiKey: string; endpoint?: string },
): CanonicalHttpRequest {
  return {
    method: 'POST',
    url: config.endpoint ?? DEFAULT_ENDPOINT,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    bodyKind: 'json',
    bodyJson: {
      model: config.model,
      input: [...texts],
      encoding_format: 'float',
    },
  };
}

function parseEmbeddings(body: unknown, _headers: Record<string, string>): number[][] {
  const obj = coerceBodyToObject(body, 'openai-embeddings');
  const data = obj['data'];
  if (!Array.isArray(data) || data.length === 0) {
    throw new ResponseParseError({ message: 'openai-embeddings: missing data[]' });
  }
  const indexed: Array<{ index: number; vector: number[] }> = [];
  for (const item of data) {
    if (item === null || typeof item !== 'object') {
      throw new ResponseParseError({ message: 'openai-embeddings: invalid data element' });
    }
    const entry = item as Record<string, unknown>;
    const embedding = entry['embedding'];
    if (!Array.isArray(embedding)) {
      throw new ResponseParseError({ message: 'openai-embeddings: element missing embedding' });
    }
    if (embedding.length === 0) {
      throw new ResponseParseError({ message: 'openai-embeddings: empty embedding vector' });
    }
    if (typeof embedding[0] !== 'number') {
      throw new ResponseParseError({
        message: 'openai-embeddings: embedding elements must be numbers',
      });
    }
    const index = typeof entry['index'] === 'number' ? entry['index'] : indexed.length;
    indexed.push({ index, vector: embedding as number[] });
  }
  indexed.sort((a, b) => a.index - b.index);
  return indexed.map((e) => e.vector);
}

export const openaiEmbeddingsBinding: EmbeddingBinding = {
  provider: 'openai',
  buildRequest,
  parseEmbeddings,
  classifyError: (signal) => classifyOpenAILikeError(signal, 'openai-embeddings'),
  readRateLimitHeaders: (headers, nowMono) => readOpenAILikeRateLimitHeaders(headers, nowMono),
  quirks: {
    hasRateLimitHeaders: true,
  },
};
