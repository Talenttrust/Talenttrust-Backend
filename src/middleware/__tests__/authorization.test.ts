

// ─── Set secret BEFORE any other imports so the middleware picks it up ────────
process.env.JWT_SECRET = "talenttrust-test-secret";

import express, { type Request, type Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  requireAuth,
  requireRole,
  requirePermission,
} from "../authorization";
import { AuthenticatedRequest } from "../../lib/types";

// ─── Constants ────────────────────────────────────────────────────────────────

const SECRET       = process.env.JWT_SECRET || 'your-jwt-secret';
const WRONG_SECRET = "wrong-secret";

// ─── Token helpers ────────────────────────────────────────────────────────────

/**
 * Signs a valid JWT.  `sub` lives only in the payload — never in options.subject
 * — to avoid the "payload already has sub property" error from jsonwebtoken.
 */
function makeToken(
  role: string,
  sub  = "user-1",
  opts: { secret?: string; expiresIn?: string | number } = {}
): string {
  return jwt.sign(
    { sub, email: "test@tt.com", role },
    opts.secret ?? SECRET,
    { expiresIn: (opts.expiresIn ?? "1h") as any }
  );
}

const adminToken      = () => makeToken("admin",      "admin-1");
const clientToken     = (id = "client-1") => makeToken("client",     id);
const freelancerToken = (id = "free-1")   => makeToken("freelancer", id);

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

//  App factory 

function makeApp(
  middlewares: any[],
  handler = (_req: Request, res: Response) => res.json({ ok: true })
) {
  const app = express();
  app.use(express.json());
  app.get("/test", ...middlewares, handler);
  return app;
}


it("requireAuth: valid token → 200 and req.user populated", async () => {
  const app = makeApp(
    [requireAuth],
    (req: AuthenticatedRequest, res: Response) => res.json({ user: req.user })
  );
  const res = await request(app).get("/test").set(bearer(clientToken("client-abc")));
  expect(res.status).toBe(200);
  expect(res.body.user).toMatchObject({ id: "client-abc", role: "client" });
});


it("requireAuth: missing Authorization header → 401", async () => {
  const app = makeApp([requireAuth]);
  const res = await request(app).get("/test");
  expect(res.status).toBe(401);
  expect(res.body).toHaveProperty("error");
});

it("requireAuth: token signed with wrong secret → 401", async () => {
  const forged = makeToken("admin", "attacker", { secret: WRONG_SECRET });
  const app = makeApp([requireAuth]);
  const res = await request(app).get("/test").set(bearer(forged));
  expect(res.status).toBe(401);
});


it("requireAuth: expired token → 401 with expiry message", async () => {
  const expired = makeToken("admin", "user-1", { expiresIn: -1 });
  const app = makeApp([requireAuth]);
  const res = await request(app).get("/test").set(bearer(expired));
  expect(res.status).toBe(401);
  expect(res.body.error).toMatch(/expired/i);
});

it("requireAuth: token with unknown role → 401", async () => {
  const badRole = makeToken("superadmin", "u-1");
  const app = makeApp([requireAuth]);
  const res = await request(app).get("/test").set(bearer(badRole));
  expect(res.status).toBe(401);
});


it("requireRole: matching role → 200; non-matching role → 403", async () => {
  const adminApp      = makeApp([requireAuth, requireRole("admin")]);
  const freelancerApp = makeApp([requireAuth, requireRole("admin")]);

  const pass = await request(adminApp).get("/test").set(bearer(adminToken()));
  expect(pass.status).toBe(200);

  const fail = await request(freelancerApp).get("/test").set(bearer(freelancerToken()));
  expect(fail.status).toBe(403);
  expect(fail.body).toHaveProperty("error");
});


it("requireRole: called without requireAuth → 401", async () => {
  const app = makeApp([requireRole("admin")]);
  const res = await request(app).get("/test");
  expect(res.status).toBe(401);
});

it("requirePermission: client may list jobs; freelancer may not create jobs", async () => {
  const listApp   = makeApp([requireAuth, requirePermission("jobs", "list")]);
  const createApp = makeApp([requireAuth, requirePermission("jobs", "create")]);

  const pass = await request(listApp).get("/test").set(bearer(clientToken()));
  expect(pass.status).toBe(200);

  const fail = await request(createApp).get("/test").set(bearer(freelancerToken()));
  expect(fail.status).toBe(403);
});


it("requirePermission ownOnly: owner → 200; non-owner → 403; missing record → 404", async () => {
  const ownerResolver    = jest.fn().mockResolvedValue("client-1");
  const nonOwnerResolver = jest.fn().mockResolvedValue("someone-else");
  const missingResolver  = jest.fn().mockResolvedValue(null);

  const app = (resolver: any) =>
    makeApp([requireAuth, requirePermission("jobs", "update", resolver)]);

  const own  = await request(app(ownerResolver)).get("/test").set(bearer(clientToken("client-1")));
  expect(own.status).toBe(200);

  const deny = await request(app(nonOwnerResolver)).get("/test").set(bearer(clientToken("client-1")));
  expect(deny.status).toBe(403);

  const miss = await request(app(missingResolver)).get("/test").set(bearer(clientToken("client-1")));
  expect(miss.status).toBe(404);
});

it("security: 403 and 401 responses do not leak ids or token contents", async () => {
  // 403 must not contain either user id
  const resolver = jest.fn().mockResolvedValue("owner-secret-id");
  const forbiddenApp = makeApp([requireAuth, requirePermission("jobs", "update", resolver)]);
  const forbiddenRes = await request(forbiddenApp)
    .get("/test")
    .set(bearer(clientToken("requester-secret-id")));
  expect(forbiddenRes.status).toBe(403);
  const forbiddenBody = JSON.stringify(forbiddenRes.body);
  expect(forbiddenBody).not.toContain("requester-secret-id");
  expect(forbiddenBody).not.toContain("owner-secret-id");

  // 401 must not echo the raw token back
  const rawToken = makeToken("admin", "u1", { secret: WRONG_SECRET });
  const unauthorizedApp = makeApp([requireAuth]);
  const unauthorizedRes = await request(unauthorizedApp).get("/test").set(bearer(rawToken));
  expect(unauthorizedRes.status).toBe(401);
  expect(JSON.stringify(unauthorizedRes.body)).not.toContain(rawToken);
});