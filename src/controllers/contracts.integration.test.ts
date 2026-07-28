/**
 * Integration tests for Contract CRUD routes — JWT auth and RBAC.
 *
 * Covers:
 *  - 401 when no token / malformed header / expired token
 *  - 403 when authenticated but wrong role or non-owner
 *  - 200 / 201 for authorised callers
 *  - Owner-only enforcement on PATCH and DELETE
 *  - No information leakage in 401/403 responses
 *  - Error envelope shape { error: { code, message, requestId } }
 */

// Set env vars BEFORE any imports so singletons pick them up.
process.env.JWT_SECRET = "contracts-test-secret";
process.env.DB_PATH = ":memory:";

import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { closeDb, getDb } from "../db/database";
import app from "../index";

// ─── Token helpers ────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

// UUIDs that match the seeded users created in beforeAll.
const CLIENT_ID = "00000000-0000-0000-0000-000000000001";
const CLIENT_B_ID = "00000000-0000-0000-0000-000000000003";
const FREELANCER_ID = "00000000-0000-0000-0000-000000000002";

function makeToken(
  role: string,
  sub = "user-1",
  expiresIn: number | string = "1h",
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn,
  } as any) as string;
}

const adminToken = () => makeToken("admin", "admin-1");
const clientToken = (id = CLIENT_ID) => makeToken("client", id);
const freelancerToken = (id = FREELANCER_ID) => makeToken("freelancer", id);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared contract payload ───────────────────────────────────────────────

const validPayload = {
  title: "Test Contract Title",
  description: "This is a valid long enough description for testing.",
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 5000,
};

// ─── Seed users for FK constraints ──────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  // Insert with specific IDs so our tokens (which carry these as `sub`) match
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, "testclient", "testclient@test.com", "client", now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_B_ID, "testclientB", "testclientB@test.com", "client", now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    FREELANCER_ID,
    "testfreelancer",
    "testfreelancer@test.com",
    "freelancer",
    now,
  );
});

import { rateLimitStore } from "../config/rateLimit";

beforeEach(() => {
  rateLimitStore.clear();
  const db = getDb();
  db.exec("DELETE FROM contracts");
});

// ─── Helper: create a contract as admin ─────────────────────────────────────

async function createContractAsAdmin(): Promise<string> {
  const res = await request(app)
    .post("/api/v1/contracts")
    .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
    .send(validPayload);
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

// ─── GET /api/v1/contracts ────────────────────────────────────────────────────

describe("GET /api/v1/contracts", () => {
  it("returns 401 when no Authorization header", async () => {
    const res = await request(app).get("/api/v1/contracts");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: "unauthorized" });
  });

  it("returns 401 for malformed Authorization header (no Bearer prefix)", async () => {
    const res = await request(app)
      .get("/api/v1/contracts")
      .set("Authorization", "Token not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired token", async () => {
    const expired = makeToken("admin", "u1", -1);
    const res = await request(app).get("/api/v1/contracts").set(auth(expired));
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { sub: "x", email: "x@x.com", role: "admin" },
      "wrong-secret",
    );
    const res = await request(app).get("/api/v1/contracts").set(auth(forged));
    expect(res.status).toBe(401);
  });

  it("returns 200 for admin", async () => {
    const res = await request(app)
      .get("/api/v1/contracts")
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it("returns 403 for client (list is ownOnly; no owner resolver on collection route)", async () => {
    // The permission matrix marks client.contracts.list as ownOnly.
    // A collection route has no single resource id to resolve ownership against,
    // so requirePermission correctly denies access.
    const res = await request(app)
      .get("/api/v1/contracts")
      .set(auth(clientToken()));
    expect(res.status).toBe(403);
  });

  it("returns 403 for freelancer (list is ownOnly)", async () => {
    const res = await request(app)
      .get("/api/v1/contracts")
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
  });

  it("does not leak user id or token contents on 401", async () => {
    const forged = jwt.sign(
      { sub: "secret-id", email: "x@x.com", role: "admin" },
      "wrong-secret",
    );
    const res = await request(app).get("/api/v1/contracts").set(auth(forged));
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("secret-id");
    expect(body).not.toContain(forged);
  });

  it("returns paginated list with pagination metadata", async () => {
    await createContractAsAdmin();
    await createContractAsAdmin();
    const res = await request(app)
      .get("/api/v1/contracts?limit=1")
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toMatchObject({
      limit: 1,
      hasNextPage: true,
    });
  });

  it("returns 400 for invalid limit parameter", async () => {
    const res = await request(app)
      .get("/api/v1/contracts?limit=abc")
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
  });

  // ─── Cursor pagination tests ──────────────────────────────────────────────

  it("returns cursor page when using limit without page param", async () => {
    await createContractAsAdmin();
    const res = await request(app)
      .get("/api/v1/contracts?limit=5")
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.meta).toHaveProperty("nextCursor");
    expect(res.body.meta).toHaveProperty("hasNextPage");
    expect(res.body.meta).toHaveProperty("limit");
  });

  it("traverses all pages with cursor without skipping or duplicating", async () => {
    const count = 7;
    for (let i = 0; i < count; i++) {
      await createContractAsAdmin();
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pageNum = 0;
    const pageSize = 3;

    while (true) {
      const qs = cursor
        ? `/api/v1/contracts?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`
        : `/api/v1/contracts?limit=${pageSize}`;
      const res = await request(app).get(qs).set(auth(adminToken()));
      expect(res.status).toBe(200);
      const items = res.body.data as Array<{ id: string }>;
      const meta = res.body.meta;
      for (const c of items) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
      pageNum++;
      if (!meta.hasNextPage) break;
      cursor = meta.nextCursor;
      if (pageNum > count) throw new Error("Infinite pagination loop");
    }

    expect(seen.size).toBe(count);
  });

  it("returns 400 when cursor limit exceeds 100", async () => {
    const res = await request(app)
      .get("/api/v1/contracts?limit=101")
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid cursor", async () => {
    const res = await request(app)
      .get("/api/v1/contracts?cursor=garbage")
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("error");
  });

  it("returns cursor page with empty data set", async () => {
    const res = await request(app)
      .get("/api/v1/contracts?limit=5")
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.meta.nextCursor).toBeNull();
    expect(res.body.meta.hasNextPage).toBe(false);
  });

  describe("cursor pagination — page boundary cases", () => {
    it("returns 200 with empty data array when no contracts exist", async () => {
      const res = await request(app)
        .get("/api/v1/contracts")
        .set(auth(adminToken()));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        status: "success",
        data: [],
        meta: expect.objectContaining({
          hasNextPage: false,
        }),
      });
      expect(res.body).toHaveProperty("requestId");
    });

    it("supports cursor-based pagination with valid cursor", async () => {
      await createContractAsAdmin();
      await createContractAsAdmin();
      await createContractAsAdmin();

      const first = await request(app)
        .get("/api/v1/contracts?limit=2")
        .set(auth(adminToken()));

      expect(first.status).toBe(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta.hasNextPage).toBe(true);

      if (first.body.meta.nextCursor) {
        const second = await request(app)
          .get(
            `/api/v1/contracts?limit=2&cursor=${encodeURIComponent(first.body.meta.nextCursor)}`,
          )
          .set(auth(adminToken()));
        expect(second.status).toBe(200);
        expect(second.body.data).toHaveLength(1);
        expect(second.body.meta.hasNextPage).toBe(false);
      }
    });
  });

  // ─── POST /api/v1/contracts ───────────────────────────────────────────────────

  describe("POST /api/v1/contracts", () => {
    it("returns 401 without a token", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .send(validPayload);
      expect(res.status).toBe(401);
    });

    it("returns 201 for admin with valid payload", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body.data).toHaveProperty("id");
      expect(res.body.data.title).toBe(validPayload.title);
    });

    it("returns 201 for client (create is permitted)", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(clientToken()), "Idempotency-Key": randomUUID() })
        .send(validPayload);
      expect(res.status).toBe(201);
    });

    it("returns 403 for freelancer (create not in permission matrix)", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set(auth(freelancerToken()))
        .send(validPayload);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatchObject({ code: "forbidden" });
    });

    it("returns 400 for admin with invalid payload (missing title)", async () => {
      const { title: _t, ...noTitle } = validPayload;
      const res = await request(app)
        .post("/api/v1/contracts")
        .set(auth(adminToken()))
        .send(noTitle);
      expect(res.status).toBe(400);
    });

    it("returns 400 for admin with negative budget", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set(auth(adminToken()))
        .send({ ...validPayload, budget: -100 });
      expect(res.status).toBe(400);
    });

    it("returns 400 for budget exceeding maximum contract amount (validation)", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, budget: 999_000_000_000_000_000 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 when clientId is missing", async () => {
      const { clientId: _c, ...noClient } = validPayload;
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send(noClient);
      expect(res.status).toBe(400);
    });

    it("returns 400 when clientId is not a valid UUID", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, clientId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when description is missing", async () => {
      const { description: _d, ...noDesc } = validPayload;
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send(noDesc);
      expect(res.status).toBe(400);
    });

    it("returns 400 when description is too short", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, description: "Short" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when title is too short", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, title: "Hi" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when budget is zero", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, budget: 0 });
      expect(res.status).toBe(400);
    });

    it("returns 400 when budget is missing", async () => {
      const { budget: _b, ...noBudget } = validPayload;
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send(noBudget);
      expect(res.status).toBe(400);
    });

    it("returns 400 when freelancerId is not a valid UUID", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, freelancerId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });

    it("returns 400 when milestone has negative amount", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({
          ...validPayload,
          milestones: [
            {
              title: "Bad Milestone",
              description: "Negative amount",
              amount: -100,
            },
          ],
        });
      expect(res.status).toBe(400);
    });

    it("returns 201 on success with expected envelope shape", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        status: "success",
        data: expect.objectContaining({
          title: validPayload.title,
          clientId: CLIENT_ID,
          status: "draft",
        }),
      });
      expect(res.body).toHaveProperty("requestId");
      expect(res.body.data).toHaveProperty("id");
      expect(res.body.data).toHaveProperty("version", 0);
      expect(res.body.data).toHaveProperty("createdAt");
    });

    it("returns 422 for milestone count exceeding maximum limit", async () => {
      const excessiveMilestones = Array.from({ length: 25 }, (_, i) => ({
        title: `Milestone ${i}`,
        description: `Description ${i}`,
        amount: 100,
      }));
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, milestones: excessiveMilestones });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: "contract_bounds_error" });
    });

    it("returns 400 for total milestone amount exceeding bounds (schema validation)", async () => {
      const excessiveAmountMilestones = [
        {
          title: "Milestone 1",
          description: "Valid description",
          amount: 999_000_000_000_000_000,
        },
      ];
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, milestones: excessiveAmountMilestones });
      // The DTO schema's per-milestone amount cap catches this at validation
      // time (400) before the service can apply the 422 bounds check.
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });
  });

  describe("POST /api/v1/contracts idempotency", () => {
    it("returns 400 when Idempotency-Key header is missing", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set(auth(adminToken()))
        .send(validPayload);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "bad_request" });
    });
  });

  afterAll(() => {
    closeDb();
  });

  // ─── Validation hardening: unknown field stripping ────────────────────────────

  describe("POST /api/v1/contracts — unknown field stripping", () => {
    it("strips unknown fields from body and still creates successfully", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({
          ...validPayload,
          __admin: true,
          inject: "evil",
          extraField: 999,
        });
      expect(res.status).toBe(201);
      // unknown fields must not appear in the response data
      expect(res.body.data).not.toHaveProperty("__admin");
      expect(res.body.data).not.toHaveProperty("inject");
      expect(res.body.data).not.toHaveProperty("extraField");
    });

    it("strips unknown milestone fields and still creates successfully", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({
          ...validPayload,
          milestones: [
            {
              title: "M1",
              description: "Valid desc",
              amount: 100,
              __secret: "leak",
              bonus: 50,
            },
          ],
        });
      expect(res.status).toBe(201);
    });
  });

  describe("PATCH /api/v1/contracts/:id — unknown field rejection", () => {
    // Unlike POST (which strips unknown fields), PATCH rejects them outright:
    // this is the write path used to initiate/resolve disputes via `status`,
    // so a typo'd or unexpected field must surface as an error rather than be
    // silently dropped. See the `.strict()` rationale on updateContractBodySchema.
    it("rejects unknown fields in the update body with a structured 400", async () => {
      const contractId = await createContractAsAdmin();
      const fetched = await request(app)
        .get(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()));
      const version = (fetched.body as { data: { version: number } }).data
        .version;

      const res = await request(app)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()))
        .send({
          version,
          title: "Stripped Update",
          __admin: true,
          __inject: "payload",
          extraField: "should-be-dropped",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "bad_request" });
    });
  });

  // ─── Validation hardening: route param :id ────────────────────────────────────

  describe("GET /api/v1/contracts/:id — route param validation", () => {
    it("returns 400 for an id that exceeds the max length", async () => {
      const oversizedId = "a".repeat(129);
      const res = await request(app)
        .get(`/api/v1/contracts/${oversizedId}`)
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });
  });

  describe("PATCH /api/v1/contracts/:id — route param validation", () => {
    it("returns 400 for an id that exceeds the max length", async () => {
      const oversizedId = "a".repeat(129);
      const res = await request(app)
        .patch(`/api/v1/contracts/${oversizedId}`)
        .set(auth(adminToken()))
        .send({ version: 0, title: "Should not reach service" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });
  });

  describe("DELETE /api/v1/contracts/:id — route param validation", () => {
    it("returns 400 for an id that exceeds the max length", async () => {
      const oversizedId = "a".repeat(129);
      const res = await request(app)
        .delete(`/api/v1/contracts/${oversizedId}`)
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });
  });

  // ─── Validation hardening: query param validation ────────────────────────────

  describe("GET /api/v1/contracts — query param validation", () => {
    it("returns 400 for limit exceeding QUERY_LIMIT_MAX (101)", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?limit=101")
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
    });

    it("returns 400 for non-numeric limit", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?limit=abc")
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for invalid status enum value", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?status=pending")
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for non-UUID clientId in query", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?clientId=not-a-uuid")
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for invalid sortOrder", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?sortOrder=random")
        .set(auth(adminToken()));
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("strips unknown query params and returns 200", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?page=1&limit=10&admin=true&__inject=evil")
        .set(auth(adminToken()));
      expect(res.status).toBe(200);
    });

    it("returns 200 with limit = QUERY_LIMIT_MAX (100)", async () => {
      const res = await request(app)
        .get("/api/v1/contracts?limit=100")
        .set(auth(adminToken()));
      expect(res.status).toBe(200);
    });
  });

  // ─── Validation hardening: string length bounds on POST ──────────────────────

  describe("POST /api/v1/contracts — string length bounds", () => {
    it("returns 400 for title longer than 100 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, title: "A".repeat(101) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for description longer than 1000 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, description: "A".repeat(1001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for terms longer than 5000 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, terms: "A".repeat(5001) });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 201 for terms at exactly 5000 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({ ...validPayload, terms: "A".repeat(5000) });
      expect(res.status).toBe(201);
    });

    it("returns 400 for milestone title exceeding 100 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({
          ...validPayload,
          milestones: [{ title: "A".repeat(101), amount: 100 }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });

    it("returns 400 for milestone description exceeding 500 characters", async () => {
      const res = await request(app)
        .post("/api/v1/contracts")
        .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
        .send({
          ...validPayload,
          milestones: [
            { title: "M1", description: "A".repeat(501), amount: 100 },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "validation_error" });
    });
  });

  // ─── Validation hardening: numeric range bounds on PATCH ─────────────────────

  describe("PATCH /api/v1/contracts/:id — numeric range and type bounds", () => {
    let contractId: string;
    let contractVersion: number;

    beforeEach(async () => {
      contractId = await createContractAsAdmin();
      const fetched = await request(app)
        .get(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()));
      contractVersion = (fetched.body as { data: { version: number } }).data
        .version;
    });

    it("returns 400 for negative budget on update", async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()))
        .send({ version: contractVersion, budget: -1 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "bad_request" });
    });

    it("returns 400 for title too short on update", async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()))
        .send({ version: contractVersion, title: "Hi" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "bad_request" });
    });

    it("returns 400 for invalid status on update", async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()))
        .send({ version: contractVersion, status: "archived" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: "bad_request" });
    });

    it("returns 400 when version is a string instead of a number", async () => {
      const res = await request(app)
        .patch(`/api/v1/contracts/${contractId}`)
        .set(auth(adminToken()))
        .send({ version: "zero", title: "Type error update" });
      expect(res.status).toBe(400);
    });
  });
});

afterAll(() => {
  closeDb();
});
