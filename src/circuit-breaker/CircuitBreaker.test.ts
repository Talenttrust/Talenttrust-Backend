/**
 * Tests for CircuitBreaker.
 *
 * Uses Jest fake timers to control the OPEN→HALF_OPEN timeout without real
 * waiting.  All calls use a tiny in-process async function — no network.
 */

import { CircuitBreaker } from "./CircuitBreaker";
import { CircuitOpenError } from "./errors";

/** Helper: returns a function that resolves immediately. */
const succeed = () => async () => "ok";

/** Helper: returns a function that always rejects with a given message. */
const fail =
  (msg = "upstream error") =>
  async () => {
    throw new Error(msg);
  };

describe("CircuitBreaker — initial state", () => {
  it("starts in CLOSED state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("CLOSED");
  });

  it("getStats returns zeroed-out counters", () => {
    const cb = new CircuitBreaker();
    expect(cb.getStats()).toEqual({
      state: "CLOSED",
      failureCount: 0,
      successCount: 0,
      lastFailureTime: null,
    });
  });
});

describe("CircuitBreaker — CLOSED state", () => {
  it("passes a successful call through and returns its value", async () => {
    const cb = new CircuitBreaker();
    const result = await cb.execute(succeed());
    expect(result).toBe("ok");
  });

  it("does not increment failure count on success", async () => {
    const cb = new CircuitBreaker();
    await cb.execute(succeed());
    expect(cb.getStats().failureCount).toBe(0);
  });

  it("re-throws the upstream error on failure", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 10 });
    await expect(cb.execute(fail("boom"))).rejects.toThrow("boom");
  });

  it("increments failure count on each failure", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    await expect(cb.execute(fail())).rejects.toThrow();
    await expect(cb.execute(fail())).rejects.toThrow();
    expect(cb.getStats().failureCount).toBe(2);
  });

  it("trips to OPEN after failureThreshold consecutive failures", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(fail())).rejects.toThrow();
    }
    expect(cb.getState()).toBe("OPEN");
  });

  it("does not trip on non-consecutive failures (success resets count)", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    await expect(cb.execute(fail())).rejects.toThrow();
    await expect(cb.execute(fail())).rejects.toThrow();
    await cb.execute(succeed()); // success resets
    await expect(cb.execute(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("CLOSED"); // only 1 failure since last success
  });
});

describe("CircuitBreaker — OPEN state", () => {
  function openBreaker(threshold = 3): CircuitBreaker {
    const cb = new CircuitBreaker({
      failureThreshold: threshold,
      timeout: 5_000,
    });
    return cb;
  }

  async function tripBreaker(cb: CircuitBreaker, threshold = 3) {
    for (let i = 0; i < threshold; i++) {
      await expect(cb.execute(fail())).rejects.toThrow();
    }
  }

  it("throws CircuitOpenError immediately without calling fn", async () => {
    const cb = openBreaker();
    await tripBreaker(cb);
    const spy = jest.fn().mockResolvedValue("x");
    await expect(cb.execute(spy)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("CircuitOpenError carries the circuit name", async () => {
    const cb = new CircuitBreaker({ name: "my-rpc", failureThreshold: 1 });
    await expect(cb.execute(fail())).rejects.toThrow();
    try {
      await cb.execute(succeed());
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).circuitName).toBe("my-rpc");
    }
  });

  it("transitions to HALF_OPEN after timeout elapses", async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, timeout: 1_000 });
    await expect(cb.execute(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("OPEN");

    jest.advanceTimersByTime(1_001);
    expect(cb.getState()).toBe("HALF_OPEN");
    jest.useRealTimers();
  });

  it("records lastFailureTime when tripping", async () => {
    const before = Date.now();
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(fail())).rejects.toThrow();
    const { lastFailureTime } = cb.getStats();
    expect(lastFailureTime).not.toBeNull();
    expect(lastFailureTime!).toBeGreaterThanOrEqual(before);
  });
});

describe("CircuitBreaker — HALF_OPEN state", () => {
  async function halfOpenBreaker(timeout = 1_000): Promise<CircuitBreaker> {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, timeout });
    await expect(cb.execute(fail())).rejects.toThrow();
    jest.advanceTimersByTime(timeout + 1);
    expect(cb.getState()).toBe("HALF_OPEN");
    return cb;
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  it("closes after a successful probe", async () => {
    const cb = await halfOpenBreaker();
    await cb.execute(succeed());
    expect(cb.getState()).toBe("CLOSED");
  });

  it("trips back to OPEN after a failed probe", async () => {
    const cb = await halfOpenBreaker();
    await expect(cb.execute(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("OPEN");
  });

  it("rejects concurrent calls with CircuitOpenError (only one probe at a time)", async () => {
    jest.useRealTimers();
    const cb = new CircuitBreaker({ failureThreshold: 1, timeout: 0 });
    await expect(cb.execute(fail())).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 1)); // let timeout elapse

    // Simulate two concurrent calls
    let resolveProbe!: (v: string) => void;
    const slowProbe = () =>
      new Promise<string>((resolve) => {
        resolveProbe = resolve;
      });

    const first = cb.execute(slowProbe); // starts the probe
    const second = cb.execute(succeed()); // concurrent — should be rejected

    await expect(second).rejects.toBeInstanceOf(CircuitOpenError);
    resolveProbe("done");
    await expect(first).resolves.toBe("done");
  });
});

describe("CircuitBreaker — reset()", () => {
  it("forces the circuit back to CLOSED from OPEN", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(fail())).rejects.toThrow();
    expect(cb.getState()).toBe("OPEN");
    cb.reset();
    expect(cb.getState()).toBe("CLOSED");
  });

  it("clears all counters", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 5 });
    await expect(cb.execute(fail())).rejects.toThrow();
    cb.reset();
    const stats = cb.getStats();
    expect(stats.failureCount).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.lastFailureTime).toBeNull();
  });

  it("allows calls to pass again after reset", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(fail())).rejects.toThrow();
    cb.reset();
    const result = await cb.execute(succeed());
    expect(result).toBe("ok");
  });
});

describe("CircuitBreaker — custom options", () => {
  it("respects a custom failureThreshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    await expect(cb.execute(fail())).rejects.toThrow(); // 1
    expect(cb.getState()).toBe("CLOSED");
    await expect(cb.execute(fail())).rejects.toThrow(); // 2 — trips
    expect(cb.getState()).toBe("OPEN");
  });

  it("respects a custom successThreshold > 1 in HALF_OPEN", async () => {
    jest.useFakeTimers();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      timeout: 1_000,
      successThreshold: 2,
    });
    await expect(cb.execute(fail())).rejects.toThrow();
    jest.advanceTimersByTime(1_001);

    // First probe succeeds — still HALF_OPEN
    await cb.execute(succeed());
    expect(cb.getState()).toBe("HALF_OPEN");

    // Second probe succeeds — now CLOSED
    await cb.execute(succeed());
    expect(cb.getState()).toBe("CLOSED");
    jest.useRealTimers();
  });
});
