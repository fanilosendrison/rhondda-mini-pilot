// NIB-M-INFRA-UTILS §3.1 — two-clock abstraction.
// Sole production access point for wall + monotone time (C-IU1).

export interface Clock {
  nowWall(): Date;
  nowWallIso(): string;
  nowMono(): number;
}

export const defaultClock: Clock = {
  nowWall: (): Date => new Date(),
  nowWallIso: (): string => new Date().toISOString(),
  nowMono: (): number => performance.now(),
};
