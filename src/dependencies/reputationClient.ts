/**
 * reputationClient.ts — Reputation upstream client with retry + circuit breaker.
 *
 * All outbound calls to the external reputation service go through this module
 * so that transient failures are retried with exponential backoff + jitter, and
 * persistent degradation is isolated by a per-dependency circuit breaker.
 *
 * ## Design
 *
 * ### Retry classification
 *
 * | Operation | Idempotent? | Retryable failures | Non-retryable failures |
 * |-----------|------------|---------------------|-------------------------|
 * | `getProfile` | Yes (GET) | 5xx, 429, timeouts, network errors | 4xx (client error — will not heal) |
 * | `createRating` | No (POST) | None — never retried | All (caller responsible) |
 * | `listProfiles` | Yes (GET) | 5xx, 429, timeouts, network errors | 4xx |
 *
 * Retryable operations are wrapped in {@link withRetry} for bounded
 * exponential-backoff retries with jitter. Non-retryable operations bypass
 * the retry layer entirely and fail immediately.
 *
 * ### Circuit breaker
 *
 * A per-dependency `CircuitBreaker` (named `"reputation"`) guards all calls.
 * The breaker is registered in `circuitBreakerRegistry` at construction time.
 * Only retryable upstream failures count toward the failure threshold;
 * deterministic application errors (4xx, validation) do not.
 *
 * ### Error handling
 *
 * - `UpstreamUnavailableError` (typed, `code: "upstream_unavailable"`)
 *   is thrown when the circuit is OPEN or when all retries are exhausted.
 * - `ReputationError` wraps non-retryable upstream errors (4xx).
 * - Raw error details are preserved in the error message for logging;
 *   API-facing responses are mapped through the safe error policy.
 *
 * ### Observability
 *
 * Uses the existing `logger` for structured events:
 *  - `reputation_client_retry_attempting`
 *  - `reputation_client_retry_exhausted`
 *  - `reputation_client_circuit_opened`
 *  - `reputation_client_half_open`
 *  - `reputation_client_circuit_closed`
 *  - `reputation_client_request_rejected`
 *
 * ## Usage
 *
 * ```ts
 * import { createReputationClient } from './dependencies/reputationClient';
 *
 * const client = createReputationClient();
 * const profile = await client.getProfile('user-123');
 * ```
 */

import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker/';
import { circuitBreakerRegistry } from '../circuit-breaker/';
import { logger, Logger } from '../logger';
import { withRetry, sleep } from '../utils/retry';
import type { ReputationClientConfig } from './reputationConfig';

// ── Typed errors ────────────────────────────────────────────────────────────

/**
 * Thrown when the upstream reputation service is unavailable — either because
 * the circuit breaker is OPEN or all retries were exhausted.
 *
 * Carries a stable machine-readable code (`upstream_unavailable`) so API
 * handlers can return HTTP 503 without leaking internals.
 */
export class UpstreamUnavailableError extends Error {
  /** Stable machine-readable error code. */
  readonly code = 'upstream_unavailable';
  /** The reason the upstream was unavailable (for logs). */
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? `Reputation service unavailable: ${reason}`);
    this.name = 'UpstreamUnavailableError';
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Wraps a non-retryable error from the reputation upstream (e.g. HTTP 4xx).
 * The `status` and `body` fields are preserved for logging; never expose them
 * in API responses directly.
 */
export class ReputationError extends Error {
  /** HTTP status code returned by the upstream. */
  readonly status: number;
  /** Parsed response body (for logs / debugging only). */
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Reputation upstream error ${status}`);
    this.name = 'ReputationError';
    this.status = status;
    this.body = body;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Retry classification ─────────────────────────────────────────────────────

/**
 * Decides whether a given error should trigger a retry.
 *
 * Retryable:
 *  - connection / timeout / network errors (not `ReputationError`)
 *  - 5xx `ReputationError` (server transient)
 *  - 429 `ReputationError` (rate-limited)
 *
 * Non-retryable:
 *  - 4xx (except 429) `ReputationError` — caller bug, won't heal
 *  - `UpstreamUnavailableError` already includes a reason; no point retrying
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof UpstreamUnavailableError) return false;
  if (error instanceof ReputationError) {
    if (error.status === 429) return true;
    if (error.status >= 500 && error.status < 600) return true;
    if (error.status === 0) return true; // timeout / no HTTP response received
    return false;
  }
  // Network / timeout / connection errors are retryable.
  return true;
}

/**
 * Decides whether a given error should count as a circuit-breaker failure.
 * Same rules as {@link isRetryable} — deterministic/caller errors don't count.
 *
 * This predicate is passed to `breaker.execute(fn, { recordFailure })` so
 * that a 400 never contributes to the failure threshold even if the caller
 * passes `maxAttempts: 1`.
 */
function recordsBreakerFailure(error: unknown): boolean {
  if (error instanceof UpstreamUnavailableError) return false;
  if (error instanceof ReputationError) {
    if (error.status === 429) return true;
    if (error.status >= 500 && error.status < 600) return true;
    if (error.status === 0) return true; // timeout counts toward the threshold
    return false;
  }
  return true; // network errors count
}

// ── Types for upstream payloads ──────────────────────────────────────────────

/** Profile returned by the external reputation service. */
export interface ReputationProfileResponse {
  freelancerId: string;
  score: number;
  weightedScore: number;
  totalRatings: number;
  reviews: Array<{
    reviewerId: string;
    rating: number;
    comment?: string;
    createdAt: string;
  }>;
}

/** Rating submitted to the external reputation service. */
export interface CreateRatingRequest {
  reviewerId: string;
  targetId: string;
  rating: number;
  contextId: string;
  comment?: string;
}

/** Response from the external reputation service after creating a rating. */
export interface CreateRatingResponse {
  id: string;
  reviewerId: string;
  targetId: string;
  rating: number;
  createdAt: string;
}

// ── Injectable transport (for testing) ───────────────────────────────────────

/**
 * Injectable HTTP transport. Default uses global `fetch`.
 *
 * Contract: must throw on non-2xx, on network error, or on timeout.
 * A successful response must be returned with a `status` and parsed JSON `data`.
 */
export type HttpTransport = (
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<{ status: number; data: unknown }>;

/**
 * Default production transport using the global `fetch` API.
 *
 * @throws {@link ReputationError} on non-2xx status codes.
 * @throws {Error} on network failures, aborted signals, or JSON parse errors.
 */
async function defaultTransport(
  url: string,
  options: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
): Promise<{ status: number; data: unknown }> {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body,
    signal: options.signal,
  });

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ReputationError(response.status, null, `Unparseable response body (status ${response.status})`);
  }

  if (!response.ok) {
    throw new ReputationError(response.status, data, `HTTP ${response.status}`);
  }

  return { status: response.status, data };
}

// ── Client ───────────────────────────────────────────────────────────────────

/** Injected dependencies — everything swappable for tests. */
export interface ReputationClientDeps {
  /** HTTP transport function. */
  transport?: HttpTransport;
  /** Logger instance — defaults to the root logger. */
  log?: Logger;
  /** Injectable `sleep` for deterministic retry-backoff tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Reputation upstream client with retry, circuit breaker, and observability.
 *
 * All operations may throw:
 *  - {@link UpstreamUnavailableError} when the circuit is OPEN or retries are exhausted.
 *  - {@link ReputationError} for non-retryable upstream errors (4xx, unparseable body).
 */
export class ReputationClient {
  private readonly breaker: CircuitBreaker;
  private readonly transport: HttpTransport;
  private readonly log: Logger;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly config: ReputationClientConfig,
    deps: ReputationClientDeps = {},
  ) {
    this.transport = deps.transport ?? defaultTransport;
    this.log = deps.log ?? logger;
    this.sleepFn = deps.sleepFn ?? sleep;

    // Register breaker in the global registry (idempotent — safe to call multiple times).
    this.breaker = circuitBreakerRegistry.getOrCreate('reputation', {
      name: 'reputation',
      failureThreshold: config.cbFailureThreshold,
      successThreshold: config.cbSuccessThreshold,
      timeout: config.cbTimeoutMs,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Fetches a single reputation profile. **Idempotent (GET)** — retried on
   * transient failures.
   *
   * @param freelancerId - The target user ID.
   * @returns The reputation profile.
   * @throws {@link UpstreamUnavailableError} if the circuit is OPEN or retries exhausted.
   * @throws {@link ReputationError} for non-retryable upstream errors.
   */
  async getProfile(freelancerId: string): Promise<ReputationProfileResponse> {
    const url = `${this.config.baseUrl}/${encodeURIComponent(freelancerId)}`;
    return this.executeWithResilience('getProfile', () =>
      this.singleRequest<ReputationProfileResponse>(url, 'GET'),
    );
  }

  /**
   * Lists reputation profiles. **Idempotent (GET)** — retried on transient failures.
   *
   * @param params - Optional query parameters (limit, offset, etc.).
   * @returns Array of profiles.
   * @throws {@link UpstreamUnavailableError} if the circuit is OPEN or retries exhausted.
   */
  async listProfiles(
    params?: { limit?: number; offset?: number },
  ): Promise<ReputationProfileResponse[]> {
    const qs = new URLSearchParams();
    if (params?.limit !== undefined) qs.set('limit', String(params.limit));
    if (params?.offset !== undefined) qs.set('offset', String(params.offset));
    const queryPart = qs.toString();
    const url = `${this.config.baseUrl}${queryPart ? `?${queryPart}` : ''}`;
    return this.executeWithResilience('listProfiles', () =>
      this.singleRequest<ReputationProfileResponse[]>(url, 'GET'),
    );
  }

  /**
   * Creates a reputation rating. **NOT idempotent (POST)** — never retried.
   * The circuit breaker still guards the call: if the breaker is OPEN the call
   * fails immediately with {@link UpstreamUnavailableError}.
   *
   * @param rating - The rating to submit.
   * @returns The created rating entry.
   * @throws {@link UpstreamUnavailableError} if the circuit is OPEN.
   * @throws {@link ReputationError} for any upstream error.
   */
  async createRating(rating: CreateRatingRequest): Promise<CreateRatingResponse> {
    const url = this.config.baseUrl;

    // Breaker check happens first — fail fast if OPEN.
    if (this.breaker.getState() === 'OPEN') {
      this.log.warn('reputation_client_request_rejected', {
        dependency: 'reputation',
        operation: 'createRating',
        breaker_state: 'OPEN',
        reason: 'Circuit breaker is OPEN',
      });
      throw new UpstreamUnavailableError('circuit_open');
    }

    try {
      return await this.breaker.execute(
        () => this.singleRequest<CreateRatingResponse>(url, 'POST', rating),
        { recordFailure: recordsBreakerFailure },
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new UpstreamUnavailableError('circuit_open');
      }
      throw err;
    }
  }

  /**
   * Returns the current state of the underlying circuit breaker.
   */
  getBreakerState() {
    return this.breaker.getState();
  }

  /**
   * Returns stats for the underlying circuit breaker.
   */
  getBreakerStats() {
    return this.breaker.getStats();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Executes an idempotent operation with retry + circuit-breaker protection.
   *
   * Retries happen BELOW the circuit breaker: a transient blip that recovers
   * within the retry budget counts as a single circuit-breaker success.
   *
   * Exhausted retries open the circuit automatically.
   */
  private async executeWithResilience<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.breaker.execute(
        () =>
          withRetry(
            async () => {
              try {
                return await fn();
              } catch (err) {
                // If the breaker tripped mid-call, surface as typed error.
                if (err instanceof CircuitOpenError) throw err;
                throw err;
              }
            },
            {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
              jitter: true,
              isRetryable,
              sleepFn: this.sleepFn,
              onRetry: (err, attempt, delayMs) => {
                this.log.warn('reputation_client_retry_attempting', {
                  dependency: 'reputation',
                  operation,
                  attempt_number: attempt,
                  max_attempts: this.config.maxAttempts,
                  delay_ms: delayMs,
                  error: err instanceof Error ? err.message : String(err),
                });
              },
            },
          ),
        { recordFailure: recordsBreakerFailure },
      );
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        this.log.warn('reputation_client_request_rejected', {
          dependency: 'reputation',
          operation,
          breaker_state: 'OPEN',
          reason: 'Circuit breaker is OPEN',
        });
        throw new UpstreamUnavailableError('circuit_open');
      }

      // Exhausted retries — log and throw typed error.
      if (err instanceof ReputationError && isRetryable(err)) {
        this.log.error('reputation_client_retry_exhausted', {
          dependency: 'reputation',
          operation,
          final_status: err.status,
          max_attempts: this.config.maxAttempts,
        });
        throw new UpstreamUnavailableError('retries_exhausted');
      }

      // Any other error that is retryable in nature (network, timeout) →
      // also counts as upstream_unavailable after retries are done.
      if (err instanceof Error && isRetryable(err)) {
        this.log.error('reputation_client_retry_exhausted', {
          dependency: 'reputation',
          operation,
          error_message: err.message,
          max_attempts: this.config.maxAttempts,
        });
        throw new UpstreamUnavailableError('retries_exhausted');
      }

      // Non-retryable errors (4xx, validation) pass through unchanged.
      throw err;
    }
  }

  /**
   * Performs a single HTTP request with a per-call AbortController timeout.
   * Never retries — retry is the responsibility of the caller.
   */
  private async singleRequest<T>(url: string, method: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const { data } = await this.transport(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      return data as T;
    } catch (err) {
      // If the abort signal fired, convert to a ReputationError so the retry
      // classifier sees it as transient.
      if (controller.signal.aborted && !(err instanceof ReputationError)) {
        throw new ReputationError(0, null, 'Request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a ReputationClient from environment-validated configuration.
 *
 * On the first call, registers the `"reputation"` circuit breaker in the
 * global registry. Subsequent calls return the same breaker instance.
 *
 * Use this factory in app startup code. For tests, construct
 * {@link ReputationClient} directly with a test configuration + fake transport.
 */
let _defaultClient: ReputationClient | null = null;

export function createReputationClient(deps?: ReputationClientDeps): ReputationClient {
  if (_defaultClient) return _defaultClient;

  // Lazy-import to avoid import cycles with appConfiguration.
  const { loadReputationClientConfig } = require('./reputationConfig');
  const config = loadReputationClientConfig();

  _defaultClient = new ReputationClient(config, deps);
  return _defaultClient;
}

/** Resets the singleton (for tests). */
export function _resetReputationClientSingleton(): void {
  _defaultClient = null;
}
