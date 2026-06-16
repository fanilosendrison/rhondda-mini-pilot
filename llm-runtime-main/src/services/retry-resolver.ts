// NIB-M-RETRY-RESOLVER — pure decision for retry + RFC-7231 Retry-After parser.

import {
  AbortedError,
  AuthError,
  ContentFilterError,
  InvalidRequestError,
  OverloadedError,
  ProviderProtocolError,
  RateLimitError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from '../errors/index.js';
import { defaultClock } from '../infra/clock.js';
import type { RetryPolicy } from '../types.js';

export type RetryDecisionReason =
  | 'fatal_auth'
  | 'fatal_invalid_request'
  | 'fatal_parse_error'
  | 'fatal_content_filter'
  | 'fatal_aborted'
  | 'fatal_protocol'
  | 'fatal_truncation'
  | 'retry_exhausted'
  | 'transient_rate_limit'
  | 'transient_overloaded'
  | 'transient_provider'
  | 'transient_timeout'
  | 'transient_unknown';

export type RetryDecision =
  | { readonly retry: false; readonly reason: RetryDecisionReason }
  | { readonly retry: true; readonly delayMs: number; readonly reason: RetryDecisionReason };

const INTEGER_RE = /^\d+$/;
// RFC 7231 IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`. Any other shape → undefined.
const IMF_FIXDATE_RE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function computeBackoff(attempt: number, policy: RetryPolicy): number {
  const raw = policy.backoffBaseMs * 2 ** attempt;
  return Math.min(raw, policy.maxBackoffMs);
}

function classifyFatal(error: Error): RetryDecisionReason | undefined {
  if (error instanceof AuthError) return 'fatal_auth';
  if (error instanceof InvalidRequestError) return 'fatal_invalid_request';
  if (error instanceof ResponseParseError) return 'fatal_parse_error';
  if (error instanceof ContentFilterError) return 'fatal_content_filter';
  if (error instanceof AbortedError) return 'fatal_aborted';
  if (error instanceof ProviderProtocolError) return 'fatal_protocol';
  if (error instanceof SilentTruncationError) return 'fatal_truncation';
  return undefined;
}

function classifyRetriable(error: Error): RetryDecisionReason {
  if (error instanceof RateLimitError) return 'transient_rate_limit';
  if (error instanceof OverloadedError) return 'transient_overloaded';
  if (error instanceof TransientProviderError) return 'transient_provider';
  if (error instanceof TimeoutError) return 'transient_timeout';
  return 'transient_unknown';
}

export function resolveRetryDecision(
  error: Error,
  attempt: number,
  headers: Record<string, string>,
  policy: RetryPolicy,
): RetryDecision {
  const fatalReason = classifyFatal(error);
  if (fatalReason !== undefined) {
    return { retry: false, reason: fatalReason };
  }

  if (attempt + 1 >= policy.maxAttempts) {
    return { retry: false, reason: 'retry_exhausted' };
  }

  const reason = classifyRetriable(error);

  // Retry-After primes for rate-limit / overloaded only (NIB-M-RETRY-RESOLVER).
  if (reason === 'transient_rate_limit' || reason === 'transient_overloaded') {
    const retryAfterMs = parseRetryAfter(headers);
    if (retryAfterMs !== undefined) {
      return { retry: true, delayMs: retryAfterMs, reason };
    }
  }

  return { retry: true, delayMs: computeBackoff(attempt, policy), reason };
}

export function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (raw === undefined || raw === '') return undefined;

  // Seconds format — strict integer (RFC 7231, no leading whitespace).
  if (INTEGER_RE.test(raw)) {
    return Number.parseInt(raw, 10) * 1000;
  }

  // HTTP-date format — strict IMF-fixdate only (NIB-T §3.2).
  if (!IMF_FIXDATE_RE.test(raw)) return undefined;
  const parsed = new Date(raw);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return undefined;
  const delta = ms - defaultClock.nowWall().getTime();
  return delta <= 0 ? 0 : delta;
}
