/**
 * @module health/router
 * @description Express router exposing the hardened /health endpoint.
 *
 * Security notes:
 * - Probe detail strings are stripped in production to avoid leaking
 *   internal topology to unauthenticated callers.
 * - HTTP 200 for "ok", 503 for "degraded" so load-balancers can act on it.
 * - Cache-Control: no-store prevents stale health data from caches.
 */

import { Router, Request, Response } from "express";
import { runHealthCheck } from "./checker";
import { Probe, HealthResponse } from "./types";

/**
 * Build the health router.
 *
 * @param probes - Optional probe override (useful in tests).
 */
export function buildHealthRouter(probes?: Probe[]): Router {
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const result = await runHealthCheck(probes);

    // Strip probe details in production to avoid topology leakage.
    const sanitized: HealthResponse =
      process.env.NODE_ENV === "production"
        ? {
            ...result,
            probes: result.probes.map(({ name, ok, latencyMs }) => ({
              name,
              ok,
              latencyMs,
            })),
          }
        : result;

    res.status(sanitized.status === "ok" ? 200 : 503).json(sanitized);
  });

  return router;
}
