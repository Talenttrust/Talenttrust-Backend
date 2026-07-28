/**
 * @module health/probes
 * @description Built-in dependency probes for the health check subsystem.
 *
 * Each probe is a zero-argument async function returning a {@link ProbeResult}.
 * Add new probes here and register them in {@link runHealthCheck}.
 */

import Redis from "ioredis";
import { getDb } from "../db/database";
import { ProbeResult } from "./types";
import { QueueManager } from "../queue/queue-manager";
import { circuitBreakerRegistry } from "../circuit-breaker/registry";
import { HealthProbeConfig } from "../appConfiguration";

const DEFAULT_HEALTH_PROBE_CONFIG: Required<HealthProbeConfig> = {
  queueFailedThreshold: 10,
  queueBacklogThreshold: 100,
  queueProbeTimeoutMs: 3_000,
};

const REDIS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probe: verify required environment variables are present.
 * Does NOT expose values — only checks existence.
 */
export async function envProbe(): Promise<ProbeResult> {
  const start = Date.now();
  const required = (process.env.REQUIRED_ENV_VARS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const missing = required.filter((key) => !process.env[key]);
  const ok = missing.length === 0;

  return {
    name: "env",
    ok,
    status: ok ? "up" : "down",
    detail: ok ? undefined : `Missing vars: ${missing.join(", ")}`,
    latencyMs: Date.now() - start,
  };
}

/**
 * Probe: reachability check for the configured Stellar/Soroban RPC endpoint.
 * Uses a lightweight GET to the horizon or soroban-rpc base URL.
 * Aborts after 5 seconds to avoid blocking the health response.
 */
export async function stellarRpcProbe(): Promise<ProbeResult> {
  const url = process.env.STELLAR_RPC_URL ?? "";
  const start = Date.now();

  if (!url) {
    return {
      name: "stellar-rpc",
      ok: false,
      status: "down",
      detail: "STELLAR_RPC_URL not set",
      latencyMs: 0,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref();

  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });

    const latencyMs = Date.now() - start;
    const ok = res.status < 500;
    return {
      name: "stellar-rpc",
      ok,
      status: ok ? "up" : "down",
      detail: ok ? undefined : `HTTP ${res.status}`,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      name: "stellar-rpc",
      ok: false,
      status: "down",
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

const DB_PROBE_TIMEOUT_MS = 3_000;
const DB_PROBE_DEGRADED_THRESHOLD_MS = 1_000;

/**
 * Probe: verify the SQLite database is reachable with a lightweight SELECT 1.
 * Maps response time to status:
 * - < 1000ms: up (healthy)
 * - 1000ms-3000ms: degraded (slow but responding)
 * - >= 3000ms or error: down (failed or timeout)
 *
 * Uses the shared singleton returned by {@link getDb}.
 * Security: Query is hardcoded—no user input.
 */
export async function dbProbe(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    // Store the timer so it can be cancelled once the race settles —
    // if the DB query wins, the pending timeout must not keep the event
    // loop alive after the probe resolves.
    let dbTimerId: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.resolve(getDb().prepare("SELECT 1").run()),
      new Promise<never>((_, reject) => {
        dbTimerId = setTimeout(
          () => reject(new Error("db probe timeout")),
          DB_PROBE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => {
      clearTimeout(dbTimerId);
    });

    const latencyMs = Date.now() - start;
    
    if (latencyMs >= DB_PROBE_TIMEOUT_MS) {
      return {
        name: "db",
        ok: false,
        status: "down",
        detail: "db probe timeout",
        latencyMs,
      };
    }

    const status = latencyMs > DB_PROBE_DEGRADED_THRESHOLD_MS ? "degraded" : "up";
    return {
      name: "db",
      ok: status === "up",
      status,
      detail: status === "degraded" ? `slow response: ${latencyMs}ms` : undefined,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      name: "db",
      ok: false,
      status: "down",
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Probe: verify Redis is reachable with a PING command.
 * Opens a short-lived connection using environment configuration, sends PING,
 * then disconnects. Times out after {@link REDIS_PROBE_TIMEOUT_MS} ms.
 */
export async function redisProbe(): Promise<ProbeResult> {
  const start = Date.now();
  const host = process.env["REDIS_HOST"] ?? "localhost";
  const port = parseInt(process.env["REDIS_PORT"] ?? "6379", 10);
  const password = process.env["REDIS_PASSWORD"] || undefined;

  const client = new Redis({
    host,
    port,
    password,
    connectTimeout: REDIS_PROBE_TIMEOUT_MS,
    commandTimeout: REDIS_PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  // Suppress unhandled-error events — errors are captured via the try/catch.
  client.on("error", () => undefined);

  try {
    await client.connect();
    await client.ping();
    return { name: "redis", ok: true, status: "up", latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "redis",
      ok: false,
      status: "down",
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  } finally {
    try {
      client.disconnect();
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Probe: checks BullMQ queue health via {@link QueueManager.getHealth}.
 *
 * Reports `degraded` when any queue has failed-job count above
 * `config.queueFailedThreshold` or waiting backlog above
 * `config.queueBacklogThreshold`. The probe resolves in at most
 * `config.queueProbeTimeoutMs` ms.
 *
 * @param config - Thresholds and timeout for queue health probing
 */
export async function queueProbe(config?: HealthProbeConfig): Promise<ProbeResult> {
  const cfg = { ...DEFAULT_HEALTH_PROBE_CONFIG, ...config };
  const start = Date.now();
  try {
    let probeTimerId: NodeJS.Timeout | undefined;
    const healthInfos = await Promise.race([
      QueueManager.getInstance().getHealth(),
      new Promise<never>((_, reject) => {
        probeTimerId = setTimeout(
          () => reject(new Error("queue probe timeout")),
          cfg.queueProbeTimeoutMs,
        );
      }),
    ]).finally(() => {
      clearTimeout(probeTimerId);
    });

    const violations: string[] = [];
    for (const q of healthInfos) {
      if (q.failed > cfg.queueFailedThreshold) {
        violations.push(`${q.jobType}: ${q.failed} failed jobs`);
      }
      if (q.waiting > cfg.queueBacklogThreshold) {
        violations.push(`${q.jobType}: ${q.waiting} waiting jobs`);
      }
    }

    const ok = violations.length === 0;
    return {
      name: "queue",
      ok,
      status: ok ? "up" : "degraded",
      detail: ok ? undefined : violations.join("; "),
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      name: "queue",
      ok: false,
      status: "down",
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Probe: reports the number of open circuit breakers from
 * {@link circuitBreakerRegistry}.
 *
 * Returns `ok: false` (degraded) when at least one breaker is in the OPEN
 * state. Detail is a count of open breakers — no internal topology is exposed.
 */
export async function circuitBreakerProbe(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const statuses = circuitBreakerRegistry.getAll();
    const openCount = statuses.filter((s) => s.state === "OPEN").length;
    const ok = openCount === 0;
    return {
      name: "circuit-breaker",
      ok,
      status: ok ? "up" : "degraded",
      detail: ok ? undefined : `${openCount} breaker(s) open`,
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      name: "circuit-breaker",
      ok: false,
      status: "down",
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}
