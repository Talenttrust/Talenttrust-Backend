import request from "supertest";
import { routerApp } from "./router";
import * as loggerModule from "./logger";
import type { LogRecord } from "./logger";

// Capture log records written during tests
const capturedRecords: LogRecord[] = [];

beforeAll(() => {
  loggerModule.setWriteRecordImpl((record) => {
    capturedRecords.push(record);
  });
});

beforeEach(() => {
  capturedRecords.length = 0;
  process.env.ACTIVE_COLOR = "blue";
  process.env.BLUE_PORT = "3001";
  process.env.GREEN_PORT = "3002";
});

// ─── existing behaviour ────────────────────────────────────────────────────

describe("Router – proxy behaviour", () => {
  it("returns 502 when backend unavailable", async () => {
    const res = await request(routerApp).get("/api/v1/contracts");
    expect(res.status).toBe(502);
  });

  it("health/router returns active backend URL", async () => {
    const res = await request(routerApp).get("/health/router");
    expect(res.body.active).toBe("http://localhost:3001");
  });

  it("switch to green updates route", async () => {
    process.env.ACTIVE_COLOR = "green";
    const res = await request(routerApp).get("/health/router");
    expect(res.body.active).toBe("http://localhost:3002");
  });
});

// ─── structured log shape ─────────────────────────────────────────────────

describe("Router – structured log shape", () => {
  it("emits an info record with required fields on each proxied request", async () => {
    await request(routerApp).get("/api/v1/contracts");

    const info = capturedRecords.find((r) => r.level === "info");
    expect(info).toBeDefined();
    expect(info).toMatchObject({
      level: "info",
      service: "talenttrust-backend",
      component: "blue-green-router",
      method: "GET",
    });
    expect(typeof info!.timestamp).toBe("string");
    expect(typeof info!.message).toBe("string");
  });

  it("emits an error record for 502 (backend down)", async () => {
    await request(routerApp).get("/api/v1/contracts");

    const err = capturedRecords.find((r) => r.level === "error");
    expect(err).toBeDefined();
    expect(err).toMatchObject({
      level: "error",
      service: "talenttrust-backend",
      component: "blue-green-router",
    });
  });

  it("attaches requestId to every log record", async () => {
    await request(routerApp).get("/api/v1/contracts");

    for (const record of capturedRecords) {
      expect(typeof record.requestId).toBe("string");
      expect(record.requestId!.length).toBeGreaterThan(0);
    }
  });

  it("uses client-supplied X-Request-Id when valid", async () => {
    const id = "my-request-id-abc123";
    await request(routerApp).get("/api/v1/contracts").set("x-request-id", id);

    expect(capturedRecords[0]?.requestId).toBe(id);
  });

  it("ignores an invalid X-Request-Id and generates a new one", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("x-request-id", "bad id with spaces!");

    expect(capturedRecords[0]?.requestId).toMatch(/^[a-zA-Z0-9-]{36}$/); // UUID
  });
});

// ─── correlation ID ───────────────────────────────────────────────────────

describe("Router – correlation ID", () => {
  it("attaches correlationId from X-Correlation-Id header", async () => {
    const cid = "trace-abc-123";
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("x-correlation-id", cid);

    for (const record of capturedRecords) {
      expect(record.correlationId).toBe(cid);
    }
  });

  it("omits correlationId when header is absent", async () => {
    await request(routerApp).get("/api/v1/contracts");

    for (const record of capturedRecords) {
      expect(record.correlationId).toBeUndefined();
    }
  });

  it("rejects an invalid correlation ID and omits it from logs", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("x-correlation-id", "<script>bad</script>");

    for (const record of capturedRecords) {
      expect(record.correlationId).toBeUndefined();
    }
  });
});

// ─── redaction ────────────────────────────────────────────────────────────

describe("Router – redaction", () => {
  it("redacts Authorization header from logged headers", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("Authorization", "Bearer super-secret-token");

    for (const record of capturedRecords) {
      const headers = record.headers as Record<string, unknown> | undefined;
      if (headers) {
        expect(headers["authorization"]).toBeUndefined();
        expect(headers["Authorization"]).toBeUndefined();
      }
      // The raw secret must not appear anywhere in the serialised record
      expect(JSON.stringify(record)).not.toContain("super-secret-token");
    }
  });

  it("redacts cookie header from logged headers", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("cookie", "session=abc123; auth=xyz");

    for (const record of capturedRecords) {
      const headers = record.headers as Record<string, unknown> | undefined;
      if (headers) {
        expect(headers["cookie"]).toBeUndefined();
      }
    }
  });

  it("redacts x-api-key header from logged headers", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("x-api-key", "my-api-key-value");

    for (const record of capturedRecords) {
      expect(JSON.stringify(record)).not.toContain("my-api-key-value");
    }
  });

  it("masks sensitive query params in logged URL", async () => {
    await request(routerApp).get(
      "/api/v1/contracts?token=secret123&page=1"
    );

    const info = capturedRecords.find((r) => r.level === "info");
    expect(info).toBeDefined();
    expect(String(info!.url)).not.toContain("secret123");
    expect(String(info!.url)).toContain("[REDACTED]");
    // Non-sensitive params are preserved
    expect(String(info!.url)).toContain("page=1");
  });

  it("does not redact non-sensitive headers", async () => {
    await request(routerApp)
      .get("/api/v1/contracts")
      .set("x-custom-header", "safe-value");

    const info = capturedRecords.find((r) => r.level === "info");
    expect(info).toBeDefined();
    const headers = info!.headers as Record<string, unknown>;
    expect(headers["x-custom-header"]).toBe("safe-value");
  });
});
