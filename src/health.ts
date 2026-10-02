import { Router, Request, Response } from "express";
import { dbProbe, redisProbe, stellarRpcProbe } from "./health/probes";
import { isReadinessDraining } from "./shutdown";
import { createRateLimiter } from "./middleware/rateLimiter";
import { rateLimitConfig } from "./config/rateLimit";
import { healthRateLimitKeyFn } from "./health/rateLimitKey";

const READY_PROBE_TIMEOUT_MS = 3_000;
const SERVICE_NAME = process.env.SERVICE_NAME ?? "talenttrust-backend";

interface ProbeSnapshot {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

function withTimeout<T>(probe: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    probe().finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timeout after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]);
}

function sanitizeProbe(probe: ProbeSnapshot): ProbeSnapshot {
  if (process.env.NODE_ENV === "production") {
    const { name, ok, latencyMs } = probe;
    return { name, ok, latencyMs };
  }

  return probe;
}

/**
 * Re-export the key function so callers that previously imported it from
 * this module continue to work without change.
 */
export { healthRateLimitKeyFn } from "./health/rateLimitKey";

/**
 * Health checks for blue-green deployments.
 * /health/live: process liveness only.
 * /health/ready: dependency readiness for traffic gating.
 */
export const healthRouter = Router();

const healthLimiter = createRateLimiter({
  ...rateLimitConfig.health,
  keyFn: healthRateLimitKeyFn,
});

healthRouter.use(healthLimiter);

healthRouter.get("/live", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ status: "ok", service: SERVICE_NAME, probe: "live" });
});

healthRouter.get("/ready", async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");

  if (isReadinessDraining()) {
    return res.status(503).json({
      status: "not-ready",
      service: SERVICE_NAME,
      probe: "ready",
      reason: "drain-in-progress",
      activeColor: process.env.ACTIVE_COLOR ?? "blue",
    });
  }

  try {
    const [db, rpc, queue] = await Promise.allSettled([
      withTimeout(() => dbProbe(), READY_PROBE_TIMEOUT_MS),
      withTimeout(() => stellarRpcProbe(), READY_PROBE_TIMEOUT_MS),
      withTimeout(() => redisProbe(), READY_PROBE_TIMEOUT_MS),
    ]);

    const checks: ProbeSnapshot[] = [db, rpc, queue].map((result, index) => {
      const name = ["db", "stellar-rpc", "queue"][index];
      if (result.status === "fulfilled") {
        return sanitizeProbe({ name, ok: result.value.ok || false, latencyMs: result.value.latencyMs, detail: result.value.detail });
      }

      return sanitizeProbe({
        name,
        ok: false,
        latencyMs: 0,
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const ready = checks.every((probe) => probe.ok);

    return res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not-ready",
      service: SERVICE_NAME,
      probe: "ready",
      activeColor: process.env.ACTIVE_COLOR ?? "blue",
      checks,
    });
  } catch (error) {
    return res.status(503).json({
      status: "not-ready",
      service: SERVICE_NAME,
      probe: "ready",
      activeColor: process.env.ACTIVE_COLOR ?? "blue",
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
