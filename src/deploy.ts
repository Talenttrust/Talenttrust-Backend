import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";

import { register as defaultRegister } from "prom-client";

import { logger } from "./logger";
import { isSafeUrl } from "./utils/ssrf";

/**
 * Blue-green deployment state machine.
 *
 * Transitions:
 *   blue  --switchToGreen()--> green
 *   green --rollback()-------> blue
 *
 * State is persisted to `.deployment-state.json` so it survives process
 * restarts.  The file is gitignored; never put secrets in it.
 *
 * Concurrency: a simple in-process mutex prevents two concurrent
 * `switchToGreen` calls from racing on the state file.
 *
 * Post-switch safety: after promoting green, {@link monitorAndAutoRollback}
 * watches the HTTP error-rate metric for a configurable soak window and
 * invokes {@link rollback} automatically if a threshold is breached.  Every
 * decision is emitted as a structured `deploy_decision` log so operators have
 * an audit trail of why a deployment was kept or reverted.
 *
 * @module deploy
 */

const STATE_FILE = path.join(process.cwd(), ".deployment-state.json");

/** Shape of the persisted deployment state. */
export interface DeploymentState {
  activeColor: "blue" | "green";
  /** Unix ms timestamp of the last successful transition. */
  lastSwitch: number;
  /** The color that was active before the most recent switch. */
  previousColor?: "blue" | "green";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readState(): Promise<DeploymentState> {
  try {
    const data = await fs.promises.readFile(STATE_FILE, "utf8");
    return JSON.parse(data) as DeploymentState;
  } catch {
    return { activeColor: "blue", lastSwitch: Date.now() };
  }
}

async function writeState(state: DeploymentState): Promise<void> {
  await fs.promises.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/**
 * Perform a single HTTP readiness probe against the green instance.
 *
 * Validates the target URL with the SSRF guard so the probe cannot be
 * redirected to arbitrary internal hosts. Returns `true` only when the
 * endpoint responds with HTTP 200; any other status or network error is
 * treated as unhealthy.
 *
 * @param port - The port the green instance is listening on.
 * @param timeoutMs - Abort the request after this many milliseconds (default 3 s).
 */
async function checkHealth(port: string, timeoutMs = 3_000): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health/ready`;

  if (!isSafeUrl(url)) {
    throw new Error(`SSRF guard rejected probe target: ${url}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "Cache-Control": "no-store" },
    });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health-check function used by `switchToGreen`.
 * Replaced in tests via `setHealthChecker`.
 */
let _healthChecker: (port: string) => Promise<boolean> = checkHealth;

/**
 * Polling configuration for `switchToGreen` health gate.
 * These can be tuned via environment variables in deployment scripts.
 */
const DEFAULT_POLL_INTERVAL_MS = 500; // ms between health probes
const DEFAULT_POLL_TIMEOUT_MS = 5_000; // total timeout before aborting

function parseEnvMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Override the health-check implementation.
 * Intended for testing only — do not call in production code.
 *
 * @param fn - Async function that returns `true` when the target is healthy.
 */
export function setHealthChecker(
  fn: (port: string) => Promise<boolean>
): void {
  _healthChecker = fn;
}

// Simple in-process mutex to guard concurrent switch attempts.
let _switching = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Promote the green instance to active.
 *
 * - No-op (idempotent) when green is already active.
 * - Throws `Error("Green not ready")` when the health check fails.
 * - Throws `Error("Switch already in progress")` when called concurrently.
 *
 * @throws {Error} If green is unhealthy or a switch is already in progress.
 */
export async function switchToGreen(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "green") return; // idempotent

  if (_switching) throw new Error("Switch already in progress");
  _switching = true;

  try {
    // Poll the green readiness endpoint until healthy or until timeout.
    const intervalMs = parseEnvMs(
      "SWITCH_GREEN_POLL_INTERVAL_MS",
      DEFAULT_POLL_INTERVAL_MS,
    );
    const timeoutMs = parseEnvMs(
      "SWITCH_GREEN_TIMEOUT_MS",
      DEFAULT_POLL_TIMEOUT_MS,
    );

    const port = process.env.GREEN_PORT ?? "3002";
    const start = Date.now();

    let healthy = false;
    // Keep probing until healthy or timeout exceeded
    while (Date.now() - start <= timeoutMs) {
      try {
        /* eslint-disable no-await-in-loop */
        // delegate to the injected health checker (testable)
        if (await _healthChecker(port)) {
          healthy = true;
          break;
        }
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        // Treat errors as an unhealthy response and continue polling
      }

      // Wait before the next probe
      await new Promise((res) => setTimeout(res, intervalMs));
    }

    if (!healthy) throw new Error("Green not ready");

    // All good — commit the switch atomically
    state.previousColor = state.activeColor;
    state.activeColor = "green";
    state.lastSwitch = Date.now();
    await writeState(state);
    process.env.ACTIVE_COLOR = "green";
    console.log("Switched to green");
  } finally {
    _switching = false;
  }
}

/**
 * Roll back to the previous (blue) color.
 *
 * - No-op when already on blue or when there is no recorded previous color.
 */
export async function rollback(): Promise<void> {
  const state = await readState();
  if (state.activeColor === "blue" || !state.previousColor) return;

  state.activeColor = state.previousColor;
  state.lastSwitch = Date.now();
  await writeState(state);
  process.env.ACTIVE_COLOR = state.activeColor;
  console.log("Rolled back to", state.activeColor);
}

/**
 * Return the current deployment state without modifying it.
 */
export async function getStatus(): Promise<DeploymentState> {
  return readState();
}

// ---------------------------------------------------------------------------
// Automatic post-switch rollback
// ---------------------------------------------------------------------------

/**
 * A cumulative snapshot of request counters used to derive an error rate.
 *
 * Counters are monotonic (Prometheus style), so the monitor diffs two
 * snapshots to obtain the error rate *during the soak window* rather than the
 * lifetime average of the process.
 */
export interface ErrorRateSample {
  /** Total requests observed since process start. */
  totalRequests: number;
  /** Subset of {@link totalRequests} that returned a 5xx status. */
  errorRequests: number;
}

/** Reads the current cumulative request counters. */
export type ErrorRateReader = () => Promise<ErrorRateSample>;

/** Tunables for the post-switch soak / auto-rollback loop. */
export interface AutoRollbackConfig {
  /** When `false`, the monitor records the decision and exits immediately. */
  enabled: boolean;
  /** Fraction (0..1) of 5xx responses that triggers a rollback when exceeded. */
  errorRateThreshold: number;
  /** Total time (ms) to observe the new deployment after a switch. */
  soakWindowMs: number;
  /** Spacing (ms) between samples within the soak window. */
  sampleIntervalMs: number;
  /**
   * Minimum number of requests that must be observed in the window before a
   * breach is actionable.  Guards against rolling back on statistical noise
   * from a handful of requests.
   */
  minRequests: number;
}

/** Why the monitor reached its verdict — surfaced for logging and tests. */
export type AutoRollbackReason =
  | "disabled"
  | "not-green"
  | "healthy"
  | "breached"
  | "insufficient-data";

/** Outcome of a {@link monitorAndAutoRollback} run. */
export interface AutoRollbackResult {
  rolledBack: boolean;
  reason: AutoRollbackReason;
  /** Highest error rate observed across all samples. */
  peakErrorRate: number;
  /** Requests observed during the window (delta from the baseline). */
  observedRequests: number;
  /** Number of samples actually taken. */
  samples: number;
}

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

const AUTO_ROLLBACK_DEFAULTS: AutoRollbackConfig = {
  enabled: true,
  errorRateThreshold: 0.05,
  soakWindowMs: 30_000,
  sampleIntervalMs: 5_000,
  minRequests: 20,
};

// Defensive bounds so a misconfigured env cannot pin the process in an
// unbounded loop or hammer the metrics registry every millisecond.
const SOAK_WINDOW_BOUNDS = { min: 1_000, max: 600_000 } as const;
const SAMPLE_INTERVAL_BOUNDS = { min: 100, max: 60_000 } as const;

/**
 * Parse and validate the auto-rollback configuration from the environment.
 *
 * Missing variables fall back to safe defaults; variables that are *present
 * but invalid* throw a descriptive (secret-free) error so misconfiguration
 * fails fast rather than silently disabling the safety net.
 *
 * @param env - Environment source (defaults to `process.env`; injectable for tests).
 * @throws {Error} When a provided value is non-numeric or out of range.
 */
export function loadAutoRollbackConfig(
  env: NodeJS.ProcessEnv = process.env
): AutoRollbackConfig {
  const soakWindowMs = clamp(
    parseIntEnv("ROLLBACK_SOAK_WINDOW_MS", env.ROLLBACK_SOAK_WINDOW_MS, AUTO_ROLLBACK_DEFAULTS.soakWindowMs),
    SOAK_WINDOW_BOUNDS.min,
    SOAK_WINDOW_BOUNDS.max
  );
  const sampleIntervalMs = clamp(
    parseIntEnv("ROLLBACK_SAMPLE_INTERVAL_MS", env.ROLLBACK_SAMPLE_INTERVAL_MS, AUTO_ROLLBACK_DEFAULTS.sampleIntervalMs),
    SAMPLE_INTERVAL_BOUNDS.min,
    SAMPLE_INTERVAL_BOUNDS.max
  );

  return {
    enabled: parseBoolEnv(
      "AUTO_ROLLBACK_ENABLED",
      env.AUTO_ROLLBACK_ENABLED,
      AUTO_ROLLBACK_DEFAULTS.enabled
    ),
    errorRateThreshold: parseFloatEnv(
      "ROLLBACK_ERROR_RATE_THRESHOLD",
      env.ROLLBACK_ERROR_RATE_THRESHOLD,
      AUTO_ROLLBACK_DEFAULTS.errorRateThreshold,
      { min: 0, max: 1 }
    ),
    soakWindowMs,
    // A sample interval longer than the window is pointless; cap it so we
    // always take at least one in-window sample.
    sampleIntervalMs: Math.min(sampleIntervalMs, soakWindowMs),
    minRequests: parseIntEnv(
      "ROLLBACK_MIN_REQUESTS",
      env.ROLLBACK_MIN_REQUESTS,
      AUTO_ROLLBACK_DEFAULTS.minRequests,
      { min: 0 }
    ),
  };
}

/**
 * Default error-rate reader: derives 5xx ratio from the `http_requests_total`
 * Prometheus counter in the process-wide registry.
 *
 * Returns zeroed counts when the metric is absent (e.g. before any traffic),
 * which the monitor treats as "no signal yet" rather than a failure.
 */
export async function readErrorRateFromRegistry(): Promise<ErrorRateSample> {
  const metrics = await defaultRegister.getMetricsAsJSON();
  const httpTotal = metrics.find((m) => m.name === "http_requests_total");

  if (!httpTotal || !Array.isArray(httpTotal.values)) {
    return { totalRequests: 0, errorRequests: 0 };
  }

  let totalRequests = 0;
  let errorRequests = 0;
  for (const series of httpTotal.values) {
    const count = Number(series.value);
    if (!Number.isFinite(count)) continue;
    totalRequests += count;
    const status = Number(series.labels?.status_code);
    if (status >= 500 && status <= 599) {
      errorRequests += count;
    }
  }

  return { totalRequests, errorRequests };
}

let _errorRateReader: ErrorRateReader = readErrorRateFromRegistry;

/**
 * Override the error-rate source.
 * Intended for testing only — do not call in production code.
 *
 * @param reader - Async function returning the current cumulative counters.
 */
export function setErrorRateReader(reader: ErrorRateReader): void {
  _errorRateReader = reader;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Watch error-rate metrics for a soak window after a green switch and roll
 * back automatically if the configured threshold is breached.
 *
 * The function is safe to call unconditionally after `switchToGreen`:
 *
 * - It is a no-op (returns `reason: "not-green"`) unless green is currently
 *   active, so it never rolls back a deployment it didn't promote.
 * - The rollback path delegates to {@link rollback}, which is idempotent, so a
 *   repeated or concurrent invocation cannot double-revert.
 * - Every verdict is emitted as a structured `deploy_decision` log.
 *
 * @param overrides - Partial config to override env-derived defaults (tests).
 * @returns A summary of what was observed and whether a rollback was issued.
 */
export async function monitorAndAutoRollback(
  overrides: Partial<AutoRollbackConfig> = {}
): Promise<AutoRollbackResult> {
  const config = { ...loadAutoRollbackConfig(), ...overrides };
  const log = logger.child({ component: "deploy", event: "deploy_decision" });

  if (!config.enabled) {
    log.info("Auto-rollback disabled; retaining deployment without soak", {
      decision: "skip",
      reason: "disabled",
    });
    return { rolledBack: false, reason: "disabled", peakErrorRate: 0, observedRequests: 0, samples: 0 };
  }

  const state = await readState();
  if (state.activeColor !== "green") {
    log.info("Active color is not green; skipping post-switch soak", {
      decision: "skip",
      reason: "not-green",
      activeColor: state.activeColor,
    });
    return { rolledBack: false, reason: "not-green", peakErrorRate: 0, observedRequests: 0, samples: 0 };
  }

  const baseline = await _errorRateReader();
  const sampleCount = Math.max(
    1,
    Math.round(config.soakWindowMs / config.sampleIntervalMs)
  );

  log.info("Starting post-switch soak", {
    decision: "soak_start",
    soakWindowMs: config.soakWindowMs,
    sampleIntervalMs: config.sampleIntervalMs,
    errorRateThreshold: config.errorRateThreshold,
    minRequests: config.minRequests,
  });

  let peakErrorRate = 0;
  let observedRequests = 0;

  for (let sample = 1; sample <= sampleCount; sample += 1) {
    await sleep(config.sampleIntervalMs);

    const current = await _errorRateReader();
    const deltaTotal = Math.max(0, current.totalRequests - baseline.totalRequests);
    const deltaErrors = Math.max(0, current.errorRequests - baseline.errorRequests);
    const errorRate = deltaTotal > 0 ? deltaErrors / deltaTotal : 0;

    observedRequests = deltaTotal;
    if (errorRate > peakErrorRate) peakErrorRate = errorRate;

    // Don't act on a sample too small to be statistically meaningful.
    if (deltaTotal < config.minRequests) {
      log.debug("Soak sample below minimum request volume; ignoring", {
        decision: "observe",
        sample,
        observedRequests: deltaTotal,
        minRequests: config.minRequests,
      });
      continue;
    }

    if (errorRate > config.errorRateThreshold) {
      log.warn("Error-rate threshold breached; triggering automatic rollback", {
        decision: "rollback",
        reason: "breached",
        sample,
        errorRate: round(errorRate),
        errorRateThreshold: config.errorRateThreshold,
        observedRequests: deltaTotal,
        errorRequests: deltaErrors,
      });

      await rollback();
      const after = await getStatus();

      log.warn("Automatic rollback complete", {
        decision: "rolled_back",
        activeColor: after.activeColor,
      });

      return {
        rolledBack: true,
        reason: "breached",
        peakErrorRate,
        observedRequests: deltaTotal,
        samples: sample,
      };
    }

    log.debug("Soak sample within threshold", {
      decision: "observe",
      sample,
      errorRate: round(errorRate),
      observedRequests: deltaTotal,
    });
  }

  const reason: AutoRollbackReason =
    observedRequests < config.minRequests ? "insufficient-data" : "healthy";

  log.info("Soak window completed without breach; deployment retained", {
    decision: "retain",
    reason,
    peakErrorRate: round(peakErrorRate),
    observedRequests,
    samples: sampleCount,
  });

  return { rolledBack: false, reason, peakErrorRate, observedRequests, samples: sampleCount };
}

// ---------------------------------------------------------------------------
// Env parsing helpers
// ---------------------------------------------------------------------------

function parseBoolEnv(
  name: string,
  value: string | undefined,
  fallback: boolean
): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new Error(`Invalid boolean for ${name}: expected true/false`);
}

function parseIntEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  range: { min?: number; max?: number } = {}
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid integer for ${name}`);
  }
  assertRange(name, parsed, range);
  return parsed;
}

function parseFloatEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  range: { min?: number; max?: number } = {}
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}`);
  }
  assertRange(name, parsed, range);
  return parsed;
}

function assertRange(
  name: string,
  value: number,
  { min, max }: { min?: number; max?: number }
): void {
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${name} must be <= ${max}`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round to 4 decimals to keep error-rate logs readable. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === "switch-green") {
    // Promote green, then soak on error-rate metrics and auto-rollback on breach.
    switchToGreen()
      .then(() => monitorAndAutoRollback())
      .then((result) => {
        if (result.rolledBack) process.exitCode = 1;
      })
      .catch(console.error);
  } else if (cmd === "rollback") {
      rollback().catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
  } else if (cmd === "status") {
    getStatus().then(console.log);
  } else if (cmd === "auto-rollback" || cmd === "soak") {
    // Run the soak monitor against the current deployment on its own.
    monitorAndAutoRollback()
      .then((result) => {
        console.log(JSON.stringify(result));
        if (result.rolledBack) process.exitCode = 1;
      })
      .catch(console.error);
  }
}
