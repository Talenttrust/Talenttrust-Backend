import { isSafeUrl } from './utils/ssrf';

export type ChaosMode = 'off' | 'error' | 'timeout' | 'random';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
}

/**
 * Webhook retry policy configuration for transient failure recovery.
 * Controls exponential backoff with jitter for retrying webhook deliveries
 * before enqueuing to DLQ.
 */
export interface WebhookRetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterFactor: number;
}

export interface HealthProbeConfig {
  queueFailedThreshold: number;
  queueBacklogThreshold: number;
  queueProbeTimeoutMs: number;
}

export interface AppConfig {
  port: number;
  gracefulDegradationEnabled: boolean;
  upstreamContractsUrl: string;
  upstreamTimeoutMs: number;
  chaosMode: ChaosMode;
  chaosTargets: string[];
  chaosProbability: number;
  circuitBreaker: CircuitBreakerConfig;
  webhookRetry: WebhookRetryConfig;
  /**
   * Per-provider circuit-breaker configuration for outbound webhook delivery.
   * Thresholds are intentionally separate from the RPC circuit breaker so
   * webhook and RPC failure modes can be tuned independently.
   */
  webhookCircuitBreaker: CircuitBreakerConfig;
  healthProbes: HealthProbeConfig;
  idempotencyTtlMs: number;
  allowedAssets: string[];
  /**
   * When `true` (default), milestones are validated and enforced through the
   * contracts API. When `false`, milestone fields are stripped from incoming
   * requests so the feature is entirely disabled at runtime without a deploy.
   */
  milestonesEnabled: boolean;
}

export type ConfigLifecycleState = 'UNINITIALIZED' | 'ACTIVE' | 'RECONFIGURING';

export interface ConfigurationStateSnapshot {
  readonly state: ConfigLifecycleState;
  readonly config: AppConfig;
  readonly version: number;
  readonly updatedAt: Date;
}

export class ConfigurationAuthError extends Error {
  constructor(message: string = 'Unauthorized attempt to modify configuration state') {
    super(message);
    this.name = 'ConfigurationAuthError';
  }
}

export class ConfigurationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationStateError';
  }
}

const MAX_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const DEFAULT_ALLOWED_ASSETS: readonly string[] = Object.freeze(['USDC', 'XLM', 'BTC', 'ETH']);
const ASSET_CODE_REGEX = /^[A-Z0-9_-]{1,12}$/;

/**
 * Recursively freezes an object and its nested properties to guarantee
 * runtime immutability and protect against post-creation state corruption.
 */
export function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  const seen = new WeakSet<object>();

  function freezeRecursive(current: any): void {
    if (current === null || typeof current !== 'object' || seen.has(current)) {
      return;
    }
    seen.add(current);

    Object.freeze(current);

    for (const key of Object.keys(current)) {
      const val = current[key];
      if (val !== null && typeof val === 'object') {
        freezeRecursive(val);
      }
    }
  }

  freezeRecursive(obj);
  return obj as Readonly<T>;
}

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = typeof value === 'string' ? value.trim() : String(value).trim();
  if (trimmed === '') {
    return fallback;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && !Number.isNaN(parsed) ? parsed : fallback;
}

function toInteger(value: string | undefined, fallback: number): number {
  const num = toNumber(value, fallback);
  return Math.trunc(num);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseChaosMode(value: string | undefined): ChaosMode {
  if (!value) {
    return 'off';
  }
  const mode = value.trim().toLowerCase();
  if (mode === 'error' || mode === 'timeout' || mode === 'random') {
    return mode;
  }
  return 'off';
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  const trimmed = String(value).trim().toLowerCase();
  return trimmed === 'true';
}

function parseTargets(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const tokens = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  // Invariant: Deduplicate targets while preserving order
  return Array.from(new Set(tokens));
}

export function parseAssets(value: string | undefined): string[] {
  if (!value) {
    return [...DEFAULT_ALLOWED_ASSETS];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [...DEFAULT_ALLOWED_ASSETS];
  }

  const tokens = trimmed
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0);

  if (tokens.length === 0) {
    return [...DEFAULT_ALLOWED_ASSETS];
  }

  // Invariant: Deduplicate assets while preserving order
  const unique = Array.from(new Set(tokens));

  // Invariant: Enforce valid asset format and sanitize
  const valid = unique.filter((asset) => ASSET_CODE_REGEX.test(asset));

  return valid.length > 0 ? valid : [...DEFAULT_ALLOWED_ASSETS];
}

// Backwards-compatible alias
export const _parseAssets = parseAssets;

function sanitizeUrlForDiagnostics(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return urlString.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@');
  }
}

function resolveUpstreamContractsUrl(rawUrl: string | undefined): string {
  const trimmed = rawUrl?.trim();
  const url = trimmed && trimmed.length > 0 ? trimmed : 'https://example.invalid/contracts';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_err) {
    throw new Error(`Invalid UPSTREAM_CONTRACTS_URL: Malformed URL "${sanitizeUrlForDiagnostics(url)}"`);
  }

  // Protocol invariant: Only HTTP and HTTPS are permitted
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid UPSTREAM_CONTRACTS_URL: Forbidden protocol "${parsed.protocol}". Only HTTP and HTTPS are permitted.`
    );
  }

  // SSRF Invariant: Access to internal/private resources must be rejected
  if (!isSafeUrl(url)) {
    throw new Error(
      `Invalid UPSTREAM_CONTRACTS_URL: SSRF protection blocked access to internal resource "${sanitizeUrlForDiagnostics(url)}"`
    );
  }

  return url;
}

/**
 * Loads, validates, and deep-freezes the application configuration from environment variables.
 *
 * Invariants Enforced:
 * 1. Data Integrity: All inputs are normalized, bounds-clamped, and sanitized.
 * 2. Cross-Field Consistency: Webhook retry max delay is guaranteed to be >= initial delay.
 * 3. Security: Upstream contract URLs are validated against SSRF and restricted to HTTP(S).
 * 4. Immutability: The returned configuration and all nested structures are recursively frozen.
 * 5. Determinism: Duplicate list entries (allowedAssets, chaosTargets) are deduplicated in order.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = clamp(toInteger(env.PORT, 3001), 1, 65535);
  const upstreamTimeoutMs = clamp(toInteger(env.UPSTREAM_TIMEOUT_MS, 1200), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const chaosProbability = clamp(toNumber(env.CHAOS_PROBABILITY, 0), 0, 1);
  const idempotencyTtlMs = clamp(toInteger(env.IDEMPOTENCY_TTL_MS, 3_600_000), 0, 7 * 24 * 60 * 60 * 1000);

  const initialDelayMs = clamp(toInteger(env.WEBHOOK_RETRY_INITIAL_DELAY_MS, 1_000), 100, 60_000);
  const rawMaxDelayMs = clamp(toInteger(env.WEBHOOK_RETRY_MAX_DELAY_MS, 30_000), 1_000, 600_000);
  // Cross-field invariant: maxDelayMs must always be >= initialDelayMs
  const maxDelayMs = Math.max(initialDelayMs, rawMaxDelayMs);

  const config: AppConfig = {
    port,
    gracefulDegradationEnabled: parseBoolean(env.GRACEFUL_DEGRADATION_ENABLED, true),
    upstreamContractsUrl: resolveUpstreamContractsUrl(env.UPSTREAM_CONTRACTS_URL),
    upstreamTimeoutMs,
    chaosMode: parseChaosMode(env.CHAOS_MODE),
    chaosTargets: parseTargets(env.CHAOS_TARGETS),
    chaosProbability,
    circuitBreaker: {
      failureThreshold: clamp(toInteger(env.CB_FAILURE_THRESHOLD, 5), 1, 100),
      successThreshold: clamp(toInteger(env.CB_SUCCESS_THRESHOLD, 1), 1, 20),
      timeoutMs: clamp(toInteger(env.CB_TIMEOUT_MS, 30_000), 1_000, 300_000),
    },
    webhookRetry: {
      maxAttempts: clamp(toInteger(env.WEBHOOK_RETRY_MAX_ATTEMPTS, 5), 1, 20),
      initialDelayMs,
      maxDelayMs,
      multiplier: clamp(toNumber(env.WEBHOOK_RETRY_MULTIPLIER, 2), 1, 10),
      jitterFactor: clamp(toNumber(env.WEBHOOK_RETRY_JITTER_FACTOR, 0.1), 0, 1),
    },
    webhookCircuitBreaker: {
      failureThreshold: clamp(toInteger(env.WEBHOOK_CB_FAILURE_THRESHOLD, 5), 1, 100),
      successThreshold: clamp(toInteger(env.WEBHOOK_CB_SUCCESS_THRESHOLD, 1), 1, 20),
      timeoutMs: clamp(toInteger(env.WEBHOOK_CB_TIMEOUT_MS, 60_000), 1_000, 300_000),
    },
    healthProbes: {
      queueFailedThreshold: clamp(toInteger(env.QUEUE_FAILED_THRESHOLD, 10), 0, 10_000),
      queueBacklogThreshold: clamp(toInteger(env.QUEUE_BACKLOG_THRESHOLD, 100), 0, 1_000_000),
      queueProbeTimeoutMs: clamp(toInteger(env.QUEUE_PROBE_TIMEOUT_MS, 3_000), 100, 30_000),
    },
    idempotencyTtlMs,
    allowedAssets: parseAssets(env.ALLOWED_ASSETS),
    milestonesEnabled: parseBoolean(env.MILESTONES_ENABLED, true),
  };

  return deepFreeze(config) as AppConfig;
}

/**
 * Thread-safe configuration state manager that controls lifecycle transitions,
 * enforces authorization for dynamic updates, and ensures concurrency safety
 * with atomic snapshot swaps.
 */
export class ConfigurationStateManager {
  private currentSnapshot: ConfigurationStateSnapshot;
  private readonly configAuthSecret?: string;

  constructor(authSecret?: string) {
    this.configAuthSecret = authSecret ?? process.env.CONFIG_ADMIN_SECRET;
    this.currentSnapshot = {
      state: 'UNINITIALIZED',
      config: null as unknown as AppConfig,
      version: 0,
      updatedAt: new Date(0),
    };
  }

  /**
   * Returns the current lifecycle state.
   */
  getState(): ConfigLifecycleState {
    return this.currentSnapshot.state;
  }

  /**
   * Returns current version counter.
   */
  getVersion(): number {
    return this.currentSnapshot.version;
  }

  /**
   * Returns snapshot metadata.
   */
  getSnapshot(): ConfigurationStateSnapshot {
    return this.currentSnapshot;
  }

  /**
   * Retrieves the active configuration. If uninitialized, lazily initializes it.
   */
  getConfig(): AppConfig {
    if (this.currentSnapshot.state === 'UNINITIALIZED') {
      this.initialize();
    }
    return this.currentSnapshot.config;
  }

  /**
   * Initializes configuration state. Idempotent if already active.
   */
  initialize(env: NodeJS.ProcessEnv = process.env): AppConfig {
    if (this.currentSnapshot.state === 'ACTIVE') {
      return this.currentSnapshot.config;
    }

    const config = loadConfig(env);
    this.currentSnapshot = deepFreeze({
      state: 'ACTIVE',
      config,
      version: 1,
      updatedAt: new Date(),
    });

    return this.currentSnapshot.config;
  }

  /**
   * Reconfigures application configuration dynamically.
   *
   * State Invariants Enforced:
   * - Authorization: Reconfiguration requires matching secret if one is configured.
   * - Transition: Only valid from ACTIVE or UNINITIALIZED state.
   * - Atomic swap: If new config validation fails, previous active config remains intact.
   */
  reconfigure(newEnv: NodeJS.ProcessEnv, authSecret?: string): AppConfig {
    if (this.configAuthSecret) {
      if (!authSecret || authSecret !== this.configAuthSecret) {
        throw new ConfigurationAuthError();
      }
    }

    // Load and validate new configuration atomically
    const newConfig = loadConfig(newEnv);

    // Atomically swap snapshot to new version
    const nextVersion = this.currentSnapshot.version + 1;
    this.currentSnapshot = deepFreeze({
      state: 'ACTIVE',
      config: newConfig,
      version: nextVersion,
      updatedAt: new Date(),
    });

    return this.currentSnapshot.config;
  }

  /**
   * Resets state back to UNINITIALIZED. Primarily for test isolation.
   */
  reset(): void {
    this.currentSnapshot = {
      state: 'UNINITIALIZED',
      config: null as unknown as AppConfig,
      version: 0,
      updatedAt: new Date(0),
    };
  }
}

// Global default singleton instance
export const appConfigManager = new ConfigurationStateManager();
