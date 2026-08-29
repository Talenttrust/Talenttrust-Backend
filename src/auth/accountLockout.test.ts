/**
 * @file accountLockout.test.ts
 * @description
 * Unit tests for `AccountLockoutTracker` (issue #631).
 *
 * The tracker is the heart of the per-account lockout policy on
 * `POST /auth/login`. Because the timing for this state machine is
 * inherently time-dependent, all tests inject a fake clock (`now`)
 * and a captured `sleep` so we can assert on delay values without
 * actually waiting on real timers. The audit sink is a mock that
 * records every entry it receives (`auditCalls`) so we can assert
 * per-case that:
 *
 *   - exactly one `AUTH_LOCKOUT_TRIGGERED` fires per streak
 *     (the strict-equality guarantee)
 *   - `AUTH_LOCKOUT_RELEASED` fires once on the FIRST successful
 *     login after a streak that included a lockout
 *   - no audit entries fire on success without a prior lockout
 *     (auth middleware still emits its own `AUTH_LOGIN` entry)
 *   - audit sink failures do not break the state transitions
 *
 * Coverage goals: ≥ 95% statements/branches/functions/lines for
 * `src/auth/accountLockout.ts`. Reviewer note: the env-loading
 * helpers (`toBool`, `toCount`, `toMs`, `loadAccountLockoutConfig`)
 * are exercised indirectly via the tracker; they are not
 * re-tested here so the suite stays focused on the state machine.
 */

import {
  AccountLockoutTracker,
  DEFAULT_ACCOUNT_LOCKOUT_CONFIG,
} from './accountLockout';

// ── Test fixtures ────────────────────────────────────────────────────────────

const FAST_CONFIG = {
  enabled: true,
  maxFailures: 5,
  decayWindowMs: 60_000,
  lockoutDurationMs: 30_000,
  baseDelayMs: 250,
  delayMultiplier: 2,
  maxDelayMs: 5000,
};

const TINY_CONFIG = {
  enabled: true,
  maxFailures: 3,
  decayWindowMs: 1000,
  lockoutDurationMs: 500,
  baseDelayMs: 10,
  delayMultiplier: 2,
  maxDelayMs: 50,
};

interface AuditCall {
  action: string;
  severity: string;
  actor: string;
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  correlationId?: string;
}

function makeTracker(
  config = FAST_CONFIG,
  options: {
    audit?: 'mock' | 'throwing';
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const auditCalls: AuditCall[] = [];
  const audit =
    options.audit === 'throwing'
      ? {
          log: jest.fn(() => {
            throw new Error('audit store offline');
          }),
        }
      : {
          log: jest.fn((input: AuditCall) => {
            auditCalls.push(input);
            return input as unknown as ReturnType<typeof auditService.log>;
          }),
        };

  let clockMs = 1_700_000_000_000;
  const now = options.now ?? (() => clockMs);
  const sleep = options.sleep ?? jest.fn(async () => {});
  const advance = (ms: number) => {
    clockMs += ms;
  };

  const tracker = new AccountLockoutTracker(config, { audit, now, sleep });

  return {
    tracker,
    auditCalls,
    logSpy: audit.log,
    now: now as () => number,
    sleep: sleep as jest.Mock,
    advance,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AccountLockoutTracker — config & initial state', () => {
  it('default config preserves the documented defaults', () => {
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.maxFailures).toBe(5);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.decayWindowMs).toBe(15 * 60 * 1000);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.lockoutDurationMs).toBe(15 * 60 * 1000);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.baseDelayMs).toBe(250);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.delayMultiplier).toBe(2);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.maxDelayMs).toBe(5000);
    expect(DEFAULT_ACCOUNT_LOCKOUT_CONFIG.enabled).toBe(true);
  });

  it('computes the progressive delay curve correctly', () => {
    const { tracker } = makeTracker();
    // 0 -> 0; 1 -> 250; 2 -> 500; 3 -> 1000; 4 -> 2000; 5 -> 4000; 6 -> 5000 (capped)
    expect(tracker.computeDelay(0)).toBe(0);
    expect(tracker.computeDelay(1)).toBe(250);
    expect(tracker.computeDelay(2)).toBe(500);
    expect(tracker.computeDelay(3)).toBe(1000);
    expect(tracker.computeDelay(4)).toBe(2000);
    expect(tracker.computeDelay(5)).toBe(4000);
    expect(tracker.computeDelay(6)).toBe(5000); // capped
    expect(tracker.computeDelay(20)).toBe(5000); // still capped
  });

  it('treats disabled trackers as a no-op', () => {
    // Spread FAST_CONFIG first so the explicit `enabled: false` overrides
    // it last (object spread order matters).
    const { tracker, auditCalls, sleep } = makeTracker({ ...FAST_CONFIG, enabled: false });

    expect(tracker.assess('a@example.com')).toEqual({
      isLocked: false,
      failures: 0,
      remainingLockoutMs: 0,
      preDelayMs: 0,
    });

    const failResult = tracker.recordFailure('a@example.com');
    expect(failResult).toEqual({
      isNowLocked: false,
      failures: 0,
      waitMs: 0,
      triggeredLockout: false,
    });

    const okResult = tracker.recordSuccess('a@example.com');
    expect(okResult.releasedLockout).toBe(false);

    expect(auditCalls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(tracker.size).toBe(0);
  });
});

describe('AccountLockoutTracker — assess (read-only)', () => {
  it('returns zero-assessment for an unknown identity', () => {
    const { tracker } = makeTracker();
    expect(tracker.assess('unknown@example.com')).toEqual({
      isLocked: false,
      failures: 0,
      remainingLockoutMs: 0,
      preDelayMs: 0,
    });
  });

  it('returns the live failure count after one recordFailure', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('a@example.com');
    const assessment = tracker.assess('a@example.com');
    expect(assessment.isLocked).toBe(false);
    expect(assessment.failures).toBe(1);
    expect(assessment.preDelayMs).toBe(250);
    expect(assessment.remainingLockoutMs).toBe(0);
  });

  it('reports isLocked=true with remainingLockoutMs after triggering', () => {
    const { tracker } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    const assessment = tracker.assess('a@example.com');
    expect(assessment.isLocked).toBe(true);
    expect(assessment.failures).toBe(5);
    expect(assessment.remainingLockoutMs).toBeGreaterThan(0);
    expect(assessment.remainingLockoutMs).toBeLessThanOrEqual(30_000);
    expect(assessment.preDelayMs).toBe(5000); // max delay when locked
  });

  it('resets assessment state once the lockout has expired', () => {
    const { tracker, advance } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(tracker.assess('a@example.com').isLocked).toBe(true);

    advance(FAST_CONFIG.lockoutDurationMs + 1);
    const after = tracker.assess('a@example.com');
    expect(after.isLocked).toBe(false);
    expect(after.failures).toBe(0);
    expect(after.remainingLockoutMs).toBe(0);
    expect(after.preDelayMs).toBe(0);
  });

  it('aggregates case-variant and whitespace variants of the same identity', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('Alice@Example.COM');
    expect(tracker.assess('alice@example.com').failures).toBe(1);
    expect(tracker.assess('  ALICE@example.com  ').failures).toBe(1);
  });
});

describe('AccountLockoutTracker — recordFailure (state mutation)', () => {
  it('increments failures and creates the record on the first call', () => {
    const { tracker } = makeTracker();
    const r = tracker.recordFailure('a@example.com');
    expect(r.failures).toBe(1);
    expect(r.waitMs).toBe(250);
    expect(r.isNowLocked).toBe(false);
    expect(r.triggeredLockout).toBe(false);
    expect(tracker.size).toBe(1);
  });

  it('returns progressive waitMs until the threshold', () => {
    const { tracker } = makeTracker();
    expect(tracker.recordFailure('a@example.com').waitMs).toBe(250);
    expect(tracker.recordFailure('a@example.com').waitMs).toBe(500);
    expect(tracker.recordFailure('a@example.com').waitMs).toBe(1000);
    expect(tracker.recordFailure('a@example.com').waitMs).toBe(2000);
  });

  it('fires the trigger audit exactly once on the threshold-crossing attempt', () => {
    const { tracker, auditCalls } = makeTracker();

    for (let i = 0; i < 4; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(auditCalls).toHaveLength(0);

    const fifth = tracker.recordFailure('a@example.com');
    expect(fifth.failures).toBe(5);
    expect(fifth.triggeredLockout).toBe(true);
    expect(fifth.waitMs).toBe(FAST_CONFIG.maxDelayMs);
    expect(fifth.isNowLocked).toBe(true);

    const triggers = auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({
      action: 'AUTH_LOCKOUT_TRIGGERED',
      severity: 'WARNING',
      actor: 'a@example.com',
      resource: 'auth',
      resourceId: 'a@example.com',
      metadata: expect.objectContaining({
        failures: 5,
        decayWindowMs: FAST_CONFIG.decayWindowMs,
        lockoutDurationMs: FAST_CONFIG.lockoutDurationMs,
        reason: 'consecutive_failures',
      }),
    });
    expect(typeof (triggers[0].metadata.lockedUntilIso as string)).toBe('string');
    expect((triggers[0].metadata.lockedUntilIso as string).length).toBeGreaterThan(0);
  });

  it('does NOT emit additional trigger audits for failures during the lockout window', () => {
    const { tracker, auditCalls } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED')).toHaveLength(1);

    // 20 more attempts during the lockout window — none should re-trigger.
    for (let i = 0; i < 20; i += 1) {
      const r = tracker.recordFailure('a@example.com');
      expect(r.triggeredLockout).toBe(false);
      expect(r.isNowLocked).toBe(true);
      expect(r.waitMs).toBe(FAST_CONFIG.maxDelayMs);
    }
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED')).toHaveLength(1);
  });

  it('captures request context (ipAddress/correlationId) in the trigger audit', () => {
    const { tracker, auditCalls } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com', {
        ipAddress: '203.0.113.42',
        correlationId: 'corr-123',
      });
    }
    const trigger = auditCalls.find((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED')!;
    expect(trigger.ipAddress).toBe('203.0.113.42');
    expect(trigger.correlationId).toBe('corr-123');
  });
});

describe('AccountLockoutTracker — recordSuccess (release audit)', () => {
  it('is a no-op when there is no prior failure history', () => {
    const { tracker, auditCalls } = makeTracker();
    const r = tracker.recordSuccess('a@example.com');
    expect(r.releasedLockout).toBe(false);
    expect(r.previousFailures).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('clears the counter on a non-locked success (no release audit)', () => {
    const { tracker, auditCalls, sleep: _sleepUnused } = makeTracker();
    void _sleepUnused;
    tracker.recordFailure('a@example.com');
    tracker.recordFailure('a@example.com');

    const r = tracker.recordSuccess('a@example.com');
    expect(r.releasedLockout).toBe(false);
    expect(r.previousFailures).toBe(2);
    expect(tracker.size).toBe(0);
    expect(tracker.assess('a@example.com').failures).toBe(0);
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_RELEASED')).toHaveLength(0);
  });

  it('emits exactly one AUTH_LOCKOUT_RELEASED after a locked streak', () => {
    const { tracker, auditCalls } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    const r = tracker.recordSuccess('a@example.com');
    expect(r.releasedLockout).toBe(true);
    expect(r.previousFailures).toBe(5);

    const release = auditCalls.find((c) => c.action === 'AUTH_LOCKOUT_RELEASED');
    expect(release).toBeDefined();
    expect(release).toMatchObject({
      action: 'AUTH_LOCKOUT_RELEASED',
      severity: 'INFO',
      actor: 'a@example.com',
      resource: 'auth',
      resourceId: 'a@example.com',
      metadata: expect.objectContaining({
        previousFailures: 5,
        lockoutDurationMs: FAST_CONFIG.lockoutDurationMs,
        reason: 'successful_login',
      }),
    });
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_RELEASED')).toHaveLength(1);
  });

  it('emits the release audit even when the lockout has already expired', () => {
    const { tracker, auditCalls, advance } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    advance(FAST_CONFIG.lockoutDurationMs + 1);
    const r = tracker.recordSuccess('a@example.com');
    expect(r.releasedLockout).toBe(true);
    expect(r.previousFailures).toBe(5);
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_RELEASED')).toHaveLength(1);
  });

  it('does NOT emit a stale release audit for a fresh failure that has fully decayed', () => {
    const { tracker, auditCalls, advance } = makeTracker();
    tracker.recordFailure('a@example.com');
    advance(FAST_CONFIG.decayWindowMs + 1);
    // The record has decayed out of existence — no lockout, no release.
    const r = tracker.recordSuccess('a@example.com');
    expect(r.releasedLockout).toBe(false);
    expect(auditCalls).toHaveLength(0);
  });
});

describe('AccountLockoutTracker — decay semantics', () => {
  it('resets counter when the decay window has elapsed since the last failure', () => {
    const { tracker, advance } = makeTracker();
    tracker.recordFailure('a@example.com'); // failures=1
    tracker.recordFailure('a@example.com'); // failures=2
    expect(tracker.assess('a@example.com').failures).toBe(2);

    advance(FAST_CONFIG.decayWindowMs + 10);
    expect(tracker.assess('a@example.com').failures).toBe(0);
    expect(tracker.assess('a@example.com').preDelayMs).toBe(0);
  });

  it('extends the decay window with each new failure (sliding semantics)', () => {
    const { tracker, advance } = makeTracker();
    for (let i = 0; i < 3; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    // Advance just under the decay window — still alive.
    advance(FAST_CONFIG.decayWindowMs - 1000);
    expect(tracker.assess('a@example.com').failures).toBe(3);

    tracker.recordFailure('a@example.com'); // refreshes lastFailureAt
    expect(tracker.assess('a@example.com').failures).toBe(4);

    // Advance another near-decay window — still alive because last failure was just now.
    advance(FAST_CONFIG.decayWindowMs - 1000);
    expect(tracker.assess('a@example.com').failures).toBe(4);
  });

  it('locks out from a fresh streak once the lockout expires (not the previous failure count)', () => {
    const { tracker, auditCalls, advance } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED')).toHaveLength(1);

    // Lockout elapses — full reset; new strikes should re-count from zero.
    advance(FAST_CONFIG.lockoutDurationMs + 1);

    for (let i = 0; i < 4; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    // Skipped to 5 from fresh; should trigger again.
    const fifth = tracker.recordFailure('a@example.com');
    expect(fifth.triggeredLockout).toBe(true);
    expect(
      auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED'),
    ).toHaveLength(2);
  });
});

describe('AccountLockoutTracker — identity normalization', () => {
  it('normalizes identities so whitespace variants collide', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('  alice@example.com  ');
    expect(tracker.size).toBe(1);
    tracker.recordFailure('alice@example.com');
    expect(tracker.assess('alice@example.com').failures).toBe(2);
  });

  it('normalizes identities so case variants collide', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('Alice@Example.COM');
    tracker.recordFailure('alice@example.com');
    tracker.recordFailure('ALICE@EXAMPLE.com');
    expect(tracker.assess('ALICE@EXAMPLE.com').failures).toBe(3);
  });

  it('does not create a record for an empty-after-trim identity', () => {
    const { tracker, auditCalls } = makeTracker();
    const r = tracker.recordFailure('   ');
    expect(r.failures).toBe(0);
    expect(r.waitMs).toBe(0);
    expect(tracker.size).toBe(0);
    expect(auditCalls).toHaveLength(0);
  });

  it('does not create a record for the empty string', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('');
    expect(tracker.size).toBe(0);
  });
});

describe('AccountLockoutTracker — sweep GC and lifecycle', () => {
  it('removes records whose lockout has expired', () => {
    const { tracker, advance } = makeTracker();
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(tracker.size).toBe(1);
    advance(FAST_CONFIG.lockoutDurationMs + 1);
    // Manually sweep — and immediately succeed so the record is gone.
    const removed = tracker.sweep();
    expect(removed).toBe(1);
    expect(tracker.size).toBe(0);
  });

  it('removes records past the decay window (non-locked)', () => {
    const { tracker, advance } = makeTracker();
    tracker.recordFailure('a@example.com');
    tracker.recordFailure('a@example.com');
    expect(tracker.size).toBe(1);
    advance(FAST_CONFIG.decayWindowMs + 1);
    const removed = tracker.sweep();
    expect(removed).toBe(1);
    expect(tracker.size).toBe(0);
  });

  it('keeps records that have NOT yet decayed', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('a@example.com');
    tracker.recordFailure('a@example.com');
    expect(tracker.sweep()).toBe(0);
    expect(tracker.size).toBe(1);
  });

  it('reset() clears all records without stopping the sweep timer', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('a@example.com');
    tracker.recordFailure('b@example.com');
    expect(tracker.size).toBe(2);
    tracker.reset();
    expect(tracker.size).toBe(0);
  });

  it('destroy() clears records and stops the sweep timer', () => {
    const { tracker } = makeTracker();
    tracker.recordFailure('a@example.com');
    tracker.destroy();
    expect(tracker.size).toBe(0);
  });
});

describe('AccountLockoutTracker — audit sink resilience', () => {
  it('does not throw when the audit sink throws on trigger emit', () => {
    const { tracker } = makeTracker(FAST_CONFIG, { audit: 'throwing' });
    // Suppress the console noise from the audit-failure logger so the
    // test output stays readable.
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      for (let i = 0; i < 5; i += 1) {
        tracker.recordFailure('a@example.com');
      }
    }).not.toThrow();
    consoleSpy.mockRestore();
  });

  it('does not throw when the audit sink throws on release emit', () => {
    const { tracker } = makeTracker(FAST_CONFIG, { audit: 'throwing' });
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 5; i += 1) {
      tracker.recordFailure('a@example.com');
    }
    expect(() => tracker.recordSuccess('a@example.com')).not.toThrow();
    consoleSpy.mockRestore();
  });
});

describe('AccountLockoutTracker — tiny config quick smoke', () => {
  it('with tiny config, 3 failures trigger and release on success', () => {
    const { tracker, auditCalls, advance } = makeTracker(TINY_CONFIG);
    tracker.recordFailure('a@example.com');
    tracker.recordFailure('a@example.com');
    const third = tracker.recordFailure('a@example.com');
    expect(third.triggeredLockout).toBe(true);
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_TRIGGERED')).toHaveLength(1);

    advance(TINY_CONFIG.lockoutDurationMs + 1);
    tracker.recordSuccess('a@example.com');
    expect(auditCalls.filter((c) => c.action === 'AUTH_LOCKOUT_RELEASED')).toHaveLength(1);
  });
});
