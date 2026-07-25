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
  idempotencyTtlMs: number;
  allowedAssets: string[];
}

const MAX_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;

function toNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseChaosMode(value: string | undefined): ChaosMode {
  const mode = (value ?? 'off').toLowerCase();
  if (mode === 'error' || mode === 'timeout' || mode === 'random') {
    return mode;
  }
  return 'off';
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value.toLowerCase() === 'true';
}

function parseTargets(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function _parseAssets(value: string | undefined): string[] {
  if (!value) {
    return ['USDC', 'XLM', 'BTC', 'ETH']; // Default assets
  }

  return value
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = clamp(toNumber(env.PORT, 3001), 1, 65535);
  const upstreamTimeoutMs = clamp(toNumber(env.UPSTREAM_TIMEOUT_MS, 1200), MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const chaosProbability = clamp(toNumber(env.CHAOS_PROBABILITY, 0), 0, 1);
  const idempotencyTtlMs = clamp(toNumber(env.IDEMPOTENCY_TTL_MS, 3_600_000), 0, 7 * 24 * 60 * 60 * 1000);

  return {
    port,
    gracefulDegradationEnabled: parseBoolean(env.GRACEFUL_DEGRADATION_ENABLED, true),
    upstreamContractsUrl: (() => {
      const url = env.UPSTREAM_CONTRACTS_URL ?? 'https://example.invalid/contracts';
      if (!isSafeUrl(url)) {
        throw new Error(`Invalid UPSTREAM_CONTRACTS_URL: SSRF protection blocked access to internal resource "${url}"`);
      }
      return url;
    })(),
    upstreamTimeoutMs,
    chaosMode: parseChaosMode(env.CHAOS_MODE),
    chaosTargets: parseTargets(env.CHAOS_TARGETS),
    chaosProbability,
    circuitBreaker: {
      failureThreshold: clamp(toNumber(env.CB_FAILURE_THRESHOLD, 5), 1, 100),
      successThreshold: clamp(toNumber(env.CB_SUCCESS_THRESHOLD, 1), 1, 20),
      timeoutMs: clamp(toNumber(env.CB_TIMEOUT_MS, 30_000), 1_000, 300_000),
    },
    webhookRetry: {
      maxAttempts: clamp(toNumber(env.WEBHOOK_RETRY_MAX_ATTEMPTS, 5), 1, 20),
      initialDelayMs: clamp(toNumber(env.WEBHOOK_RETRY_INITIAL_DELAY_MS, 1_000), 100, 60_000),
      maxDelayMs: clamp(toNumber(env.WEBHOOK_RETRY_MAX_DELAY_MS, 30_000), 1_000, 600_000),
      multiplier: clamp(toNumber(env.WEBHOOK_RETRY_MULTIPLIER, 2), 1, 10),
      jitterFactor: clamp(toNumber(env.WEBHOOK_RETRY_JITTER_FACTOR, 0.1), 0, 1),
    },
    webhookCircuitBreaker: {
      failureThreshold: clamp(toNumber(env.WEBHOOK_CB_FAILURE_THRESHOLD, 5), 1, 100),
      successThreshold: clamp(toNumber(env.WEBHOOK_CB_SUCCESS_THRESHOLD, 1), 1, 20),
      timeoutMs: clamp(toNumber(env.WEBHOOK_CB_TIMEOUT_MS, 60_000), 1_000, 300_000),
    },
    idempotencyTtlMs,
    allowedAssets: _parseAssets(env.ALLOWED_ASSETS),
  };
}
