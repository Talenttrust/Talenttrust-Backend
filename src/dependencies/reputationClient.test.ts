/**
 * Tests for ReputationClient — retry, circuit breaker, and observability.
 *
 * Covers all 12 required edge cases from the issue spec plus configuration
 * and integration scenarios.
 */

import { ReputationClient, UpstreamUnavailableError, ReputationError, HttpTransport, _resetReputationClientSingleton } from './reputationClient';
import { circuitBreakerRegistry } from '../circuit-breaker/';
import type { ReputationClientConfig } from './reputationConfig';
import { DEFAULT_REPUTATION_CLIENT_CONFIG } from './reputationConfig';

// ── Helpers ──────────────────────────────────────────────────────────────────

const sleepImmediate = () => Promise.resolve();

/** Builds a minimal valid config for testing. */
function testConfig(overrides: Partial<ReputationClientConfig> = {}): ReputationClientConfig {
  return {
    ...DEFAULT_REPUTATION_CLIENT_CONFIG,
    baseUrl: 'http://reputation.test',
    timeoutMs: 500,
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 50,
    cbFailureThreshold: 3,
    cbSuccessThreshold: 1,
    cbTimeoutMs: 500,
    ...overrides,
  };
}

/** Creates a scripted transport that returns/completes in sequence. */
function scriptedTransport(responses: Array<{ status: number; data: unknown } | Error>): HttpTransport {
  let callCount = 0;
  return async () => {
    const entry = responses[callCount++];
    if (!entry) throw new Error('Transport exhausted: no more scripted responses');
    if (entry instanceof Error) throw entry;
    return { status: entry.status, data: entry.data };
  };
}

const sampleProfile = { freelancerId: 'u1', score: 4.5, weightedScore: 4.2, totalRatings: 10, reviews: [] };
const sampleCreated = { id: 'r1', reviewerId: 'rv', targetId: 'tg', rating: 5, createdAt: new Date().toISOString() };

// Reset the singleton + registry between tests.
beforeEach(() => {
  _resetReputationClientSingleton();
  circuitBreakerRegistry.clear();
});

// ── TEST 11 — Normal success ──────────────────────────────────────────────

describe('ReputationClient — normal success', () => {
  it('getProfile returns the upstream profile', async () => {
    const client = new ReputationClient(testConfig(), {
      transport: scriptedTransport([{ status: 200, data: sampleProfile }]),
      sleepFn: sleepImmediate,
    });
    const result = await client.getProfile('u1');
    expect(result).toEqual(sampleProfile);
    expect(client.getBreakerState()).toBe('CLOSED');
  });

  it('listProfiles returns the upstream profiles', async () => {
    const client = new ReputationClient(testConfig(), {
      transport: scriptedTransport([{ status: 200, data: [sampleProfile] }]),
      sleepFn: sleepImmediate,
    });
    const result = await client.listProfiles();
    expect(result).toEqual([sampleProfile]);
  });

  it('createRating returns the created entry', async () => {
    const client = new ReputationClient(testConfig(), {
      transport: scriptedTransport([{ status: 201, data: sampleCreated }]),
      sleepFn: sleepImmediate,
    });
    const result = await client.createRating({ reviewerId: 'rv', targetId: 'tg', rating: 5, contextId: 'ctx' });
    expect(result).toEqual(sampleCreated);
    expect(client.getBreakerState()).toBe('CLOSED');
  });
});

// ── TEST 1 — Transient failure then success ────────────────────────────────

describe('ReputationClient — transient failure then success', () => {
  it('retries on 5xx and eventually succeeds', async () => {
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport: scriptedTransport([
        new ReputationError(503, null, 'down'),
        new ReputationError(502, null, 'gateway'),
        { status: 200, data: sampleProfile },
      ]),
      sleepFn: sleepImmediate,
    });

    const result = await client.getProfile('u1');
    expect(result).toEqual(sampleProfile);
    // Three attempts total: two failures, then success.
    expect(client.getBreakerState()).toBe('CLOSED');
    const stats = client.getBreakerStats();
    expect(stats.failureCount).toBe(0); // successes reset
  });

  it('retries on timeout errors and succeeds', async () => {
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport: scriptedTransport([
        new ReputationError(0, null, 'Request timed out'),
        { status: 200, data: sampleProfile },
      ]),
      sleepFn: sleepImmediate,
    });

    const result = await client.getProfile('u1');
    expect(result).toEqual(sampleProfile);
  });
});

// ── TEST 2 — N consecutive failures opens breaker ──────────────────────────

describe('ReputationClient — consecutive failures open breaker', () => {
  it('trips CLOSED → OPEN after cbFailureThreshold upstream failures', async () => {
    const client = new ReputationClient(testConfig({ cbFailureThreshold: 3, maxAttempts: 1 }), {
      transport: scriptedTransport([
        new ReputationError(503, null, 'fail'),
        new ReputationError(503, null, 'fail'),
        new ReputationError(503, null, 'fail'),
      ]),
      sleepFn: sleepImmediate,
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    expect(client.getBreakerState()).toBe('OPEN');
  });
});

// ── TEST 3 — OPEN circuit fails fast ───────────────────────────────────────

describe('ReputationClient — OPEN fast-fail', () => {
  it('fails immediately without calling upstream when breaker is OPEN', async () => {
    const transport = jest.fn().mockImplementation(async () => {
      return { status: 200, data: sampleProfile };
    });

    const client = new ReputationClient(testConfig({ cbFailureThreshold: 1, maxAttempts: 1 }), {
      transport,
      sleepFn: sleepImmediate,
    });

    // Trip the breaker.
    const failingClient = new ReputationClient(testConfig({ cbFailureThreshold: 1, maxAttempts: 1 }), {
      transport: scriptedTransport([new ReputationError(500, null, 'boom')]),
      sleepFn: sleepImmediate,
    });
    await expect(failingClient.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    // Now the breaker is OPEN — shared via registry.
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(transport).not.toHaveBeenCalled();
  });
});

// ── TEST 4 — Cooldown / HALF_OPEN ──────────────────────────────────────────

describe('ReputationClient — HALF_OPEN recovery', () => {
  it('probe succeeds and closes the circuit after cooldown', async () => {
    jest.useFakeTimers();

    const client = new ReputationClient(
      testConfig({ cbFailureThreshold: 1, cbTimeoutMs: 1_000, maxAttempts: 1 }),
      { transport: scriptedTransport([new ReputationError(503, null, 'fail')]), sleepFn: sleepImmediate },
    );

    // Trip the breaker.
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(client.getBreakerState()).toBe('OPEN');

    // Advance past cooldown.
    await jest.advanceTimersByTimeAsync(1_001);

    // Now HALF_OPEN — replace transport with a success.
    const freshClient = new ReputationClient(
      testConfig({ cbFailureThreshold: 1, cbTimeoutMs: 1_000, maxAttempts: 1 }),
      { transport: scriptedTransport([{ status: 200, data: sampleProfile }]), sleepFn: sleepImmediate },
    );

    // The breaker is shared via registry.
    const result = await freshClient.getProfile('u1');
    expect(result).toEqual(sampleProfile);
    expect(freshClient.getBreakerState()).toBe('CLOSED');

    jest.useRealTimers();
  });

  it('probe fails and reopens', async () => {
    jest.useFakeTimers();

    const cfg = testConfig({ cbFailureThreshold: 1, cbTimeoutMs: 1_000, maxAttempts: 1 });

    // Trip breaker.
    const client1 = new ReputationClient(cfg, {
      transport: scriptedTransport([new ReputationError(500, null, 'fail')]),
      sleepFn: sleepImmediate,
    });
    await expect(client1.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    await jest.advanceTimersByTimeAsync(1_001);

    // Probe fails.
    const client2 = new ReputationClient(cfg, {
      transport: scriptedTransport([new ReputationError(503, null, 'still down')]),
      sleepFn: sleepImmediate,
    });
    await expect(client2.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(client2.getBreakerState()).toBe('OPEN');

    jest.useRealTimers();
  });
});

// ── TEST 5 — Concurrent HALF_OPEN ──────────────────────────────────────────

describe('ReputationClient — concurrent HALF_OPEN probes', () => {
  it('rejects concurrent calls when a probe is in flight', async () => {
    const cfg = testConfig({ cbFailureThreshold: 1, cbTimeoutMs: 0, maxAttempts: 1 });

    // Trip the breaker with an immediate failure.
    const trippingClient = new ReputationClient(cfg, {
      transport: scriptedTransport([new ReputationError(500, null, 'fail')]),
      sleepFn: sleepImmediate,
    });
    await expect(trippingClient.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    const breaker = circuitBreakerRegistry.getOrCreate('reputation');
    // timeout 0 → cooldown already elapsed → HALF_OPEN on next access.
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Start a probe that hangs.
    let resolveProbe!: (v: { status: number; data: unknown }) => void;
    const hangingTransport: HttpTransport = () =>
      new Promise((resolve) => {
        resolveProbe = resolve;
      });

    const client = new ReputationClient(cfg, { transport: hangingTransport, sleepFn: sleepImmediate });
    const probe = client.getProfile('u1');

    // Give the probe a microtask to set probeInFlight.
    await Promise.resolve();

    // Concurrent call fails fast — no second upstream probe.
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    // Complete the probe — circuit closes.
    resolveProbe!({ status: 200, data: sampleProfile });
    await expect(probe).resolves.toEqual(sampleProfile);
    expect(breaker.getState()).toBe('CLOSED');
  });
});

// ── TEST 6 — Non-retryable error ───────────────────────────────────────────

describe('ReputationClient — non-retryable errors', () => {
  it('does not retry on 4xx and preserves original error', async () => {
    // Use a transport that always throws 4xx (not a single-use script).
    const transport = jest.fn().mockRejectedValue(new ReputationError(400, { error: 'bad' }, 'bad request'));
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport,
      sleepFn: sleepImmediate,
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(ReputationError);
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(ReputationError);
    // Called exactly once per operation — no retry on 4xx.
    expect(transport).toHaveBeenCalledTimes(2);
    // Breaker still CLOSED — 4xx does NOT count as a failure.
    expect(client.getBreakerState()).toBe('CLOSED');
  });

  it('does not retry on 422 validation error', async () => {
    const transport = jest.fn().mockRejectedValue(new ReputationError(422, { detail: 'invalid' }, 'invalid'));
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport,
      sleepFn: sleepImmediate,
    });
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(ReputationError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(client.getBreakerState()).toBe('CLOSED');
  });

  it('createRating does not retry on 5xx failure (single attempt)', async () => {
    const transport = jest.fn().mockRejectedValue(new ReputationError(503, null, 'fail'));
    const client = new ReputationClient(testConfig({ maxAttempts: 5 }), {
      transport,
      sleepFn: sleepImmediate,
    });

    await expect(client.createRating({ reviewerId: 'rv', targetId: 'tg', rating: 5, contextId: 'ctx' }))
      .rejects.toBeInstanceOf(ReputationError);
    // Called exactly once — no retry for non-idempotent POST.
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

// ── TEST 7 — Maximum attempt bound ─────────────────────────────────────────

describe('ReputationClient — max attempt bound', () => {
  it('never exceeds configured maxAttempts', async () => {
    const attempts: number[] = [];
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport: async () => {
        attempts.push(1);
        throw new ReputationError(503, null, 'fail');
      },
      sleepFn: sleepImmediate,
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(attempts.length).toBe(3);
  });

  it('does not sleep after the final failed attempt', async () => {
    const sleeps: number[] = [];
    const client = new ReputationClient(testConfig({ maxAttempts: 2 }), {
      transport: async () => { throw new ReputationError(500, null, 'fail'); },
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    // maxAttempts=2 means at most 1 sleep (between attempt 1 and 2).
    expect(sleeps.length).toBeLessThanOrEqual(1);
    // Last delay must be > 0 if it happened.
    if (sleeps.length > 0) expect(sleeps[0]).toBeGreaterThan(0);
  });
});

// ── TEST 8 — Exponential backoff ───────────────────────────────────────────

describe('ReputationClient — exponential backoff + jitter', () => {
  it('delays grow exponentially and are capped at maxDelayMs', async () => {
    const sleeps: number[] = [];
    const client = new ReputationClient(testConfig({
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
    }), {
      transport: async () => { throw new ReputationError(503, null, 'fail'); },
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);

    // 4 sleeps: after attempts 1, 2, 3, 4 (maxAttempts=5, last throws)
    expect(sleeps).toHaveLength(4);

    // Each delay should be within [0.5 * expected, 1.0 * expected].
    for (let i = 0; i < sleeps.length; i++) {
      const expected = Math.min(100 * 2 ** i, 1000);
      const min = expected * 0.5;
      const max = expected;
      expect(sleeps[i]).toBeGreaterThanOrEqual(min);
      expect(sleeps[i]).toBeLessThanOrEqual(max);
    }

    // Delays should be non-decreasing (exponential growth).
    for (let i = 1; i < sleeps.length; i++) {
      // Check growth: each step roughly 2× or capped. Loose check.
      expect(sleeps[i]).toBeGreaterThanOrEqual(sleeps[i - 1] * 0.8);
    }
  });

  it('never exceeds maxDelayMs', async () => {
    const sleeps: number[] = [];
    const client = new ReputationClient(testConfig({ baseDelayMs: 100, maxDelayMs: 150, maxAttempts: 10 }), {
      transport: async () => { throw new ReputationError(503, null, 'fail'); },
      sleepFn: async (ms) => { sleeps.push(ms); },
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    for (const s of sleeps) {
      expect(s).toBeLessThanOrEqual(150);
    }
  });
});

// ── TEST 9 — Successful request resets failures ────────────────────────────

describe('ReputationClient — success resets failure counter', () => {
  it('resets failureCount after a successful call', async () => {
    const client = new ReputationClient(testConfig({ cbFailureThreshold: 5, maxAttempts: 1 }), {
      transport: scriptedTransport([
        new ReputationError(500, null, 'fail'),
        new ReputationError(500, null, 'fail'),
        { status: 200, data: sampleProfile },
      ]),
      sleepFn: sleepImmediate,
    });

    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(client.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(client.getBreakerState()).toBe('CLOSED'); // threshold not reached yet (only 2 failures)

    // Now succeed — resets counter.
    await client.getProfile('u1'); // success
    const stats = client.getBreakerStats();
    expect(stats.failureCount).toBe(0);
    expect(client.getBreakerState()).toBe('CLOSED');
  });
});

// ── TEST 10 — Independent dependency breakers ──────────────────────────────

describe('ReputationClient — independent per-dependency breakers', () => {
  it('a tripped reputation breaker does not affect other dependencies', async () => {
    // Trip the reputation breaker.
    const repClient = new ReputationClient(testConfig({ cbFailureThreshold: 1, maxAttempts: 1 }), {
      transport: scriptedTransport([new ReputationError(500, null, 'fail')]),
      sleepFn: sleepImmediate,
    });
    await expect(repClient.getProfile('u1')).rejects.toBeInstanceOf(UpstreamUnavailableError);
    expect(repClient.getBreakerState()).toBe('OPEN');

    // Create a breaker for a different dependency — must be CLOSED.
    const otherBreaker = circuitBreakerRegistry.getOrCreate('other-dep', {
      failureThreshold: 2, successThreshold: 1, timeout: 10_000,
    });
    expect(otherBreaker.getState()).toBe('CLOSED');

    // The reputation breaker is still OPEN.
    expect(circuitBreakerRegistry.getOrCreate('reputation').getState()).toBe('OPEN');
  });
});

// ── TEST 12 — Integration (factory + registry + real withRetry) ────────────

describe('ReputationClient — integration', () => {
  it('full path: transient failure → retry → success, breaker listable', async () => {
    const client = new ReputationClient(testConfig({ maxAttempts: 3 }), {
      transport: scriptedTransport([
        new ReputationError(503, null, 'transient'),
        { status: 200, data: sampleProfile },
      ]),
      sleepFn: sleepImmediate,
    });

    const result = await client.getProfile('u1');
    expect(result).toEqual(sampleProfile);

    // Breaker appears in the registry.
    const all = circuitBreakerRegistry.getAll();
    const rep = all.find((b) => b.name === 'reputation');
    expect(rep).toBeDefined();
    expect(rep!.state).toBe('CLOSED');
    expect(rep!.failureCount).toBe(0);
  });
});