/**
 * @file src/auth/authenticate.test.ts
 *
 * Comprehensive negative test suite for the `requireAuth` middleware.
 *
 * Tests cover:
 * - JWT expiry: expired tokens are rejected with appropriate error message
 * - Signature: tokens signed with wrong secret are rejected
 * - Malformed tokens: tampered signatures, invalid base64, corrupted structure
 * - Algorithm confusion: alg: none, RS256, HS384, HS512, missing alg are rejected
 * - Missing claims: tokens without sub/email/role are rejected
 * - Header parsing: missing Authorization, malformed Bearer prefix, empty token
 *
 * The auth path accepts ONLY HS256-signed JWTs. Any other algorithm in the token
 * header — most notably `alg: none` and HS/RS confusion attempts — cause the
 * request to fail with HTTP 401.
 *
 * These tests exercise the real `requireAuth` middleware exported from
 * `src/middleware/authorization.ts` and the `adminAuthGuard` middleware.
 * The shared `JWT_VERIFY_OPTIONS` constant from `src/auth/jwtConfig.ts` is
 * also asserted directly.
 */

// Configure the secret BEFORE other imports so the middleware's lazy
// getJwtSecret() grabs the right value.
process.env.JWT_SECRET = "talenttrust-test-secret";

import express, { type Response, type NextFunction } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import {
  JWT_ALLOWED_ALGORITHMS,
  JWT_VERIFY_OPTIONS,
} from "./jwtConfig";
import { requireAuth } from "../middleware/authorization";
import { adminAuthGuard } from "../middleware/adminAuthGuard";
import type { AuthenticatedRequest } from "../lib/types";

const SECRET = process.env.JWT_SECRET || "talenttrust-test-secret";
const WRONG_SECRET = "definitely-not-the-real-secret";

// ─── Base64URL helpers (required to hand-craft attack tokens) ──────────────────

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Build a JWT with a fully-controlled header. Used to fabricate attack
 * tokens (`alg: none`, `RS256`) that `jsonwebtoken.sign()` refuses to
 * produce on its own.
 */
function craftToken(
  header: Record<string, unknown>,
  payload: object,
  signature = "",
): string {
  return [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
    base64url(signature),
  ].join(".");
}

function userPayload() {
  return { sub: "user-1", email: "test@tt.com", role: "client" };
}

function adminPayload() {
  return { sub: "admin-1", email: "admin@tt.com", role: "admin" };
}

// Type-specific test app builders. The requireAuth and adminAuthGuard
// middlewares take different request shapes so they cannot share one
// generic `makeApp` without union types — keeping them apart is both
// clearer and strictly typed.

function makeRequireAuthApp() {
  const app = express();
  app.use(express.json());
  app.get(
    "/test",
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      res.json({ ok: true, user: req.user });
    },
  );
  return app;
}

function makeAdminAuthApp() {
  const app = express();
  app.use(express.json());
  app.get(
    "/admin",
    adminAuthGuard,
    (req: Request, res: Response, _next: NextFunction): void => {
      // AdminAuthenticatedRequest widens Request with optional `user` and
      // `apiKey`; we read only what adminAuthGuard populates.
      const user = (req as any).user;
      res.json({
        ok: true,
        user: user && {
          id: user.id,
          email: user.email,
          role: user.role,
          authMethod: user.authMethod,
        },
      });
    },
  );
  return app;
}

// `Request` is brought in late so the helper above reuses it for the
// admin route handler shape; express's types please us here.
import type { Request } from "express";

// ─── Constant assertions ──────────────────────────────────────────────────────

describe("jwtConfig (the algorithm pin contract)", () => {
  it("pins JWT_ALLOWED_ALGORITHMS to exactly ['HS256']", () => {
    expect(JWT_ALLOWED_ALGORITHMS).toEqual(["HS256"]);
    expect(JWT_ALLOWED_ALGORITHMS).toHaveLength(1);
  });

  it("freezes JWT_VERIFY_OPTIONS so consumers cannot edit it at runtime", () => {
    expect(Object.isFrozen(JWT_VERIFY_OPTIONS)).toBe(true);
    expect(Object.isFrozen(JWT_VERIFY_OPTIONS.algorithms)).toBe(true);
  });

  it("JWT_VERIFY_OPTIONS.algorithms == JWT_ALLOWED_ALGORITHMS", () => {
    expect(JWT_VERIFY_OPTIONS.algorithms).toEqual(JWT_ALLOWED_ALGORITHMS);
  });

  it("does not allow 'none' under any circumstances", () => {
    expect((JWT_ALLOWED_ALGORITHMS as readonly string[]).includes("none")).toBe(false);
  });
});

// ─── requireAuth + algorithm-confusion attack tokens ─────────────────────────

describe("requireAuth — algorithm-confusion hardening", () => {
  const app = makeRequireAuthApp();

  // Tiny helper so each test reads as one line.
  const get = (token: string) =>
    request(app).get("/test").set("Authorization", `Bearer ${token}`);

  it("accepts a valid HS256 token (positive control)", async () => {
    const tok = jwt.sign(userPayload(), SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "user-1", role: "client" });
  });

  it("rejects an alg=none token even with a valid-looking payload", async () => {
    // Per RFC 7519 an unsecured JWT omits the signature segment.
    const tok = craftToken({ alg: "none", typ: "JWT" }, userPayload(), "");
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty("code", "unauthorized");
  });

  it("rejects an alg=none token with a non-empty fake signature", async () => {
    // Some libraries allow an empty third segment for alg=none; we want
    // to make sure arbitrary "garbage" in that slot is also rejected.
    const tok = craftToken({ alg: "none", typ: "JWT" }, userPayload(), "fake");
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects an RS256-headered token (HS/RS confusion attempt)", async () => {
    const tok = craftToken(
      { alg: "RS256", typ: "JWT" },
      userPayload(),
      "any-fake-signature",
    );
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error).toHaveProperty("code", "unauthorized");
  });

  it("rejects an HS512-headered token even when the secret is right", async () => {
    const tok = jwt.sign(userPayload(), SECRET, {
      algorithm: "HS512",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects an HS384-headered token", async () => {
    const tok = jwt.sign(userPayload(), SECRET, {
      algorithm: "HS384",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects a token whose header omits the alg field", async () => {
    const tok = craftToken({ typ: "JWT" }, userPayload(), "signature");
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects a token whose header alg is an unknown string", async () => {
    const tok = craftToken({ alg: "HS999", typ: "JWT" }, userPayload(), "signature");
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("still rejects HS256 tokens signed with the wrong secret", async () => {
    const tok = jwt.sign(userPayload(), WRONG_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("still rejects expired HS256 tokens", async () => {
    const tok = jwt.sign(userPayload(), SECRET, {
      algorithm: "HS256",
      expiresIn: -10,
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  // ─── Missing / malformed claims ───────────────────────────────────────────────

  it("rejects a token missing the required 'sub' claim", async () => {
    const tok = jwt.sign({ email: "test@tt.com", role: "client" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing required claims/i);
  });

  it("rejects a token missing the required 'email' claim", async () => {
    const tok = jwt.sign({ sub: "user-1", role: "client" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/missing required claims/i);
  });

  it("rejects a token missing the required 'role' claim", async () => {
    const tok = jwt.sign({ sub: "user-1", email: "test@tt.com" }, SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/unrecognised role/i);
  });

  // ─── Header edge cases ───────────────────────────────────────────────────────

  it("rejects missing Authorization header", async () => {
    const res = await request(app).get("/test");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects malformed Bearer prefix (no space)", async () => {
    const tok = jwt.sign(userPayload(), SECRET, { algorithm: "HS256" });
    const res = await request(app).get("/test").set("Authorization", `Bearer${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/malformed/i);
  });

  it("rejects empty token after Bearer", async () => {
    const res = await request(app).get("/test").set("Authorization", "Bearer ");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/malformed/i);
  });

  it("rejects malformed Bearer prefix (wrong prefix)", async () => {
    const tok = jwt.sign(userPayload(), SECRET, { algorithm: "HS256" });
    const res = await request(app).get("/test").set("Authorization", `Basic ${tok}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/malformed/i);
  });

  // ─── Tampered signature (malformed token) ───────────────────────────────────────

  it("rejects a token with a tampered signature", async () => {
    const tok = jwt.sign(userPayload(), SECRET, { algorithm: "HS256" });
    // Tamper with the signature by flipping bits in the last character
    const parts = tok.split(".");
    const tamperedSig = parts[2].slice(0, -1) + "X";
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    const res = await request(app).get("/test").set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects a token with malformed base64 payload", async () => {
    // Token with invalid base64 in payload section
    const malformed = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aGVsbG8#world.signature`;
    const res = await request(app).get("/test").set("Authorization", `Bearer ${malformed}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });
});

// ─── adminAuthGuard — same algorithm pin must hold on the admin path ─────────

describe("adminAuthGuard — algorithm-confusion hardening", () => {
  const app = makeAdminAuthApp();

  const get = (token: string) =>
    request(app).get("/admin").set("Authorization", `Bearer ${token}`);

  it("accepts a valid HS256 admin token", async () => {
    const tok = jwt.sign(adminPayload(), SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: "admin-1", role: "admin" });
  });

  it("rejects an alg=none admin token", async () => {
    const tok = craftToken(
      { alg: "none", typ: "JWT" },
      adminPayload(),
      "",
    );
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects an RS256-headered admin token", async () => {
    const tok = craftToken(
      { alg: "RS256", typ: "JWT" },
      adminPayload(),
      "fake-sig",
    );
    const res = await get(tok);
    expect(res.status).toBe(401);
  });

  it("rejects an HS512 admin token even with the right secret", async () => {
    const tok = jwt.sign(adminPayload(), SECRET, {
      algorithm: "HS512",
      expiresIn: "1h",
    });
    const res = await get(tok);
    expect(res.status).toBe(401);
  });
});

// ─── Direct guard against an "options-less" jwt.verify bypass ────────────────
//
// These tests prove the constant alone is sufficient — even if a future
// caller passed JWT_VERIFY_OPTIONS but a future regression stripped the
// field, jsonwebtoken's behaviour with no allowlist permits alg:none.

describe("JWT_VERIFY_OPTIONS is genuinely enforced by jwt.verify", () => {
  it("verifies a valid HS256 token through JWT_VERIFY_OPTIONS", () => {
    const tok = jwt.sign(userPayload(), SECRET, { algorithm: "HS256" });
    const decoded = jwt.verify(tok, SECRET, JWT_VERIFY_OPTIONS) as jwt.JwtPayload;
    expect(decoded.sub).toBe("user-1");
  });

  it("throws on an alg=none token", () => {
    const tok = craftToken({ alg: "none", typ: "JWT" }, userPayload(), "");
    expect(() => jwt.verify(tok, SECRET, JWT_VERIFY_OPTIONS)).toThrow();
  });

  it("throws on an RS256-headered token", () => {
    const tok = craftToken({ alg: "RS256", typ: "JWT" }, userPayload(), "fake");
    expect(() => jwt.verify(tok, SECRET, JWT_VERIFY_OPTIONS)).toThrow();
  });

  it("throws on an HS512-signed token fed to an HS256-only verifier", () => {
    const tok = jwt.sign(userPayload(), SECRET, { algorithm: "HS512" });
    expect(() => jwt.verify(tok, SECRET, JWT_VERIFY_OPTIONS)).toThrow();
  });
});
