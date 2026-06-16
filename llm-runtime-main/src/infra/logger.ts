// NIB-M-INFRA-UTILS §3.3 — default NDJSON stderr logger + noop + policy resolver.

import type { LLMEvent, LLMLogger, LoggingPolicy } from '../types.js';

export const defaultStderrLogger: LLMLogger = {
  emit(event: LLMEvent): void {
    try {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    } catch {
      // NIB-M-INFRA-UTILS C-IU3 — logger failures never break the runtime.
    }
  },
};

export const noopLogger: LLMLogger = {
  emit(): void {
    // intentionally empty.
  },
};

export function resolveLogger(policy: LoggingPolicy | undefined): LLMLogger {
  // NIB-M-INFRA-UTILS §3.3.3 — single-switch: enabled: false cuts any injection.
  // Undefined policy or undefined enabled ⇒ default on.
  if (policy?.enabled === false) return noopLogger;
  return policy?.logger ?? defaultStderrLogger;
}
