// NIB-M-SIGNAL-COMPOSER — composeSignal + abortableSleep.
//
// Rules:
// - External abort primes over timeout when both race (first-aborted-wins is the natural
//   behaviour of AbortController; external is wired synchronously, timer handler is async).
// - cleanup() clears the timer and detaches the external listener (NIB-T §8.4 C-SC-01).
// - abortableSleep never surfaces a raw DOMException from Node's internals — it rejects
//   with whatever `signal.reason` is (the engine re-classifies to AbortedError if needed).

export interface ComposedSignal {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

export class TimeoutAbortReason extends Error {
  public readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Signal aborted after ${timeoutMs}ms timeout`);
    this.name = 'TimeoutAbortReason';
    this.timeoutMs = timeoutMs;
  }
}

export function isTimeoutAbortReason(reason: unknown): reason is TimeoutAbortReason {
  return reason instanceof TimeoutAbortReason;
}

export function composeSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): ComposedSignal {
  const controller = new AbortController();

  // External already aborted → propagate immediately, no timer needed.
  if (external?.aborted) {
    controller.abort(external.reason);
    return {
      signal: controller.signal,
      cleanup: (): void => {
        // noop — no resources to release.
      },
    };
  }

  let timerId: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(external?.reason);
    }
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
  };

  if (external !== undefined) {
    external.addEventListener('abort', onExternalAbort, { once: true });
  }

  timerId = setTimeout(() => {
    timerId = undefined;
    if (!controller.signal.aborted) {
      controller.abort(new TimeoutAbortReason(timeoutMs));
    }
  }, timeoutMs);

  const cleanup = (): void => {
    if (timerId !== undefined) {
      clearTimeout(timerId);
      timerId = undefined;
    }
    if (external !== undefined) {
      external.removeEventListener('abort', onExternalAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    let timerId: ReturnType<typeof setTimeout> | undefined;

    const onAbort = (): void => {
      if (timerId !== undefined) {
        clearTimeout(timerId);
        timerId = undefined;
      }
      reject(signal.reason);
    };

    timerId = setTimeout(() => {
      timerId = undefined;
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
