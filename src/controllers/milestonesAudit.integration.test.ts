/**
 * Integration tests for the milestones audit trail (issue #858).
 *
 * Exercises the real Express app end-to-end: contract create/update/delete
 * over HTTP, and the `GET /:id/milestones/audit-log` read view, verifying
 * actor/action/before-after summary/timestamp are recorded, secrets are
 * redacted, and the read view is bounded.
 */

// Must be set before any import so singletons pick them up.
process.env.JWT_SECRET = 'milestones-audit-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../db/database';
import app from '../index';
import { auditService } from '../audit/service';

const SECRET = process.env.JWT_SECRET as string;

const CLIENT_ID = '00000000-0000-0000-0000-000000000021';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000022';

function makeToken(role: string, sub = 'admin-1'): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' } as any) as string;
}

const adminToken = () => makeToken('admin', 'admin-1');
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const basePayload = {
  title: 'Milestones Audit Test Contract',
  description: 'Contract used exclusively for milestones-audit integration tests.',
  clientId: CLIENT_ID,
  freelancerId: FREELANCER_ID,
  budget: 10_000,
};

beforeAll(() => {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(CLIENT_ID, 'auditclient', 'auditclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'auditfreelancer', 'auditfreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

afterAll(() => {
  closeDb();
});

async function createContract(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; version: number }> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return { id: res.body.data.id as string, version: res.body.data.version as number };
}

async function patchContract(id: string, version: number, fields: Record<string, unknown>) {
  return request(app)
    .patch(`/api/v1/contracts/${id}`)
    .set(auth(adminToken()))
    .send({ version, ...fields });
}

async function getAuditLog(id: string, query = '') {
  return request(app)
    .get(`/api/v1/contracts/${id}/milestones/audit-log${query}`)
    .set(auth(adminToken()));
}

describe('Milestones audit trail — create', () => {
  it('records a MILESTONES_CREATED entry with actor, before=null, after summary, and a timestamp', async () => {
    const { id } = await createContract({
      milestones: [{ title: 'Kickoff', description: 'Start', amount: 1000 }],
    });

    const res = await getAuditLog(id);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(1);

    const entry = res.body.data.entries[0];
    expect(entry.action).toBe('MILESTONES_CREATED');
    expect(entry.severity).toBe('INFO');
    expect(entry.actor).toBe('admin-1');
    expect(entry.resource).toBe('milestones');
    expect(entry.resourceId).toBe(id);
    expect(typeof entry.timestamp).toBe('string');
    expect(new Date(entry.timestamp).toString()).not.toBe('Invalid Date');
    expect(entry.metadata.before).toBeNull();
    expect(entry.metadata.after).toMatchObject({ count: 1, totalAmount: 1000 });
  });

  it('does not record an audit entry for a contract created without milestones', async () => {
    const { id } = await createContract();
    const res = await getAuditLog(id);
    expect(res.status).toBe(200);
    expect(res.body.data.entries).toHaveLength(0);
  });
});

describe('Milestones audit trail — update', () => {
  it('records MILESTONES_UPDATED with a before/after diff when milestones content changes', async () => {
    const { id, version } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000 }],
    });

    const patch = await patchContract(id, version, {
      milestones: [{ title: 'Phase 1 revised', description: 'x', amount: 1500 }],
    });
    expect(patch.status).toBe(200);

    const res = await getAuditLog(id);
    expect(res.body.data.entries).toHaveLength(2);

    // Newest-first.
    const [latest, original] = res.body.data.entries;
    expect(original.action).toBe('MILESTONES_CREATED');
    expect(latest.action).toBe('MILESTONES_UPDATED');
    expect(latest.metadata.before).toMatchObject({ totalAmount: 1000 });
    expect(latest.metadata.after).toMatchObject({ totalAmount: 1500 });
  });

  it('does not record a new entry when a PATCH does not touch milestones', async () => {
    const { id, version } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000 }],
    });
    await patchContract(id, version, { title: 'Renamed, no milestones change' });

    const res = await getAuditLog(id);
    expect(res.body.data.entries).toHaveLength(1); // only the original CREATED entry
  });

  it('records a WARNING-severity MILESTONES_DELETED entry when milestones are cleared via PATCH', async () => {
    const { id, version } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000 }],
    });
    const patch = await patchContract(id, version, { milestones: [] });
    expect(patch.status).toBe(200);

    const res = await getAuditLog(id);
    const [latest] = res.body.data.entries;
    expect(latest.action).toBe('MILESTONES_DELETED');
    expect(latest.severity).toBe('WARNING');
    expect(latest.metadata.after).toBeNull();
  });

  it('does not record a no-op entry when a PATCH resubmits identical milestones', async () => {
    const { id, version } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000, deadline: '2026-12-01T00:00:00.000Z' }],
    });
    await patchContract(id, version, {
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000, deadline: '2026-12-01T00:00:00.000Z' }],
    });

    const res = await getAuditLog(id);
    expect(res.body.data.entries).toHaveLength(1);
  });
});

describe('Milestones audit trail — delete', () => {
  it('records a MILESTONES_DELETED entry when a contract with milestones is deleted', async () => {
    const { id } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 1000 }],
    });

    const del = await request(app).delete(`/api/v1/contracts/${id}`).set(auth(adminToken()));
    expect(del.status).toBe(200);

    // The convenience read-view route requires the contract to still exist
    // (it shares the same ownership/visibility check as GET /:id), so after
    // deletion we assert on the underlying audit store directly — this is a
    // known, documented scope boundary (see PR description).
    const entries = auditService.query({ resource: 'milestones', resourceId: id });
    expect(entries).toHaveLength(2);
    expect(entries[entries.length - 1]).toMatchObject({
      action: 'MILESTONES_DELETED',
      severity: 'WARNING',
      actor: 'admin-1',
    });
  });

  it('does not record an audit entry when a contract without milestones is deleted', async () => {
    const { id } = await createContract();
    const del = await request(app).delete(`/api/v1/contracts/${id}`).set(auth(adminToken()));
    expect(del.status).toBe(200);

    const entries = auditService.query({ resource: 'milestones', resourceId: id });
    expect(entries).toHaveLength(0);
  });
});

describe('Milestones audit trail — redaction', () => {
  it('masks an email-shaped milestone title before it is stored', async () => {
    const { id } = await createContract({
      milestones: [{ title: 'contact-owner@example.com', description: 'x', amount: 500 }],
    });

    const res = await getAuditLog(id);
    const [entry] = res.body.data.entries;
    expect(entry.metadata.after.items[0].title).toBe('con***@example.com');
    expect(entry.metadata.after.items[0].title).not.toContain('contact-owner@example.com');
  });

  it('never includes the free-text milestone description in the stored summary', async () => {
    const { id } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'token=super-secret-value-not-for-logs', amount: 500 }],
    });

    const res = await getAuditLog(id);
    const [entry] = res.body.data.entries;
    expect(JSON.stringify(entry.metadata)).not.toContain('super-secret-value-not-for-logs');
  });
});

describe('Milestones audit trail — read view', () => {
  it('returns 404 for a non-existent contract', async () => {
    const res = await getAuditLog('00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('bounds the page size and rejects an excessive limit by clamping to the store maximum', async () => {
    const { id } = await createContract({
      milestones: [{ title: 'Phase 1', description: 'x', amount: 100 }],
    });

    const res = await getAuditLog(id, '?limit=999999');
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBeLessThanOrEqual(100);
  });
});
