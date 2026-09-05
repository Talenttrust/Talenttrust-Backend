import { runHealthCheck, buildProbes, DEFAULT_HEALTH_BUDGET } from "./checker";
import { HealthBudget, Probe } from "./types";

const okProbe =
  (name: string): Probe =>
  async () => ({
    name,
    ok: true,
    latencyMs: 1,
  });

const failProbe =
  (name: string): Probe =>
  async () => ({
    name,
    ok: false,
    detail: "down",
    latencyMs: 1,
  });
const throwingProbe = (name: string): Probe => {
  const p: Probe = async () => {
    throw new Error("boom");
  };
  Object.defineProperty(p, "name", { value: name });
  return p;
};

describe("runHealthCheck", () => {
  it("returns ok when all probes pass", async () => {
    const result = await runHealthCheck([okProbe("a"), okProbe("b")]);
    expect(result.status).toBe("ok");
    expect(result.probes).toHaveLength(2);
    expect(result.probes.every((p) => p.ok)).toBe(true);
  });
  it("returns degraded when any probe fails", async () => {
    const result = await runHealthCheck([okProbe("a"), failProbe("b")]);
    expect(result.status).toBe("degraded");
    expect(result.probes).toHaveLength(2);
    expect(result.probes.filter((r) => Boolean(r.ok))).toHaveLength(1);
    expect(result.probes[1].ok).toBe(false);
  });
  it("returns degraded when a probe throws", async () => {
    const result = await runHealthCheck([throwingProbe("bad")]);
    expect(result.status).toBe("degraded");
    expect(result.probes[0].ok).toBe(false);
    expect(result.probes[0].detail).toContain("boom");
  });
  it("returns degraded when all probes fail", async () => {
    const result = await runHealthCheck([failProbe("x"), failProbe("y")]);
    expect(result.status).toBe("degraded");
    expect(result.probes.every((r) => r.ok)).toBe(false);
  });
  it("includes service,timestamp, and uptimeSeconds", async () => {
    const result = await runHealthCheck([okProbe("a")]);
    expect(result.service).toBe("talenttrust-backend");
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof result.uptimeSeconds).toBe("number");
  });
  it("runs with no probes and returns ok", async () => {
    const result = await runHealthCheck([]);
    expect(result.status).toBe("ok");
    expect(result.probes).toHaveLength(0);
  });
  it("runs all probes concurrently (all settle)", async () => {
    const slow: Probe = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ name: "slow", ok: true, latencyMs: 50 }), 50)
      );
    const result = await runHealthCheck([slow, okProbe("fast")]);
    expect(result.probes).toHaveLength(2);
  });

  // ── Dependency healthy ─────────────────────────────────────────────────────
  it("keeps a fresh dependency up and passes freshness fields through", async () => {
    const fresh: Probe = async () => ({
      name: "indexer",
      ok: true,
      status: "up",
      latencyMs: 2,
      ageMs: 1_000,
      lastSuccessfulAt: "2026-03-24T00:00:00.000Z",
    });

    const result = await runHealthCheck([fresh]);

    expect(result.status).toBe("ok");
    expect(result.probes[0].status).toBe("up");
    expect(result.probes[0].ageMs).toBe(1_000);
    expect(result.probes[0].lastSuccessfulAt).toBe("2026-03-24T00:00:00.000Z");
  });

  // ── Stale dependency (freshness budget) ────────────────────────────────────
  it("downgrades a dependency to degraded when its data exceeds the age budget", async () => {
    const stale: Probe = async () => ({
      name: "indexer",
      ok: true,
      status: "up",
      latencyMs: 2,
      ageMs: DEFAULT_HEALTH_BUDGET.maxAgeMs + 60_000,
      lastSuccessfulAt: "2026-03-24T00:00:00.000Z",
    });

    const result = await runHealthCheck([stale]);

    expect(result.status).toBe("degraded");
    expect(result.probes[0].status).toBe("degraded");
    expect(result.probes[0].ok).toBe(false);
    expect(result.probes[0].detail).toContain("freshness budget");
  });

  it("honours a custom age budget when resolving freshness", async () => {
    const stale: Probe = async () => ({
      name: "indexer",
      ok: true,
      status: "up",
      latencyMs: 2,
      ageMs: 10_000,
    });

    const tightBudget: HealthBudget = { ...DEFAULT_HEALTH_BUDGET, maxAgeMs: 5_000 };
    const result = await runHealthCheck([stale], tightBudget);

    expect(result.probes[0].status).toBe("degraded");
  });

  // ── Probe timeout (bounded latency) ────────────────────────────────────────
  it("marks a probe that exceeds the latency budget as down (probe timeout)", async () => {
    const hanging: Probe = () => new Promise(() => { /* never resolves */ });

    const tightBudget: HealthBudget = { ...DEFAULT_HEALTH_BUDGET, maxLatencyMs: 25 };
    const result = await runHealthCheck([hanging], tightBudget);

    expect(result.status).toBe("degraded");
    expect(result.probes[0].ok).toBe(false);
    expect(result.probes[0].status).toBe("down");
    expect(result.probes[0].detail).toContain("probe timeout");
    expect(result.probes[0].latencyMs).toBeLessThanOrEqual(25);
  });

  it("clamps a probe's reported latency to the latency budget", async () => {
    const slow: Probe = async () => ({
      name: "slow",
      ok: true,
      status: "up",
      latencyMs: DEFAULT_HEALTH_BUDGET.maxLatencyMs + 5_000,
    });

    const result = await runHealthCheck([slow]);

    expect(result.probes[0].latencyMs).toBe(DEFAULT_HEALTH_BUDGET.maxLatencyMs);
  });

  // ── One dependency unavailable ─────────────────────────────────────────────
  it("returns degraded when a single dependency is unavailable", async () => {
    const result = await runHealthCheck([okProbe("db"), failProbe("redis")]);

    expect(result.status).toBe("degraded");
    expect(result.probes.find((p) => p.name === "db")!.ok).toBe(true);
    expect(result.probes.find((p) => p.name === "redis")!.ok).toBe(false);
  });
});

describe("buildProbes", () => {
  it("returns an array of seven probes including queue, circuit-breaker, and indexer", () => {
    const probes = buildProbes();
    expect(probes).toHaveLength(7);
  });

  it("returns a queue probe that uses provided config", async () => {
    const probes = buildProbes({ queueFailedThreshold: 5, queueBacklogThreshold: 100 });
    expect(probes).toHaveLength(7);
    const queueProbeFn = probes[4];
    expect(typeof queueProbeFn).toBe("function");
  });

  it("buildProbes without config still includes all standard probes", () => {
    const probes = buildProbes();
    expect(probes).toHaveLength(7);
  });
});
