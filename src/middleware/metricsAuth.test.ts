/**
 * @file metricsAuth.test.ts
 * @description Unit tests for the /metrics bearer token middleware.
 */

import express, { Request, Response } from "express";
import request from "supertest";
import { metricsAuthMiddleware } from "./metricsAuth";

function buildApp() {
  const app = express();
  app.get("/metrics", metricsAuthMiddleware, (_req: Request, res: Response) => {
    res.status(200).json({ data: "metrics" });
  });
  return app;
}

describe("metricsAuthMiddleware", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });
  afterEach(() => {
    process.env = ORIGINAL;
  });

  describe("when METRICS_AUTH_TOKEN is not configured", () => {
    it("allows unauthenticated requests", async () => {
      delete process.env.METRICS_AUTH_TOKEN;
      const res = await request(buildApp()).get("/metrics");
      expect(res.status).toBe(200);
    });

    it("ignores any Authorization header sent", async () => {
      delete process.env.METRICS_AUTH_TOKEN;
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Bearer anything");
      expect(res.status).toBe(200);
    });
  });

  describe("when METRICS_AUTH_TOKEN is configured", () => {
    beforeEach(() => {
      process.env.METRICS_AUTH_TOKEN = "super-secret-token";
    });

    it("allows a request with the correct bearer token", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Bearer super-secret-token");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: "metrics" });
    });

    it("rejects a request with no Authorization header — 401", async () => {
      const res = await request(buildApp()).get("/metrics");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("rejects a request with wrong token — 401", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("rejects a request with Basic auth scheme — 401", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Basic dXNlcjpwYXNz");
      expect(res.status).toBe(401);
    });

    it("rejects a request with empty bearer token — 401", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Bearer ");
      expect(res.status).toBe(401);
    });

    it("does not leak the configured token value in the response body", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "Bearer wrong");
      expect(JSON.stringify(res.body)).not.toContain("super-secret-token");
    });

    it("is not bypassed by case variation in the Bearer scheme", async () => {
      const res = await request(buildApp())
        .get("/metrics")
        .set("Authorization", "bearer super-secret-token");
      // Express lowercases header values but not scheme — 'bearer' != 'Bearer'
      expect(res.status).toBe(401);
    });
  });
});
