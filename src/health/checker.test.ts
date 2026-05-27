import { runHealthCheck } from "./checker";
import { Probe } from "./types";

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
});
