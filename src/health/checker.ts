/**
 * @module health/checker
 * @description Aggregates probe results into a structured {@link HealthResponse}.
 *
 * All probes run concurrently via Promise.allSettled so a single slow or
 * failing probe never blocks the others.
 */

import { envProbe, stellarRpcProbe } from "./probes";
import { HealthResponse, Probe } from "./types";

/** Default probe registry. Override via the probes parameter for testing. */
const DEFAULT_PROBES: Probe[] = [envProbe, stellarRpcProbe];

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

  const probeResults = results.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          name: probes[i].name || `probe-${i}`,
          ok: false,
          detail: String((r as PromiseRejectedResult).reason),
          latencyMs: 0,
        }
  );

  const allOk = probeResults.every((p) => p.ok);

  return {
    status: allOk ? "ok" : "degraded",
    service: "talenttrust-backend",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    probes: probeResults,
  };
}
