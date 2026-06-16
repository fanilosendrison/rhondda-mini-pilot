// NIB-M-EXECUTE-EMBEDDING — embedding engine orchestrator.

import type { EmbeddingBinding } from '../bindings/types.js';
import {
  AbortedError,
  LLMRuntimeError,
  ResponseParseError,
  TimeoutError,
  TransientProviderError,
} from '../errors/index.js';
import type { Clock } from '../infra/clock.js';
import { classifyErrorBase, type ProviderErrorSignal } from '../services/error-classifier-base.js';
import { isRetriableKind } from '../services/error-kind.js';
import { classifyNetworkError } from '../services/network-error-classifier.js';
import { resolveRetryDecision } from '../services/retry-resolver.js';
import {
  abortableSleep,
  composeSignal,
  isTimeoutAbortReason,
} from '../services/signal-composer.js';
import type { EmbeddingAdapterConfig, LLMLogger, ProviderLongId } from '../types.js';
import { enrichError } from './_internal/enrich-error.js';
import { normalizeHeaders, runFetch } from './_internal/fetch-utils.js';

export interface ExecuteEmbeddingContext {
  readonly binding: EmbeddingBinding;
  readonly config: EmbeddingAdapterConfig;
  readonly provider: ProviderLongId;
  readonly clock: Clock;
  readonly logger: LLMLogger;
  readonly createCallId: () => string;
  readonly fetchImpl?: typeof fetch;
}

export interface ExecuteEmbeddingStatsDelta {
  readonly succeeded: boolean;
  readonly durationMs: number;
}

const NEVER_ABORTING_SIGNAL: AbortSignal = new AbortController().signal;

const DEFAULT_RETRY = { maxAttempts: 5, backoffBaseMs: 2000, maxBackoffMs: 60_000 } as const;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BATCH_SIZE = 100;

export async function executeEmbedding(
  texts: readonly string[],
  externalSignal: AbortSignal | undefined,
  ctx: ExecuteEmbeddingContext,
): Promise<{ embeddings: number[][]; delta: ExecuteEmbeddingStatsDelta }> {
  const { binding, config, provider, clock, logger, createCallId } = ctx;
  const callId = createCallId();
  const model = config.model;
  const retry = config.retry ?? DEFAULT_RETRY;
  const timeoutMs = config.timeout?.perAttemptMs ?? DEFAULT_TIMEOUT_MS;
  const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
  const startMono = clock.nowMono();
  const fetchImpl =
    ctx.fetchImpl ??
    (config as unknown as { providerOptions?: { fetch?: typeof fetch } }).providerOptions?.fetch ??
    (globalThis as { fetch: typeof fetch }).fetch;

  const bindingConfig = {
    model,
    apiKey: config.apiKey,
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
  };
  // Reuse the first batch build just to resolve the endpoint URL for start event.
  const endpoint =
    texts.length > 0
      ? binding.buildRequest(texts.slice(0, 1), bindingConfig).url
      : binding.buildRequest([''], bindingConfig).url;

  const baseEvent = (eventType: string): Record<string, unknown> => ({
    eventType,
    callId,
    provider,
    model,
    timestamp: clock.nowWallIso(),
  });

  logger.emit({
    ...baseEvent('llm_embedding_start'),
    endpoint,
    textsCount: texts.length,
    batchSize,
  } as never);

  function emitEnd(success: boolean, totalBatches: number, errorKind?: string): void {
    const payload: Record<string, unknown> = {
      ...baseEvent('llm_embedding_end'),
      success,
      totalBatches,
      totalDurationMs: Math.max(0, Math.round(clock.nowMono() - startMono)),
    };
    if (errorKind !== undefined) payload['errorKind'] = errorKind;
    logger.emit(payload as never);
  }

  if (texts.length === 0) {
    emitEnd(true, 0);
    return {
      embeddings: [],
      delta: { succeeded: true, durationMs: 0 },
    };
  }

  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  const results: number[][] = [];

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batchTexts = batches[batchIndex] ?? [];
    let lastError: LLMRuntimeError | null = null;
    let lastHeaders: Record<string, string> = {};
    let attempt = 0;
    let batchSuccess = false;

    for (; attempt < retry.maxAttempts; attempt += 1) {
      if (attempt > 0 && lastError !== null) {
        const decision = resolveRetryDecision(lastError, attempt - 1, lastHeaders, retry);
        if (decision.retry === false) {
          const kind = lastError.kind;
          const enriched = enrichError(lastError, { callId, provider, model, attempts: attempt });
          emitEnd(false, batchIndex, kind);
          throw enriched;
        }
        // NIB-M-EXECUTE-EMBEDDING §3.5.5: embedding-specific event name.
        logger.emit({
          ...baseEvent('llm_embedding_retry_scheduled'),
          batchIndex,
          attempt,
          delayMs: decision.delayMs,
          reason: decision.reason,
          errorKind: lastError.kind,
        } as import('../types.js').LLMEmbeddingRetryScheduledEvent);
        if (decision.delayMs > 0) {
          const sleepSignal = externalSignal ?? NEVER_ABORTING_SIGNAL;
          try {
            await abortableSleep(decision.delayMs, sleepSignal);
          } catch (cause) {
            const abortErr = new AbortedError({
              message: 'aborted during retry sleep',
              cause,
            });
            const enriched = enrichError(abortErr, {
              callId,
              provider,
              model,
              attempts: attempt,
            });
            emitEnd(false, batchIndex, 'aborted');
            throw enriched;
          }
        }
      }

      const batchStartMono = clock.nowMono();
      function emitBatchEvent(): void {
        logger.emit({
          ...baseEvent('llm_embedding_batch'),
          batchIndex,
          batchTextsCount: batchTexts.length,
          durationMs: Math.max(0, Math.round(clock.nowMono() - batchStartMono)),
        } as never);
      }
      const composed = composeSignal(externalSignal, timeoutMs);
      const canonical = binding.buildRequest(batchTexts, bindingConfig);
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
        const aborted = externalSignal?.aborted === true;
        const timedOut = !aborted && isTimeoutAbortReason(composed.signal.reason);
        if (aborted) {
          const abortErr = new AbortedError({
            message: 'aborted during embedding fetch',
            cause: externalSignal?.reason,
          });
          const enriched = enrichError(abortErr, {
            callId,
            provider,
            model,
            attempts: attempt + 1,
          });
          emitEnd(false, batchIndex, 'aborted');
          throw enriched;
        }
        if (timedOut) {
          lastError = new TimeoutError({
            message: `embedding attempt timed out after ${timeoutMs}ms`,
            timeoutMs,
            cause: fetchError,
          });
          lastHeaders = {};
          emitBatchEvent();
          continue;
        }
        const networkErrorKind = classifyNetworkError(fetchError);
        const signal: ProviderErrorSignal = {
          aborted: false,
          timeout: false,
          headers: {},
          ...(networkErrorKind !== undefined ? { networkErrorKind } : {}),
          cause: fetchError,
        };
        lastError = classifyErrorBase(signal) as LLMRuntimeError;
        if (lastError.kind === 'provider_protocol') {
          lastError = new TransientProviderError({
            message: fetchError instanceof Error ? fetchError.message : String(fetchError),
            ...(networkErrorKind !== undefined ? { networkErrorKind } : {}),
            cause: fetchError,
          });
        }
        lastHeaders = {};
        emitBatchEvent();
        continue;
      }

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
        lastError = classified;
        emitBatchEvent();
        continue;
      }

      let batchVectors: number[][];
      try {
        const bodyText = await res.text();
        const bodyJson = bodyText.length === 0 ? null : JSON.parse(bodyText);
        batchVectors = binding.parseEmbeddings(bodyJson, headers);
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
        const enriched = enrichError(parseErr, {
          callId,
          provider,
          model,
          attempts: attempt + 1,
        });
        emitEnd(false, batchIndex, parseErr.kind);
        throw enriched;
      }

      // Emit batch event after successful fetch with actual duration.
      emitBatchEvent();
      for (const vec of batchVectors) results.push(vec);
      batchSuccess = true;
      break;
    }

    if (!batchSuccess) {
      const finalErr =
        lastError ?? new TransientProviderError({ message: 'retry exhausted without error' });
      const enriched = enrichError(finalErr, {
        callId,
        provider,
        model,
        attempts: attempt,
      });
      emitEnd(false, batchIndex, finalErr.kind);
      throw enriched;
    }
  }

  emitEnd(true, batches.length);
  const durationMs = Math.max(0, clock.nowMono() - startMono);
  return {
    embeddings: results,
    delta: { succeeded: true, durationMs },
  };
}
