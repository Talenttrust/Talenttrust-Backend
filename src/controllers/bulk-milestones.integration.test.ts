/**
 * Integration tests for the Bulk Milestones endpoint.
 *
 * POST /api/v1/contracts/milestones/bulk
 *
 * Tests cover:
 *   ✓ Success paths          – create, update, delete milestones in bulk
 *   ✓ Partial failure        – mixed valid/invalid operations in one batch
 *   ✓ Over-cap rejection     – batch exceeding BULK_BATCH_SIZE_MAX
 *   ✓ Empty batch rejection  – empty operations array
 *   ✓ Validation errors      – missing required fields per action
 *   ✓ Not-found paths        – operations targeting non-existent contracts
 *   ✓ Version conflicts      – stale version on update/delete
 */

process.env.JWT_SECRET = "bulk-milestones-test-secret";
process.env.DB_PATH = ":memory:";

import request from "supertest";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { closeDb, getDb } from "../db/database";
import app from "../index";
import {
  MAX_MILESTONES_PER_CONTRACT,
  BULK_BATCH_SIZE_MAX,
} from "../contracts/bounds";

// Re-export BULK_BATCH_SIZE_MAX from DTO if not in bounds
const BATCH_MAX = 25;

// ─── Token helpers ─────────────────────────────────────────────────────────────

const SECRET = process.env.JWT_SECRET as string;

const CLIENT_ID = "00000000-0000-0000-0000-000000000011";
const FREELANCER_ID = "00000000-0000-0000-0000-000000000012";

function makeToken(role: string, sub = "user-1"): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, {
    expiresIn: "1h",
  } as any) as string;
}

const adminToken = () => makeToken("admin", "admin-1");
const clientToken = (id = CLIENT_ID) => makeToken("client", id);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

// ─── Shared payloads ───────────────────────────────────────────────────────────

const BULK_URL = "/api/v1/contracts/bulk";

const baseCreatePayload = {
  title: "Bulk Test Contract",
  description: "Contract used for bulk milestone integration tests.",
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 50_000,
};

// ─── Seed users so FK constraints pass ──────────────────────────────────────────

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, "bulkclient", "bulkclient@test.com", "client", now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    FREELANCER_ID,
    "bulkfreelancer",
    "bulkfreelancer@test.com",
    "freelancer",
    now,
  );
});

import { rateLimitStore } from "../config/rateLimit";

beforeEach(() => {
  rateLimitStore.clear();
  getDb().exec("DELETE FROM contracts");
});

afterAll(() => {
  closeDb();
});

// ─── Helpers ────────────────────────────────────────────────────────────────────

async function createContract(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await request(app)
    .post("/api/v1/contracts")
    .set({ ...auth(adminToken()), "Idempotency-Key": randomUUID() })
    .send({ ...baseCreatePayload, ...overrides });
  expect(res.status).toBe(201);
  return {
    id: res.body.data.id as string,
    version: res.body.data.version as number,
  };
}

// ─── Success paths ─────────────────────────────────────────────────────────────

describe("Bulk milestones – success paths", () => {
  it("creates a single contract with milestones via bulk endpoint", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Bulk Created Contract",
            description: "Created via bulk milestones endpoint.",
            clientId: CLIENT_ID,
            freelancerId: FREELANCER_ID,
            budget: 10_000,
            milestones: [
              {
                title: "Design",
                description: "UI/UX design phase",
                amount: 3000,
              },
              {
                title: "Development",
                description: "Implementation phase",
                amount: 7000,
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(1);
    expect(res.body.data.results[0]).toMatchObject({
      index: 0,
      status: "success",
    });
    expect(res.body.data.results[0].contractId).toBeDefined();
    expect(res.body.data.summary).toEqual({
      total: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it("creates multiple contracts in a single bulk request", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Contract Alpha",
            description: "First bulk contract for testing.",
            clientId: CLIENT_ID,
            budget: 5000,
            milestones: [
              {
                title: "MS-A1",
                description: "Alpha milestone 1",
                amount: 5000,
              },
            ],
          },
          {
            action: "create",
            title: "Contract Beta",
            description: "Second bulk contract for testing.",
            clientId: CLIENT_ID,
            budget: 8000,
            milestones: [
              { title: "MS-B1", description: "Beta milestone 1", amount: 4000 },
              { title: "MS-B2", description: "Beta milestone 2", amount: 4000 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0].status).toBe("success");
    expect(res.body.data.results[1].status).toBe("success");
    expect(res.body.data.summary).toEqual({
      total: 2,
      succeeded: 2,
      failed: 0,
    });
  });

  it("updates milestones on an existing contract via bulk endpoint", async () => {
    const { id, version } = await createContract();

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            contractId: id,
            version,
            milestones: [
              {
                title: "Updated MS",
                description: "Replaced milestone",
                amount: 2000,
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({
      index: 0,
      status: "success",
      contractId: id,
    });
    expect(res.body.data.summary).toEqual({
      total: 1,
      succeeded: 1,
      failed: 0,
    });
  });

  it("deletes milestones (sets to empty array) via bulk endpoint", async () => {
    const { id, version } = await createContract({
      milestones: [
        { title: "To Delete", description: "Will be removed", amount: 1000 },
      ],
    });

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "delete",
            contractId: id,
            version,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0]).toMatchObject({
      index: 0,
      status: "success",
      contractId: id,
    });
  });

  it("mixed create and update operations in one batch", async () => {
    const { id, version } = await createContract();

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "New Contract",
            description: "Created alongside an update operation.",
            clientId: CLIENT_ID,
            budget: 3000,
            milestones: [
              { title: "New MS", description: "New milestone", amount: 3000 },
            ],
          },
          {
            action: "update",
            contractId: id,
            version,
            milestones: [
              {
                title: "Replaced MS",
                description: "Updated milestone",
                amount: 500,
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0].status).toBe("success");
    expect(res.body.data.results[1].status).toBe("success");
    expect(res.body.data.results[0].contractId).toBeDefined();
    expect(res.body.data.results[1].contractId).toBe(id);
    expect(res.body.data.summary).toEqual({
      total: 2,
      succeeded: 2,
      failed: 0,
    });
  });

  it("client owner can use bulk endpoint to create contracts", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(clientToken(CLIENT_ID)))
      .send({
        operations: [
          {
            action: "create",
            title: "Client Owned Contract",
            description: "Created by client via bulk endpoint.",
            clientId: CLIENT_ID,
            budget: 2000,
            milestones: [
              {
                title: "Client MS",
                description: "Client milestone",
                amount: 2000,
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("success");
  });

  it("response envelope includes requestId", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Envelope Test",
            description: "Testing response envelope structure.",
            clientId: CLIENT_ID,
            budget: 1000,
            milestones: [
              { title: "Env MS", description: "Envelope", amount: 1000 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("requestId");
    expect(res.body.status).toBe("success");
  });
});

// ─── Partial failure paths ─────────────────────────────────────────────────────

describe("Bulk milestones – partial failure", () => {
  it("reports per-item errors when some operations fail", async () => {
    const { id, version } = await createContract();

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Valid Contract",
            description: "This create operation should succeed.",
            clientId: CLIENT_ID,
            budget: 5000,
            milestones: [
              { title: "Valid MS", description: "Valid", amount: 5000 },
            ],
          },
          {
            action: "update",
            contractId: "00000000-0000-0000-0000-000000000000",
            version: 0,
            milestones: [
              {
                title: "Ghost MS",
                description: "Non-existent contract",
                amount: 100,
              },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(2);
    expect(res.body.data.results[0].status).toBe("success");
    expect(res.body.data.results[0].contractId).toBeDefined();
    expect(res.body.data.results[1].status).toBe("error");
    expect(res.body.data.results[1].error).toHaveProperty("code", "not_found");
    expect(res.body.data.summary).toEqual({
      total: 2,
      succeeded: 1,
      failed: 1,
    });
  });

  it("reports error when milestones total exceeds budget on create", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Over Budget Contract",
            description: "Milestones exceed budget.",
            clientId: CLIENT_ID,
            budget: 1000,
            milestones: [
              { title: "Expensive MS", description: "Too much", amount: 5000 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("error");
    expect(res.body.data.results[0].error).toHaveProperty(
      "code",
      "contract_bounds_error",
    );
    expect(res.body.data.summary).toEqual({
      total: 1,
      succeeded: 0,
      failed: 1,
    });
  });

  it("reports error when milestone count exceeds max on create", async () => {
    const milestones = Array.from(
      { length: MAX_MILESTONES_PER_CONTRACT + 1 },
      (_, i) => ({
        title: `MS-${i + 1}`,
        description: `Milestone ${i + 1}`,
        amount: 1,
      }),
    );

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Too Many Milestones",
            description: "Exceeds max milestone count.",
            clientId: CLIENT_ID,
            budget: 100_000,
            milestones,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("error");
    expect(res.body.data.results[0].error).toHaveProperty(
      "code",
      "contract_bounds_error",
    );
  });

  it("reports version conflict on update with stale version", async () => {
    const { id, version } = await createContract();

    // First update succeeds
    const first = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            contractId: id,
            version,
            milestones: [
              { title: "First Update", description: "V1", amount: 500 },
            ],
          },
        ],
      });
    expect(first.status).toBe(200);
    expect(first.body.data.results[0].status).toBe("success");

    // Second update with stale version fails
    const second = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            contractId: id,
            version, // stale
            milestones: [
              { title: "Stale Update", description: "Conflict", amount: 600 },
            ],
          },
        ],
      });
    expect(second.status).toBe(200);
    expect(second.body.data.results[0].status).toBe("error");
    expect(second.body.data.results[0].error).toHaveProperty(
      "code",
      "ERR_CONFLICT",
    );
  });
});

// ─── Over-cap rejection ────────────────────────────────────────────────────────

describe("Bulk milestones – over-cap rejection", () => {
  it(`rejects batch exceeding ${BATCH_MAX} operations with 400`, async () => {
    const operations = Array.from({ length: BATCH_MAX + 1 }, (_, i) => ({
      action: "create" as const,
      title: `Contract ${i + 1}`,
      description: `Bulk contract number ${i + 1} for over-cap test.`,
      clientId: CLIENT_ID,
      budget: 100,
      milestones: [
        {
          title: `MS-${i + 1}`,
          description: `Milestone ${i + 1}`,
          amount: 100,
        },
      ],
    }));

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({ operations });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("accepts exactly the maximum batch size", async () => {
    const operations = Array.from({ length: BATCH_MAX }, (_, i) => ({
      action: "create" as const,
      title: `Max Batch Contract ${i + 1}`,
      description: `Contract ${i + 1} at the batch limit.`,
      clientId: CLIENT_ID,
      budget: 100,
      milestones: [
        {
          title: `MS-${i + 1}`,
          description: `Milestone ${i + 1}`,
          amount: 100,
        },
      ],
    }));

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({ operations });

    expect(res.status).toBe(200);
    expect(res.body.data.results).toHaveLength(BATCH_MAX);
    expect(res.body.data.summary.total).toBe(BATCH_MAX);
  });
});

// ─── Empty batch rejection ─────────────────────────────────────────────────────

describe("Bulk milestones – empty batch rejection", () => {
  it("rejects empty operations array with 400", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({ operations: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects missing operations field with 400", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });
});

// ─── Validation errors ─────────────────────────────────────────────────────────

describe("Bulk milestones – validation errors", () => {
  it("rejects create action with empty milestones array", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Empty Milestones",
            description: "Create with empty milestones should fail validation.",
            clientId: CLIENT_ID,
            budget: 5000,
            milestones: [],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects create action missing milestones field", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "No Milestones Field",
            description: "Create without milestones field.",
            clientId: CLIENT_ID,
            budget: 5000,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects update action missing contractId", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            version: 0,
            milestones: [
              { title: "MS", description: "No contractId", amount: 100 },
            ],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects update action missing version", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            contractId: randomUUID(),
            milestones: [
              { title: "MS", description: "No version", amount: 100 },
            ],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects delete action missing contractId", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "delete",
            version: 0,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects delete action missing version", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "delete",
            contractId: randomUUID(),
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects invalid action value", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "invalid_action",
            title: "Bad Action",
            description: "Invalid action type.",
            clientId: CLIENT_ID,
            budget: 1000,
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects create with invalid milestone amount (negative)", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Negative Amount",
            description: "Negative milestone amount.",
            clientId: CLIENT_ID,
            budget: 5000,
            milestones: [
              { title: "Bad MS", description: "Negative", amount: -100 },
            ],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects create with empty milestone title", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Empty Title MS",
            description: "Milestone with empty title.",
            clientId: CLIENT_ID,
            budget: 5000,
            milestones: [
              { title: "", description: "Empty title", amount: 100 },
            ],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("rejects create with invalid clientId UUID", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "create",
            title: "Bad Client",
            description: "Invalid clientId format.",
            clientId: "not-a-uuid",
            budget: 5000,
            milestones: [{ title: "MS", description: "Test", amount: 100 }],
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code", "validation_error");
  });

  it("error envelope has code, message, and requestId", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({ operations: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty("code");
    expect(res.body.error).toHaveProperty("message");
    expect(res.body.error).toHaveProperty("requestId");
  });
});

// ─── Not-found paths ──────────────────────────────────────────────────────────

describe("Bulk milestones – not-found paths", () => {
  it("reports not_found for update on non-existent contract", async () => {
    const ghostId = "00000000-0000-0000-0000-000000000000";

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "update",
            contractId: ghostId,
            version: 0,
            milestones: [
              { title: "Ghost MS", description: "Not found", amount: 100 },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("error");
    expect(res.body.data.results[0].error).toHaveProperty("code", "not_found");
  });

  it("reports not_found for delete on non-existent contract", async () => {
    const ghostId = "00000000-0000-0000-0000-000000000000";

    const res = await request(app)
      .post(BULK_URL)
      .set(auth(adminToken()))
      .send({
        operations: [
          {
            action: "delete",
            contractId: ghostId,
            version: 0,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe("error");
    expect(res.body.data.results[0].error).toHaveProperty("code", "not_found");
  });
});

// ─── Auth required ─────────────────────────────────────────────────────────────

describe("Bulk milestones – authentication", () => {
  it("rejects unauthenticated request with 401", async () => {
    const res = await request(app)
      .post(BULK_URL)
      .send({
        operations: [
          {
            action: "create",
            title: "Unauthed",
            description: "No auth token provided.",
            clientId: CLIENT_ID,
            budget: 1000,
            milestones: [{ title: "MS", description: "Test", amount: 100 }],
          },
        ],
      });

    expect(res.status).toBe(401);
  });
});
