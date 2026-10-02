/**
 * @file health/pagination.test.ts
 * @description Comprehensive tests for cursor-based pagination logic and the
 * paginated /health endpoint.
 *
 * Covers:
 * - encodeCursor / decodeCursor round-trips
 * - decodeCursor with invalid / tampered / out-of-range inputs
 * - clampPageSize bounds
 * - paginateItems — empty set, single item, exact-page boundary, over-limit
 *   clamp, last page, multi-page traversal
 * - HTTP-level integration via buildHealthRouter:
 *   - default page size
 *   - ?limit= parameter (valid, over-max clamped, invalid)
 *   - ?cursor= parameter (valid, invalid, tampered, out-of-range)
 *   - empty probe set
 *   - exact-page boundary (no nextCursor on last page)
 *   - existing verbose filter still works across pages
 *   - item shape is unchanged
 *   - full traversal collects all probes exactly once
 */

import express from "express";
import request from "supertest";
import { buildHealthRouter } from "./router";
import { Probe } from "./types";
import {
  encodeCursor,
  decodeCursor,
  clampPageSize,
  paginateItems,
  DEFAULT_HEALTH_PAGE_SIZE,
  MAX_HEALTH_PAGE_SIZE,
} from "./pagination";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeProbe(name: string): Probe {
  return async () => ({ name, ok: true, latencyMs: 1 });
}

/** Build N probes named probe-0 … probe-(N-1). */
function makeProbes(n: number): Probe[] {
  return Array.from({ length: n }, (_, i) => makeProbe(`probe-${i}`));
}

function buildApp(probes: Probe[]) {
  const app = express();
  app.use("/health", buildHealthRouter(probes));
  return app;
}

// ─── encodeCursor / decodeCursor ──────────────────────────────────────────────

describe("encodeCursor / decodeCursor", () => {
  it("round-trips index 0", () => {
    const cursor = encodeCursor(0);
    const result = decodeCursor(cursor, 100);
    expect(result).toEqual({ ok: true, index: 0 });
  });

  it("round-trips a mid-range index", () => {
    const cursor = encodeCursor(42);
    const result = decodeCursor(cursor, 100);
    expect(result).toEqual({ ok: true, index: 42 });
  });

  it("round-trips an index equal to totalItems (valid empty-last-page)", () => {
    const cursor = encodeCursor(10);
    const result = decodeCursor(cursor, 10);
    expect(result).toEqual({ ok: true, index: 10 });
  });

  it("rejects a cursor with index > totalItems", () => {
    const cursor = encodeCursor(11);
    const result = decodeCursor(cursor, 10);
    expect(result).toEqual({ ok: false, error: "cursor_out_of_range" });
  });

  it("rejects a completely invalid string", () => {
    const result = decodeCursor("not-a-cursor", 10);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: string }).error).toBe("invalid_cursor");
  });

  it("rejects a base64-encoded non-JSON string", () => {
    const garbage = Buffer.from("hello world").toString("base64url");
    const result = decodeCursor(garbage, 10);
    expect(result.ok).toBe(false);
  });

  it("rejects a tampered cursor (wrong JSON structure)", () => {
    const tampered = Buffer.from(JSON.stringify({ offset: 5 })).toString("base64url");
    const result = decodeCursor(tampered, 10);
    expect(result).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("rejects a cursor with a negative index", () => {
    const bad = Buffer.from(JSON.stringify({ index: -1 })).toString("base64url");
    const result = decodeCursor(bad, 10);
    expect(result).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("rejects a cursor with a floating-point index", () => {
    const bad = Buffer.from(JSON.stringify({ index: 2.5 })).toString("base64url");
    const result = decodeCursor(bad, 10);
    expect(result).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("rejects a cursor with a string index", () => {
    const bad = Buffer.from(JSON.stringify({ index: "5" })).toString("base64url");
    const result = decodeCursor(bad, 10);
    expect(result).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("rejects a cursor that is null JSON", () => {
    const bad = Buffer.from("null").toString("base64url");
    const result = decodeCursor(bad, 10);
    expect(result).toEqual({ ok: false, error: "invalid_cursor" });
  });

  it("produces a URL-safe string (no +, /, or = padding)", () => {
    for (let i = 0; i < 50; i++) {
      const cursor = encodeCursor(i);
      expect(cursor).not.toMatch(/[+/=]/);
    }
  });
});

// ─── clampPageSize ────────────────────────────────────────────────────────────

describe("clampPageSize", () => {
  it("returns the value unchanged when within range", () => {
    expect(clampPageSize(20)).toBe(20);
  });

  it("clamps a value above MAX_HEALTH_PAGE_SIZE to the max", () => {
    expect(clampPageSize(MAX_HEALTH_PAGE_SIZE + 1)).toBe(MAX_HEALTH_PAGE_SIZE);
  });

  it("clamps a value below 1 to 1", () => {
    expect(clampPageSize(0)).toBe(1);
  });

  it("accepts exactly 1", () => {
    expect(clampPageSize(1)).toBe(1);
  });

  it("accepts exactly MAX_HEALTH_PAGE_SIZE", () => {
    expect(clampPageSize(MAX_HEALTH_PAGE_SIZE)).toBe(MAX_HEALTH_PAGE_SIZE);
  });

  it("clamps very large numbers to the max", () => {
    expect(clampPageSize(Number.MAX_SAFE_INTEGER)).toBe(MAX_HEALTH_PAGE_SIZE);
  });
});

// ─── paginateItems ────────────────────────────────────────────────────────────

describe("paginateItems", () => {
  it("returns an empty items array and null nextCursor for an empty input", () => {
    const result = paginateItems([], 0, 10);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("returns all items when count < limit and no cursor", () => {
    const items = [1, 2, 3];
    const result = paginateItems(items, 0, 10);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns the first page when count === limit (exact boundary)", () => {
    const items = [1, 2, 3];
    const result = paginateItems(items, 0, 3);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.nextCursor).toBeNull(); // exactly filled — no more items
  });

  it("returns a nextCursor when there are more items than the limit", () => {
    const items = [1, 2, 3, 4, 5];
    const result = paginateItems(items, 0, 3);
    expect(result.items).toEqual([1, 2, 3]);
    expect(result.nextCursor).not.toBeNull();
  });

  it("second page items are correct and nextCursor is null on last page", () => {
    const items = [1, 2, 3, 4, 5];
    const firstPage = paginateItems(items, 0, 3);
    const cursor = firstPage.nextCursor as string;

    const decoded = decodeCursor(cursor, items.length);
    expect(decoded.ok).toBe(true);
    const secondPage = paginateItems(items, (decoded as { ok: true; index: number }).index, 3);

    expect(secondPage.items).toEqual([4, 5]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("returns correct limit after clamping an over-limit request", () => {
    const items = [1, 2];
    const result = paginateItems(items, 0, MAX_HEALTH_PAGE_SIZE + 50);
    expect(result.limit).toBe(MAX_HEALTH_PAGE_SIZE);
  });

  it("startIndex at end of array yields empty page with null cursor", () => {
    const items = [1, 2, 3];
    const result = paginateItems(items, 3, 10);
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it("full traversal collects all items exactly once", () => {
    const items = Array.from({ length: 7 }, (_, i) => i);
    const pageSize = 3;
    const collected: number[] = [];
    let startIndex = 0;

    for (let page = 0; page < 10; page++) {
      const result = paginateItems(items, startIndex, pageSize);
      collected.push(...result.items);
      if (result.nextCursor === null) break;
      const decoded = decodeCursor(result.nextCursor, items.length);
      expect(decoded.ok).toBe(true);
      startIndex = (decoded as { ok: true; index: number }).index;
    }

    expect(collected).toEqual(items);
  });
});

// ─── HTTP integration — buildHealthRouter ────────────────────────────────────

describe("GET /health — cursor pagination (HTTP)", () => {
  // ── Empty probe set ────────────────────────────────────────────────────────

  it("returns empty probes, null nextCursor for empty probe set", async () => {
    const res = await request(buildApp([])).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(0);
    expect(res.body.nextCursor).toBeNull();
  });

  // ── Default page size ──────────────────────────────────────────────────────

  it("returns at most DEFAULT_HEALTH_PAGE_SIZE probes when limit is omitted", async () => {
    const probes = makeProbes(DEFAULT_HEALTH_PAGE_SIZE + 5);
    const res = await request(buildApp(probes)).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(DEFAULT_HEALTH_PAGE_SIZE);
    expect(res.body.nextCursor).not.toBeNull();
    expect(res.body.limit).toBe(DEFAULT_HEALTH_PAGE_SIZE);
  });

  it("returns all probes when total < DEFAULT_HEALTH_PAGE_SIZE", async () => {
    const probes = makeProbes(5);
    const res = await request(buildApp(probes)).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(5);
    expect(res.body.nextCursor).toBeNull();
  });

  // ── ?limit= parameter ─────────────────────────────────────────────────────

  it("respects ?limit= within range", async () => {
    const probes = makeProbes(10);
    const res = await request(buildApp(probes)).get("/health?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(3);
    expect(res.body.limit).toBe(3);
    expect(res.body.nextCursor).not.toBeNull();
  });

  it("clamps ?limit= above MAX_HEALTH_PAGE_SIZE to the max", async () => {
    const probes = makeProbes(5);
    const res = await request(buildApp(probes)).get(
      `/health?limit=${MAX_HEALTH_PAGE_SIZE + 50}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(MAX_HEALTH_PAGE_SIZE);
  });

  it("returns 400 for ?limit=0", async () => {
    const res = await request(buildApp(makeProbes(3))).get("/health?limit=0");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for a non-integer ?limit=", async () => {
    const res = await request(buildApp(makeProbes(3))).get("/health?limit=abc");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns 400 for a negative ?limit=", async () => {
    const res = await request(buildApp(makeProbes(3))).get("/health?limit=-5");
    expect(res.status).toBe(400);
  });

  // ── Exact-page boundary (no nextCursor on last page) ──────────────────────

  it("nextCursor is null when total probes === limit (exact boundary)", async () => {
    const probes = makeProbes(5);
    const res = await request(buildApp(probes)).get("/health?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(5);
    expect(res.body.nextCursor).toBeNull();
  });

  it("nextCursor is present when total probes === limit + 1", async () => {
    const probes = makeProbes(6);
    const res = await request(buildApp(probes)).get("/health?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.probes).toHaveLength(5);
    expect(res.body.nextCursor).not.toBeNull();
  });

  // ── ?cursor= navigation ────────────────────────────────────────────────────

  it("second page via cursor returns correct probes", async () => {
    const probes = makeProbes(7);
    const firstRes = await request(buildApp(probes)).get("/health?limit=4");
    expect(firstRes.status).toBe(200);
    expect(firstRes.body.probes).toHaveLength(4);

    const cursor = firstRes.body.nextCursor as string;
    expect(cursor).toBeTruthy();

    const secondRes = await request(buildApp(probes)).get(
      `/health?limit=4&cursor=${cursor}`,
    );
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.probes).toHaveLength(3);
    expect(secondRes.body.nextCursor).toBeNull();
  });

  it("full traversal via cursors collects all probes exactly once", async () => {
    const n = 11;
    const probes = makeProbes(n);
    const app = buildApp(probes);
    const collectedNames: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const url = cursor ? `/health?limit=4&cursor=${cursor}` : "/health?limit=4";
      const res = await request(app).get(url);
      expect(res.status).toBe(200);

      for (const probe of res.body.probes as { name: string }[]) {
        collectedNames.push(probe.name);
      }

      cursor = res.body.nextCursor as string | null;
      if (cursor === null) break;
    }

    expect(collectedNames).toHaveLength(n);
    expect(collectedNames).toEqual(Array.from({ length: n }, (_, i) => `probe-${i}`));
  });

  it("returns 400 for an invalid cursor string", async () => {
    const res = await request(buildApp(makeProbes(5))).get(
      "/health?cursor=not-a-valid-cursor",
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details[0].message).toBe("invalid_cursor");
  });

  it("returns 400 for a tampered cursor (altered JSON payload)", async () => {
    const tampered = Buffer.from(JSON.stringify({ index: 99999 })).toString("base64url");
    const res = await request(buildApp(makeProbes(5))).get(
      `/health?cursor=${tampered}`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details[0].message).toBe("cursor_out_of_range");
  });

  it("returns 400 for an empty cursor string", async () => {
    // The schema rejects an empty string before the router logic runs.
    const res = await request(buildApp(makeProbes(5))).get("/health?cursor=");
    expect(res.status).toBe(400);
  });

  // ── Item shape is unchanged ────────────────────────────────────────────────

  it("probe items retain name, ok, and latencyMs fields", async () => {
    const probes = makeProbes(2);
    const res = await request(buildApp(probes)).get("/health");
    expect(res.status).toBe(200);
    for (const probe of res.body.probes as Record<string, unknown>[]) {
      expect(typeof probe.name).toBe("string");
      expect(typeof probe.ok).toBe("boolean");
      expect(typeof probe.latencyMs).toBe("number");
    }
  });

  // ── Existing filters work across pages ────────────────────────────────────

  it("verbose=true still works on paginated pages (non-production)", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    const verboseProbe: Probe = async () => ({
      name: "test",
      ok: false,
      detail: "connection refused",
      latencyMs: 1,
    });
    const app = express();
    app.use("/health", buildHealthRouter([verboseProbe]));

    const res = await request(app).get("/health?verbose=true");
    process.env.NODE_ENV = originalEnv;

    expect(res.status).toBe(503);
    const failedProbe = res.body.probes.find(
      (p: Record<string, unknown>) => !p.ok,
    );
    expect(failedProbe?.detail).toBe("connection refused");
  });

  it("details are still stripped when verbose is not set (paginated)", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";

    const verboseProbe: Probe = async () => ({
      name: "test",
      ok: false,
      detail: "secret topology info",
      latencyMs: 1,
    });
    const app = express();
    app.use("/health", buildHealthRouter([verboseProbe]));

    const res = await request(app).get("/health?limit=1");
    process.env.NODE_ENV = originalEnv;

    for (const p of res.body.probes as Record<string, unknown>[]) {
      expect(p.detail).toBeUndefined();
    }
  });

  it("details are stripped in production even with verbose=true on a paginated page", async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const verboseProbe: Probe = async () => ({
      name: "test",
      ok: false,
      detail: "internal error",
      latencyMs: 1,
    });
    const app = express();
    app.use("/health", buildHealthRouter([verboseProbe]));

    const res = await request(app).get("/health?verbose=true&limit=10");
    process.env.NODE_ENV = original;

    for (const p of res.body.probes as Record<string, unknown>[]) {
      expect(p.detail).toBeUndefined();
    }
  });

  // ── Response envelope ─────────────────────────────────────────────────────

  it("response includes status, service, timestamp, uptimeSeconds, probes, nextCursor, limit", async () => {
    const res = await request(buildApp(makeProbes(3))).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(res.body).toHaveProperty("service");
    expect(res.body).toHaveProperty("timestamp");
    expect(res.body).toHaveProperty("uptimeSeconds");
    expect(res.body).toHaveProperty("probes");
    expect(res.body).toHaveProperty("nextCursor");
    expect(res.body).toHaveProperty("limit");
  });

  it("returns 503 when a probe fails and still paginates correctly", async () => {
    const failProbe: Probe = async () => ({
      name: "broken",
      ok: false,
      latencyMs: 0,
    });
    const app = buildApp([failProbe]);
    const res = await request(app).get("/health?limit=1");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.probes).toHaveLength(1);
    expect(res.body.nextCursor).toBeNull();
  });

  it("Cache-Control is no-store on paginated responses", async () => {
    const res = await request(buildApp(makeProbes(3))).get("/health?limit=2");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
