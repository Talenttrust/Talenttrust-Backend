/**
 * @module health/checker
 * @description Aggregates probe results into a structured {@link HealthResponse}.
 *
 * All probes run concurrently via Promise.allSettled so a single slow or
 * failing probe never blocks the others.
 */

import { dbProbe, envProbe, redisProbe, stellarRpcProbe, queueProbe, circuitBreakerProbe } from "./probes";
import { HealthResponse, Probe } from "./types";

/** Default probe registry. Override via the probes parameter for testing. */
const DEFAULT_PROBES: Probe[] = [envProbe, dbProbe, redisProbe, stellarRpcProbe, queueProbe, circuitBreakerProbe];

/**
 * Run all probes concurrently and return a structured health response.
 *
 * @param probes - Probe list to execute (defaults to DEFAULT_PROBES).
 * @returns Resolved HealthResponse — never rejects.
 */
export async function runHealthCheck(
  probes: Probe[] = DEFAULT_PROBES
): Promise<HealthResponse> {
  const results = await Promise.allSettled(probes.map((p) => p()));

  const probeResults = results.map((r, i) => {
    if (r.status === "fulfilled") {
      const probe = r.value;
      // Normalize: if status is missing, derive from ok field
      if (!probe.status && probe.ok !== undefined) {
        return {
          ...probe,
          status: (probe.ok ? "up" : "down") as import("./types").ProbeStatus,
        };
      }
      return probe;
    }
    return {
      name: probes[i]!.name || `probe-${i}`,
      ok: false,
      status: "down" as import("./types").ProbeStatus,
      detail: String((r as PromiseRejectedResult).reason),
      latencyMs: 0,
    };
  });

  const allOk = probeResults.every((p) => p.status === "up" || p.ok);

  return {
    status: allOk ? "ok" : "degraded",
    service: "talenttrust-backend",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    probes: probeResults,
  };
}
