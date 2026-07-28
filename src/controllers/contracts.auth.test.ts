/**
 * @file controllers/contracts.auth.test.ts
 * @description Authorization and tenant-scoping tests for `/api/v1/contracts`.
 *
 * Issue #729 — Cover contracts auth and scoping.
 *
 * NOTE ON "TENANT":
 * This codebase does not implement multi-tenant isolation via tenantId/orgId.
 * Authorization is RBAC with optional per-record ownership (`ownOnly`).
 * For contracts, the owner resolver returns `contract.clientId`.
 * Issue language ("cross-tenant") is mapped here to **cross-owner** access:
 * Client A must not read/update Client B's contract.
 *
 * Documented current behaviours (not changed by this suite):
 *  - Collection `list` / `stats` / `bounds` use ownOnly without an owner
 *    resolver → client & freelancer receive 403 (not a filtered list).
 *  - Owner identity is `clientId` only → a freelancer JWT whose `sub`
 *    matches `freelancerId` still fails ownOnly on GET/PATCH.
 *  - `GET /:id/history` is currently unauthenticated (open).
 */

process.env.JWT_SECRET = 'contracts-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { getDb } from '../db/database';
import app from '../index';

const SECRET = process.env.JWT_SECRET as string;

const CLIENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLIENT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const FREELANCER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeToken(
  role: string,
  sub: string,
  expiresIn: number | string = '1h',
): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign(
    { sub, email: `${sub}@test.com`, role },
    SECRET,
    { expiresIn } as any,
  ) as string;
}

const adminToken = () => makeToken('admin', 'admin-authz-1');
const auditorToken = () => makeToken('auditor', 'auditor-authz-1');
const clientAToken = () => makeToken('client', CLIENT_A);
const clientBToken = () => makeToken('client', CLIENT_B);
const freelancerToken = () => makeToken('freelancer', FREELANCER_ID);

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const basePayload = {
  title: 'Authz Contract Title',
  description: 'Long enough description for contract authz coverage tests.',
  clientId: CLIENT_A,
  freelancerId: FREELANCER_ID,
  budget: 4200,
};

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(CLIENT_A, 'clienta', 'clienta@test.com', 'client', now);
  insert.run(CLIENT_B, 'clientb', 'clientb@test.com', 'client', now);
  insert.run(FREELANCER_ID, 'freelancera', 'freelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

async function createOwnedContract(
  overrides: Partial<typeof basePayload> = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return (res.body as { data: { id: string } }).data.id;
}

async function fetchVersion(id: string): Promise<number> {
  const res = await request(app)
    .get(`/api/v1/contracts/${id}`)
    .set(auth(adminToken()));
  expect(res.status).toBe(200);
  return (res.body as { data: { version: number } }).data.version;
}

// ─── Missing / invalid auth → 401 ───────────────────────────────────────────

describe('contracts authz — missing and invalid auth (401)', () => {
  const protectedGets = [
    ['GET /', '/api/v1/contracts'],
    ['GET /bounds', '/api/v1/contracts/bounds'],
    ['GET /stats', '/api/v1/contracts/stats'],
  ] as const;

  it.each(protectedGets)('%s returns 401 without Authorization', async (_label, path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('GET /:id returns 401 without Authorization', async () => {
    const id = await createOwnedContract();
    const res = await request(app).get(`/api/v1/contracts/${id}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('POST / returns 401 without Authorization', async () => {
    const res = await request(app).post('/api/v1/contracts').send(basePayload);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('PATCH /:id returns 401 without Authorization', async () => {
    const id = await createOwnedContract();
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .send({ version: 1, title: 'Nope' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('DELETE /:id returns 401 without Authorization', async () => {
    const id = await createOwnedContract();
    const res = await request(app).delete(`/api/v1/contracts/${id}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatchObject({ code: 'unauthorized' });
  });

  it('returns 401 for malformed Authorization (no Bearer)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', 'Token not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 for empty Bearer token', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Authorization', 'Bearer ');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 for expired JWT', async () => {
    const expired = makeToken('admin', 'admin-authz-1', -1);
    const res = await request(app).get('/api/v1/contracts').set(auth(expired));
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).toMatch(/expired/i);
  });

  it('returns 401 for JWT signed with wrong secret', async () => {
    const forged = jwt.sign(
      { sub: 'x', email: 'x@x.com', role: 'admin' },
      'wrong-secret',
      { algorithm: 'HS256' },
    );
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 for JWT with unrecognised role', async () => {
    const token = jwt.sign(
      { sub: 'x', email: 'x@x.com', role: 'superadmin' },
      SECRET,
      { algorithm: 'HS256' },
    );
    const res = await request(app).get('/api/v1/contracts').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('does not leak sub or token material on 401', async () => {
    const forged = jwt.sign(
      { sub: 'secret-leak-id', email: 'x@x.com', role: 'admin' },
      'wrong-secret',
      { algorithm: 'HS256' },
    );
    const res = await request(app).get('/api/v1/contracts').set(auth(forged));
    expect(res.status).toBe(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('secret-leak-id');
    expect(body).not.toContain(forged);
  });
});

// ─── Wrong scope / forbidden → 403 ──────────────────────────────────────────

describe('contracts authz — wrong scope / forbidden (403)', () => {
  it('freelancer cannot create contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(freelancerToken()), 'Idempotency-Key': randomUUID() })
      .send(basePayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('auditor cannot create contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(auditorToken()), 'Idempotency-Key': randomUUID() })
      .send(basePayload);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('client cannot delete contracts (delete is admin-only)', async () => {
    const id = await createOwnedContract();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(clientAToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('freelancer cannot delete contracts', async () => {
    const id = await createOwnedContract();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('auditor cannot update contracts', async () => {
    const id = await createOwnedContract();
    const version = await fetchVersion(id);
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(auditorToken()))
      .send({ version, title: 'Auditor should not update' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('auditor cannot delete contracts', async () => {
    const id = await createOwnedContract();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(auditorToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('client is denied collection list (ownOnly without owner resolver)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(clientAToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('freelancer is denied collection list (ownOnly without owner resolver)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('client is denied /stats (list ownOnly without owner resolver)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts/stats')
      .set(auth(clientAToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('client is denied /bounds (read ownOnly without owner resolver)', async () => {
    const res = await request(app)
      .get('/api/v1/contracts/bounds')
      .set(auth(clientAToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });
});

// ─── Cross-owner ("cross-tenant") denial ────────────────────────────────────

describe('contracts authz — cross-owner denial (scoped access)', () => {
  it('client B cannot GET client A contract → 403', async () => {
    const id = await createOwnedContract({ clientId: CLIENT_A });
    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(clientBToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
    // No contract payload leakage
    expect(res.body.data).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(CLIENT_A);
  });

  it('client B cannot PATCH client A contract → 403', async () => {
    const id = await createOwnedContract({ clientId: CLIENT_A });
    const version = await fetchVersion(id);
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(clientBToken()))
      .send({ version, title: 'Cross-owner hijack attempt' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('freelancer party cannot GET via freelancerId (owner is clientId) → 403', async () => {
    const id = await createOwnedContract({
      clientId: CLIENT_A,
      freelancerId: FREELANCER_ID,
    });
    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(freelancerToken()));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('freelancer party cannot PATCH via freelancerId → 403', async () => {
    const id = await createOwnedContract();
    const version = await fetchVersion(id);
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(freelancerToken()))
      .send({ version, title: 'Freelancer ownOnly mismatch' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'forbidden' });
  });

  it('missing contract id yields 404 (not 403) for authenticated client', async () => {
    const missingId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const res = await request(app)
      .get(`/api/v1/contracts/${missingId}`)
      .set(auth(clientAToken()));
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'not_found' });
  });
});

// ─── Owner / privileged allow paths ─────────────────────────────────────────

describe('contracts authz — owner and privileged allow', () => {
  it('owning client can GET their contract', async () => {
    const id = await createOwnedContract({ clientId: CLIENT_A });
    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(clientAToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.clientId).toBe(CLIENT_A);
  });

  it('owning client can PATCH their contract', async () => {
    const id = await createOwnedContract({ clientId: CLIENT_A });
    const version = await fetchVersion(id);
    const res = await request(app)
      .patch(`/api/v1/contracts/${id}`)
      .set(auth(clientAToken()))
      .send({ version, title: 'Owner Updated Title' });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe('Owner Updated Title');
  });

  it('admin can list all contracts (unscoped privileged list)', async () => {
    await createOwnedContract({ clientId: CLIENT_A });
    await createOwnedContract({
      clientId: CLIENT_B,
      title: 'Second Authz Contract Title',
    });
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
    const rows =
      res.body.data?.data ?? res.body.data;
    expect(Array.isArray(rows) || Array.isArray(res.body.data)).toBe(true);
    // Admin list is not filtered to a single caller — both owners may appear.
    const serialized = JSON.stringify(res.body);
    expect(serialized).toContain(CLIENT_A);
    expect(serialized).toContain(CLIENT_B);
  });

  it('auditor can list contracts', async () => {
    await createOwnedContract();
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(auditorToken()));
    expect(res.status).toBe(200);
  });

  it('auditor can GET a contract by id', async () => {
    const id = await createOwnedContract({ clientId: CLIENT_A });
    const res = await request(app)
      .get(`/api/v1/contracts/${id}`)
      .set(auth(auditorToken()));
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
  });

  it('admin can DELETE a contract', async () => {
    const id = await createOwnedContract();
    const res = await request(app)
      .delete(`/api/v1/contracts/${id}`)
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
  });

  it('client can create a contract', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set({ ...auth(clientAToken()), 'Idempotency-Key': randomUUID() })
      .send(basePayload);
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveProperty('id');
  });
});

// ─── Documented open history route (current behaviour) ──────────────────────

describe('contracts authz — GET /:id/history current behaviour', () => {
  it('allows unauthenticated history reads (documented gap; no behaviour change)', async () => {
    const id = await createOwnedContract();
    const res = await request(app).get(`/api/v1/contracts/${id}/history`);
    // Current router mounts history without requireAuth.
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  });
});

// ─── Edge: validation still runs for authenticated callers ──────────────────

describe('contracts authz — validation edges with auth present', () => {
  it('rejects oversized :id with 400 before ownership resolution', async () => {
    const oversizedId = 'a'.repeat(129);
    const res = await request(app)
      .get(`/api/v1/contracts/${oversizedId}`)
      .set(auth(clientAToken()));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
  });

  it('rejects invalid list query for admin with 400', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?page=-1')
      .set(auth(adminToken()));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'validation_error' });
  });

  it('strips unknown list query keys for admin and still returns 200', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?page=1&limit=5&debug=1')
      .set(auth(adminToken()));
    expect(res.status).toBe(200);
  });
});
