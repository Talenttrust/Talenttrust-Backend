import { describe, expect, it } from 'vitest';
import { AccountLockoutTracker } from './accountLockout';

describe('AccountLockoutTracker boundaries', () => {
  it('locks exactly at the configured failure threshold and does not extend it', () => {
    let now = 0;
    const tracker = new AccountLockoutTracker({ enabled: true, maxFailures: 2, decayWindowMs: 1000, lockoutDurationMs: 5000, baseDelayMs: 1, delayMultiplier: 2, maxDelayMs: 8 }, { now: () => now, sleep: async () => {}, sweepIntervalMs: 0, audit: { log: () => undefined as any } });
    expect(tracker.recordFailure('User@Example.com').triggeredLockout).toBe(false);
    const locked = tracker.recordFailure(' user@example.com ');
    expect(locked.triggeredLockout).toBe(true);
    now = 100;
    expect(tracker.recordFailure('USER@example.com').triggeredLockout).toBe(false);
    expect(tracker.assess('user@example.com').isLocked).toBe(true);
  });
});
