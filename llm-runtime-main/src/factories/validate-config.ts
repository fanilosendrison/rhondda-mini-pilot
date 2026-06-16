// NIB-M-FACTORIES — config validation (I-4 fail-closed).
// Called at the top of every factory before any resource allocation.

import { InvalidRequestError } from '../errors/index.js';
import type {
  AdapterConfig,
  EmbeddingAdapterConfig,
  RetryPolicy,
  TimeoutPolicy,
} from '../types.js';

function validateRetryPolicy(retry: RetryPolicy | undefined, label: string): void {
  if (retry === undefined) return;
  if (retry.maxAttempts < 1) {
    throw new InvalidRequestError({ message: `${label}: retry.maxAttempts must be >= 1` });
  }
  if (retry.backoffBaseMs < 0) {
    throw new InvalidRequestError({ message: `${label}: retry.backoffBaseMs must be >= 0` });
  }
  if (retry.maxBackoffMs < 0) {
    throw new InvalidRequestError({ message: `${label}: retry.maxBackoffMs must be >= 0` });
  }
}

function validateTimeoutPolicy(timeout: TimeoutPolicy | undefined, label: string): void {
  if (timeout === undefined) return;
  if (timeout.perAttemptMs <= 0) {
    throw new InvalidRequestError({ message: `${label}: timeout.perAttemptMs must be > 0` });
  }
}

/**
 * Validate required fields on AdapterConfig and throw InvalidRequestError
 * for anything malformed. Enforces I-4 fail-closed: no silent acceptance
 * of broken configs.
 */
export function validateAdapterConfig(config: AdapterConfig): void {
  if (config.model === undefined || config.model.length === 0) {
    throw new InvalidRequestError({ message: 'AdapterConfig: model is required' });
  }
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new InvalidRequestError({ message: 'AdapterConfig: apiKey is required' });
  }
  validateRetryPolicy(config.retry, 'AdapterConfig');
  validateTimeoutPolicy(config.timeout, 'AdapterConfig');
}

/**
 * Validate required fields on EmbeddingAdapterConfig.
 */
export function validateEmbeddingAdapterConfig(config: EmbeddingAdapterConfig): void {
  if (config.model === undefined || config.model.length === 0) {
    throw new InvalidRequestError({ message: 'EmbeddingAdapterConfig: model is required' });
  }
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new InvalidRequestError({ message: 'EmbeddingAdapterConfig: apiKey is required' });
  }
  if (config.batchSize !== undefined && config.batchSize < 1) {
    throw new InvalidRequestError({
      message: 'EmbeddingAdapterConfig: batchSize must be >= 1',
    });
  }
  validateRetryPolicy(config.retry, 'EmbeddingAdapterConfig');
  validateTimeoutPolicy(config.timeout, 'EmbeddingAdapterConfig');
}
