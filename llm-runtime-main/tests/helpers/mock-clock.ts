// NIB-T §27.2 — controllable wall + monotone clocks for deterministic tests.
// Test-time utility (not production code).
//
// Install/uninstall pattern:
//   The `install()` helper writes the current mock into `mockClockRegistry.current`,
//   which the test file wires into `src/infra/clock.js` via `vi.doMock` at the top
//   of the test, e.g.:
//
//     import { mockClockRegistry } from '../helpers/mock-clock.js';
//     vi.doMock('../../src/infra/clock.js', () => ({
//       defaultClock: {
//         nowWall: () => mockClockRegistry.current?.nowWall() ?? new Date(),
//         nowWallIso: () => mockClockRegistry.current?.nowWallIso() ?? new Date().toISOString(),
//         nowMono: () => mockClockRegistry.current?.nowMono() ?? performance.now(),
//       },
//     }));
//
// This keeps the helper free of dynamic `vi.mock` calls (which are hoisted and
// awkward to parameterize from within a helper).

export interface MockClock {
  setWall(isoOrDate: string | Date): void;
  setMono(ms: number): void;
  advanceMono(ms: number): void;
  advanceWall(ms: number): void;
  nowWall(): Date;
  nowWallIso(): string;
  nowMono(): number;
  /** Register this clock in mockClockRegistry. If vi.doMock is not wired,
   *  the engine will silently use the real defaultClock. Use assertWired()
   *  after install to validate. */
  install(): void;
  uninstall(): void;
  /** Returns true if mockClockRegistry.current === this clock. */
  isInstalled(): boolean;
}

interface MockClockRegistry {
  current: MockClock | undefined;
}

export const mockClockRegistry: MockClockRegistry = {
  current: undefined,
};

export function createMockClock(initialWall?: string, initialMono?: number): MockClock {
  const wallInit = initialWall !== undefined ? new Date(initialWall).getTime() : 0;
  if (Number.isNaN(wallInit)) {
    throw new Error(`createMockClock: invalid initialWall "${initialWall}" produces NaN`);
  }
  let wallMs: number = wallInit;
  let monoMs: number = initialMono ?? 0;

  const clock: MockClock = {
    setWall(isoOrDate: string | Date): void {
      const t = isoOrDate instanceof Date ? isoOrDate.getTime() : new Date(isoOrDate).getTime();
      if (Number.isNaN(t)) {
        throw new Error(`mockClock.setWall: invalid date "${String(isoOrDate)}" produces NaN`);
      }
      wallMs = t;
    },
    setMono(ms: number): void {
      monoMs = ms;
    },
    advanceMono(ms: number): void {
      monoMs += ms;
    },
    advanceWall(ms: number): void {
      wallMs += ms;
    },
    nowWall(): Date {
      return new Date(wallMs);
    },
    nowWallIso(): string {
      return new Date(wallMs).toISOString();
    },
    nowMono(): number {
      return monoMs;
    },
    install(): void {
      if (mockClockRegistry.current !== undefined && mockClockRegistry.current !== clock) {
        throw new Error(
          'mockClock.install(): another mock clock is already installed. ' +
            'Call uninstall() on the previous clock first.',
        );
      }
      mockClockRegistry.current = clock;
    },
    uninstall(): void {
      if (mockClockRegistry.current === clock) {
        mockClockRegistry.current = undefined;
      }
    },
    isInstalled(): boolean {
      return mockClockRegistry.current === clock;
    },
  };

  return clock;
}
