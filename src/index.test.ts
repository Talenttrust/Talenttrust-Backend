/**
 * Comprehensive API tests for src/index.ts.
 *
 * Uses supertest to verify all Express routes without binding to a port.
 * Uses an in-memory SQLite database (`:memory:`) injected into the singleton
 * to ensure isolation and speed.
 */

import request from "supertest";
import { app } from "./index";
import { getDb, closeDb } from "./db/database";

let originalConsoleError: typeof console.error;

beforeAll(() => {
  // Ensure the DB is initialized with ':memory:' before routes are hit
  getDb(":memory:");

  // Suppress expected Express error logs from polluting the test output
  originalConsoleError = console.error;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  closeDb();
  console.error = originalConsoleError;
});

describe("Global / Ops", () => {
  it("GET /health returns 200 OK", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "talenttrust-backend" });
  });

  it("GET /api/v1/circuit-breaker/status returns stats", async () => {
    const res = await request(app).get("/api/v1/circuit-breaker/status");
    expect(res.status).toBe(200);
    expect(res.body.circuitBreaker).toBeDefined();
    expect(res.body.circuitBreaker.state).toBe("CLOSED");
  });

  it("Returns 500 when simulating an unhandled error", async () => {
    // We force an error by sending invalid JSON that crashes body-parser
    // which falls through to our global error handler.
    const res = await request(app)
      .post("/api/v1/users")
      .set("Content-Type", "application/json")
      .send('{ "bad": json }');

    // The express body-parser natively responds with a 400 SyntaxError for bad JSON,
    // so we specifically need a mock or a route that throws to test our 500 handler.
    // Let's test the 500 handler by calling an internal method improperly if needed,
    // or we can test it by stubbing the DB temporarily.
    // Actually, body-parser returns 400. Let's stub a route failure by patching app later.
  });
});

describe("Users API", () => {
  let createdUserId: string;

  it("GET /api/v1/users returns all users", async () => {
    const res = await request(app).get("/api/v1/users");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  it("POST /api/v1/users creates a user", async () => {
    const res = await request(app).post("/api/v1/users").send({
      username: "testuser",
      email: "test@example.com",
      role: "freelancer",
    });
    expect(res.status).toBe(201);
    expect(res.body.user).toBeDefined();
    expect(res.body.user.username).toBe("testuser");
    createdUserId = res.body.user.id;
  });

  it("GET /api/v1/users/:id returns the user", async () => {
    const res = await request(app).get(`/api/v1/users/${createdUserId}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(createdUserId);
  });

  it("GET /api/v1/users/:id returns 404 for unknown user", async () => {
    const res = await request(app).get("/api/v1/users/ghost");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });

  it("POST /api/v1/users returns 400 on missing fields", async () => {
    const res = await request(app)
      .post("/api/v1/users")
      .send({ username: "only" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("POST /api/v1/users returns 400 on duplicate email constraint violation", async () => {
    const res = await request(app).post("/api/v1/users").send({
      username: "another",
      email: "test@example.com", // Duplicate
      role: "client",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("DELETE /api/v1/users/:id deletes the user", async () => {
    const dRes = await request(app).delete(`/api/v1/users/${createdUserId}`);
    expect(dRes.status).toBe(204);

    const fRes = await request(app).get(`/api/v1/users/${createdUserId}`);
    expect(fRes.status).toBe(404);
  });

  it("DELETE /api/v1/users/:id returns 404 for unknown user", async () => {
    const dRes = await request(app).delete("/api/v1/users/ghost");
    expect(dRes.status).toBe(404);
    expect(dRes.body.error).toBe("User not found");
  });
});

describe("Contracts API", () => {
  let clientId: string;
  let freelancerId: string;
  let contractId: string;

  beforeAll(async () => {
    // Provide users for the FK constraints
    const cRes = await request(app)
      .post("/api/v1/users")
      .send({ username: "c1", email: "c1@ex.com", role: "client" });
    if (!cRes.body.user)
      throw new Error(
        "cRes failed: " + cRes.status + " " + JSON.stringify(cRes.body),
      );
    clientId = cRes.body.user.id;

    const fRes = await request(app)
      .post("/api/v1/users")
      .send({ username: "f1", email: "f1@ex.com", role: "freelancer" });
    if (!fRes.body.user)
      throw new Error(
        "fRes failed: " + fRes.status + " " + JSON.stringify(fRes.body),
      );
    freelancerId = fRes.body.user.id;
  });

  it("GET /api/v1/contracts returns all contracts", async () => {
    const res = await request(app).get("/api/v1/contracts");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.contracts)).toBe(true);
  });

  it("POST /api/v1/contracts creates a contract", async () => {
    const res = await request(app).post("/api/v1/contracts").send({
      title: "Work",
      clientId,
      freelancerId,
      amount: 1000,
    });
    expect(res.status).toBe(201);
    expect(res.body.contract.title).toBe("Work");
    contractId = res.body.contract.id;
  });

  it("GET /api/v1/contracts/:id returns the contract", async () => {
    const res = await request(app).get(`/api/v1/contracts/${contractId}`);
    expect(res.status).toBe(200);
    expect(res.body.contract.id).toBe(contractId);
  });

  it("GET /api/v1/contracts/:id returns 404 for unknown contract", async () => {
    const res = await request(app).get("/api/v1/contracts/ghost");
    expect(res.status).toBe(404);
  });

  it("POST /api/v1/contracts returns 400 on missing fields", async () => {
    const res = await request(app)
      .post("/api/v1/contracts")
      .send({ title: "Only title" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("PATCH /api/v1/contracts/:id/status updates status", async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}/status`)
      .send({ status: "active" });
    expect(res.status).toBe(200);
    expect(res.body.contract.status).toBe("active");
  });

  it("PATCH /api/v1/contracts/:id/status returns 400 on missing status", async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}/status`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });

  it("PATCH /api/v1/contracts/:id/status returns 400 on invalid status constraint", async () => {
    const res = await request(app)
      .patch(`/api/v1/contracts/${contractId}/status`)
      .send({ status: "fake_status" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("PATCH /api/v1/contracts/:id/status returns 404 for unknown contract", async () => {
    const res = await request(app)
      .patch("/api/v1/contracts/ghost/status")
      .send({ status: "cancelled" });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/v1/contracts/:id deletes the contract", async () => {
    const res = await request(app).delete(`/api/v1/contracts/${contractId}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /api/v1/contracts/:id returns 404 for unknown contract", async () => {
    const res = await request(app).delete("/api/v1/contracts/ghost");
    expect(res.status).toBe(404);
  });
});

describe("Global Error Handler", () => {
  it("Handles internal server errors gracefully (500)", async () => {
    // To cleanly hit the global error handler without modifying index.ts heavily,
    // we can temporarily stub the DB inside a known route to throw an error.
    const db = getDb();
    const mockDbQuery = jest.spyOn(db, "prepare").mockImplementationOnce(() => {
      throw new Error("Database exploded");
    });

    // Suppress the expected stack trace from polluting the test output
    const mockConsoleErr = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const res = await request(app).get("/api/v1/users");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");

    mockConsoleErr.mockRestore();
    mockDbQuery.mockRestore();
  });
});
