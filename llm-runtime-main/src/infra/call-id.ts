// NIB-M-INFRA-UTILS §3.2 — monotonic ULID-based callId generator.
// Monotonic variant guarantees lexicographic increase even within the same ms.

import { monotonicFactory } from 'ulid';

const monotonicUlid = monotonicFactory();

export function createCallId(): string {
  return monotonicUlid();
}
