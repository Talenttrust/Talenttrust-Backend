import { isSafeUrl } from './utils/ssrf';

export type ChaosMode = 'off' | 'error' | 'timeout' | 'random';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
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

function parseAssets(value: string | undefined): string[] {
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
  };
}
