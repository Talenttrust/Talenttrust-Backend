/**
 * @module health/probes
 * @description Built-in dependency probes for the health check subsystem.
 *
 * Each probe is a zero-argument async function returning a {@link ProbeResult}.
 * Add new probes here and register them in {@link runHealthCheck}.
 */

import { ProbeResult } from "./types";

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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timeout);

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
  }
}
