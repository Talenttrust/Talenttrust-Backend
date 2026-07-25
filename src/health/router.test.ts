import express from "express";
import request from "supertest";
import { buildHealthRouter } from "./router";
import { Probe } from "./types";
import { Logger, LogRecord } from "../logger";

const okProbe: Probe = async () => ({ name: "test", ok: true, latencyMs: 1 });
const failProbe: Probe = async () => ({
  name: "test",
  ok: false,
  detail: "down",
  latencyMs: 1,
});
const degradedProbe: Probe = async () => ({
  name: "db",
  ok: false,
  status: "degraded",
  latencyMs: 50,
});
const multiProbe: Probe[] = [
  async () => ({ name: "db", ok: true, latencyMs: 2 }),
  async () => ({ name: "redis", ok: true, latencyMs: 3 }),
  async () => ({ name: "rpc", ok: false, detail: "timeout", latencyMs: 100 }),
];

function buildApp(probes?: Probe[]) {
  const app = express();
  app.use("/health", buildHealthRouter(probes));
  return app;
}

// ── Helper: spy logger ──────────────────────────────────────────────────────

function createSpyLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger = new Logger();
  // Override the write implementation to capture records
  const originalWrite = (logger as any).log;
  jest.spyOn(logger as any, "log").mockImplementation(
    (_level: string, message: string, extra: Record<string, unknown> = {}) => {
      records.push({
        timestamp: new Date().toISOString(),
        level: _level as any,
        message,
        service: "talenttrust-backend",
        ...extra,
      });
    },
  );
  return { logger, records };
}

// ── Helper: mock metrics service ────────────────────────────────────────────

function createMockMetricsService() {
  return {
    recordHealthStatus: jest.fn(),
  };
}

describe("GET /health", () => {
  it("returns 200 and status ok when all probes pass", async () => {
    const res = await request(buildApp([okProbe])).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("talenttrust-backend");
    expect(Array.isArray(res.body.probes)).toBe(true);
  });

  it("returns 503 and status degraded when a probe fails", async () => {
    const res = await request(buildApp([failProbe])).get("/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });

  it("sets Cache-Control: no-store header", async () => {
    const res = await request(buildApp([okProbe])).get("/health");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("includes timestamp and uptimeSeconds", async () => {
    const res = await request(buildApp([okProbe])).get("/health");
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  it("strips detail field in production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const res = await request(buildApp([failProbe])).get("/health");
    process.env.NODE_ENV = original;
    res.body.probes.forEach((p: Record<string, unknown>) => {
      expect(p.detail).toBeUndefined();
    });
  });

  it("includes detail field outside production", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const res = await request(buildApp([failProbe])).get("/health");
    process.env.NODE_ENV = original;
    const failedProbe = res.body.probes.find(
      (p: Record<string, unknown>) => !p.ok
    );
    expect(failedProbe?.detail).toBe("down");
  });

  it("returns 200 with no probes configured", async () => {
    const res = await request(buildApp([])).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(0);
  });
});

// ── Issue #773: Structured metrics and logging ─────────────────────────────

describe("health router — observability", () => {
  it("records health status gauge as up when all probes pass", async () => {
    const metrics = createMockMetricsService();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [okProbe], metricsService: metrics }));

    await request(app).get("/health");

    expect(metrics.recordHealthStatus).toHaveBeenCalledTimes(1);
    expect(metrics.recordHealthStatus).toHaveBeenCalledWith("up");
  });

  it("records health status gauge as degraded when a probe fails", async () => {
    const metrics = createMockMetricsService();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [failProbe], metricsService: metrics }));

    await request(app).get("/health");

    expect(metrics.recordHealthStatus).toHaveBeenCalledTimes(1);
    expect(metrics.recordHealthStatus).toHaveBeenCalledWith("degraded");
  });

  it("emits structured log with status ok on healthy response", async () => {
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [okProbe], log: logger }));

    await request(app).get("/health");

    const healthLog = records.find((r) => r.message === "health_check");
    expect(healthLog).toBeDefined();
    expect(healthLog!.status).toBe("ok");
    expect(healthLog!.httpStatus).toBe(200);
    expect(typeof healthLog!.durationMs).toBe("number");
    expect(healthLog!.probeCount).toBe(1);
    expect(healthLog!.failedProbes).toEqual([]);
  });

  it("emits structured log with status degraded on failure", async () => {
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [failProbe], log: logger }));

    await request(app).get("/health");

    const healthLog = records.find((r) => r.message === "health_check");
    expect(healthLog).toBeDefined();
    expect(healthLog!.status).toBe("degraded");
    expect(healthLog!.httpStatus).toBe(503);
    expect(healthLog!.failedProbes).toContain("test");
  });

  it("includes per-probe details in structured log", async () => {
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: multiProbe, log: logger }));

    await request(app).get("/health");

    const healthLog = records.find((r) => r.message === "health_check");
    expect(healthLog).toBeDefined();
    expect(healthLog!.probeCount).toBe(3);
    expect(Array.isArray(healthLog!.probes)).toBe(true);
    expect(healthLog!.probes).toHaveLength(3);
    expect(healthLog!.probes[0]).toMatchObject({ name: "db", ok: true });
    expect(healthLog!.probes[2]).toMatchObject({ name: "rpc", ok: false });
    expect(healthLog!.failedProbes).toContain("rpc");
  });

  it("logs durationMs as a finite number", async () => {
    const { logger, records } = createSpyLogger();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [okProbe], log: logger }));

    await request(app).get("/health");

    const healthLog = records.find((r) => r.message === "health_check");
    expect(healthLog).toBeDefined();
    expect(Number.isFinite(healthLog!.durationMs)).toBe(true);
    expect((healthLog!.durationMs as number) >= 0).toBe(true);
  });

  it("does not record metrics when no metricsService is supplied", async () => {
    const app = express();
    app.use("/health", buildHealthRouter({ probes: [okProbe] }));

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });

  it("records degraded status when probes have mixed results", async () => {
    const metrics = createMockMetricsService();
    const app = express();
    app.use("/health", buildHealthRouter({ probes: multiProbe, metricsService: metrics }));

    await request(app).get("/health");

    expect(metrics.recordHealthStatus).toHaveBeenCalledWith("degraded");
  });
});

// ── Backward compatibility: Probe[] signature ───────────────────────────────

describe("health router — backward compatibility", () => {
  it("accepts a plain Probe array (legacy signature)", async () => {
    const res = await request(buildApp([okProbe])).get("/health");
    expect(res.status).toBe(200);
  });

  it("accepts an empty array (legacy signature)", async () => {
    const res = await request(buildApp([])).get("/health");
    expect(res.status).toBe(200);
  });
});
