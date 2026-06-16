// NIB-T §27.3 — in-memory event collector conforming to LLMLogger.
// Test-time utility (not production code).

import type { LLMEvent, LLMLogger } from '../../src/types.js';

export interface MockLogger extends LLMLogger {
  readonly events: LLMEvent[];
  reset(): void;
  find(eventType: string): LLMEvent | undefined;
  findAll(eventType: string): LLMEvent[];
  eventTypes(): string[];
}

export function createMockLogger(): MockLogger {
  const events: LLMEvent[] = [];

  return {
    events,
    emit(event: LLMEvent): void {
      events.push(event);
    },
    reset(): void {
      events.length = 0;
    },
    find(eventType: string): LLMEvent | undefined {
      return events.find((e) => e.eventType === eventType);
    },
    findAll(eventType: string): LLMEvent[] {
      return events.filter((e) => e.eventType === eventType);
    },
    eventTypes(): string[] {
      return events.map((e) => e.eventType);
    },
  };
}
