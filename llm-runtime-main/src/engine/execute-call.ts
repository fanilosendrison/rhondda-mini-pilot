// NIB-M-EXECUTE-CALL — completion engine orchestrator.

import type { ProviderBinding } from '../bindings/types.js';
import {
  AbortedError,
  InvalidRequestError,
  LLMRuntimeError,
  ProviderProtocolError,
  ResponseParseError,
  SilentTruncationError,
  TimeoutError,
  TransientProviderError,
} from '../errors/index.js';
import type { Clock } from '../infra/clock.js';
import { classifyErrorBase, type ProviderErrorSignal } from '../services/error-classifier-base.js';
import { isRetriableKind } from '../services/error-kind.js';
import { classifyNetworkError } from '../services/network-error-classifier.js';
import { resolveRetryDecision } from '../services/retry-resolver.js';
import {
  detectHeuristicTruncation,
  stripJsonFence,
  stripThinkingTags,
} from '../services/sanitizer.js';
import {
  abortableSleep,
  composeSignal,
  isTimeoutAbortReason,
} from '../services/signal-composer.js';
import { type RateLimitSnapshot, resolveThrottleDecision } from '../services/throttle-resolver.js';
import { estimateCallTokens } from '../services/token-estimator.js';
import type {
  AdapterConfig,
  LLMCallEndEvent,
  LLMLogger,
  LLMRequest,
  LLMResponse,
  ProviderLongId,
  TerminationReason,
} from '../types.js';
import { enrichError } from './_internal/enrich-error.js';
import { normalizeHeaders, runFetch } from './_internal/fetch-utils.js';

export interface ExecuteCallContext {
  readonly binding: ProviderBinding;
  readonly config: AdapterConfig;
  readonly provider: ProviderLongId;
  readonly clock: Clock;
  readonly logger: LLMLogger;
  readonly createCallId: () => string;
  readonly getSnapshot: () => RateLimitSnapshot | null;
  readonly setSnapshot: (snapshot: RateLimitSnapshot | null) => void;
  readonly fetchImpl?: typeof fetch;
}

export interface ExecuteCallStatsDelta {
  readonly succeeded: boolean;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly durationMs: number;
}

const DEFAULT_RETRY = { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 } as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const PREVIEW_MAX = 500;

// Signal that is never aborted. Used as fallback when no external signal is
// provided, avoiding a fresh AbortController allocation per sleep call.
const NEVER_ABORTING_SIGNAL: AbortSignal = new AbortController().signal;

function isAborted(s: AbortSignal | undefined): boolean {
  return s?.aborted === true;
}

function resolveSanitization(
  config: AdapterConfig,
  binding: ProviderBinding,
): { stripThinkingTags: boolean; stripJsonFence: boolean } {
  return {
    stripThinkingTags:
      config.sanitization.stripThinkingTags ??
      binding.quirks.defaultSanitization.stripThinkingTags,
    stripJsonFence:
      config.sanitization.stripJsonFence ?? binding.quirks.defaultSanitization.stripJsonFence,
  };
}

function validateRequest(request: LLMRequest): void {
  if (!Array.isArray(request.messages) || request.messages.length === 0) {
    throw new InvalidRequestError({ message: 'messages must be a non-empty array' });
  }
  let systemCount = 0;
  for (const m of request.messages) {
    if (m.role === 'system') systemCount += 1;
  }
  if (systemCount > 1) {
    throw new InvalidRequestError({ message: 'only one system message is allowed' });
  }
}

function clampPreview(raw: string): string {
  return raw.length > PREVIEW_MAX ? raw.slice(0, PREVIEW_MAX) : raw;
}

export async function executeCall(
  request: LLMRequest,
  externalSignal: AbortSignal | undefined,
  ctx: ExecuteCallContext,
): Promise<{ response: LLMResponse; delta: ExecuteCallStatsDelta }> {
  const { binding, config, provider, clock, logger, createCallId } = ctx;
  const callId = createCallId();
  const model = config.model;
  const retry = config.retry ?? DEFAULT_RETRY;
  const timeoutMs = config.timeout?.perAttemptMs ?? DEFAULT_TIMEOUT_MS;
  const integrity = config.integrity;
  const sanitizePolicy = resolveSanitization(config, binding);
  const startedAt = clock.nowWallIso();
  const startMono = clock.nowMono();
  const fetchImpl =
    ctx.fetchImpl ??
    (config.providerOptions as { fetch?: typeof fetch } | undefined)?.fetch ??
    (globalThis as { fetch: typeof fetch }).fetch;

  const baseEvent = (eventType: string): Record<string, unknown> => ({
    eventType,
    callId,
    provider,
    model,
    timestamp: clock.nowWallIso(),
  });

  // ─── validation + abort initial ───
  const bindingConfig = {
    model,
    apiKey: config.apiKey,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.providerOptions !== undefined
      ? { providerOptions: config.providerOptions as Record<string, unknown> }
      : {}),
  };
  const bindingRequestUrl = (() => {
    try {
      return binding.buildRequest(request, bindingConfig).url;
    } catch {
      return '';
    }
  })();

  logger.emit({
    ...baseEvent('llm_call_start'),
    endpoint: bindingRequestUrl,
    messagesCount: Array.isArray(request.messages) ? request.messages.length : 0,
  } as never);

  function emitEnd(
    success: boolean,
    attemptCount: number,
    extra: {
      termination?: TerminationReason;
      usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
      providerModel?: string;
      errorKind?: string;
      durationMs?: number;
    } = {},
  ): void {
    const endPayload: Record<string, unknown> = {
      ...baseEvent('llm_call_end'),
      success,
      durationMs: extra.durationMs ?? Math.max(0, Math.round(clock.nowMono() - startMono)),
      attemptCount,
    };
    if (extra.termination !== undefined) endPayload['termination'] = extra.termination;
    if (extra.usage !== undefined) endPayload['usage'] = extra.usage;
    if (extra.providerModel !== undefined) endPayload['providerModel'] = extra.providerModel;
    if (extra.errorKind !== undefined) endPayload['errorKind'] = extra.errorKind;
    logger.emit(endPayload as unknown as LLMCallEndEvent);
  }

  try {
    validateRequest(request);
  } catch (err) {
    const enriched = enrichError(err as LLMRuntimeError, { callId, provider, model, attempts: 0 });
    emitEnd(false, 0, { errorKind: (enriched as LLMRuntimeError).kind });
    throw enriched;
  }

  if (isAborted(externalSignal)) {
    const err = new AbortedError({
      message: 'aborted before call',
      cause: externalSignal?.reason,
    });
    const enriched = enrichError(err, { callId, provider, model, attempts: 0 });
    emitEnd(false, 0, { errorKind: 'aborted' });
    throw enriched;
  }

  let lastError: Error | null = null;
  let lastHeaders: Record<string, string> = {};
  let attempt = 0;

  function toLLMRuntimeError(err: Error): LLMRuntimeError {
    if (err instanceof LLMRuntimeError) return err;
    return new TransientProviderError({
      message: err.message,
      cause: err,
    });
  }

  for (; attempt < retry.maxAttempts; attempt += 1) {
    // ─── retry sleep (attempt > 0) ───
    if (attempt > 0 && lastError !== null) {
      const retryDecision = resolveRetryDecision(lastError, attempt - 1, lastHeaders, retry);
      if (retryDecision.retry === false) {
        const wrapped = toLLMRuntimeError(lastError);
        const kind = wrapped.kind;
        const enriched = enrichError(wrapped, { callId, provider, model, attempts: attempt });
        emitEnd(false, attempt, { errorKind: kind });
        throw enriched;
      }
      const retryErrorKind =
        lastError instanceof LLMRuntimeError ? lastError.kind : 'transient_provider';
      logger.emit({
        ...baseEvent('llm_call_retry_scheduled'),
        attempt,
        delayMs: retryDecision.delayMs,
        reason: retryDecision.reason,
        errorKind: retryErrorKind,
      } as never);
      // Abortable sleep on external signal only; no per-attempt timeout for sleep.
      if (retryDecision.delayMs > 0) {
        const sleepSignal = externalSignal ?? NEVER_ABORTING_SIGNAL;
        try {
          await abortableSleep(retryDecision.delayMs, sleepSignal);
        } catch (sleepErr) {
          const abortErr = new AbortedError({
            message: 'aborted during retry sleep',
            cause: sleepErr,
          });
          const enriched = enrichError(abortErr, {
            callId,
            provider,
            model,
            attempts: attempt,
          });
          emitEnd(false, attempt, { errorKind: 'aborted' });
          throw enriched;
        }
      }
    }

    // ─── throttle ───
    if (binding.quirks.hasRateLimitHeaders) {
      const snapshot = ctx.getSnapshot();
      const estimatedTokens = estimateCallTokens(request.messages, snapshot, request.maxTokens);
      const throttleDecision = resolveThrottleDecision(snapshot, estimatedTokens, clock.nowMono());
      if (throttleDecision.throttle === true) {
        logger.emit({
          ...baseEvent('llm_call_throttled'),
          waitMs: throttleDecision.waitMs,
          reason: throttleDecision.reason,
          snapshotState: snapshot?.state ?? 'unknown',
          estimatedTokens,
        } as never);
        const sleepSignal = externalSignal ?? NEVER_ABORTING_SIGNAL;
        try {
          await abortableSleep(throttleDecision.waitMs, sleepSignal);
        } catch (sleepErr) {
          const abortErr = new AbortedError({
            message: 'aborted during throttle wait',
            cause: sleepErr,
          });
          const enriched = enrichError(abortErr, {
            callId,
            provider,
            model,
            attempts: attempt,
          });
          emitEnd(false, attempt, { errorKind: 'aborted' });
          throw enriched;
        }
      }
    }

    // ─── attempt start ───
    logger.emit({ ...baseEvent('llm_call_attempt_start'), attempt } as never);

    // ─── compose signal (timeout + external) ───
    const composed = composeSignal(externalSignal, timeoutMs);

    // ─── build + fetch ───
    const canonical = binding.buildRequest(request, bindingConfig);
    let response: Response | undefined;
    let fetchError: unknown;
    try {
      response = await runFetch(
        fetchImpl,
        canonical.url,
        canonical.headers,
        canonical.bodyJson,
        composed.signal,
      );
    } catch (err) {
      fetchError = err;
    } finally {
      composed.cleanup();
    }

    if (fetchError !== undefined) {
      // External abort takes precedence.
      const aborted = isAborted(externalSignal);
      const timedOut = !aborted && isTimeoutAbortReason(composed.signal.reason);
      if (aborted) {
        const abortErr = new AbortedError({
          message: 'aborted during fetch',
          cause: externalSignal?.reason,
        });
        const enriched = enrichError(abortErr, {
          callId,
          provider,
          model,
          attempts: attempt + 1,
        });
        logger.emit({
          ...baseEvent('llm_call_fetch_error'),
          networkErrorKind: 'unknown',
          message: 'aborted',
        } as never);
        emitEnd(false, attempt + 1, { errorKind: 'aborted' });
        throw enriched;
      }
      if (timedOut) {
        const timeoutErr = new TimeoutError({
          message: `attempt timed out after ${timeoutMs}ms`,
          timeoutMs,
          cause: fetchError,
        });
        logger.emit({
          ...baseEvent('llm_call_fetch_error'),
          networkErrorKind: 'unknown',
          message: 'timeout',
        } as never);
        lastError = timeoutErr;
        lastHeaders = {};
        continue;
      }
      // Generic fetch error → classify via base classifier or mark as unknown.
      const networkErrorKind = classifyNetworkError(fetchError);
      const errMessage =
        fetchError instanceof Error && typeof fetchError.message === 'string'
          ? fetchError.message
          : String(fetchError);
      logger.emit({
        ...baseEvent('llm_call_fetch_error'),
        ...(networkErrorKind !== undefined
          ? { networkErrorKind }
          : { networkErrorKind: 'unknown' }),
        message: errMessage,
      } as never);
      if (networkErrorKind === undefined) {
        // Unclassified error → emit unknown warn event and keep raw Error.
        logger.emit({
          ...baseEvent('llm_call_unknown_error_classified'),
          rawMessage: errMessage,
        } as never);
        lastError = fetchError instanceof Error ? fetchError : new Error(errMessage);
      } else {
        const signal: ProviderErrorSignal = {
          aborted: false,
          timeout: false,
          headers: {},
          networkErrorKind,
          cause: fetchError,
        };
        lastError = classifyErrorBase(signal) as LLMRuntimeError;
      }
      lastHeaders = {};
      continue;
    }

    // response is defined here.
    const res = response!;
    const headers = normalizeHeaders(res.headers);
    lastHeaders = headers;

    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      const providerSignal: ProviderErrorSignal = {
        aborted: false,
        timeout: false,
        headers,
        status: res.status,
        bodyText,
      };
      const classified = binding.classifyError(providerSignal);
      logger.emit({
        ...baseEvent('llm_call_provider_error'),
        status: res.status,
        semanticErrorKind: classified.kind,
        retryable: isRetriableKind(classified.kind),
      } as never);

      // Snapshot update on 429 / rate-limit.
      if (binding.quirks.hasRateLimitHeaders) {
        const fresh = binding.readRateLimitHeaders(headers, clock.nowMono(), clock.nowWall());
        if (fresh !== null) {
          ctx.setSnapshot(fresh);
        } else if (res.status === 429) {
          // Invalidate snapshot when 429 but no exploitable headers.
          ctx.setSnapshot({
            remainingTokens: 0,
            resetTokensAt: clock.nowMono(),
            lastCallOutputTokens: 0,
            state: 'unknown',
          });
        }
      }

      lastError = classified;
      continue;
    }

    // ─── parse ───
    let parsed: import('../bindings/types.js').ParsedProviderResponse;
    try {
      const bodyText = await res.text();
      const bodyJson = bodyText.length === 0 ? null : JSON.parse(bodyText);
      parsed = binding.parseResponse(bodyJson, headers);
    } catch (err) {
      const parseErr =
        err instanceof LLMRuntimeError
          ? err
          : new ResponseParseError({
              message: err instanceof Error ? err.message : 'parse failed',
              cause: err,
            });
      logger.emit({
        ...baseEvent('llm_call_parse_error'),
        message: parseErr.message,
      } as never);
      // Fatal: ResponseParseError or ContentFilterError (from bindings).
      const enriched = enrichError(parseErr, {
        callId,
        provider,
        model,
        attempts: attempt + 1,
      });
      emitEnd(false, attempt + 1, { errorKind: parseErr.kind });
      throw enriched;
    }

    // ─── sanitize ───
    let content = parsed.rawContent;
    let thinkingRemoved = false;
    let jsonFenceRemoved = false;
    if (sanitizePolicy.stripThinkingTags) {
      const r = stripThinkingTags(content);
      content = r.content;
      thinkingRemoved = r.removed;
    }
    if (sanitizePolicy.stripJsonFence) {
      const r = stripJsonFence(content);
      content = r.content;
      jsonFenceRemoved = r.removed;
    }
    if (thinkingRemoved || jsonFenceRemoved) {
      const sanitizedEvent: Record<string, unknown> = {
        ...baseEvent('llm_call_sanitized'),
        thinkingTagsRemoved: thinkingRemoved,
        jsonFenceRemoved,
      };
      if (thinkingRemoved && content.length === 0) {
        sanitizedEvent['rawContentPreview'] = clampPreview(parsed.rawContent);
      }
      logger.emit(sanitizedEvent as never);
    }

    // ─── integrity: truncation ───
    let truncationDetected = false;
    let truncationMode: 'heuristic_json_unclosed' | 'explicit_max_tokens' | undefined;
    const terminationSignal = parsed.terminationSignal;
    const mappedTermination = binding.terminationMap[terminationSignal];
    if (integrity?.detectHeuristicTruncation === true) {
      if (detectHeuristicTruncation(content, request.maxTokens)) {
        truncationDetected = true;
        truncationMode = 'heuristic_json_unclosed';
      }
    }
    if (mappedTermination === 'max_tokens') {
      truncationDetected = true;
      truncationMode = 'explicit_max_tokens';
    }
    if (
      integrity?.failOnSilentTruncation === true &&
      truncationMode === 'heuristic_json_unclosed'
    ) {
      const err = new SilentTruncationError({
        message: 'silent truncation detected (heuristic)',
        truncationMode: 'heuristic_json_unclosed',
      });
      const enriched = enrichError(err, { callId, provider, model, attempts: attempt + 1 });
      emitEnd(false, attempt + 1, { errorKind: 'silent_truncation' });
      throw enriched;
    }

    // ─── termination mapping ───
    let termination: TerminationReason;
    if (mappedTermination !== undefined) {
      termination = mappedTermination;
    } else {
      logger.emit({
        ...baseEvent('llm_call_unknown_termination'),
        rawSignal: terminationSignal,
      } as never);
      if (integrity?.failOnUnknownTermination === true) {
        const err = new ProviderProtocolError({
          message: `unknown termination signal: ${terminationSignal}`,
        });
        const enriched = enrichError(err, {
          callId,
          provider,
          model,
          attempts: attempt + 1,
        });
        emitEnd(false, attempt + 1, { errorKind: 'provider_protocol' });
        throw enriched;
      }
      termination = 'unknown';
    }

    // ─── model mismatch ───
    if (integrity?.failOnModelMismatch === true && parsed.providerModel !== undefined) {
      const predicate = integrity.modelMismatchPredicate;
      let mismatch = false;
      if (predicate !== undefined) {
        mismatch = predicate(model, parsed.providerModel);
      } else if (!binding.quirks.mayRouteModel) {
        mismatch = parsed.providerModel !== model;
      }
      if (mismatch) {
        const err = new ProviderProtocolError({
          message: `model mismatch: requested=${model} received=${parsed.providerModel}`,
        });
        const enriched = enrichError(err, {
          callId,
          provider,
          model,
          attempts: attempt + 1,
        });
        emitEnd(false, attempt + 1, { errorKind: 'provider_protocol' });
        throw enriched;
      }
    }

    // ─── snapshot update (success) ───
    if (binding.quirks.hasRateLimitHeaders) {
      const fresh = binding.readRateLimitHeaders(headers, clock.nowMono(), clock.nowWall());
      if (fresh !== null) {
        const outputTokens = parsed.usage.outputTokens ?? 0;
        ctx.setSnapshot({ ...fresh, lastCallOutputTokens: outputTokens });
      }
    }

    // ─── response ───
    const endedAt = clock.nowWallIso();
    const durationMs = Math.max(0, Math.round(clock.nowMono() - startMono));
    const integrityInfo: LLMResponse['integrity'] = {
      truncationDetected,
      ...(truncationMode !== undefined ? { truncationMode } : {}),
    };
    const sanitizationInfo: LLMResponse['sanitization'] = {
      thinkingTagsRemoved: thinkingRemoved,
      jsonFenceRemoved,
    };
    const responseOut: LLMResponse = {
      callId,
      provider,
      model,
      ...(parsed.providerModel !== undefined ? { providerModel: parsed.providerModel } : {}),
      ...(parsed.providerResponseId !== undefined
        ? { providerResponseId: parsed.providerResponseId }
        : {}),
      content,
      rawContent: parsed.rawContent,
      termination,
      attemptCount: attempt + 1,
      durationMs,
      startedAt,
      endedAt,
      usage: parsed.usage,
      sanitization: sanitizationInfo,
      integrity: integrityInfo,
    };

    emitEnd(true, attempt + 1, {
      termination,
      usage: parsed.usage,
      ...(parsed.providerModel !== undefined ? { providerModel: parsed.providerModel } : {}),
      durationMs,
    });

    return {
      response: responseOut,
      delta: {
        succeeded: true,
        ...(parsed.usage.inputTokens !== undefined
          ? { inputTokens: parsed.usage.inputTokens }
          : {}),
        ...(parsed.usage.outputTokens !== undefined
          ? { outputTokens: parsed.usage.outputTokens }
          : {}),
        durationMs,
      },
    };
  }

  // Retry budget exhausted without success.
  if (lastError !== null) {
    const wrapped = toLLMRuntimeError(lastError);
    const kind = wrapped.kind;
    const enriched = enrichError(wrapped, { callId, provider, model, attempts: attempt });
    emitEnd(false, attempt, { errorKind: kind });
    throw enriched;
  }
  const fallback = new TransientProviderError({ message: 'retry exhausted without error' });
  const enriched = enrichError(fallback, { callId, provider, model, attempts: attempt });
  emitEnd(false, attempt, { errorKind: 'transient_provider' });
  throw enriched;
}
