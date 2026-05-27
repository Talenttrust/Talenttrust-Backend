/**
 * Tests for StellarClient.
 *
 * The real network transport is replaced with a Jest mock so tests are
 * hermetic and fast.  We test that the client correctly delegates to the
 * circuit breaker and surfaces errors appropriately.
 */

import { StellarClient } from "./stellarClient";
import { CircuitOpenError } from "../circuit-breaker";
import type { Transport } from "./stellarClient";

/** Builds a mock transport that resolves with the given data. */
const okTransport = (data: unknown = { result: "ledger-42" }): Transport =>
  jest.fn().mockResolvedValue({ data, status: 200 });

/** Builds a mock transport that always rejects. */
const failTransport = (msg = "connection refused"): Transport =>
  jest.fn().mockRejectedValue(new Error(msg));

describe("StellarClient.call", () => {
  it("returns the RPC response on success", async () => {
    const client = new StellarClient(okTransport());
    const result = await client.call({ method: "getLatestLedger" });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ result: "ledger-42" });
  });

  it("forwards the payload to the transport", async () => {
    const transport: Transport = jest
      .fn()
      .mockResolvedValue({ data: {}, status: 200 });
    const client = new StellarClient(transport);
    const payload = { method: "getTransaction", params: ["abc123"] };
    await client.call(payload);
    expect(transport).toHaveBeenCalledWith(expect.any(String), payload);
  });

  it("re-throws transport errors", async () => {
    const client = new StellarClient(failTransport("timeout"));
    await expect(client.call({ method: "getLatestLedger" })).rejects.toThrow(
      "timeout",
    );
  });

  it("opens the circuit after repeated failures", async () => {
    // Default failureThreshold is 5 — make 5 consecutive failures to trip.
    const client = new StellarClient(failTransport(), "http://localhost");
    for (let i = 0; i < 5; i++) {
      await expect(client.call({ method: "test" })).rejects.toThrow();
    }
    expect(client.getBreaker().getState()).toBe("OPEN");
  });

  it("throws CircuitOpenError when the circuit is open", async () => {
    // Trip the circuit with 5 failures (default threshold), then verify CircuitOpenError.
    const client = new StellarClient(failTransport(), "http://localhost");
    for (let i = 0; i < 5; i++) {
      await expect(client.call({ method: "test" })).rejects.toThrow();
    }
    await expect(client.call({ method: "test" })).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
  });
});

describe("StellarClient.getCircuitStats", () => {
  it("returns stats from the underlying breaker", async () => {
    const client = new StellarClient(okTransport());
    await client.call({ method: "ping" });
    const stats = client.getCircuitStats();
    expect(stats.state).toBe("CLOSED");
    expect(stats.failureCount).toBe(0);
  });
});
