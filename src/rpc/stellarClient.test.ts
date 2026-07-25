/**
 * Tests for StellarClient and the resilient default transport.
 *
 * Coverage targets >= 95% for src/rpc/stellarClient.ts:
 *  - Successful single-attempt calls.
 *  - AbortController-driven timeout (raises StellarTimeoutError).
 *  - HTTP retry classification (timeout, network, 5xx, 429 retry; 4xx, JSON parse fail).
 *  - Retry budget exhaustion.
 *  - Bounded exponential backoff.
 *  - Circuit-breaker integration: a successful retry counts as 1 success;
 *    an exhausted retry counts as 1 failure (no double-counting).
 *  - loadStellarRpcConfig env validation.
 */

import {
  StellarClient,
  StellarRpcError,
  StellarTimeoutError,
  createStellarTransport,
  loadDefaultTransportOptions,
  loadStellarRpcConfig,
  DEFAULT_STELLAR_RPC_CONFIG,
} from "./stellarClient";
import type { FetchLike } from "./stellarClient";
import { CircuitOpenError } from "../circuit-breaker";

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Builds a tiny in-memory `fetch` implementation that returns a sequence of
 * `Response` objects (or throws) based on `script`.  Each call consumes the
 * next entry, so `mock.calls.length` tells us exactly how many attempts the
 * transport made.
 */
function scriptedFetch(
  script: Array<
    | { ok: boolean; status: number; body: unknown; raw?: string }
    | { throw: Error }
  >,
  callLog: Array<{ url: string; signal: AbortSignal | null; body: string }>,
) {
  let i = 0;
  const fn: jest.Mock<Promise<Response>, Parameters<FetchLike>> = jest.fn(
    async (url, init) => {
      const step = script[i++];
      if (!step) throw new Error(`script exhausted at attempt ${i}`);
      callLog.push({
        url,
        signal: init.signal ?? null,
        body: init.body,
      });
      if ("throw" in step) throw step.throw;
      const body = step.raw ?? JSON.stringify(step.body ?? {});
      return new Response(body, {
        status: step.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
  return fn;
}

const okStep = (data: unknown = { result: "ledger-42" }) => ({
  ok: true,
  status: 200,
  body: data,
});

const errStep = (status: number, data: unknown = { error: "boom" }) => ({
  ok: false,
  status,
  body: data,
});

const throwStep = (err: Error) => ({ throw: err });

/** Constructs a transport with tiny deterministic retry backoff (test-friendly). */
function makeTransport(
  fetchImpl: FetchLike,
  overrides: Partial<{
    timeoutMs: number;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }> = {},
) {
  return createStellarTransport({
    timeoutMs: 50,
    maxAttempts: 3,
    baseDelayMs: 1,
    maxDelayMs: 2,
    ...overrides,
    fetchImpl,
  });
}

// ── Test cases ──────────────────────────────────────────────────────────────
// This suite uses REAL timers (not fake) because `jest.useFakeTimers()`
// rotates the JS clock in a way that does not cleanly interleave with
// native `AbortController` microtasks. We compensate with sub-millisecond
// `baseDelay`/`maxDelay` so total retry time stays single-digit ms.

describe("createStellarTransport", () => {
  it("returns the parsed response on the first successful attempt", async () => {
    const fetchImpl = scriptedFetch([okStep()], []);
    const transport = makeTransport(fetchImpl);

    const result = await transport("https://example.test/rpc", {
      method: "ping",
    });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ result: "ledger-42" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("POSTs with JSON Content-Type and the provided payload", async () => {
    const fetchImpl = scriptedFetch([okStep()], []);
    const transport = makeTransport(fetchImpl);

    await transport("https://example.test/rpc", {
      method: "getTransaction",
      params: ["abc123"],
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method: "getTransaction",
          params: ["abc123"],
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("throws StellarTimeoutError when the AbortController fires before response", async () => {
    const fetchImpl: FetchLike = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const transport = makeTransport(fetchImpl, { timeoutMs: 5, maxAttempts: 1 });

    // Capture both assertions in a single transport invocation.
    const err = await transport("https://example.test/rpc", { method: "x" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(StellarTimeoutError);
    expect(err.timeoutMs).toBe(5);
    expect(err.url).toBe("https://example.test/rpc");
  });

  it("retries on timeout and surfaces a single StellarTimeoutError after exhaustion", async () => {
    const fetchImpl: FetchLike = jest.fn((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const transport = makeTransport(fetchImpl, {
      timeoutMs: 5,
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    await expect(
      transport("https://example.test/rpc", { method: "x" }),
    ).rejects.toBeInstanceOf(StellarTimeoutError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on 5xx and succeeds if the next attempt is healthy", async () => {
    const fetchImpl = scriptedFetch(
      [errStep(503), errStep(502), okStep({ result: "ok" })],
      [],
    );
    const transport = makeTransport(fetchImpl);

    const result = await transport("https://example.test/rpc", { method: "x" });

    expect(result.status).toBe(200);
    expect(result.data).toEqual({ result: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on 429 (rate limit) when within budget", async () => {
    const fetchImpl = scriptedFetch([errStep(429), okStep({ result: "ok" })], []);
    const transport = makeTransport(fetchImpl);

    const result = await transport("https://example.test/rpc", { method: "x" });

    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws StellarRpcError when 4xx is returned (no retries, call count = 1)", async () => {
    const fetchImpl = scriptedFetch(
      [errStep(400, { error: "bad payload" })],
      [],
    );
    const transport = makeTransport(fetchImpl, { maxAttempts: 4 });

    const err = await transport("https://example.test/rpc", { method: "x" }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(StellarRpcError);
    expect(err.status).toBe(400);
    expect(err.data).toEqual({ error: "bad payload" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces StellarRpcError when 5xx retries are exhausted", async () => {
    const fetchImpl = scriptedFetch(
      [errStep(500), errStep(502), errStep(503)],
      [],
    );
    const transport = makeTransport(fetchImpl, { maxAttempts: 3 });

    await expect(
      transport("https://example.test/rpc", { method: "x" }),
    ).rejects.toBeInstanceOf(StellarRpcError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on JSON parse failure (single attempt, name = StellarJsonParseError)", async () => {
    const raw = "this is not json";
    const fetchImpl: FetchLike = jest.fn(async () => {
      return new Response(raw, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const transport = makeTransport(fetchImpl, { maxAttempts: 5 });

    const err = await transport("https://example.test/rpc", { method: "x" }).catch(
      (e) => e,
    );

    // The transport wraps the cross-realm SyntaxError from `Response.json()`
    // into a same-realm Error with `.name === "StellarJsonParseError"` so
    // the retry classifier can recognise it across realms.
    expect(err).toBeDefined();
    expect(err.name).toBe("StellarJsonParseError");
    expect(err.message).toMatch(/non-JSON/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on generic network errors (e.g. DNS) up to budget", async () => {
    const fetchImpl: FetchLike = jest.fn(async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    });
    const transport = makeTransport(fetchImpl, {
      maxAttempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    await expect(
      transport("https://example.test/rpc", { method: "x" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries on generic network errors and succeeds on the last attempt", async () => {
    const fetchImpl = scriptedFetch(
      [throwStep(new TypeError("connection reset")), okStep()],
      [],
    );
    const transport = makeTransport(fetchImpl);

    await expect(
      transport("https://example.test/rpc", { method: "x" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("propagates underlying AbortController signal to fetch", async () => {
    const callLog: Array<{
      url: string;
      signal: AbortSignal | null;
      body: string;
    }> = [];
    const fetchImpl = scriptedFetch([okStep()], callLog);
    const transport = makeTransport(fetchImpl);

    await transport("https://example.test/rpc", { method: "x" });

    expect(callLog).toHaveLength(1);
    expect(callLog[0].signal).not.toBeNull();
    expect(callLog[0].signal!.aborted).toBe(false);
  });

  it("clearTimeout is called even when fetch resolves successfully", async () => {
    const clearSpy = jest.spyOn(global, "clearTimeout");
    const fetchImpl = scriptedFetch([okStep()], []);
    const transport = makeTransport(fetchImpl);

    await transport("https://example.test/rpc", { method: "x" });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("uses default global fetch when no fetchImpl is supplied", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const transport = createStellarTransport({
      timeoutMs: 50,
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    const result = await transport("https://example.test/rpc", { method: "x" });
    expect(result.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});

describe("StellarRpcError / StellarTimeoutError constructors", () => {
  it("StellarRpcError exposes status and data and uses default message", () => {
    const e = new StellarRpcError(503, { error: "down" });
    expect(e.name).toBe("StellarRpcError");
    expect(e.status).toBe(503);
    expect(e.data).toEqual({ error: "down" });
    expect(e.message).toContain("Stellar RPC error 503");
  });

  it("StellarRpcError accepts a custom message", () => {
    const e = new StellarRpcError(400, null, "custom");
    expect(e.message).toBe("custom");
  });

  it("StellarRpcError formats a string data payload cleanly (no double JSON stringify)", () => {
    const e = new StellarRpcError(502, "upstream gone");
    expect(e.message).toBe("Stellar RPC error 502: upstream gone");
  });

  it("StellarTimeoutError exposes timeoutMs + url and uses default message", () => {
    const e = new StellarTimeoutError(2500, "https://x/rpc");
    expect(e.name).toBe("StellarTimeoutError");
    expect(e.timeoutMs).toBe(2500);
    expect(e.url).toBe("https://x/rpc");
    expect(e.message).toContain("timed out");
    expect(e.message).toContain("2500ms");
  });

  it("StellarTimeoutError accepts a custom message", () => {
    const e = new StellarTimeoutError(1, "u", "boom");
    expect(e.message).toBe("boom");
  });

  it("errors are instanceof Error", () => {
    expect(new StellarRpcError(500, {})).toBeInstanceOf(Error);
    expect(new StellarTimeoutError(1, "u")).toBeInstanceOf(Error);
  });
});

describe("loadStellarRpcConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["STELLAR_RPC_TIMEOUT_MS"];
    delete process.env["STELLAR_RPC_MAX_RETRIES"];
    delete process.env["STELLAR_RPC_RETRY_BASE_DELAY_MS"];
    delete process.env["STELLAR_RPC_RETRY_MAX_DELAY_MS"];
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  it("returns defaults when no env vars are set", () => {
    const cfg = loadStellarRpcConfig(process.env);
    expect(cfg).toEqual(DEFAULT_STELLAR_RPC_CONFIG);
  });

  it("parses valid env vars", () => {
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "1234";
    process.env["STELLAR_RPC_MAX_RETRIES"] = "5";
    process.env["STELLAR_RPC_RETRY_BASE_DELAY_MS"] = "100";
    process.env["STELLAR_RPC_RETRY_MAX_DELAY_MS"] = "2000";
    const cfg = loadStellarRpcConfig(process.env);
    expect(cfg.timeoutMs).toBe(1234);
    expect(cfg.maxRetries).toBe(5);
    expect(cfg.retryBaseDelayMs).toBe(100);
    expect(cfg.retryMaxDelayMs).toBe(2000);
  });

  it("rejects zero timeout (must be > 0)", () => {
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "0";
    expect(() => loadStellarRpcConfig(process.env)).toThrow(/STELLAR_RPC_TIMEOUT_MS/);
  });

  it("rejects negative timeout", () => {
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "-1";
    expect(() => loadStellarRpcConfig(process.env)).toThrow();
  });

  it("rejects non-integer timeout", () => {
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "abc";
    expect(() => loadStellarRpcConfig(process.env)).toThrow();
  });

  it("rejects timeout above 120000", () => {
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "999999";
    expect(() => loadStellarRpcConfig(process.env)).toThrow();
  });

  it("rejects negative max retries", () => {
    process.env["STELLAR_RPC_MAX_RETRIES"] = "-1";
    expect(() => loadStellarRpcConfig(process.env)).toThrow(/STELLAR_RPC_MAX_RETRIES/);
  });

  it("rejects max retries above 10", () => {
    process.env["STELLAR_RPC_MAX_RETRIES"] = "11";
    expect(() => loadStellarRpcConfig(process.env)).toThrow();
  });

  it("rejects max delay < base delay", () => {
    process.env["STELLAR_RPC_RETRY_BASE_DELAY_MS"] = "500";
    process.env["STELLAR_RPC_RETRY_MAX_DELAY_MS"] = "10";
    expect(() => loadStellarRpcConfig(process.env)).toThrow(/MAX/);
  });

  it("loadDefaultTransportOptions converts maxRetries to maxAttempts", () => {
    process.env["STELLAR_RPC_MAX_RETRIES"] = "4";
    process.env["STELLAR_RPC_TIMEOUT_MS"] = "1000";
    const opts = loadDefaultTransportOptions();
    expect(opts.maxAttempts).toBe(5); // maxRetries 4 -> 5 attempts
    expect(opts.timeoutMs).toBe(1000);
  });
});

describe("StellarClient.call", () => {
  it("returns the RPC response on success", async () => {
    const fetchImpl = scriptedFetch([okStep({ result: "ledger-42" })], []);
    const transport = makeTransport(fetchImpl, { maxAttempts: 1 });
    const client = new StellarClient(transport);
    const result = await client.call({ method: "getLatestLedger" });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ result: "ledger-42" });
  });

  it("re-throws transport errors", async () => {
    const fetchImpl = scriptedFetch([errStep(500)], []);
    const transport = makeTransport(fetchImpl, {
      maxAttempts: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const client = new StellarClient(transport);
    await expect(client.call({ method: "x" })).rejects.toBeInstanceOf(
      StellarRpcError,
    );
  });

  it("retries inside the transport so the circuit breaker sees one success, not N", async () => {
    const fetchImpl = scriptedFetch(
      [errStep(503), errStep(503), errStep(503), okStep({ result: "ok" })],
      [],
    );
    const transport = makeTransport(fetchImpl, {
      maxAttempts: 4,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const client = new StellarClient(transport);

    const result = await client.call({ method: "x" });

    expect(result.status).toBe(200);
    // 4 HTTP attempts, but the breaker records 1 success.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(client.getBreaker().getStats()).toMatchObject({
      state: "CLOSED",
      failureCount: 0,
    });
  });

  it("opens the circuit after retry-exhausted failures count per call", async () => {
    const fetcher = scriptedFetch(Array(5 * 3).fill(errStep(500)), []);
    const transport = makeTransport(fetcher, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const client = new StellarClient(transport);

    for (let i = 0; i < 5; i++) {
      await expect(client.call({ method: "x" })).rejects.toBeInstanceOf(
        StellarRpcError,
      );
    }

    expect(client.getBreaker().getState()).toBe("OPEN");
  });

  it("throws CircuitOpenError when the circuit is OPEN", async () => {
    const fetcher = scriptedFetch(Array(15).fill(errStep(500)), []);
    const transport = makeTransport(fetcher, {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });
    const client = new StellarClient(transport);

    for (let i = 0; i < 5; i++) {
      await expect(client.call({ method: "x" })).rejects.toThrow();
    }

    await expect(client.call({ method: "x" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });

  it("getCircuitStats returns stats from the underlying breaker", async () => {
    const transport = makeTransport(scriptedFetch([okStep()], []), {
      maxAttempts: 1,
    });
    const client = new StellarClient(transport);
    await client.call({ method: "ping" });
    const stats = client.getCircuitStats();
    expect(stats.state).toBe("CLOSED");
    expect(stats.failureCount).toBe(0);
  });
});
