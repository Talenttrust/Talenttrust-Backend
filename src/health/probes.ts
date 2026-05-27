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
      detail: ok ? undefined : `HTTP ${res.status}`,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      name: "stellar-rpc",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe: verify the SQLite database is reachable with a lightweight SELECT 1.
 * Uses the shared singleton returned by {@link getDb}.
 */
export async function dbProbe(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    getDb().prepare("SELECT 1").run();
    return { name: "db", ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "db",
      ok: false,
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
    return { name: "redis", ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "redis",
      ok: false,
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
