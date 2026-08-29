/**
 * @module health/router
 * @description Express router exposing the hardened /health endpoint.
 *
 * Security notes:
 * - Probe detail strings are stripped in production to avoid leaking
 *   internal topology to unauthenticated callers.
 * - HTTP 200 for "ok", 503 for "degraded" so load-balancers can act on it.
 * - Cache-Control: no-store prevents stale health data from caches.
 * - Query parameters are validated against {@link HealthQuerySchema} so that
 *   unknown keys are rejected and `verbose`, `limit`, and `cursor` are
 *   validated before any probe logic runs.
 *
 * Pagination notes:
 * - The `probes` array is cursor-paginated with a default page size of
 *   {@link DEFAULT_HEALTH_PAGE_SIZE} and a hard cap of
 *   {@link MAX_HEALTH_PAGE_SIZE}.
 * - Cursors are opaque Base64url strings. Clients must not construct them.
 * - An invalid cursor is rejected with HTTP 400.
 * - Existing filters (verbose) continue to work across pages unchanged.
 * - The item shape of each probe is not changed.
 */

import { Router, Request, Response } from "express";
import { runHealthCheck } from "./checker";
import { Probe, HealthResponse, ProbeResult } from "./types";
import { logger as rootLogger, Logger } from "../logger";
import type { MetricsServiceLike } from "../observability/metrics-service";
import { validateQuery } from "../middleware/validation";
import { HealthQuerySchema, DEFAULT_HEALTH_PAGE_SIZE } from "./validation";
import {
  decodeCursor,
  paginateItems,
  clampPageSize,
} from "./pagination";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Optional metrics service passed to {@link buildHealthRouter}. */
export interface MetricsService {
  recordHealthStatus(status: "up" | "degraded" | "down"): void;
}

/** Full options object accepted by {@link buildHealthRouter}. */
export interface HealthRouterOptions {
  /** List of probes to run. Defaults to the built-in probe registry. */
  probes?: Probe[];
  /** Optional metrics service for recording health status gauges. */
  metricsService?: MetricsService;
  /** Optional logger override (defaults to the root application logger). */
  log?: typeof rootLogger;
}

// ─── Builder ──────────────────────────────────────────────────────────────────

export interface HealthRouterOptions {
  probes?: Probe[];
  metricsService?: Pick<MetricsServiceLike, "recordHealthStatus">;
  log?: Pick<Logger, "info">;
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

  router.get("/", validateQuery(HealthQuerySchema), async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");

    // ── Run all probes ───────────────────────────────────────────────────────
    const start = process.hrtime.bigint();
    const result = await runHealthCheck(opts.probes);
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;

    // ── Metrics ──────────────────────────────────────────────────────────────
    const serviceStatus: "up" | "degraded" | "down" =
      result.status === "ok" ? "up" : "degraded";

    if (opts.metricsService) {
      opts.metricsService.recordHealthStatus(serviceStatus);
    }

    // ── Structured log (full probe set, no PII) ──────────────────────────────
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

    // ── Decode pagination parameters ─────────────────────────────────────────
    // After validateQuery, req.query fields are Zod-transformed values.
    // limit: number | undefined (undefined when omitted, number after transform)
    // cursor: string | undefined
    const rawLimit = req.query['limit'];
    const rawCursor = req.query['cursor'];

    // rawLimit is a number after Zod transform, or undefined if omitted.
    // Fall back to DEFAULT_HEALTH_PAGE_SIZE when missing.
    const requestedLimit =
      typeof rawLimit === 'number' && rawLimit >= 1
        ? rawLimit
        : DEFAULT_HEALTH_PAGE_SIZE;
    const effectiveLimit = clampPageSize(requestedLimit);

    let startIndex = 0;

    if (typeof rawCursor === 'string' && rawCursor.length > 0) {
      const decoded = decodeCursor(rawCursor, result.probes.length);
      if (!decoded.ok) {
        return res.status(400).json({
          error: {
            code: "validation_error",
            message:
              decoded.error === "cursor_out_of_range"
                ? "Cursor is out of range for the current dataset"
                : "Cursor is invalid or has been tampered with",
            requestId:
              typeof res.locals.requestId === "string"
                ? res.locals.requestId
                : "unknown",
            details: [{ path: ["cursor"], message: decoded.error, code: decoded.error }],
          },
        });
      }
      startIndex = decoded.index;
    }

    // ── Paginate ─────────────────────────────────────────────────────────────
    const page = paginateItems(result.probes, startIndex, effectiveLimit);

    // ── Sanitise probe details ───────────────────────────────────────────────
    const isVerbose = req.query['verbose'] === 'true';
    const isProduction = process.env.NODE_ENV === "production";

    const sanitizeProbe = (p: ProbeResult): ProbeResult =>
      isProduction || !isVerbose
        ? { name: p.name, ok: p.ok, latencyMs: p.latencyMs }
        : p;

    const sanitizedProbes = page.items.map(sanitizeProbe);

    // ── Build response ───────────────────────────────────────────────────────
    const response: PaginatedHealthResponse = {
      status: result.status,
      service: result.service,
      timestamp: result.timestamp,
      uptimeSeconds: result.uptimeSeconds,
      probes: sanitizedProbes,
      nextCursor: page.nextCursor,
      limit: page.limit,
    };

    res.status(response.status === "ok" ? 200 : 503).json(response);
  });

  return router;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Normalise the flexible constructor signature into a full options object.
 */
function normalizeOptions(
  input: Probe[] | HealthRouterOptions | undefined,
): {
  probes?: Probe[];
  metricsService?: Pick<MetricsServiceLike, "recordHealthStatus">;
  log?: Pick<Logger, "info">;
} {
  if (Array.isArray(input)) {
    return { probes: input };
  }
  return {
    probes: input?.probes,
    metricsService: input?.metricsService,
    log: input?.log,
  };
}
