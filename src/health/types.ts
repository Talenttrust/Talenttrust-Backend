/**
 * @module health/types
 * @description Shared types for the health check subsystem.
 */

/** Status of a probe: up = healthy, degraded = slow/warning, down = failure. */
export type ProbeStatus = "up" | "degraded" | "down";

/** Result of a single dependency probe. */
export interface ProbeResult {
  /** Human-readable name of the dependency. */
  name: string;
  /** Probe status: up, degraded, or down. Kept for backward compatibility. */
  ok?: boolean;
  /** Probe health status. */
  status?: ProbeStatus;
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

/**
 * Paginated health response payload.
 *
 * Extends {@link HealthResponse} with cursor-pagination metadata.
 * The `probes` array is bounded to the requested page size.
 */
export interface PaginatedHealthResponse extends HealthResponse {
  /**
   * Opaque cursor to pass as `?cursor=` on the next request.
   * `null` when this is the last (or only) page.
   */
  nextCursor: string | null;
  /** Effective page size used for this response (after clamping). */
  limit: number;
}

/** A probe is any async function returning a ProbeResult. */
export type Probe = () => Promise<ProbeResult>;
