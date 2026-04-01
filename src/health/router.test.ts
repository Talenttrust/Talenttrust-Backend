import express from "express";
import request from "supertest";
import { buildHealthRouter } from "./router";
import { Probe } from "./types";

// supertest is needed: npm install --save-dev supertest @types/supertest

const okProbe: Probe = async () => ({ name: "test", ok: true, latencyMs: 1 });
const failProbe: Probe = async () => ({
  name: "test",
  ok: false,
  detail: "down",
  latencyMs: 1,
});

function buildApp(probes: Probe[]) {
  const app = express();
  app.use("/health", buildHealthRouter(probes));
  return app;
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
