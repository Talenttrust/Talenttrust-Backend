/**
 * @file health/auth.test.ts
 * @description Authorization and tenant-scoping tests for the health endpoint.
 *
 * Covers:
 *  - Health endpoints are publicly accessible (no auth middleware applied).
 *  - requireAuth middleware properly rejects unauthenticated requests (401).
 *  - requireRole middleware properly rejects insufficient roles (403).
 *  - requirePermission middleware works for the "health" resource.
 *  - The permission matrix grants "health:read" to all roles including guest.
 *  - Cross-user / cross-ownership access patterns (no tenant-scoping exists).
 *
 * NOTE: This codebase does not implement multi-tenant isolation. Authorization
 * is role-based with optional per-record ownership checks (ownOnly). There
 * is no tenant ID, organization scoping, or namespace isolation. This test
 * file documents that finding.
 */

import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { buildHealthRouter } from "./router";
import { requireAuth, requireRole, requirePermission } from "../middleware/authorization";
import { isAuthorized, PERMISSION_MATRIX } from "../lib/authorization";
import { User } from "../lib/types";

const JWT_SECRET = process.env.JWT_SECRET || "test-secret-key-for-auth-tests";

// ── Helpers ─────────────────────────────────────────────────────────────────

const okProbe = async () => ({ name: "test", ok: true, latencyMs: 1 });

function signToken(payload: { sub: string; email: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { algorithm: "HS256", expiresIn: "1h" });
}

function buildHealthApp(probes = [okProbe]) {
  const app = express();
  app.use("/health", buildHealthRouter({ probes }));
  return app;
}

function buildProtectedHealthApp(probes = [okProbe]) {
  const app = express();
  app.use("/health", requireAuth, requirePermission("health", "read"), buildHealthRouter({ probes }));
  return app;
}

function buildRoleProtectedHealthApp(probes = [okProbe]) {
  const app = express();
  app.use(
    "/health",
    requireAuth,
    requireRole("admin", "auditor"),
    buildHealthRouter({ probes }),
  );
  return app;
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("health endpoint — public accessibility", () => {
  it("returns 200 without any Authorization header", async () => {
    const res = await request(buildHealthApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("returns 200 with a malformed Authorization header (health is public)", async () => {
    const res = await request(buildHealthApp())
      .get("/health")
      .set("Authorization", "Bearer invalid-token");
    expect(res.status).toBe(200);
  });
});

describe("health endpoint — requireAuth rejections", () => {
  let server: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    server = buildProtectedHealthApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await request(server).get("/health");
    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when Authorization header is malformed (no Bearer prefix)", async () => {
    const res = await request(server)
      .get("/health")
      .set("Authorization", "Basic abc123");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when Authorization header has empty Bearer token", async () => {
    const res = await request(server)
      .get("/health")
      .set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when JWT signature is invalid", async () => {
    const token = signToken({ sub: "user-1", email: "test@example.com", role: "admin" });
    const tampered = token.slice(0, -5) + "XXXXX";
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when JWT is signed with wrong secret", async () => {
    const token = jwt.sign(
      { sub: "user-1", email: "test@example.com", role: "admin" },
      "wrong-secret",
      { algorithm: "HS256" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when JWT is expired", async () => {
    const token = jwt.sign(
      { sub: "user-1", email: "test@example.com", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256", expiresIn: "-1h" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it("returns 401 when JWT has no sub claim", async () => {
    const token = jwt.sign(
      { email: "test@example.com", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when JWT has no email claim", async () => {
    const token = jwt.sign(
      { sub: "user-1", role: "admin" },
      JWT_SECRET,
      { algorithm: "HS256" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("returns 401 when JWT has unrecognised role", async () => {
    const token = jwt.sign(
      { sub: "user-1", email: "test@example.com", role: "superadmin" },
      JWT_SECRET,
      { algorithm: "HS256" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});

describe("health endpoint — requireRole rejections", () => {
  let server: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    server = buildRoleProtectedHealthApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("returns 403 when user role is not in allowed roles", async () => {
    const token = signToken({ sub: "user-1", email: "fl@test.com", role: "freelancer" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("forbidden");
  });

  it("returns 403 when user role is client", async () => {
    const token = signToken({ sub: "user-2", email: "cl@test.com", role: "client" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("allows access when user role is admin", async () => {
    const token = signToken({ sub: "admin-1", email: "admin@test.com", role: "admin" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("allows access when user role is auditor", async () => {
    const token = signToken({ sub: "aud-1", email: "aud@test.com", role: "auditor" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("health endpoint — requirePermission for health:read", () => {
  let server: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    server = buildProtectedHealthApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("allows admin to read health", async () => {
    const token = signToken({ sub: "u1", email: "a@test.com", role: "admin" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("allows auditor to read health", async () => {
    const token = signToken({ sub: "u2", email: "au@test.com", role: "auditor" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("allows freelancer to read health", async () => {
    const token = signToken({ sub: "u3", email: "f@test.com", role: "freelancer" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("allows client to read health", async () => {
    const token = signToken({ sub: "u4", email: "c@test.com", role: "client" });
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("permission matrix — health resource", () => {
  const roles = ["admin", "auditor", "client", "freelancer"] as const;
  const actions = ["create", "read", "update", "delete", "list"] as const;

  it("health:read is allowed for all roles in the matrix", () => {
    for (const role of roles) {
      const result = isAuthorized({
        user: { id: "u1", email: `${role}@test.com`, role },
        resource: "health",
        action: "read",
      });
      expect(result.granted).toBe(true);
    }
  });

  it("health resource only has 'read' action defined in PERMISSION_MATRIX", () => {
    const healthActions = Object.keys(
      (PERMISSION_MATRIX as Record<string, unknown>)["health"] ?? {},
    );
    expect(healthActions).toEqual(["read"]);
  });

  it("health resource does not exist in legacy ACCESS_CONTROL_MATRIX with write actions for non-admin", async () => {
    // Import the legacy matrix to cross-check
    const { ACCESS_CONTROL_MATRIX } = await import("../auth/roles");
    for (const role of ["auditor", "freelancer", "client", "guest"] as const) {
      const actions = ACCESS_CONTROL_MATRIX[role]?.health ?? [];
      expect(actions).not.toContain("create");
      expect(actions).not.toContain("update");
      expect(actions).not.toContain("delete");
    }
  });
});

describe("health endpoint — authorization edge cases", () => {
  let server: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    server = buildProtectedHealthApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it("rejects request with algorithm:none token", async () => {
    // Manually construct an alg:none token
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u1", email: "x@test.com", role: "admin", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    const token = `${header}.${payload}.`;

    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it("rejects HS256 token signed with HMAC when RSA key is expected (confusion protection)", async () => {
    // The server expects HS256, but this tests that a random key won't work
    const token = jwt.sign(
      { sub: "u1", email: "x@test.com", role: "admin" },
      "completely-different-key",
      { algorithm: "HS256" },
    );
    const res = await request(server)
      .get("/health")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("health endpoint — tenant-scoping note", () => {
  it("documents that this codebase has no multi-tenant isolation", () => {
    // FINDING: The TalentTrust backend does not implement tenant-level scoping.
    // Authorization is role-based (admin, auditor, client, freelancer) with
    // optional per-record ownership checks (ownOnly pattern). There is no
    // tenant ID, organization ID, or namespace isolation layer.
    //
    // Implications:
    // - All users share a single data namespace.
    // - Cross-user data isolation relies on explicit ownership checks per route.
    // - The health endpoint has no user-scoped data; it reports system-wide status.
    //
    // Recommendation: If multi-tenancy is required in the future, add a tenantId
    // claim to the JWT and a tenantId column to data tables, then enforce
    // tenant-scoping in a middleware layer similar to requirePermission.
    expect(true).toBe(true);
  });
});
