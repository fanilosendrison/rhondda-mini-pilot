// NIB-T §27.7 — composite assertions on event sequences.
// Test-time utility (not production code). Thin wrappers around vitest expect.

import { expect } from 'vitest';

import type { LLMEvent } from '../../src/types.js';

export const eventAssertions = {
  sequenceMatches(events: LLMEvent[], expectedTypes: string[]): void {
    const actual = events.map((e) => e.eventType);
    expect(actual).toEqual(expectedTypes);
  },

  allSameCallId(events: LLMEvent[]): void {
    expect(events.length).toBeGreaterThan(0);
    const first = events[0];
    if (first === undefined) return;
    const expectedCallId = first.callId;
    for (const e of events) {
      expect(e.callId).toBe(expectedCallId);
    }
  },

  noRetryScheduled(events: LLMEvent[]): void {
    const retries = events.filter((e) => e.eventType === 'llm_call_retry_scheduled');
    expect(retries).toHaveLength(0);
  },

  countOfType(events: LLMEvent[], eventType: string): number {
    return events.filter((e) => e.eventType === eventType).length;
  },

  endEventFinal(events: LLMEvent[]): void {
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last).toBeDefined();
    if (last === undefined) return;
    expect(last.eventType.endsWith('_end')).toBe(true);
  },

  noPIIIn(events: LLMEvent[], forbiddenTexts: string[]): void {
    for (const e of events) {
      const serialized = JSON.stringify(e);
      for (const forbidden of forbiddenTexts) {
        expect(
          serialized.includes(forbidden),
          `event ${e.eventType} contains forbidden text "${forbidden}"`,
        ).toBe(false);
      }
    }
  },
};
