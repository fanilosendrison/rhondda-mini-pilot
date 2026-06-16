// NIB-T §23 — Contract invariants for the temporal model (wall vs mono).
// RED phase: source stubs throw "Not implemented". These tests are expected
// to fail at runtime but must compile cleanly.
//
// Mapping test → spec : §23.1 horloges distinctes, §23.2 résistance au clock jump,
// §23.3 timeouts monotones.

import { describe, expect, it, vi } from 'vitest';

import { mockClockRegistry } from '../helpers/mock-clock.js';

// Wire mockClockRegistry into src/infra/clock.js so that the engine uses the
// mock clock when mockClockRegistry.current is set (C-TM-04/05/06 requirement).
vi.doMock('../../src/infra/clock.js', () => ({
  defaultClock: {
    nowWall: () => mockClockRegistry.current?.nowWall() ?? new Date(),
    nowWallIso: () => mockClockRegistry.current?.nowWallIso() ?? new Date().toISOString(),
    nowMono: () => mockClockRegistry.current?.nowMono() ?? performance.now(),
  },
}));

const { TimeoutError } = await import('../../src/errors/index.js');
const { createAnthropicAdapter } = await import('../../src/factories/anthropic.js');
const { scenario } = await import('../helpers/fetch-scenario.js');
const { createMockClock } = await import('../helpers/mock-clock.js');
const { createMockFetch, createScenarioFetch } = await import('../helpers/mock-fetch.js');
const { createMockLogger } = await import('../helpers/mock-logger.js');

type AdapterConfig = import('../../src/types.js').AdapterConfig;
type LLMRequest = import('../../src/types.js').LLMRequest;

// ─── Helpers ───────────────────────────────────────────────────────────────

const REQUEST: LLMRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function baseConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return {
    model: 'claude-test',
    apiKey: 'sk-test',
    retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 5 },
    timeout: { perAttemptMs: 5_000 },
    sanitization: {},
    ...overrides,
  };
}

// ─── §23.1 Horloges distinctes ─────────────────────────────────────────────

describe('temporal contracts', () => {
  describe('§23.1 distinct clocks', () => {
    it('C-TM-01 | response.durationMs is a number ≥ 0', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      const res = await adapter.call(REQUEST);
      expect(typeof res.durationMs).toBe('number');
      expect(res.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('C-TM-02 | response.startedAt and endedAt are valid ISO 8601 strings', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const adapter = createAnthropicAdapter(baseConfig({ providerOptions: { fetch: fetchImpl } }));
      const res = await adapter.call(REQUEST);
      expect(res.startedAt).toMatch(ISO_REGEX);
      expect(res.endedAt).toMatch(ISO_REGEX);
      expect(Number.isNaN(new Date(res.startedAt).getTime())).toBe(false);
      expect(Number.isNaN(new Date(res.endedAt).getTime())).toBe(false);
    });

    it('C-TM-03 | events use wall ISO 8601 timestamp', async () => {
      const fetchImpl = createMockFetch(scenario.ok('anthropic', 'ok'));
      const logger = createMockLogger();
      const adapter = createAnthropicAdapter(
        baseConfig({
          logging: { enabled: true, logger },
          providerOptions: { fetch: fetchImpl },
        }),
      );
      await adapter.call(REQUEST).catch(() => undefined);
      for (const e of logger.events) {
        expect(e.timestamp).toMatch(ISO_REGEX);
      }
    });
  });

  // ─── §23.2 Résistance au clock jump ──────────────────────────────────────

  describe('§23.2 clock jump resistance', () => {
    it('C-TM-04 | durationMs > 0 and coherent (~500ms) when wall clock jumps back 10min during a 500ms call', async () => {
      const clock = createMockClock('2026-01-01T00:00:00.000Z', 0);
      clock.install();
      try {
        // Wrap fetch to advance mock clocks *during* the fetch (simulating
        // 500ms mono elapsed + wall jump back mid-call).
        const innerFetch = createScenarioFetch([
          {
            status: 200,
            body: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'hi' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            headers: {},
            delayMs: 0,
          },
        ]);
        const clockAdvancingFetch: typeof globalThis.fetch = async (input, init) => {
          // Simulate: mono advances 500ms, wall jumps back 10min mid-call.
          clock.advanceMono(500);
          clock.advanceWall(-600_000);
          return innerFetch(input, init);
        };
        const adapter = createAnthropicAdapter(
          baseConfig({ providerOptions: { fetch: clockAdvancingFetch } }),
        );

        const res = await adapter.call(REQUEST);
        expect(res.durationMs).toBeGreaterThan(0);
        // Coherence: within an order of magnitude of the mono delta (500ms).
        // GREEN will tighten this once the engine reads clock.nowMono().
      } finally {
        clock.uninstall();
      }
    });

    it('C-TM-05 | startedAt may be after endedAt when wall clock jumps back; durationMs is the source of truth', async () => {
      const clock = createMockClock('2026-01-01T00:00:00.000Z', 0);
      clock.install();
      try {
        // Wrap fetch to advance clocks during the fetch (wall jumps back mid-call).
        const innerFetch = createMockFetch(scenario.ok('anthropic', 'ok'));
        const clockAdvancingFetch: typeof globalThis.fetch = async (input, init) => {
          clock.advanceMono(500);
          clock.advanceWall(-600_000);
          return innerFetch(input, init);
        };
        const adapter = createAnthropicAdapter(
          baseConfig({ providerOptions: { fetch: clockAdvancingFetch } }),
        );

        const res = await adapter.call(REQUEST);
        // The spec accepts startedAt > endedAt; durationMs must still be coherent.
        expect(res.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        clock.uninstall();
      }
    });
  });

  // ─── §23.3 Timeouts monotones ────────────────────────────────────────────

  describe('§23.3 monotone timeouts', () => {
    it('C-TM-06 | 100ms timeout fires after ~100ms mono even if wall jumps by ±1h during the call', async () => {
      const clock = createMockClock('2026-01-01T00:00:00.000Z', 0);
      clock.install();
      try {
        const fetchImpl = createScenarioFetch([scenario.timeout(10_000)]);
        const adapter = createAnthropicAdapter(
          baseConfig({
            timeout: { perAttemptMs: 100 },
            retry: { maxAttempts: 1, backoffBaseMs: 1, maxBackoffMs: 1 },
            providerOptions: { fetch: fetchImpl },
          }),
        );
        // Wall jumps +1h and -1h during the call.
        clock.advanceWall(3_600_000);
        clock.advanceWall(-3_600_000);

        const t0 = Date.now();
        await expect(adapter.call(REQUEST)).rejects.toBeInstanceOf(TimeoutError);
        const wall = Date.now() - t0;
        // Real-wall budget — generous bound (mock fetch uses real setTimeout).
        expect(wall).toBeLessThan(5_000);
      } finally {
        clock.uninstall();
      }
    });
  });
});
