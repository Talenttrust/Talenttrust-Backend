/**
 * CircuitBreaker.ts — Generic circuit-breaker implementation.
 *
 * Protects any async operation (RPC call, HTTP fetch, DB query) from
 * cascading failures when an upstream dependency degrades.
 *
 * ## State machine
 *
 *   CLOSED ──(failures >= threshold)──► OPEN
 *   OPEN   ──(timeout elapsed)   ──────► HALF_OPEN
 *   HALF_OPEN ──(probe succeeds) ──────► CLOSED
 *   HALF_OPEN ──(probe fails)    ──────► OPEN
 *
 * ## Security notes
 *  - The breaker does not suppress or transform upstream errors; it re-throws
 *    them so callers always know why a call failed.
 *  - `CircuitOpenError` is distinguishable by type so callers can return 503
 *    instead of 500 and avoid misleading clients.
 *  - The `reset()` method is intended for admin/test use only; in production
 *    it should be protected behind an authenticated admin route.
 */

import { CircuitOpenError } from "./errors";

/** The three possible states of a circuit breaker. */
export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

/** Configuration options for a CircuitBreaker instance. */
export interface CircuitBreakerOptions {
  /**
   * Number of consecutive failures before the circuit trips to OPEN.
   * @default 5
   */
  failureThreshold?: number;

  /**
   * Number of consecutive successes in HALF_OPEN before closing the circuit.
   * @default 1
   */
  successThreshold?: number;

  /**
   * Milliseconds to wait in the OPEN state before transitioning to HALF_OPEN.
   * @default 30_000
   */
  timeout?: number;

  /**
   * Descriptive name used in logs and error messages.
   * @default 'default'
   */
  name?: string;
}

/** Point-in-time snapshot of circuit breaker counters. */
export interface CircuitStats {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  /** Timestamp (ms since epoch) of the most recent failure, or null. */
  lastFailureTime: number | null;
}

/**
 * Generic, configurable circuit breaker.
 *
 * @example
 * ```ts
 * const breaker = new CircuitBreaker({ name: 'stellar-rpc', failureThreshold: 3 });
 *
 * try {
 *   const result = await breaker.execute(() => fetchFromStellar());
 * } catch (err) {
 *   if (err instanceof CircuitOpenError) {
 *     res.status(503).set('Retry-After', '30').json({ error: err.message });
 *   }
 * }
 * ```
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly successThreshold: number;
  private readonly timeout: number;

  private state: CircuitState = "CLOSED";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;
  /** Tracks whether a probe call is currently in-flight in HALF_OPEN. */
  private probeInFlight = false;

  constructor(options: CircuitBreakerOptions = {}) {
    this.name = options.name ?? "default";
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 1;
    this.timeout = options.timeout ?? 30_000;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Executes `fn` if the circuit allows it, otherwise rejects immediately.
   *
   * @param fn - The async operation to guard (e.g. an RPC call).
   * @returns  The resolved value of `fn`.
   * @throws   {@link CircuitOpenError} when the circuit is OPEN.
   * @throws   The original error thrown by `fn` (failure is recorded).
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionIfNeeded();

    if (this.state === "OPEN") {
      throw new CircuitOpenError(this.name);
    }

    // In HALF_OPEN only one probe at a time is allowed.
    if (this.state === "HALF_OPEN") {
      if (this.probeInFlight) {
        throw new CircuitOpenError(this.name);
      }
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * Returns the current circuit state.
   */
  getState(): CircuitState {
    this.transitionIfNeeded();
    return this.state;
  }

  /**
   * Returns a snapshot of internal counters for monitoring.
   */
  getStats(): CircuitStats {
    this.transitionIfNeeded();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Forces the circuit back to CLOSED and resets all counters.
   *
   * Intended for admin/test use only. In production, protect this behind
   * an authenticated admin endpoint.
   */
  reset(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.probeInFlight = false;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Checks whether the timeout has elapsed and, if so, moves OPEN → HALF_OPEN.
   * Called at the top of every public method so state is always up-to-date.
   */
  private transitionIfNeeded(): void {
    if (
      this.state === "OPEN" &&
      this.lastFailureTime !== null &&
      Date.now() - this.lastFailureTime >= this.timeout
    ) {
      this.toHalfOpen();
    }
  }

  /** Records a successful call and advances the state machine if appropriate. */
  private onSuccess(): void {
    this.failureCount = 0;

    if (this.state === "HALF_OPEN") {
      this.successCount += 1;
      if (this.successCount >= this.successThreshold) {
        this.toClosed();
      }
    }
  }

  /** Records a failed call and advances the state machine if appropriate. */
  private onFailure(): void {
    this.lastFailureTime = Date.now();
    this.successCount = 0;

    if (this.state === "HALF_OPEN") {
      this.toOpen();
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold) {
      this.toOpen();
    }
  }

  private toClosed(): void {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.successCount = 0;
  }

  private toOpen(): void {
    this.state = "OPEN";
  }

  private toHalfOpen(): void {
    this.state = "HALF_OPEN";
    this.successCount = 0;
    this.probeInFlight = false;
  }
}
