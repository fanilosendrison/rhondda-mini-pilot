// NIB-T §8 — RED-phase tests for composeSignal + abortableSleep.
// Reference: specs/NIB-T-LLMRUNTIME.md §8 (T-SC-01..T-SC-14 + C-SC-01, C-SC-02 + P-SC-a, P-SC-b).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortableSleep, composeSignal } from '../../src/services/signal-composer.js';
import { createControlledSignal } from '../helpers/mock-signal.js';

describe('signal-composer', () => {
  // ───────────────────────── §8.1 composeSignal acceptance ─────────────────────────
  describe('§8.1 composeSignal acceptance', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('T-SC-01 | undefined external, timeoutMs=100 → aborted after 100ms, reason = timeout', () => {
      const composed = composeSignal(undefined, 100);
      expect(composed.signal.aborted).toEqual(false);
      vi.advanceTimersByTime(100);
      expect(composed.signal.aborted).toEqual(true);
      // reason must be a TimeoutAbortReason indicating timeout.
      const reason = composed.signal.reason;
      expect(reason).toBeDefined();
      expect(String(reason)).toMatch(/timeout/i);
      composed.cleanup();
    });

    it('T-SC-02 | undefined external, timeoutMs=50, wait 30ms → not aborted', () => {
      const composed = composeSignal(undefined, 50);
      vi.advanceTimersByTime(30);
      expect(composed.signal.aborted).toEqual(false);
      composed.cleanup();
    });

    it('T-SC-03 | external aborts immediately → composed aborted in same microtask', async () => {
      const ctrl = createControlledSignal();
      const composed = composeSignal(ctrl.signal, 10000);
      ctrl.abort(new Error('external-reason'));
      // Let microtasks flush.
      await Promise.resolve();
      expect(composed.signal.aborted).toEqual(true);
      expect(composed.signal.reason).toEqual(ctrl.signal.reason);
      composed.cleanup();
    });

    it('T-SC-04 | external abort at 50ms primes over timeoutMs=10000', async () => {
      const ctrl = createControlledSignal();
      const composed = composeSignal(ctrl.signal, 10000);
      // Simulate external abort at ~50ms.
      vi.advanceTimersByTime(50);
      ctrl.abort(new Error('external-at-50'));
      await Promise.resolve();
      expect(composed.signal.aborted).toEqual(true);
      expect(composed.signal.reason).toEqual(ctrl.signal.reason);
      composed.cleanup();
    });

    it('T-SC-05 | external already aborted before composeSignal → composed aborted immediately', () => {
      const ctrl = createControlledSignal();
      ctrl.abort(new Error('pre-aborted'));
      const composed = composeSignal(ctrl.signal, 10000);
      expect(composed.signal.aborted).toEqual(true);
      composed.cleanup();
    });

    it('T-SC-06 | cleanup() releases timer (no leak after 150ms with timeoutMs=10000)', () => {
      const composed = composeSignal(undefined, 10000);
      composed.cleanup();
      // After cleanup, advancing well beyond 150ms shouldn't re-trigger anything.
      vi.advanceTimersByTime(150);
      // Signal may or may not be aborted depending on cleanup semantics; key
      // invariant is no unhandled exception and no pending timers remain.
      expect(vi.getTimerCount()).toEqual(0);
    });
  });

  // ───────────────────────── §8.2 priority external vs timeout ─────────────────────────
  describe('§8.2 priority external vs timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('T-SC-07 | external and timeout abort in same microtask → reason = external', async () => {
      const ctrl = createControlledSignal();
      const composed = composeSignal(ctrl.signal, 100);
      // Abort external BEFORE the timeout timer fires within same tick ordering.
      ctrl.abort(new Error('external'));
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(composed.signal.aborted).toEqual(true);
      expect(composed.signal.reason).toEqual(ctrl.signal.reason);
      composed.cleanup();
    });

    it('T-SC-08 | external abort 1ms before timeout → reason = external', async () => {
      const ctrl = createControlledSignal();
      const composed = composeSignal(ctrl.signal, 100);
      vi.advanceTimersByTime(99);
      ctrl.abort(new Error('external-early'));
      await Promise.resolve();
      vi.advanceTimersByTime(1);
      expect(composed.signal.aborted).toEqual(true);
      expect(composed.signal.reason).toEqual(ctrl.signal.reason);
      composed.cleanup();
    });

    it('T-SC-09 | timeout expires before external abort → reason = timeout (not external)', async () => {
      const ctrl = createControlledSignal();
      const composed = composeSignal(ctrl.signal, 100);
      // Let timeout fire first.
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      expect(composed.signal.aborted).toEqual(true);
      const timeoutReason = composed.signal.reason;
      expect(timeoutReason).toBeDefined();
      // Now abort the external signal AFTER timeout already fired.
      const externalReason = new Error('external-late');
      ctrl.abort(externalReason);
      await Promise.resolve();
      // Composed reason must remain the timeout reason, not the late external.
      expect(composed.signal.reason).toBe(timeoutReason);
      expect(composed.signal.reason).not.toBe(externalReason);
      composed.cleanup();
    });
  });

  // ───────────────────────── §8.3 abortableSleep ─────────────────────────
  describe('§8.3 abortableSleep', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('T-SC-10 | abortableSleep(100, signal) resolves after ~100ms', async () => {
      const ctrl = createControlledSignal();
      const promise = abortableSleep(100, ctrl.signal);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
    });

    it('T-SC-11 | signal already aborted → rejects immediately with signal.reason', async () => {
      const ctrl = createControlledSignal();
      ctrl.abort(new Error('pre-aborted'));
      await expect(abortableSleep(100, ctrl.signal)).rejects.toEqual(ctrl.signal.reason);
    });

    it('T-SC-12 | abort after 50ms during 1000ms sleep → rejects at ~50ms', async () => {
      const ctrl = createControlledSignal();
      const promise = abortableSleep(1000, ctrl.signal);
      vi.advanceTimersByTime(50);
      ctrl.abort(new Error('mid-sleep'));
      await expect(promise).rejects.toEqual(ctrl.signal.reason);
      // No orphan timer.
      expect(vi.getTimerCount()).toEqual(0);
    });

    it('T-SC-13 | abortableSleep(0, signal) resolves immediately', async () => {
      const ctrl = createControlledSignal();
      const promise = abortableSleep(0, ctrl.signal);
      vi.advanceTimersByTime(0);
      await expect(promise).resolves.toBeUndefined();
    });

    it('T-SC-14 | abort after normal resolution → promise stays resolved', async () => {
      const ctrl = createControlledSignal();
      const promise = abortableSleep(50, ctrl.signal);
      vi.advanceTimersByTime(50);
      await expect(promise).resolves.toBeUndefined();
      // Abort after resolution must not cause an unhandled rejection.
      ctrl.abort(new Error('late-abort'));
      // Await again to confirm stable resolution.
      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ───────────────────────── §8.4 contract invariants ─────────────────────────
  describe('§8.4 contract invariants', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('C-SC-01 | setTimeout cleared on abort — no pending timers after abort', async () => {
      const ctrl = createControlledSignal();
      const promise = abortableSleep(5000, ctrl.signal);
      ctrl.abort(new Error('abort'));
      await expect(promise).rejects.toBeDefined();
      expect(vi.getTimerCount()).toEqual(0);
    });

    it('C-SC-02 | abortableSleep rejects with signal.reason (no raw DOMException surfacing rule at engine level)', async () => {
      const ctrl = createControlledSignal();
      const reason = new Error('my-reason');
      ctrl.abort(reason);
      // NOTE: §8.4 C-SC-02 — reclassement en AbortedError est testé au niveau
      // engine (§18). Ici, on vérifie simplement la reject-avec-reason.
      await expect(abortableSleep(100, ctrl.signal)).rejects.toEqual(reason);
    });
  });

  // ───────────────────────── §8.5 properties ─────────────────────────
  describe('§8.5 properties', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('P-SC-a | pre-aborted signal ⇒ abortableSleep rejects synchronously (no wait)', async () => {
      const ctrl = createControlledSignal();
      ctrl.abort(new Error('pre'));
      const promise = abortableSleep(100000, ctrl.signal);
      // No timer advancement.
      await expect(promise).rejects.toBeDefined();
    });

    it('P-SC-b | composeSignal(undefined, ms>0) never throws on construction', () => {
      expect(() => {
        const c = composeSignal(undefined, 1);
        c.cleanup();
      }).not.toThrow();
      expect(() => {
        const c = composeSignal(undefined, 1000);
        c.cleanup();
      }).not.toThrow();
      expect(() => {
        const c = composeSignal(undefined, 60000);
        c.cleanup();
      }).not.toThrow();
    });
  });
});
