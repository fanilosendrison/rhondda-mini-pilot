// NIB-M-ERROR-CLASSIFIER-BASE — pure HTTP signal → LLMRuntimeError mapping.

import {
  AbortedError,
  AuthError,
  InvalidRequestError,
  type LLMRuntimeError,
  type NetworkErrorKind,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  TimeoutError,
  TransientProviderError,
} from '../errors/index.js';
import { parseRetryAfter } from './retry-resolver.js';

export type { NetworkErrorKind };

export interface ProviderErrorSignal {
  readonly aborted: boolean;
  readonly timeout: boolean;
  readonly headers: Record<string, string>;
  readonly status?: number;
  readonly bodyText?: string;
  readonly networkErrorKind?: NetworkErrorKind;
  readonly timeoutMs?: number;
  readonly cause?: unknown;
}

function buildMessage(prefix: string, bodyText?: string): string {
  if (bodyText !== undefined && bodyText.length > 0) {
    return `${prefix}: ${bodyText}`;
  }
  return prefix;
}

function classifyByStatus(status: number, signal: ProviderErrorSignal): LLMRuntimeError {
  if (status === 400 || status === 404) {
    return new InvalidRequestError({
      message: buildMessage(`HTTP ${status}`, signal.bodyText),
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (status === 401 || status === 403) {
    return new AuthError({
      message: buildMessage(`HTTP ${status}`, signal.bodyText),
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(signal.headers);
    return new RateLimitError({
      message: buildMessage(`HTTP 429`, signal.bodyText),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (status === 529) {
    const retryAfterMs = parseRetryAfter(signal.headers);
    return new OverloadedError({
      message: buildMessage(`HTTP 529`, signal.bodyText),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  // 5xx + all unmapped (e.g. 418, 504) → transient provider.
  // Retry-After on 5xx is handled by the engine's retry resolver (resolveRetryDecision
  // reads headers directly), not by the classifier.
  return new TransientProviderError({
    message: buildMessage(`HTTP ${status}`, signal.bodyText),
    status,
    ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
  });
}

export function classifyErrorBase(signal: ProviderErrorSignal): LLMRuntimeError {
  if (signal.aborted) {
    return new AbortedError({
      message: 'Aborted by external signal',
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (signal.timeout) {
    return new TimeoutError({
      message: 'Request timed out',
      ...(signal.timeoutMs !== undefined ? { timeoutMs: signal.timeoutMs } : {}),
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (signal.networkErrorKind !== undefined) {
    return new TransientProviderError({
      message: `Network error (${signal.networkErrorKind})`,
      networkErrorKind: signal.networkErrorKind,
      ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
    });
  }
  if (signal.status !== undefined) {
    return classifyByStatus(signal.status, signal);
  }
  return new ProviderProtocolError({
    message: 'Unclassified provider error signal',
    ...(signal.cause !== undefined ? { cause: signal.cause } : {}),
  });
}
