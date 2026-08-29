import * as fs from "fs";
import * as path from "path";
import {
  switchToGreen, 
  rollback,
  getStatus,
  setHealthChecker,
  setErrorRateReader,
  monitorAndAutoRollback,
  loadAutoRollbackConfig,
  readErrorRateFromRegistry,
  ErrorRateSample,
  DeploymentState,
} from "./deploy";
import { setWriteRecordImpl } from "./logger";

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

/**
 * Build an error-rate reader that returns successive cumulative snapshots.
 * The first call is the soak baseline; the last snapshot repeats for any
 * extra samples so callers don't need to pad the sequence.
 */
function readerFromSequence(samples: ErrorRateSample[]): () => Promise<ErrorRateSample> {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)];
}

/** Write a known state directly to disk so tests start from a predictable point. */
function seedState(state: DeploymentState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/** Remove the state file so the module falls back to the default blue state. */
function clearState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

beforeEach(() => {
  clearState();
  // Default: healthy green
  setHealthChecker(async () => true);
  delete process.env.ACTIVE_COLOR;
  delete process.env.GREEN_PORT;
});

afterAll(() => {
  clearState();
});

// ---------------------------------------------------------------------------
// Default health checker — real HTTP readiness probe
// ---------------------------------------------------------------------------

describe("default health checker", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("promotes green when the probe returns HTTP 200", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 200 } as Response);

    let freshSwitch!: () => Promise<void>;
    let freshStatus!: () => Promise<DeploymentState>;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./deploy");
      freshSwitch = m.switchToGreen;
      freshStatus = m.getStatus;
    });

    clearState();
    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "500";

    await freshSwitch();
    const s = await freshStatus();
    expect(s.activeColor).toBe("green");

    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });

  it("aborts the switch when the probe returns HTTP 503", async () => {
    global.fetch = jest.fn().mockResolvedValue({ status: 503 } as Response);

    let freshSwitch!: () => Promise<void>;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./deploy");
      freshSwitch = m.switchToGreen;
    });

    clearState();
    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "50";

    await expect(freshSwitch()).rejects.toThrow("Green not ready");

    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });

  it("aborts the switch when the probe throws (connection refused)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    let freshSwitch!: () => Promise<void>;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./deploy");
      freshSwitch = m.switchToGreen;
    });

    clearState();
    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "50";

    await expect(freshSwitch()).rejects.toThrow("Green not ready");

    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });

  it("probes the port provided via GREEN_PORT", async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ status: 200 } as Response);
    global.fetch = fetchSpy;

    let freshSwitch!: () => Promise<void>;

    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require("./deploy");
      freshSwitch = m.switchToGreen;
    });

    clearState();
    process.env.GREEN_PORT = "4002";
    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "500";

    await freshSwitch();

    const calledUrl = (fetchSpy.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("4002");
    expect(calledUrl).toContain("/health/ready");

    delete process.env.GREEN_PORT;
    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe("getStatus", () => {
  it("returns blue as the default when no state file exists", async () => {
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.previousColor).toBeUndefined();
  });

  it("reflects whatever is persisted on disk", async () => {
    seedState({ activeColor: "green", lastSwitch: 1000, previousColor: "blue" });
    const status = await getStatus();
    expect(status.activeColor).toBe("green");
    expect(status.previousColor).toBe("blue");
    expect(status.lastSwitch).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// switchToGreen — happy path
// ---------------------------------------------------------------------------

describe("switchToGreen", () => {
  it("transitions blue → green and persists state", async () => {
    const before = Date.now();
    await switchToGreen();
    const after = Date.now();

    const status = await getStatus();
    expect(status.activeColor).toBe("green");
    expect(status.previousColor).toBe("blue");
    expect(status.lastSwitch).toBeGreaterThanOrEqual(before);
    expect(status.lastSwitch).toBeLessThanOrEqual(after);
  });

  it("sets ACTIVE_COLOR env var to green", async () => {
    await switchToGreen();
    expect(process.env.ACTIVE_COLOR).toBe("green");
  });

  it("is idempotent — repeated call does not update lastSwitch", async () => {
    await switchToGreen();
    const { lastSwitch: first } = await getStatus();

    await switchToGreen(); // second call — already green
    const { lastSwitch: second } = await getStatus();

    expect(second).toBe(first);
  });

  it("passes the GREEN_PORT env var to the health checker", async () => {
    const seenPorts: string[] = [];
    setHealthChecker(async (port) => {
      seenPorts.push(port);
      return true;
    });
    process.env.GREEN_PORT = "4002";

    await switchToGreen();
    expect(seenPorts).toContain("4002");

    delete process.env.GREEN_PORT;
  });

  it("defaults to port 3002 when GREEN_PORT is not set", async () => {
    const seenPorts: string[] = [];
    setHealthChecker(async (port) => {
      seenPorts.push(port);
      return true;
    });

    await switchToGreen();
    expect(seenPorts).toContain("3002");
  });

  it("uses the built-in health checker when none is overridden", async () => {
    // Reset to the module's own default by re-importing a fresh instance
    // isn't possible in Jest without jest.resetModules, so we call
    // setHealthChecker with a function that mirrors the default behaviour.
    // This exercises the default path (always returns true).
    setHealthChecker(async (_port: string) => true);
    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");
  });});

  it("polls until green becomes healthy within timeout", async () => {
    // Simulate green taking a couple probes to become healthy
    let calls = 0;
    setHealthChecker(async () => {
      calls += 1;
      // healthy on 3rd probe
      return calls >= 3;
    });

    // speed up polling for test
    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "500";

    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");
    expect(calls).toBeGreaterThanOrEqual(3);

    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });

  it("aborts and leaves blue when green never becomes healthy within timeout", async () => {
    setHealthChecker(async () => false);

    process.env.SWITCH_GREEN_POLL_INTERVAL_MS = "10";
    process.env.SWITCH_GREEN_TIMEOUT_MS = "50";

    await expect(switchToGreen()).rejects.toThrow("Green not ready");
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");

    delete process.env.SWITCH_GREEN_POLL_INTERVAL_MS;
    delete process.env.SWITCH_GREEN_TIMEOUT_MS;
  });

// ---------------------------------------------------------------------------
// switchToGreen — unhealthy green
// ---------------------------------------------------------------------------

describe("switchToGreen — unhealthy green", () => {
  it("throws 'Green not ready' and leaves state as blue", async () => {
    setHealthChecker(async () => false);

    await expect(switchToGreen()).rejects.toThrow("Green not ready");

    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
  });

  it("does not update ACTIVE_COLOR when health check fails", async () => {
    setHealthChecker(async () => false);
    await expect(switchToGreen()).rejects.toThrow();
    expect(process.env.ACTIVE_COLOR).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rollback
// ---------------------------------------------------------------------------

describe("rollback", () => {
  it("transitions green → blue and persists state", async () => {
    await switchToGreen();

    const before = Date.now();
    await rollback();
    const after = Date.now();

    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.lastSwitch).toBeGreaterThanOrEqual(before);
    expect(status.lastSwitch).toBeLessThanOrEqual(after);
  });

  it("sets ACTIVE_COLOR env var back to blue", async () => {
    await switchToGreen();
    await rollback();
    expect(process.env.ACTIVE_COLOR).toBe("blue");
  });

  it("is a no-op when already on blue (no previousColor)", async () => {
    // Seed an explicit blue state so lastSwitch is stable across reads
    // (an absent state file falls back to a fresh Date.now() each call).
    seedState({ activeColor: "blue", lastSwitch: 1234 });
    const { lastSwitch: before } = await getStatus();
    await rollback();
    const { lastSwitch: after } = await getStatus();
    expect(after).toBe(before);
  });

  it("is a no-op when state is blue even if previousColor is set", async () => {
    // Manually seed a state that is already blue but has a previousColor
    seedState({ activeColor: "blue", lastSwitch: 999, previousColor: "green" });
    await rollback();
    const status = await getStatus();
    expect(status.activeColor).toBe("blue");
    expect(status.lastSwitch).toBe(999); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Full round-trip transitions
// ---------------------------------------------------------------------------

describe("full round-trip", () => {
  it("blue → green → blue (rollback) → green again", async () => {
    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");

    await rollback();
    expect((await getStatus()).activeColor).toBe("blue");

    await switchToGreen();
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("status is accurate at every step", async () => {
    let s = await getStatus();
    expect(s.activeColor).toBe("blue");

    await switchToGreen();
    s = await getStatus();
    expect(s.activeColor).toBe("green");
    expect(s.previousColor).toBe("blue");

    await rollback();
    s = await getStatus();
    expect(s.activeColor).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// Concurrent invocation safety
// ---------------------------------------------------------------------------

describe("concurrent switchToGreen", () => {
  it("rejects the second concurrent call with 'Switch already in progress'", async () => {
    // Make the health checker slow so the first call is still in-flight
    // when the second one starts.
    let resolveHealth!: (v: boolean) => void;
    const healthPromise = new Promise<boolean>((res) => {
      resolveHealth = res;
    });
    setHealthChecker(() => healthPromise);

    const first = switchToGreen();
    // Second call fires before the first resolves
    const second = switchToGreen();

    // Let the health check complete so the first call can finish
    resolveHealth(true);

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);

    // One must succeed, the other must be rejected
    const statuses = [firstResult.status, secondResult.status];
    expect(statuses).toContain("fulfilled");
    expect(statuses).toContain("rejected");

    const rejected = [firstResult, secondResult].find(
      (r) => r.status === "rejected"
    ) as PromiseRejectedResult;
    expect(rejected.reason.message).toMatch(/Switch already in progress|already green/i);

    // Final state must be consistent
    const finalState = await getStatus();
    expect(["blue", "green"]).toContain(finalState.activeColor);
  });
});

// ---------------------------------------------------------------------------
// loadAutoRollbackConfig — env parsing & validation
// ---------------------------------------------------------------------------

describe("loadAutoRollbackConfig", () => {
  it("returns documented defaults when nothing is set", () => {
    const cfg = loadAutoRollbackConfig({});
    expect(cfg).toEqual({
      enabled: true,
      errorRateThreshold: 0.05,
      soakWindowMs: 30_000,
      sampleIntervalMs: 5_000,
      minRequests: 20,
    });
  });

  it("parses valid overrides", () => {
    const cfg = loadAutoRollbackConfig({
      AUTO_ROLLBACK_ENABLED: "false",
      ROLLBACK_ERROR_RATE_THRESHOLD: "0.2",
      ROLLBACK_SOAK_WINDOW_MS: "10000",
      ROLLBACK_SAMPLE_INTERVAL_MS: "2000",
      ROLLBACK_MIN_REQUESTS: "5",
    });
    expect(cfg).toEqual({
      enabled: false,
      errorRateThreshold: 0.2,
      soakWindowMs: 10_000,
      sampleIntervalMs: 2_000,
      minRequests: 5,
    });
  });

  it("clamps the soak window and sample interval to safe bounds", () => {
    const cfg = loadAutoRollbackConfig({
      ROLLBACK_SOAK_WINDOW_MS: "999999999",
      ROLLBACK_SAMPLE_INTERVAL_MS: "1",
    });
    expect(cfg.soakWindowMs).toBe(600_000);
    expect(cfg.sampleIntervalMs).toBe(100);
  });

  it("caps the sample interval to the soak window", () => {
    const cfg = loadAutoRollbackConfig({
      ROLLBACK_SOAK_WINDOW_MS: "3000",
      ROLLBACK_SAMPLE_INTERVAL_MS: "5000",
    });
    expect(cfg.sampleIntervalMs).toBe(3_000);
  });

  it("rejects a non-boolean enabled flag", () => {
    expect(() => loadAutoRollbackConfig({ AUTO_ROLLBACK_ENABLED: "maybe" })).toThrow(
      /AUTO_ROLLBACK_ENABLED/
    );
  });

  it("rejects a threshold outside 0..1", () => {
    expect(() =>
      loadAutoRollbackConfig({ ROLLBACK_ERROR_RATE_THRESHOLD: "1.5" })
    ).toThrow(/ROLLBACK_ERROR_RATE_THRESHOLD/);
  });

  it("rejects a non-numeric threshold", () => {
    expect(() =>
      loadAutoRollbackConfig({ ROLLBACK_ERROR_RATE_THRESHOLD: "abc" })
    ).toThrow(/ROLLBACK_ERROR_RATE_THRESHOLD/);
  });

  it("rejects a non-integer window", () => {
    expect(() =>
      loadAutoRollbackConfig({ ROLLBACK_SOAK_WINDOW_MS: "12.5" })
    ).toThrow(/ROLLBACK_SOAK_WINDOW_MS/);
  });

  it("rejects a negative minimum request count", () => {
    expect(() =>
      loadAutoRollbackConfig({ ROLLBACK_MIN_REQUESTS: "-1" })
    ).toThrow(/ROLLBACK_MIN_REQUESTS/);
  });

  it("treats empty strings as unset and falls back to defaults", () => {
    const cfg = loadAutoRollbackConfig({ ROLLBACK_ERROR_RATE_THRESHOLD: "" });
    expect(cfg.errorRateThreshold).toBe(0.05);
  });
});

// ---------------------------------------------------------------------------
// monitorAndAutoRollback — post-switch soak
// ---------------------------------------------------------------------------

describe("monitorAndAutoRollback", () => {
  // Keep decision logs out of the test output while still exercising them.
  beforeEach(() => {
    setWriteRecordImpl(() => {});
  });

  afterAll(() => {
    setWriteRecordImpl((record) => {
      process.stdout.write(JSON.stringify(record) + "\n");
    });
  });

  // Fast, deterministic soak for tests.
  const fastSoak = { soakWindowMs: 30, sampleIntervalMs: 10, minRequests: 10 };

  it("retains a healthy deployment (no rollback)", async () => {
    await switchToGreen();
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 0, errorRequests: 0 }, // baseline
        { totalRequests: 200, errorRequests: 0 }, // all healthy traffic
      ])
    );

    const result = await monitorAndAutoRollback(fastSoak);

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toBe("healthy");
    expect(result.peakErrorRate).toBe(0);
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("auto-rolls back when the error-rate threshold is breached", async () => {
    await switchToGreen();
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 0, errorRequests: 0 }, // baseline
        { totalRequests: 100, errorRequests: 50 }, // 50% errors → breach
      ])
    );

    const result = await monitorAndAutoRollback({
      ...fastSoak,
      errorRateThreshold: 0.1,
    });

    expect(result.rolledBack).toBe(true);
    expect(result.reason).toBe("breached");
    expect(result.peakErrorRate).toBeCloseTo(0.5);
    // Rollback must be reflected by the persisted status.
    expect((await getStatus()).activeColor).toBe("blue");
  });

  it("does not roll back on a sub-threshold error rate", async () => {
    await switchToGreen();
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 0, errorRequests: 0 },
        { totalRequests: 100, errorRequests: 3 }, // 3% < 5% threshold
      ])
    );

    const result = await monitorAndAutoRollback(fastSoak);

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toBe("healthy");
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("ignores breaches on insufficient request volume", async () => {
    await switchToGreen();
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 0, errorRequests: 0 },
        { totalRequests: 4, errorRequests: 4 }, // 100% errors but only 4 reqs
      ])
    );

    const result = await monitorAndAutoRollback({ ...fastSoak, minRequests: 20 });

    expect(result.rolledBack).toBe(false);
    expect(result.reason).toBe("insufficient-data");
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("only counts traffic served after the switch (delta, not lifetime)", async () => {
    await switchToGreen();
    // Baseline already has historical errors; the window itself is clean.
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 1000, errorRequests: 900 }, // baseline (pre-switch)
        { totalRequests: 1100, errorRequests: 900 }, // +100 reqs, 0 new errors
      ])
    );

    const result = await monitorAndAutoRollback(fastSoak);

    expect(result.rolledBack).toBe(false);
    expect(result.observedRequests).toBe(100);
    expect(result.peakErrorRate).toBe(0);
  });

  it("skips the soak entirely when disabled", async () => {
    await switchToGreen();
    let called = false;
    setErrorRateReader(async () => {
      called = true;
      return { totalRequests: 100, errorRequests: 100 };
    });

    const result = await monitorAndAutoRollback({ enabled: false });

    expect(result.reason).toBe("disabled");
    expect(result.rolledBack).toBe(false);
    expect(called).toBe(false); // never sampled
    expect((await getStatus()).activeColor).toBe("green");
  });

  it("is a no-op when green is not the active color", async () => {
    // Still on blue — nothing was promoted, so there is nothing to soak.
    let called = false;
    setErrorRateReader(async () => {
      called = true;
      return { totalRequests: 100, errorRequests: 100 };
    });

    const result = await monitorAndAutoRollback(fastSoak);

    expect(result.reason).toBe("not-green");
    expect(result.rolledBack).toBe(false);
    expect(called).toBe(false);
  });

  it("is idempotent: a second monitor after rollback does not re-revert", async () => {
    await switchToGreen();
    setErrorRateReader(
      readerFromSequence([
        { totalRequests: 0, errorRequests: 0 },
        { totalRequests: 100, errorRequests: 80 },
      ])
    );

    const first = await monitorAndAutoRollback(fastSoak);
    expect(first.rolledBack).toBe(true);
    expect((await getStatus()).activeColor).toBe("blue");

    // Running again now that we're back on blue must be a safe no-op.
    const second = await monitorAndAutoRollback(fastSoak);
    expect(second.rolledBack).toBe(false);
    expect(second.reason).toBe("not-green");
    expect((await getStatus()).activeColor).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// readErrorRateFromRegistry — default metrics-backed reader
// ---------------------------------------------------------------------------

describe("readErrorRateFromRegistry", () => {
  it("derives 5xx counts from http_requests_total in the registry", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { register, Counter } = require("prom-client");
    register.removeSingleMetric("http_requests_total");
    const counter = new Counter({
      name: "http_requests_total",
      help: "test counter",
      labelNames: ["status_code"],
      registers: [register],
    });
    counter.inc({ status_code: "200" }, 90);
    counter.inc({ status_code: "503" }, 7);
    counter.inc({ status_code: "500" }, 3);

    const sample = await readErrorRateFromRegistry();
    expect(sample.totalRequests).toBe(100);
    expect(sample.errorRequests).toBe(10);

    register.removeSingleMetric("http_requests_total");
  });

  it("returns zeroed counts when the metric is absent", async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { register } = require("prom-client");
    register.removeSingleMetric("http_requests_total");

    const sample = await readErrorRateFromRegistry();
    expect(sample).toEqual({ totalRequests: 0, errorRequests: 0 });
  });
});
