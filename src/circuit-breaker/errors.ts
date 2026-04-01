/**
 * errors.ts — Typed errors for the circuit-breaker module.
 *
 * Having a dedicated error class lets callers (e.g. Express route handlers)
 * distinguish a tripped circuit from a genuine upstream failure and respond
 * with the correct HTTP status (503 vs 502/500).
 */

/**
 * Thrown by {@link CircuitBreaker.execute} when the circuit is in the OPEN
 * state and the call is rejected without attempting the upstream operation.
 *
 * Callers should respond with HTTP 503 Service Unavailable and include a
 * `Retry-After` header derived from the breaker's `timeout` configuration.
 */
export class CircuitOpenError extends Error {
  /** Name of the circuit breaker that rejected the call. */
  readonly circuitName: string;

  /**
   * @param circuitName - The breaker's configured name (for logging & headers).
   * @param message     - Optional human-readable reason; defaults to a standard
   *                      message so callers don't need to provide one.
   */
  constructor(circuitName: string, message?: string) {
    super(
      message ??
        `Circuit "${circuitName}" is OPEN — call rejected to protect upstream.`,
    );
    this.name = "CircuitOpenError";
    this.circuitName = circuitName;

    // Maintains proper prototype chain in transpiled ES5 targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
