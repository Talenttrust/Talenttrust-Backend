/**
 * @module health/router
 * @description Express router exposing the hardened /health endpoint.
 *
 * Security notes:
 * - Probe detail strings are stripped in production to avoid leaking
 *   internal topology to unauthenticated callers.
 * - HTTP 200 for "ok", 503 for "degraded" so load-balancers can act on it.
 * - Cache-Control: no-store prevents stale health data from caches.
 *
 * Observability:
 * - Structured logs are emitted for every health check request including
 *   status, probe results, and duration (no PII).
 * - When a MetricsService is supplied the handler records the health status
 *   gauge so operators can monitor it via Prometheus.
 */

import { Router, Request, Response } from "express";
import { runHealthCheck } from "./checker";
import { Probe, HealthResponse, ProbeResult } from "./types";
import { Logger, logger as rootLogger } from "../logger";

export interface HealthRouterOptions {
  /** Probe list override (useful in tests). */
  probes?: Probe[];
  /** Metrics service used to record the health status gauge. */
  metricsService?: { recordHealthStatus(status: "up" | "degraded" | "down"): void };
  /** Logger instance; defaults to the root logger. */
  log?: Logger;
}

/**
 * Build the health router.
 *
 * @param optionsOrProbes - Either a probe array (legacy) or a full options
 *   object.  Passing a plain `Probe[]` is still supported for backward
 *   compatibility.
 */
export function buildHealthRouter(
  optionsOrProbes?: Probe[] | HealthRouterOptions,
): Router {
  const opts = normalizeOptions(optionsOrProbes);
  const log = opts.log ?? rootLogger;
  const router = Router();

  router.get("/", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    const start = process.hrtime.bigint();
    const result = await runHealthCheck(opts.probes);
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;

    // Map health status to the service-health-status gauge value.
    const serviceStatus: "up" | "degraded" | "down" =
      result.status === "ok" ? "up" : "degraded";

    // Record the health status gauge when a metrics service is available.
    if (opts.metricsService) {
      opts.metricsService.recordHealthStatus(serviceStatus);
    }

    // Structured log — no PII, no probe details in production.
    const probeSummary = result.probes.map((p: ProbeResult) => ({
      name: p.name,
      ok: p.ok ?? p.status === "up",
      latencyMs: p.latencyMs,
    }));

    log.info("health_check", {
      status: result.status,
      httpStatus: result.status === "ok" ? 200 : 503,
      durationMs: parseFloat(durationMs.toFixed(3)),
      probeCount: result.probes.length,
      failedProbes: probeSummary.filter((p) => !p.ok).map((p) => p.name),
      probes: probeSummary,
    });

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

/**
 * Normalise the flexible constructor signature into a full options object.
 */
function normalizeOptions(
  input: Probe[] | HealthRouterOptions | undefined,
): Required<Pick<HealthRouterOptions, "probes">> &
  Pick<HealthRouterOptions, "metricsService" | "log"> {
  if (Array.isArray(input)) {
    return { probes: input };
  }
  return { probes: input?.probes, metricsService: input?.metricsService, log: input?.log };
}
