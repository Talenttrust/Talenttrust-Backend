import { AppConfig } from '../appConfiguration';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import { CircuitOpenError } from '../circuit-breaker/errors';
import { classifySorobanError } from '../circuit-breaker/CircuitBreaker';
import { Contract, ContractsPayload } from '../types/contracts';
import { UpstreamHttpClient, DependencyError } from './upstreamHttpClient';

export { DependencyError };

export enum FailureKind {
  Transport = 'transport',
  RateLimit = 'rate-limit',
  Timeout = 'timeout',
  MalformedResponse = 'malformed-response',
  Contract = 'contract-error',
  UnknownProviderStatus = 'unknown-provider-status',
  CircuitOpen = 'circuit-open',
  Unknown = 'unknown',
}

const RETRYABLE_KINDS: ReadonlySet<FailureKind> = new Set([
  FailureKind.Transport,
  FailureKind.RateLimit,
  FailureKind.Timeout,
]);

const DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
} as const;

type ErrorLike = Record<string, any>;

function getErrorProperty(error: unknown, ...keys: string[]): any {
  if (error && typeof error === 'object') {
    for (const key of keys) {
      const value = (error as ErrorLike)[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Resolve the upstream provider's error code. Prefers an explicit code
 * carried on the failing error, then falls back to the `error.code` field of
 * a structured JSON failure body (`{ error: { code } }`).
 */
function getProviderCode(error: unknown): string | undefined {
  const direct = getErrorProperty(error, 'providerCode', 'code');
  if (direct != null && typeof direct === 'string') return direct;

  const responseBody = getErrorProperty(error, 'responseBody', 'body', 'response.data');
  if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
    const nested = (responseBody as ErrorLike).error;
    if (nested && typeof nested === 'object' && typeof nested.code === 'string') {
      return nested.code;
    }
  }
  return undefined;
/** Returns the root error, unwrapping DependencyError causes. */
function unwrapCause(error: unknown): unknown {
  let current = error;
  const seen = new Set<unknown>();
  while (
    current instanceof DependencyError &&
    current.cause !== undefined &&
    !seen.has(current)
  ) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

function getKindFromError(error: unknown): FailureKind {
  if (!error) return FailureKind.Unknown;

  // Classify from the root cause so wrapped upstream errors (e.g. from
  // UpstreamHttpClient) keep their original status/code/body context.
  const root = unwrapCause(error);
  const classification = classifySorobanError(root);
  switch (classification.class) {
    case 'timeout':
      return FailureKind.Timeout;
    case 'rate_limit':
      return FailureKind.RateLimit;
    case 'malformed_response':
      return FailureKind.MalformedResponse;
    case 'application':
      return FailureKind.Contract;
    case 'transport':
    case 'unknown':
      break;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return FailureKind.Timeout;
  if (message.includes('payload validation failed')) return FailureKind.MalformedResponse;
  if (message.includes('provider error')) return FailureKind.Contract;

  const responseBody = getErrorProperty(root, 'responseBody', 'body', 'response.data');
  if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
    if ('error' in responseBody) return FailureKind.Contract;
  }

  // An upstream HTTP status that the classifier mapped to a generic transport
  // failure is still a provider signal — surface it as an unknown provider
  // status rather than masking it as a low-level transport error.
  const status =
    getErrorProperty(root, 'status', 'statusCode') ??
    (root as ErrorLike)?.response?.status;
  if (status != null) {
    return FailureKind.UnknownProviderStatus;
  }

  const explicitKind = getErrorProperty(error, 'kind', 'errorKind', 'classification');
  if (explicitKind) {
    const normalized = String(explicitKind).toLowerCase();
    if (normalized.includes('timeout')) return FailureKind.Timeout;
    if (normalized.includes('rate') || normalized.includes('limit')) return FailureKind.RateLimit;
    if (normalized.includes('malformed') || normalized.includes('parse') || normalized.includes('json')) return FailureKind.MalformedResponse;
    if (normalized.includes('contract') || normalized.includes('application') || normalized.includes('rpc')) return FailureKind.Contract;
    if (normalized.includes('circuit')) return FailureKind.CircuitOpen;
  }

  if (root instanceof DependencyError) {
    return FailureKind.Unknown;
  }

  return FailureKind.Transport;
}

function resolveRetryAfterMs(error: unknown): number | undefined {
  const root = unwrapCause(error);
  const headers = getErrorProperty(root, 'headers') ?? (root as ErrorLike)?.response?.headers;
  if (headers) {
    const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
    if (retryAfter != null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
      }
    }
  }
  return undefined;
}

function isRetryable(kind: FailureKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

interface ClassifiedDependencyError extends DependencyError {
  kind: FailureKind;
  retryable: boolean;
  providerCode?: string;
  retryAfterMs?: number;
  retryAfter?: number;
}

function classifyError(error: unknown): DependencyError {
  const kind = getKindFromError(error);
  const depError = error instanceof DependencyError
    ? error
    : new DependencyError(error instanceof Error ? error.message : 'Upstream dependency unavailable');

  const classified = depError as ClassifiedDependencyError;
  classified.kind = kind;
  classified.retryable = isRetryable(kind);

  const providerCode = getProviderCode(error);
  if (providerCode != null) {
  // Provider code resolution: prefer an explicit code, then the upstream
  // response body (e.g. RPC `{ error: { code } }` payloads).
  const root = unwrapCause(error);
  const responseBody = getErrorProperty(root, 'responseBody', 'body', 'response.data');
  const providerCode =
    getErrorProperty(error, 'providerCode') ??
    getErrorProperty(error, 'code') ??
    (responseBody && typeof responseBody === 'object' && 'error' in responseBody
      ? getErrorProperty((responseBody as ErrorLike).error, 'code')
      : undefined) ??
    // The root cause may itself be the provider error body (e.g. RPC payloads).
    (root && typeof root === 'object' && 'error' in (root as ErrorLike)
      ? getErrorProperty((root as ErrorLike).error, 'code')
      : undefined) ??
    // Axios-style errors carry the body under `response.data`.
    getErrorProperty((root as ErrorLike)?.response?.data?.error, 'code');
  if (providerCode != null && typeof providerCode === 'string') {
    classified.providerCode = providerCode;
  }

  const retryAfterMs = resolveRetryAfterMs(error);
  if (retryAfterMs != null) {
    classified.retryAfterMs = retryAfterMs;
    // Seconds, matching the Retry-After header convention.
    classified.retryAfter = retryAfterMs / 1000;
  }

  return depError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches contracts from an upstream dependency and can inject outages for resilience testing.
 * Wraps calls in a circuit breaker to prevent cascading failures.
 */
export class ContractsClient {
  private readonly client: UpstreamHttpClient;
  private readonly retryOptions: typeof DEFAULT_RETRY_OPTIONS;

  constructor(
    private readonly config: Pick<AppConfig, 'upstreamContractsUrl' | 'upstreamTimeoutMs' | 'circuitBreaker'>,
    chaosPolicy: ChaosPolicy,
  ) {
    this.client = new UpstreamHttpClient(
      {
        dependencyName: 'contracts',
        baseUrl: this.config.upstreamContractsUrl,
        timeoutMs: this.config.upstreamTimeoutMs,
        retryOptions: { maxAttempts: 1 }, // Retries are handled by this client to classify failures correctly.
      },
      chaosPolicy
    );

    circuitBreakerRegistry.getOrCreate('contracts', {
      failureThreshold: this.config.circuitBreaker.failureThreshold,
      successThreshold: this.config.circuitBreaker.successThreshold,
      timeout: this.config.circuitBreaker.timeoutMs,
    });

    this.retryOptions = DEFAULT_RETRY_OPTIONS;
  }

  private async requestWithRetry<T>(
    path: string,
    options?: any,
  ): Promise<T> {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.retryOptions;
    let lastError: DependencyError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.client.get<T>(path, options);
      } catch (error) {
        const classified = classifyError(error);
        lastError = classified;
        if (!classified.retryable || attempt === maxAttempts) {
          throw classified;
        }
        const retryAfterMs = (classified as ClassifiedDependencyError).retryAfterMs;
        const delayMs = retryAfterMs ?? Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        await delay(delayMs);
      }
    }
    throw lastError ?? new DependencyError('Upstream dependency unavailable');
  }

  async getContracts(): Promise<Contract[]> {
    const breaker = circuitBreakerRegistry.getOrCreate('contracts');
    try {
      return await breaker.execute(async () => {
        const payload = await this.requestWithRetry<ContractsPayload>('', {
          headers: { Accept: 'application/json' },
        });

        // Upstream error-shaped responses (e.g. provider RPC errors) are
        // contract failures, not payload validation failures.
        if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'error' in payload) {
          throw new DependencyError('Upstream returned a provider error', { cause: payload });
        }

        if (!payload || !Array.isArray(payload.contracts)) {
          throw new DependencyError('Upstream payload validation failed');
        }

        return payload.contracts;
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        const depError = new DependencyError(`Circuit breaker open: ${error.message}`);
        const classified = depError as ClassifiedDependencyError;
        classified.kind = FailureKind.CircuitOpen;
        classified.retryable = false;
        throw depError;
      }
      throw classifyError(error);
    }
  }
}
