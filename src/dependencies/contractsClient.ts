import { AppConfig } from '../appConfiguration';
import { ChaosPolicy } from '../chaos/chaosPolicy';
import { circuitBreakerRegistry } from '../circuit-breaker/registry';
import { CircuitOpenError } from '../circuit-breaker/errors';
import { Contract, ContractsPayload } from '../types/contracts';
import { UpstreamHttpClient, DependencyError } from './upstreamHttpClient';

export { DependencyError };

export enum FailureKind {
  Transport = 'transport',
  RateLimit = 'rate_limit',
  Timeout = 'timeout',
  MalformedResponse = 'malformed_response',
  Contract = 'contract',
  UnknownProviderStatus = 'unknown_provider_status',
  CircuitOpen = 'circuit_open',
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

function getKindFromError(error: unknown): FailureKind {
  if (!error) return FailureKind.Unknown;

  const explicitKind = getErrorProperty(error, 'kind', 'errorKind', 'classification');
  if (explicitKind) {
    const normalized = String(explicitKind).toLowerCase();
    if (normalized.includes('timeout')) return FailureKind.Timeout;
    if (normalized.includes('rate') || normalized.includes('limit')) return FailureKind.RateLimit;
    if (normalized.includes('malformed') || normalized.includes('parse') || normalized.includes('json')) return FailureKind.MalformedResponse;
    if (normalized.includes('contract') || normalized.includes('application') || normalized.includes('rpc')) return FailureKind.Contract;
    if (normalized.includes('circuit')) return FailureKind.CircuitOpen;
  }

  const code = getErrorProperty(error, 'code', 'statusCode', 'status');
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNABORTED') return FailureKind.Timeout;
  if (getErrorProperty(error, 'name') === 'TimeoutError') return FailureKind.Timeout;

  const status = getErrorProperty(error, 'status', 'statusCode', 'response.status');
  if (status === 429) return FailureKind.RateLimit;

  if (error instanceof SyntaxError) return FailureKind.MalformedResponse;

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('payload validation failed')) return FailureKind.MalformedResponse;

  const responseBody = getErrorProperty(error, 'responseBody', 'body', 'response.data');
  if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
    if ('error' in responseBody) return FailureKind.Contract;
  }

  if (status != null) {
    const statusNum = Number(status);
    if (statusNum >= 400 && statusNum < 600) {
      return statusNum >= 500 ? FailureKind.Transport : FailureKind.Contract;
    }
    if (statusNum >= 300 && statusNum < 400) {
      return FailureKind.UnknownProviderStatus;
    }
    return FailureKind.UnknownProviderStatus;
  }

  if (error instanceof DependencyError) {
    return FailureKind.Unknown;
  }

  return FailureKind.Transport;
}

function resolveRetryAfterMs(error: unknown): number | undefined {
  const headers = getErrorProperty(error, 'headers', 'response.headers');
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
  return RETRQABLE_KINDS.has(kind);
}

interface ClassifiedDependencyError extends DependencyError {
  kind: FailureKind;
  retryable: boolean;
  providerCode?: string;
  retryAfterMs?: number;
}

function classifyError(error: unknown): DependencyError {
  const kind = getKindFromError(error);
  const depError = error instanceof DependencyError
    ? error
    : new DependencyError(error instanceof Error ? error.message : 'Upstream dependency unavailable');

  const classified = depError as ClassifiedDependencyError;
  classified.kind = kind;
  classified.retryable = isRetryable(kind);

  const providerCode = getErrorProperty(error, 'providerCode', 'code');
  if (providerCode != null && typeof providerCode === 'string') {
    classified.providerCode = providerCode;
  }

  const retryAfterMs = resolveRetryAfterMs(error);
  if (retryAfterMs != null) {
    classified.retryAfterMs = retryAfterMs;
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
    const { maxAttempts, baseDelayMs, maxDalayMs } = this.retryOptions;
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
        const delayMls = retryAfterMs ?? Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
        await delay(delayMls);
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
        clssified.retryable = false;
        throw depError;
      }
      throw classifyError(error);
    }
  }
}
