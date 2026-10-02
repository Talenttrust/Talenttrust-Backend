import {
  AccountLockoutTracker,
  DEFAULT_ACCOUNT_LOCKOUT_CONFIG,
  loadAccountLockoutConfig,
  type AccountLockoutConfig,
} from './accountLockout';

const policy: AccountLockoutConfig = {
  enabled: true,
  maxFailures: 3,
  decayWindowMs: 100,
  lockoutDurationMs: 1000,
  baseDelayMs: 10,
  delayMultiplier: 2,
  maxDelayMs: 100,
};

const trackers: AccountLockoutTracker[] = [];

function fixture(config = policy, start = 1000, log = jest.fn()) {
  let clock = start;
  const now = jest.fn(() => clock);
  const tracker = new AccountLockoutTracker(config, {
    now,
    audit: { log },
    sweepIntervalMs: 0,
  });
  trackers.push(tracker);
  return {
    tracker,
    log,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function lock(tracker: AccountLockoutTracker, email = 'user@example.com') {
  for (let i = 0; i < tracker.config.maxFailures; i += 1)
    tracker.recordFailure(email);
}

afterEach(() => {
  trackers.splice(0).forEach((tracker) => tracker.destroy());
  jest.restoreAllMocks();
});

describe('fixed lock deadlines dominate sliding decay', () => {
  it('keeps live assessment and failures unchanged after the shorter decay window', () => {
    const { tracker, advance, log } = fixture();
    lock(tracker);
    advance(101);
    expect(tracker.assess('user@example.com')).toEqual({
      isLocked: true,
      failures: 3,
      remainingLockoutMs: 899,
      preDelayMs: 100,
    });
    expect(tracker.recordFailure(' USER@example.com ')).toEqual({
      isNowLocked: true,
      failures: 3,
      waitMs: 100,
      triggeredLockout: false,
    });
    expect(tracker.assess('user@example.com').remainingLockoutMs).toBe(899);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('cannot delete an active lock during repeated sweeps or retries', () => {
    const { tracker, advance, log } = fixture();
    lock(tracker);
    advance(101);
    for (let i = 0; i < 20; i += 1) {
      expect(tracker.sweep()).toBe(0);
      expect(tracker.recordFailure('user@example.com').isNowLocked).toBe(true);
    }
    advance(898);
    expect(tracker.assess('user@example.com').remainingLockoutMs).toBe(1);
    expect(tracker.sweep()).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh streak at the exact deadline without renewing the old lock', () => {
    const { tracker, advance, log } = fixture();
    lock(tracker);
    advance(1000);
    expect(tracker.assess('user@example.com').isLocked).toBe(false);
    expect(tracker.recordFailure('user@example.com')).toMatchObject({
      failures: 1,
      triggeredLockout: false,
    });
    tracker.recordFailure('user@example.com');
    expect(tracker.recordFailure('user@example.com').triggeredLockout).toBe(
      true,
    );
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('removes an expired lock at its exact deadline', () => {
    const { tracker, advance } = fixture();
    lock(tracker);
    advance(1000);
    expect(tracker.sweep()).toBe(1);
    expect(tracker.sweep()).toBe(0);
    expect(tracker.size).toBe(0);
  });

  it('decays an unlocked streak created at epoch zero', () => {
    const { tracker, advance } = fixture(policy, 0);
    tracker.recordFailure('user@example.com');
    advance(100);
    expect(tracker.assess('user@example.com').failures).toBe(1);
    advance(1);
    expect(tracker.assess('user@example.com').failures).toBe(0);
    expect(tracker.recordFailure('user@example.com').failures).toBe(1);
  });

  it('reads the clock only once per failure transition', () => {
    const { tracker, now } = fixture();
    now.mockClear();
    tracker.recordFailure('user@example.com');
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('keeps normalized accounts independent during interleaved in-flight attempts', async () => {
    const { tracker, advance, log } = fixture();
    let complete!: () => void;
    const credentialsReady = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const flight = (async () => {
      const before = tracker.assess('user@example.com');
      await credentialsReady;
      return { before, live: tracker.assess('user@example.com') };
    })();
    lock(tracker);
    advance(101);
    tracker.sweep();
    await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        tracker.recordFailure(
          i % 2 ? ' USER@example.com ' : 'user@example.com',
          { ipAddress: `192.0.2.${i}` },
        );
      }),
    );
    tracker.recordFailure('other@example.com');
    complete();
    const result = await flight;
    expect(result.before.isLocked).toBe(false);
    expect(result.live.isLocked).toBe(true);
    expect(tracker.assess('other@example.com').failures).toBe(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('validated policy snapshots and failure recovery', () => {
  it('copies/freezes caller policy and supports whole-policy replacement', () => {
    const supplied = { ...policy };
    const { tracker } = fixture(supplied);
    supplied.maxFailures = 100;
    expect(tracker.config.maxFailures).toBe(3);
    expect(Object.isFrozen(tracker.config)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ACCOUNT_LOCKOUT_CONFIG)).toBe(true);
    expect(() => {
      (tracker.config as AccountLockoutConfig).maxFailures = 100;
    }).toThrow(TypeError);
    tracker.config = { ...tracker.config, maxFailures: 2 };
    tracker.recordFailure('user@example.com');
    expect(tracker.recordFailure('user@example.com').triggeredLockout).toBe(
      true,
    );
  });

  it.each([
    ['enabled', 'yes'],
    ['maxFailures', 0],
    ['maxFailures', NaN],
    ['maxFailures', Infinity],
    ['maxFailures', Number.MAX_SAFE_INTEGER + 1],
    ['maxFailures', 1.5],
    ['decayWindowMs', 0],
    ['lockoutDurationMs', -1],
    ['lockoutDurationMs', 0],
    ['baseDelayMs', -1],
    ['maxDelayMs', 2147483648],
    ['delayMultiplier', 0],
    ['delayMultiplier', 17],
  ])(
    'rejects invalid %s=%s without changing published policy or active state',
    (field, value) => {
      const { tracker } = fixture();
      lock(tracker);
      const original = tracker.config;
      expect(() => {
        tracker.config = { ...policy, [field]: value } as AccountLockoutConfig;
      }).toThrow(RangeError);
      expect(tracker.config).toBe(original);
      expect(tracker.assess('user@example.com').isLocked).toBe(true);
      expect(
        () =>
          new AccountLockoutTracker({
            ...policy,
            [field]: value,
          } as AccountLockoutConfig),
      ).toThrow(RangeError);
    },
  );

  it('locks on the next failure after lowering the threshold below an existing count', () => {
    const { tracker } = fixture({ ...policy, maxFailures: 5 });
    tracker.recordFailure('user@example.com');
    tracker.recordFailure('user@example.com');
    tracker.recordFailure('user@example.com');
    tracker.config = { ...tracker.config, maxFailures: 2 };
    expect(tracker.recordFailure('user@example.com')).toMatchObject({
      failures: 4,
      triggeredLockout: true,
      isNowLocked: true,
    });
  });

  it('does not shorten an existing lock when policy durations are replaced', () => {
    const { tracker, advance } = fixture();
    lock(tracker);
    tracker.config = {
      ...tracker.config,
      lockoutDurationMs: 10,
      decayWindowMs: 1,
    };
    advance(101);
    expect(tracker.sweep()).toBe(0);
    expect(tracker.recordFailure('user@example.com').isNowLocked).toBe(true);
    expect(tracker.assess('user@example.com').remainingLockoutMs).toBe(899);
  });

  it('keeps zero base delay finite even for enormous failure counts', () => {
    const { tracker } = fixture({ ...policy, baseDelayMs: 0 });
    expect(tracker.computeDelay(Number.MAX_SAFE_INTEGER)).toBe(0);
    expect(tracker.computeDelay(NaN)).toBe(0);
    expect(tracker.computeDelay(1.5)).toBe(0);
  });

  it('retains transitions when audit throws without exposing its error payload', () => {
    const sensitive = 'password=secret-user@example.com';
    const log = jest.fn(() => {
      throw new Error(sensitive);
    });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { tracker } = fixture(policy, 1000, log);
    lock(tracker);
    expect(tracker.assess('user@example.com').isLocked).toBe(true);
    expect(tracker.recordFailure('user@example.com').triggeredLockout).toBe(
      false,
    );
    expect(tracker.recordSuccess('user@example.com').releasedLockout).toBe(
      true,
    );
    expect(tracker.recordSuccess('user@example.com').releasedLockout).toBe(
      false,
    );
    expect(error).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain(sensitive);
    expect(tracker.size).toBe(0);
  });

  it('returns its transition snapshot even if the audit sink reenters the tracker', () => {
    const log = jest.fn();
    const { tracker } = fixture({ ...policy, maxFailures: 1 }, 1000, log);
    log.mockImplementationOnce(() => {
      tracker.config = { ...tracker.config, maxDelayMs: 0 };
    });
    expect(tracker.recordFailure('user@example.com')).toEqual({
      failures: 1,
      triggeredLockout: true,
      isNowLocked: true,
      waitMs: 100,
    });
  });
});

describe('environment policy bounds and safe diagnostics', () => {
  const fields = [
    ['AUTH_LOCKOUT_MAX_FAILURES', 'maxFailures'],
    ['AUTH_LOCKOUT_DECAY_WINDOW_MS', 'decayWindowMs'],
    ['AUTH_LOCKOUT_LOCKOUT_DURATION_MS', 'lockoutDurationMs'],
    ['AUTH_LOCKOUT_BASE_DELAY_MS', 'baseDelayMs'],
    ['AUTH_LOCKOUT_DELAY_MULTIPLIER', 'delayMultiplier'],
    ['AUTH_LOCKOUT_MAX_DELAY_MS', 'maxDelayMs'],
  ] as const;

  it.each(fields)(
    'accepts complete integer values for %s',
    (envField, field) => {
      expect(loadAccountLockoutConfig({ [envField]: ' 12 ' })[field]).toBe(12);
    },
  );

  it.each(
    fields.flatMap(([envField, field]) =>
      ['1.5', '1e3', '0x10', '', '-1', '9007199254740992', 'secret-value'].map(
        (value) => ({ envField, field, value }),
      ),
    ),
  )('falls back safely for $envField=$value', ({ envField, field, value }) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadAccountLockoutConfig({ [envField]: value })[field]).toBe(
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG[field],
    );
    expect(warn).toHaveBeenCalledWith(
      `[accountLockout] Invalid ${envField}; using fallback ${DEFAULT_ACCOUNT_LOCKOUT_CONFIG[field]}`,
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-value');
  });

  it('preserves zero padding but rejects zero retention windows and oversized timers', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = loadAccountLockoutConfig({
      AUTH_LOCKOUT_BASE_DELAY_MS: '0',
      AUTH_LOCKOUT_MAX_DELAY_MS: '0',
      AUTH_LOCKOUT_DECAY_WINDOW_MS: '0',
      AUTH_LOCKOUT_LOCKOUT_DURATION_MS: '2147483648',
    });
    expect(parsed.baseDelayMs).toBe(0);
    expect(parsed.maxDelayMs).toBe(0);
    expect(parsed.decayWindowMs).toBe(
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.decayWindowMs,
    );
    expect(parsed.lockoutDurationMs).toBe(
      DEFAULT_ACCOUNT_LOCKOUT_CONFIG.lockoutDurationMs,
    );
  });

  it.each(['true', '1', 'yes', ' TRUE '])('accepts enabled=%s', (value) => {
    expect(
      loadAccountLockoutConfig({ AUTH_LOCKOUT_ENABLED: value }).enabled,
    ).toBe(true);
  });
  it.each(['false', '0', 'no', ' FALSE '])('accepts disabled=%s', (value) => {
    expect(
      loadAccountLockoutConfig({ AUTH_LOCKOUT_ENABLED: value }).enabled,
    ).toBe(false);
  });
  it('warns safely on an invalid master switch and keeps protection enabled', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      loadAccountLockoutConfig({ AUTH_LOCKOUT_ENABLED: 'secret-value' })
        .enabled,
    ).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      '[accountLockout] Invalid AUTH_LOCKOUT_ENABLED; using fallback true',
    );
  });
});
