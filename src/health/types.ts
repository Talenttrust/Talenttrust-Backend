/**
 * @module health/types
 * @description Shared types for the health check subsystem.
 */

/** Result of a single dependency probe. */
export interface ProbeResult {
  /** Human-readable name of the dependency. */
  name: string;
  /** Whether the probe succeeded. */
  ok: boolean;
  /** Optional detail message (error text or latency note). */
  detail?: string;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
}

/** Overall health response payload. */
export interface HealthResponse {
  /** Aggregate status: "ok" when all probes pass, "degraded" otherwise. */
  status: "ok" | "degraded";
  service: string;
  /** ISO-8601 timestamp of the check. */
  timestamp: string;
  /** Uptime of the process in seconds. */
  uptimeSeconds: number;
  /** Individual dependency probe results. */
  probes: ProbeResult[];
}

/** A probe is any async function returning a ProbeResult. */
export type Probe = () => Promise<ProbeResult>;
