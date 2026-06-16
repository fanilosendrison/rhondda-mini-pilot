// NIB-T §27.4 — controlled AbortSignal for precise cancellation tests.
// Test-time utility (not production code).

export interface ControlledSignal {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
  /** Schedule abort after `ms`. Returns a cancel handle to prevent timer leak. */
  abortAfter(ms: number, reason?: unknown): { cancel(): void };
}

export function createControlledSignal(): ControlledSignal {
  const controller = new AbortController();

  return {
    signal: controller.signal,
    abort(reason?: unknown): void {
      controller.abort(reason);
    },
    abortAfter(ms: number, reason?: unknown): { cancel(): void } {
      const timer = setTimeout(() => {
        controller.abort(reason);
      }, ms);
      return {
        cancel(): void {
          clearTimeout(timer);
        },
      };
    },
  };
}
