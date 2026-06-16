// NIB-M-THROTTLE — pure throttle decision + canonical rate-limit snapshot shape.

export type RateLimitSnapshotState = 'known' | 'unknown' | 'partial';

export interface RateLimitSnapshot {
  readonly remainingTokens: number;
  readonly resetTokensAt: number;
  readonly lastCallOutputTokens: number;
  readonly state: RateLimitSnapshotState;
}

export type ThrottleDecisionReason =
  | 'no_snapshot'
  | 'snapshot_unknown_quality'
  | 'budget_sufficient'
  | 'window_already_reset'
  | 'budget_insufficient';

export type ThrottleDecision =
  | { readonly throttle: false; readonly reason: ThrottleDecisionReason }
  | { readonly throttle: true; readonly waitMs: number; readonly reason: ThrottleDecisionReason };

export function resolveThrottleDecision(
  snapshot: RateLimitSnapshot | null,
  estimatedNextCallTokens: number,
  nowMs: number,
): ThrottleDecision {
  if (snapshot === null) {
    return { throttle: false, reason: 'no_snapshot' };
  }
  if (snapshot.state === 'unknown') {
    return { throttle: false, reason: 'snapshot_unknown_quality' };
  }
  if (snapshot.remainingTokens >= estimatedNextCallTokens) {
    return { throttle: false, reason: 'budget_sufficient' };
  }
  if (snapshot.resetTokensAt <= nowMs) {
    return { throttle: false, reason: 'window_already_reset' };
  }
  return {
    throttle: true,
    waitMs: snapshot.resetTokensAt - nowMs,
    reason: 'budget_insufficient',
  };
}
