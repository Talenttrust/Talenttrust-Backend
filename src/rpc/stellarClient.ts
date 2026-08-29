/**
 * stellarClient.ts — Stellar/Soroban RPC client with circuit-breaker protection.
 *
 * All calls to the Stellar network (Horizon API, Soroban RPC) should go through
 * this module so that failures are automatically tracked by the circuit breaker
 * and the application can fail fast instead of queuing up blocked requests.
 *
 * ## Design
 *  - A single shared `CircuitBreaker` instance guards the Stellar transport.
 *  - The `Transport` is injectable for testing; pass a mock to bypass real
 *    network calls.
 *  - The **production** transport (see {@link createStellarTransport}) wraps
 *    the underlying `fetch` with:
 *      1. A per-attempt `AbortController` driven by `STELLAR_RPC_TIMEOUT_MS`,
 *         so a hung RPC can never stall the request indefinitely.
 *      2. A bounded HTTP-level retry loop with jitter (`STELLAR_RPC_MAX_RETRIES`
 *         + `STELLAR_RPC_RETRY_BASE_DELAY_MS` + `STELLAR_RPC_RETRY_MAX_DELAY_MS`),
 *         applied **inside** the transport.
 *  - Retries live **below** the circuit breaker on purpose: a transient blip
 *    that recovers within the retry budget counts as a single circuit-breaker
 *    success, so a flaky upstream does not rapidly trip the 5-failure threshold.
 *
 * ## Security notes
 *  - The circuit breaker name is included in 503 responses as `X-Circuit-Name`
 *    so ops teams can quickly identify which upstream is failing.
 *  - The RPC endpoint is read from `STELLAR_RPC_URL` env var; never hard-code
 *    production URLs in source.
 *  - All requests are bounded by `STELLAR_RPC_TIMEOUT_MS`; the circuit
 *    breaker alone is not a substitute for per-request timeouts.
 *  - On timeout we throw a dedicated {@link StellarTimeoutError} so callers can
 *    distinguish "the upstream hung" from "the upstream returned 5xx".
 */

import { CircuitBreaker } from "../circuit-breaker";
import { withRetry } from "../utils/retry";
import {
  DEFAULT_STELLAR_RPC_CONFIG,
  loadStellarRpcConfig,
  type StellarRpcConfig,
} from "./stellarConfig";

/** Minimal RPC response envelope returned by the Stellar transport. */
export interface RpcResponse<T = unknown> {
  data: T;
  status: number;
}

/** Injectable transport function — swap the default for a mock in tests. */
export type Transport = (url: string, payload: unknown) => Promise<RpcResponse>;

/**
 * Thrown by the resilient transport when a single request exceeds
 * {@link StellarRpcConfig.timeoutMs}. The error is typed so callers and the
 * circuit breaker can recognise it without relying on string matching.
 */
export class StellarTimeoutError extends Error {
  /** The configured per-request timeout that was exceeded. */
  readonly timeoutMs: number;
  /** The URL of the request that timed out (for logs / metrics). */
  readonly url: string;

  constructor(timeoutMs: number, url: string, message?: string) {
    super(
      message ??
        `Stellar RPC request to ${url} timed out after ${timeoutMs}ms`,
    );
    this.name = "StellarTimeoutError";
    this.timeoutMs = timeoutMs;
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by the resilient transport when the upstream Stellar RPC returns
 * a non-2xx status code, or when the response body cannot be parsed as JSON.
 * The `status` and `data` fields are exposed so callers (and the retry
 * classifier) can branch on them without parsing the message string.
 */
export class StellarRpcError extends Error {
  readonly status: number;
  /** Parsed JSON body of the upstream error response, when available. */
  readonly data: unknown;

  constructor(status: number, data: unknown, message?: string) {
    super(
      message ??
        `Stellar RPC error ${status}: ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`,
    );
    this.name = "StellarRpcError";
    this.status = status;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

/**
 * A swappable `fetch` implementation for testing.
 *
 * **Contract:** implementations **MUST** honor the provided `AbortSignal`
 * and reject (rather than hang) when it fires. Otherwise per-attempt
 * timeouts will silently never fire.
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

/** Configuration accepted by {@link createStellarTransport}. */
export interface StellarTransportOptions {
  /** Per-request timeout in ms. Defaults to {@link DEFAULT_STELLAR_RPC_CONFIG}. */
  timeoutMs: number;
  /** Total attempts (including the first try) — passed straight into `withRetry`. */
  maxAttempts: number;
  /** Initial backoff delay in ms for the retry policy. */
  baseDelayMs: number;
  /** Upper bound in ms for any single backoff sleep. */
  maxDelayMs: number;
  /** Optional fetch override (defaults to global `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * Classifies an error thrown by the transport as retryable or terminal.
 *
 * Cross-realm note: `response.json()` in Node's WHATWG `Response` may throw
 * a `SyntaxError` whose prototype is **not** `globalThis.SyntaxError` (the
 * classic cross-realm problem). We therefore never rely on `instanceof
 * SyntaxError` alone — we also match on `err.name === "SyntaxError"`, which
 * is a string and survives realm boundaries.
 *
 * Retryable:
 *  - {@link StellarTimeoutError}
 *  - 5xx {@link StellarRpcError} (server / gateway transient)
 *  - 429 {@link StellarRpcError} (rate-limited; safe to back off and retry)
 *  - any other network / unknown error (default-on failure)
 *
 * Non-retryable:
 *  - 4xx (except 429) {@link StellarRpcError} — caller bug, will not heal.
 *  - JSON parse failures (matched by `name === "SyntaxError"`) — structural.
 *  - Our wrapper error with `name === "StellarJsonParseError"`.
 */
function isRetryableError(err: unknown): boolean {
  if (err instanceof StellarTimeoutError) return true;
  if (err instanceof StellarRpcError) {
    if (err.status === 429) return true;
    if (err.status >= 500 && err.status < 600) return true;
    return false; // 4xx (other) is terminal
  }
  // JSON parse failures — non-retryable.  Match by string `name` to survive
  // cross-realm `SyntaxError` instances from `Response.json()`.
  if (err && typeof err === "object") {
    const name = (err as Error).name;
    if (name === "SyntaxError" || name === "StellarJsonParseError") return false;
  }
  // Network errors and other unknown errors ARE retried.
  return true;
}

/**
 * Wraps a `response.json()` parse failure into a same-realm `Error` whose
 * `name` is `"StellarJsonParseError"` so {@link isRetryableError} can
 * reliably recognise it across VM boundaries.  The original error is
 * preserved via `.cause` for structured logs / APM tooling.
 */
function wrapJsonParseError(original: unknown): Error {
  const wrapped = new Error(
    original instanceof Error
      ? `Stellar RPC returned non-JSON body: ${original.message}`
      : "Stellar RPC returned non-JSON body",
  );
  wrapped.name = "StellarJsonParseError";
  if (original instanceof Error) {
    (wrapped as Error & { cause?: unknown }).cause = original;
  }
  return wrapped;
}

/**
 * Performs a single fetch attempt against the Stellar RPC endpoint, with
 * AbortController-driven timeout protection.
 *
 * The function never retries itself; the caller is responsible for wrapping
 * this in `withRetry`. Returning a {@link StellarRpcError} on non-2xx and
 * a {@link StellarTimeoutError} on abort keeps the retry classifier simple.
 */
async function performFetchAttempt(
  url: string,
  payload: unknown,
  timeoutMs: number,
  fetchImpl: FetchLike,
): Promise<RpcResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // Strict JSON parsing — non-JSON responses wrap into a same-realm Error
    // whose name is "StellarJsonParseError" so the retry classifier can
    // notice it without depending on cross-realm `instanceof SyntaxError`.
    let data: unknown;
    try {
      data = await response.json();
    } catch (parseErr) {
      throw wrapJsonParseError(parseErr);
    }

    if (!response.ok) {
      throw new StellarRpcError(response.status, data);
    }
    return { data, status: response.status };
  } catch (err) {
    // The abort signal is the authoritative signal that the configured
    // timeout fired.  Convert whatever error the fetchImpl produced into
    // a typed `StellarTimeoutError` so the breaker records a failure the
    // caller can recognise.
    if (controller.signal.aborted) {
      throw new StellarTimeoutError(timeoutMs, url);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds a {@link Transport} that performs a single fetch attempt with
 * AbortController timeout protection, wrapped in `withRetry` for bounded
 * exponential-backoff retries with jitter.
 *
 * @param options - Transport options (typically loaded from env vars).
 * @returns A {@link Transport} compatible with the existing `StellarClient`.
 */
export function createStellarTransport(
  options: StellarTransportOptions,
): Transport {
  const fetchImpl: FetchLike =
    options.fetchImpl ?? ((url, init) => fetch(url, init));

  return (url, payload) =>
    withRetry(
      () => performFetchAttempt(url, payload, options.timeoutMs, fetchImpl),
      {
        maxAttempts: options.maxAttempts,
        baseDelayMs: options.baseDelayMs,
        maxDelayMs: options.maxDelayMs,
        jitter: true,
        isRetryable: isRetryableError,
      },
    );
}

/**
 * Returns the env-resolved options used by the production transport.
 * Exported so tests can introspect the configuration without having to
 * duplicate the env-var logic. Throws if env vars are invalid.
 */
export function loadDefaultTransportOptions(): StellarTransportOptions {
  const cfg: StellarRpcConfig = loadStellarRpcConfig();
  return {
    timeoutMs: cfg.timeoutMs,
    maxAttempts: cfg.maxRetries + 1, // `maxRetries` is "retries after first try"
    baseDelayMs: cfg.retryBaseDelayMs,
    maxDelayMs: cfg.retryMaxDelayMs,
  };
}

/**
 * Default production transport — calls the Stellar/Soroban JSON-RPC endpoint
 * with per-request timeout and bounded HTTP-level retries.
 *
 * Allocation happens once at module load. Misconfiguration in production
 * env vars causes the import of this module to fail loudly so the issue is
 * caught at startup, not at first request.
 */
export const defaultTransport: Transport = createStellarTransport(
  loadDefaultTransportOptions(),
);

// Re-export DEFAULT_STELLAR_RPC_CONFIG and `loadStellarRpcConfig` so callers
// (including tests) can introspect the configuration without having to
// duplicate the env-var logic.
export { DEFAULT_STELLAR_RPC_CONFIG, loadStellarRpcConfig };

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
   * The retry+timeout story is owned by the transport under the hood, so
   * the circuit breaker sees exactly one final outcome per logical call —
   * either a success (after 0..N retries) or a single failure (after all
   * retries are exhausted).
   *
   * @param payload - The JSON-RPC request payload.
   * @returns The full RPC response envelope.
   * @throws  {@link CircuitOpenError} if the circuit is currently OPEN.
   * @throws  {@link StellarTimeoutError} if the timeout fires and retries are exhausted.
   * @throws  {@link StellarRpcError} if the upstream returns a terminal error.
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
