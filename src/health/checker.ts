/**
 * @module health/checker
 * @description Aggregates probe results into a structured {@link HealthResponse}.
 *
 * All probes run concurrently so a single slow or failing probe never blocks
 * the others.
 *
 * Latency and age budgets:
 * - Every probe runs under a per-probe latency bound (`maxLatencyMs`). A probe
 *   that exceeds the bound is reported as `down` and its measured latency is
 *   clamped to the bound, so the check always completes within a bounded
 *   window.
 * - Probes that report `ageMs` surface dependencies whose data is reachable
 *   but too stale (compared against `maxAgeMs`).
 */

import { dbProbe, envProbe, redisProbe, stellarRpcProbe, queueProbe, circuitBreakerProbe, indexerProbe } from "./probes";
import { HealthBudget, HealthResponse, Probe, ProbeResult, ProbeStatus } from "./types";
import { HealthProbeConfig } from "../appConfiguration";

const DEFAULT_QUEUE_CONFIG: Required<HealthProbeConfig> = {
  queueFailedThreshold: 10,
  queueBacklogThreshold: 100,
  queueProbeTimeoutMs: 3_000,
};

/**
 * Default latency and freshness budgets applied to every probe.
 * The latency budget sits slightly above the slowest individual probe (the
 * stellar-rpc probe waits up to 5 s internally) so reachable-but-slow
 * dependencies are bounded rather than cut off prematurely.
 */
export const DEFAULT_HEALTH_BUDGET: HealthBudget = {
  maxLatencyMs: 5_500,
  maxAgeMs: 5 * 60_000,
};

/** Default probe registry. Override via the probes parameter for testing. */
const DEFAULT_PROBES: Probe[] = [
  envProbe,
  dbProbe,
  redisProbe,
  stellarRpcProbe,
  () => queueProbe(DEFAULT_QUEUE_CONFIG),
  circuitBreakerProbe,
  indexerProbe,
];

/**
 * Build a probe list with the given queue health configuration.
 *
 * @param config - Optional health probe thresholds; falls back to defaults when omitted.
 */
export function buildProbes(config?: HealthProbeConfig): Probe[] {
  const queue = () => queueProbe(config);
  return [envProbe, dbProbe, redisProbe, stellarRpcProbe, queue, circuitBreakerProbe, indexerProbe];
}

/**
 * Run all probes concurrently under a shared latency budget and return a
 * structured health response.
 *
 * @param probes - Probe list to execute (defaults to DEFAULT_PROBES).
 * @param budget - Latency/freshness bounds; defaults to {@link DEFAULT_HEALTH_BUDGET}.
 * @returns Resolved HealthResponse — never rejects.
 */
export async function runHealthCheck(
  probes: Probe[] = DEFAULT_PROBES,
  budget: HealthBudget = DEFAULT_HEALTH_BUDGET,
): Promise<HealthResponse> {
  const probeResults = await Promise.all(
    probes.map((probe, index) => runProbeWithinBudget(probe, index, budget)),
  );

  const normalized = probeResults.map((probe) => {
    // Normalize: if status is missing, derive from ok field
    if (!probe.status && probe.ok !== undefined) {
      return {
        ...probe,
        status: (probe.ok ? "up" : "down") as ProbeStatus,
      };
    }
    return probe;
  });

  const allOk = normalized.every((p) => p.status === "up" || p.ok);

  return {
    status: allOk ? "ok" : "degraded",
    service: "talenttrust-backend",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    probes: normalized,
  };
}

/**
 * Execute a single probe bounded by the latency budget.
 *
 * When a probe resolves, the measured latency is clamped to the budget so the
 * reported value never exceeds the bound and freshness fields pass through.
 * When the probe does not resolve in time it is marked `down` with a
 * structured "probe timeout" detail.
 */
async function runProbeWithinBudget(
  probe: Probe,
  index: number,
  budget: HealthBudget,
): Promise<ProbeResult> {
  const start = process.hrtime.bigint();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const elapsedMs = (): number => {
    const elapsedNs = process.hrtime.bigint() - start;
    return Math.min(Number(elapsedNs) / 1_000_000, budget.maxLatencyMs);
  };

  try {
    const result = await Promise.race([
      Promise.resolve(probe()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`probe timeout after ${budget.maxLatencyMs} ms`)),
          budget.maxLatencyMs,
        );
      }),
    ]);

    const freshness = applyAgeBudget(result, budget);

    return {
      name: freshness.name,
      ok: freshness.ok,
      status: freshness.status,
      detail: freshness.detail,
      latencyMs: Math.min(freshness.latencyMs, budget.maxLatencyMs),
      ageMs: freshness.ageMs,
      lastSuccessfulAt: freshness.lastSuccessfulAt,
    };
  } catch (error) {
    return {
      name: probe.name || `probe-${index}`,
      ok: false,
      status: "down",
      detail: error instanceof Error ? error.message : "unknown error",
      latencyMs: elapsedMs(),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Enforce the freshness budget on a resolved probe result.
 *
 * A dependency that successfully reported freshness (`ageMs`) but whose data
 * is older than the budget is currently reachable yet too stale, so it is
 * downgraded from `up` to `degraded`. `ok` follows the existing convention of
 * being `false` for degraded dependencies.
 */
function applyAgeBudget(result: ProbeResult, budget: HealthBudget): ProbeResult {
  if (result.ageMs === undefined || result.status === "down") {
    return result;
  }

  if (result.ageMs <= budget.maxAgeMs) {
    return result;
  }

  return {
    ...result,
    ok: false,
    status: "degraded",
    detail: result.detail ?? `data age ${result.ageMs}ms exceeds freshness budget ${budget.maxAgeMs}ms`,
  };
}