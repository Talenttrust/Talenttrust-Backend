/**
 * stellarClient.ts — Stellar/Soroban RPC client with circuit-breaker protection.
 *
 * All calls to the Stellar network (Horizon API, Soroban RPC) should go through
 * this module so that failures are automatically tracked by the circuit breaker
 * and the application can fail fast instead of queuing up blocked requests.
 *
 * ## Design
 *  - A single shared `CircuitBreaker` instance guards the Stellar transport.
 *  - The `transport` is injectable for testing — pass a mock to avoid real
 *    network calls.
 *  - In production the transport calls the Stellar Horizon HTTP API.
 *
 * ## Security notes
 *  - The circuit breaker name is included in 503 responses as `X-Circuit-Name`
 *    so ops teams can quickly identify which upstream is failing.
 *  - The RPC endpoint is read from `STELLAR_RPC_URL` env var; never hard-code
 *    production URLs in source.
 *  - All requests should time out (see `STELLAR_RPC_TIMEOUT_MS`); the circuit
 *    breaker alone is not a substitute for per-request timeouts.
 */

import { CircuitBreaker } from "../circuit-breaker";

/** Minimal RPC response envelope returned by the Stellar transport. */
export interface RpcResponse<T = unknown> {
  data: T;
  status: number;
}

/** Injectable transport function — swap the default for a mock in tests. */
export type Transport = (url: string, payload: unknown) => Promise<RpcResponse>;

/**
 * Default production transport — calls the Stellar/Soroban JSON-RPC endpoint.
 * Reads `STELLAR_RPC_URL` from the environment.
 *
 * Intentionally simple: real production code would also set a request timeout,
 * add auth headers, and handle HTTP-level retries before the circuit breaker.
 */
export const defaultTransport: Transport = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(
      `Stellar RPC error ${response.status}: ${JSON.stringify(data)}`,
    );
  }
  return { data, status: response.status };
};

/**
 * Stellar RPC client protected by a circuit breaker.
 *
 * @example
 * ```ts
 * const client = new StellarClient();
 * const result = await client.call({ method: 'getLatestLedger', params: [] });
 * ```
 */
export class StellarClient {
  private readonly breaker: CircuitBreaker;
  private readonly rpcUrl: string;
  private readonly transport: Transport;

  /**
   * @param transport - Optional transport override (use for testing).
   * @param rpcUrl    - Override the Stellar RPC endpoint (default: `STELLAR_RPC_URL` env var).
   */
  constructor(transport?: Transport, rpcUrl?: string) {
    this.transport = transport ?? defaultTransport;
    this.rpcUrl =
      rpcUrl ??
      process.env["STELLAR_RPC_URL"] ??
      "https://soroban-testnet.stellar.org";

    this.breaker = new CircuitBreaker({
      name: "stellar-rpc",
      failureThreshold: 5,
      successThreshold: 1,
      timeout: 30_000,
    });
  }

  /**
   * Executes a JSON-RPC call through the circuit breaker.
   *
   * @param payload - The JSON-RPC request payload.
   * @returns The full RPC response envelope.
   * @throws  {@link CircuitOpenError} if the circuit is currently OPEN.
   * @throws  Transport-level errors if the call itself fails.
   */
  async call(payload: {
    method: string;
    params?: unknown[];
  }): Promise<RpcResponse> {
    return this.breaker.execute(() => this.transport(this.rpcUrl, payload));
  }

  /**
   * Returns the current state and stats of the underlying circuit breaker.
   * Useful for the `/api/v1/circuit-breaker/status` endpoint.
   */
  getCircuitStats() {
    return this.breaker.getStats();
  }

  /**
   * Returns the circuit breaker instance (for direct access in routes/tests).
   */
  getBreaker(): CircuitBreaker {
    return this.breaker;
  }
}

/** Shared singleton client — use this in route handlers. */
export const stellarClient = new StellarClient();
