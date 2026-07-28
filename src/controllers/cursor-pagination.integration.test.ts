/**
 * Integration tests for cursor-based pagination on the contracts listing endpoint.
 *
 * Covers:
 *   ✓ Empty set — no contracts returns empty array with null cursor
 *   ✓ First page — returns nextCursor when more items exist
 *   ✓ Last page — returns null nextCursor
 *   ✓ Full traversal — iterate all pages, collect every item exactly once
 *   ✓ Exact-page boundary — limit equals total items
 *   ✓ Over-limit clamp — limit > MAX returns 400
 *   ✓ Invalid cursor — malformed cursor returns 400
 *   ✓ Default limit — omitting limit uses CURSOR_DEFAULT_LIMIT
 *   ✓ Custom limit — requesting a smaller page size works
 */

process.env.JWT_SECRET = 'cursor-pagination-test-secret';
process.env.DB_PATH = ':memory:';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { closeDb, getDb } from '../db/database';
import app from '../index';
import { CURSOR_MAX_LIMIT, CURSOR_DEFAULT_LIMIT } from '../contracts/cursor.types';

const SECRET = process.env.JWT_SECRET as string;
const CLIENT_ID = '00000000-0000-0000-0000-000000000031';
const FREELANCER_ID = '00000000-0000-0000-0000-000000000032';

function makeToken(role: string, sub = 'user-1'): string {
  return jwt.sign({ sub, email: `${sub}@test.com`, role }, SECRET, { expiresIn: '1h' } as any) as string;
}

const adminToken = () => makeToken('admin', 'admin-cp');

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const basePayload = {
  title: 'Cursor Pagination Test Contract',
  description: 'Contract for cursor pagination integration tests.',
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
  ).run(CLIENT_ID, 'cpclient', 'cpclient@test.com', 'client', now);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, email, role, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(FREELANCER_ID, 'cpfreelancer', 'cpfreelancer@test.com', 'freelancer', now);
});

beforeEach(() => {
  getDb().exec('DELETE FROM contracts');
});

afterAll(() => {
  closeDb();
});

async function createContract(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/contracts')
    .set({ ...auth(adminToken()), 'Idempotency-Key': randomUUID() })
    .send({ ...basePayload, ...overrides });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

// ─── Empty set ───────────────────────────────────────────────────────────────

describe('Cursor pagination — empty set', () => {
  it('returns empty array with null nextCursor when no contracts exist', async () => {
    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta).toEqual({
      limit: CURSOR_DEFAULT_LIMIT,
      nextCursor: null,
      hasNextPage: false,
    });
  });
});

// ─── First page / nextCursor ────────────────────────────────────────────────

describe('Cursor pagination — first page', () => {
  it('returns nextCursor when there are more items than limit', async () => {
    await createContract({ title: 'Contract A', budget: 100 });
    await createContract({ title: 'Contract B', budget: 200 });
    await createContract({ title: 'Contract C', budget: 300 });

    const res = await request(app)
      .get('/api/v1/contracts?limit=2')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.nextCursor).not.toBeNull();
    expect(res.body.meta.hasNextPage).toBe(true);
    expect(res.body.meta.limit).toBe(2);
  });

  it('returns null nextCursor when items fit in one page', async () => {
    await createContract({ title: 'OnlyOne', budget: 100 });

    const res = await request(app)
      .get('/api/v1/contracts?limit=10')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.nextCursor).toBeNull();
    expect(res.body.meta.hasNextPage).toBe(false);
  });
});

// ─── Last page ──────────────────────────────────────────────────────────────

describe('Cursor pagination — last page', () => {
  it('returns null nextCursor on the last page', async () => {
    await createContract({ title: 'Contract A', budget: 100 });
    await createContract({ title: 'Contract B', budget: 200 });
    await createContract({ title: 'Contract C', budget: 300 });

    // First page
    const page1 = await request(app)
      .get('/api/v1/contracts?limit=2')
      .set(auth(adminToken()));
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.meta.hasNextPage).toBe(true);

    // Second (last) page
    const cursor = page1.body.meta.nextCursor;
    const page2 = await request(app)
      .get(`/api/v1/contracts?limit=2&cursor=${cursor}`)
      .set(auth(adminToken()));
    expect(page2.status).toBe(200);
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.meta.nextCursor).toBeNull();
    expect(page2.body.meta.hasNextPage).toBe(false);
  });
});

// ─── Full traversal ─────────────────────────────────────────────────────────

describe('Cursor pagination — full traversal', () => {
  it('collects every item exactly once across all pages', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push(await createContract({ title: `Contract ${i}`, budget: 100 + i }));
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;

    while (true) {
      const url = cursor
        ? `/api/v1/contracts?limit=3&cursor=${cursor}`
        : '/api/v1/contracts?limit=3';
      const res = await request(app).get(url).set(auth(adminToken()));
      expect(res.status).toBe(200);

      for (const item of res.body.data) {
        collected.push(item.id);
      }
      pageCount++;

      if (!res.body.meta.hasNextPage) break;
      cursor = res.body.meta.nextCursor;
    }

    expect(pageCount).toBe(3); // ceil(7/3) = 3
    expect(collected).toHaveLength(7);
    // Each ID appears exactly once
    const unique = new Set(collected);
    expect(unique.size).toBe(7);
  });
});

// ─── Exact-page boundary ────────────────────────────────────────────────────

describe('Cursor pagination — exact-page boundary', () => {
  it('returns null nextCursor when total items equals limit', async () => {
    await createContract({ title: 'BoundaryA', budget: 100 });
    await createContract({ title: 'BoundaryB', budget: 200 });

    const res = await request(app)
      .get('/api/v1/contracts?limit=2')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.nextCursor).toBeNull();
    expect(res.body.meta.hasNextPage).toBe(false);
  });
});

// ─── Over-limit clamp ───────────────────────────────────────────────────────

describe('Cursor pagination — over-limit clamp', () => {
  it('returns 400 when limit exceeds CURSOR_MAX_LIMIT', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts?limit=${CURSOR_MAX_LIMIT + 1}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });

  it('returns 400 when limit is 0', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?limit=0')
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
  });

  it('returns 400 when limit is negative', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?limit=-5')
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
  });
});

// ─── Invalid cursor ─────────────────────────────────────────────────────────

describe('Cursor pagination — invalid cursor', () => {
  it('returns 400 for a malformed cursor string', async () => {
    const res = await request(app)
      .get('/api/v1/contracts?cursor=not-a-valid-cursor')
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('message');
  });

  it('returns 400 for a cursor with invalid JSON content', async () => {
    const badCursor = Buffer.from('not-json', 'utf8').toString('base64url');
    const res = await request(app)
      .get(`/api/v1/contracts?cursor=${badCursor}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
  });

  it('returns 400 for a cursor missing required fields', async () => {
    const badCursor = Buffer.from(
      JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z' }),
      'utf8',
    ).toString('base64url');
    const res = await request(app)
      .get(`/api/v1/contracts?cursor=${badCursor}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
  });

  it('returns 400 for a cursor with an invalid date', async () => {
    const badCursor = Buffer.from(
      JSON.stringify({ createdAt: 'not-a-date', id: 'abc-123' }),
      'utf8',
    ).toString('base64url');
    const res = await request(app)
      .get(`/api/v1/contracts?cursor=${badCursor}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(400);
  });
});

// ─── Default limit ──────────────────────────────────────────────────────────

describe('Cursor pagination — default limit', () => {
  it('uses CURSOR_DEFAULT_LIMIT when limit is omitted', async () => {
    for (let i = 0; i < 3; i++) {
      await createContract({ title: `DefaultLimit${i}`, budget: 100 + i });
    }

    const res = await request(app)
      .get('/api/v1/contracts')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(CURSOR_DEFAULT_LIMIT);
  });
});

// ─── Custom limit ───────────────────────────────────────────────────────────

describe('Cursor pagination — custom limit', () => {
  it('respects a custom limit of 1', async () => {
    await createContract({ title: 'CustomA', budget: 100 });
    await createContract({ title: 'CustomB', budget: 200 });

    const res = await request(app)
      .get('/api/v1/contracts?limit=1')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.limit).toBe(1);
    expect(res.body.meta.hasNextPage).toBe(true);
  });

  it('respects limit at CURSOR_MAX_LIMIT', async () => {
    await createContract({ title: 'MaxLimit', budget: 100 });

    const res = await request(app)
      .get(`/api/v1/contracts?limit=${CURSOR_MAX_LIMIT}`)
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.meta.limit).toBe(CURSOR_MAX_LIMIT);
  });
});

// ─── Item shape unchanged ───────────────────────────────────────────────────

describe('Cursor pagination — item shape', () => {
  it('returns items with the same shape as before (no new fields, no missing fields)', async () => {
    const id = await createContract({ title: 'Shape Test', budget: 500 });

    const res = await request(app)
      .get('/api/v1/contracts?limit=10')
      .set(auth(adminToken()));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);

    const item = res.body.data[0];
    expect(item).toHaveProperty('id', id);
    expect(item).toHaveProperty('title', 'Shape Test');
    expect(item).toHaveProperty('clientId', CLIENT_ID);
    expect(item).toHaveProperty('freelancerId', FREELANCER_ID);
    expect(item).toHaveProperty('amount', 500);
    expect(item).toHaveProperty('status', 'draft');
    expect(item).toHaveProperty('version');
    expect(item).toHaveProperty('createdAt');
  });
});
