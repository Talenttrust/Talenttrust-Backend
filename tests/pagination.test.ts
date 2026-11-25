import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

/**
 * Store whose clock advances one second per reading, so contracts created in a
 * loop get distinct, increasing createdAt values (the store returns copies, so
 * timestamps cannot be patched after creation).
 */
function steppedStore(): EscrowStore {
  let t = Date.now() - 3_600_000;
  return new EscrowStore(() => new Date((t += 1000)));
}

function makeContracts(store: EscrowStore, count: number, baseId = 1) {
  const created: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = store.create({
      title: `Contract ${baseId + i}`,
      client: `GCLIENT${String(baseId + i).padStart(6, '0')}`,
      freelancer: `GFR${String(baseId + i).padStart(6, '0')}`,
      milestones: [{ title: `M${baseId + i}`, amount: (baseId + i) * 10 }],
    });
    created.push(c.id);
  }
  return created;
}

async function fetchPage(app: ReturnType<typeof createApp>, limit: number, cursor?: string) {
  let url = `/api/v1/contracts?limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  return request(app).get(url);
}

describe('contract list pagination, sorting and filters', () => {
  it('default response returns data with newest 20', async () => {
    const store = steppedStore();
    makeContracts(store, 25);
    const app = createApp(store);
    const res = await request(app).get('/api/v1/contracts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(20);
    expect(res.body.page).toEqual({
      limit: 20,
      hasMore: true,
      nextCursor: expect.any(String),
    });
    // newest first (default -createdAt, tie-break by id asc)
    const ids = res.body.data.map((c: { id: number }) => c.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
  });

  it('paginates 25 contracts with limit=10 via cursors, no duplicates or gaps', async () => {
    const store = steppedStore();
    makeContracts(store, 25);
    const app = createApp(store);

    const allIds: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await fetchPage(app, 10, cursor);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.page.limit).toBe(10);
      for (const c of res.body.data) allIds.push(c.id);
      cursor = res.body.page.nextCursor;
      if (!res.body.page.hasMore || !cursor) break;
      pages++;
      if (pages > 10) throw new Error('too many pages');
    }
    expect(allIds.length).toBe(25);
    expect(new Set(allIds).size).toBe(25);
    expect(allIds.sort((a, b) => a - b)).toEqual([...Array(25)].map((_, i) => i + 1));
  });

  it('supports every sort option with totalAmount tie-break by id', async () => {
    const store = new EscrowStore();
    // same totalAmount (100) for ids 1..5 to force tie-break by id, plus distinct amounts
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] }); // id 1
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] }); // id 2
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] }); // id 3
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 200 }] }); // id 4
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 50 }] }); // id 5
    const app = createApp(store);

    const sorts: string[] = ['createdAt', '-createdAt', 'updatedAt', '-updatedAt', 'totalAmount', '-totalAmount'];
    for (const sort of sorts) {
      const res = await request(app).get(`/api/v1/contracts?sort=${sort}&limit=100`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((c: { id: number }) => c.id);
      if (sort === '-totalAmount') {
        expect(ids).toEqual([4, 1, 2, 3, 5]); // 200 first, then 100s tie-broken by id asc, then 50
      }
    }
  });

  it('filters by status alone and combined', async () => {
    const store = steppedStore();
    makeContracts(store, 3); // ids 1..3 Created
    store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] }); // id 4 Created
    // fund one to make it Funded
    const app = createApp(store);
    await request(app).post('/api/v1/contracts/4/deposit').send({ amount: 100 });

    const byCreated = await request(app).get('/api/v1/contracts?status=Created');
    expect(byCreated.status).toBe(200);
    expect(byCreated.body.data.length).toBe(3);

    const byFunded = await request(app).get('/api/v1/contracts?status=Funded');
    expect(byFunded.status).toBe(200);
    expect(byFunded.body.data.length).toBe(1);
    expect(byFunded.body.data[0].id).toBe(4);

    const combined = await request(app).get('/api/v1/contracts?status=Created,Funded');
    expect(combined.status).toBe(200);
    expect(combined.body.data.length).toBe(4);

    const invalidStatus = await request(app).get('/api/v1/contracts?status=NotAStatus');
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body.error).toBe('invalid_query');
  });

  it('filters by party and role (role requires party)', async () => {
    const store = new EscrowStore();
    store.create({ client: 'CLIENT-A', freelancer: 'FREELANCER-B', milestones: [{ amount: 100 }] });
    store.create({ client: 'CLIENT-C', freelancer: 'FREELANCER-B', milestones: [{ amount: 100 }] });
    store.create({ client: 'CLIENT-A', freelancer: 'FREELANCER-D', milestones: [{ amount: 100 }] });
    const app = createApp(store);

    const party = await request(app).get('/api/v1/contracts?party=CLIENT-A');
    expect(party.status).toBe(200);
    expect(party.body.data.length).toBe(2);

    const roleClient = await request(app).get('/api/v1/contracts?party=FREELANCER-B&role=freelancer');
    expect(roleClient.status).toBe(200);
    expect(roleClient.body.data.length).toBe(2);

    const roleWithoutParty = await request(app).get('/api/v1/contracts?role=client');
    expect(roleWithoutParty.status).toBe(400);
    expect(roleWithoutParty.body.error).toBe('invalid_query');

    const invalidRole = await request(app).get('/api/v1/contracts?party=CLIENT-A&role=admin');
    expect(invalidRole.status).toBe(400);
  });

  it('filters by token and createdAfter/createdBefore', async () => {
    const store = new EscrowStore();
    store.create({ client: 'GA', freelancer: 'GB', token: 'XLM', milestones: [{ amount: 100 }] });
    store.create({ client: 'GA', freelancer: 'GB', token: 'USDC', milestones: [{ amount: 100 }] });
    const app = createApp(store);

    const byToken = await request(app).get('/api/v1/contracts?token=USDC');
    expect(byToken.status).toBe(200);
    expect(byToken.body.data.length).toBe(1);
    expect(byToken.body.data[0].token).toBe('USDC');

    const now = new Date().toISOString();
    const future = new Date(Date.now() + 10000).toISOString();
    const afterAll = await request(app).get(`/api/v1/contracts?createdAfter=${future}`);
    expect(afterAll.status).toBe(200);
    expect(afterAll.body.data.length).toBe(0);

    const beforeAll = await request(app).get(`/api/v1/contracts?createdBefore=${now}`);
    expect(beforeAll.status).toBe(200);
    expect(beforeAll.body.data.length).toBe(2);
  });

  it('rejects limit=0 and limit=101', async () => {
    const app = createApp(new EscrowStore().seed());
    const zero = await request(app).get('/api/v1/contracts?limit=0');
    expect(zero.status).toBe(400);
    expect(zero.body.error).toBe('invalid_query');
    const over = await request(app).get('/api/v1/contracts?limit=101');
    expect(over.status).toBe(400);
    expect(over.body.error).toBe('invalid_query');
  });

  it('rejects tampered cursor', async () => {
    const store = steppedStore();
    makeContracts(store, 25);
    const app = createApp(store);
    const first = await request(app).get('/api/v1/contracts?limit=1');
    expect(first.status).toBe(200);
    const cursor = first.body.page.nextCursor;
    expect(cursor).toBeTruthy();

    const tampered = await request(app)
      .get(`/api/v1/contracts?limit=1&cursor=${encodeURIComponent(cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'))}`);
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toBe('invalid_cursor');
  });

  it('rejects cursor reused with a different sort', async () => {
    const store = steppedStore();
    makeContracts(store, 25);
    const app = createApp(store);
    const first = await request(app).get('/api/v1/contracts?limit=5&sort=-createdAt');
    const cursor = first.body.page.nextCursor;
    const res = await request(app)
      .get(`/api/v1/contracts?limit=5&sort=-totalAmount&cursor=${encodeURIComponent(cursor as string)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_cursor');
  });

  it('does not duplicate items when a contract is created between pages (sort=createdAt)', async () => {
    const store = steppedStore();
    makeContracts(store, 10);
    const app = createApp(store);
    const first = await request(app).get('/api/v1/contracts?limit=5&sort=createdAt');
    const cursor = first.body.page.nextCursor;
    // create a new contract between fetches
    store.create({ client: 'GX', freelancer: 'GY', milestones: [{ amount: 1 }] });
    const second = await request(app)
      .get(`/api/v1/contracts?limit=5&sort=createdAt&cursor=${encodeURIComponent(cursor as string)}`);
    expect(second.status).toBe(200);
    const firstIds = first.body.data.map((c: { id: number }) => c.id);
    const secondIds = second.body.data.map((c: { id: number }) => c.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length + secondIds.length);
  });

  it('filters by title substring q (case-insensitive and trimmed)', async () => {
    const store = steppedStore();
    store.create({ title: 'Landing page redesign', client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    store.create({ title: 'Smart contract audit', client: 'GA', freelancer: 'GB', milestones: [{ amount: 200 }] });
    store.create({ title: 'Mobile UI DESIGN system', client: 'GA', freelancer: 'GB', milestones: [{ amount: 150 }] });
    const app = createApp(store);

    const res = await request(app).get('/api/v1/contracts?q=design');
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: { title: string }) => c.title)).toEqual([
      'Mobile UI DESIGN system',
      'Landing page redesign',
    ]);

    // Trims surrounding whitespace and matches case-insensitively.
    const trimmed = await request(app).get('/api/v1/contracts?q=%20%20ReDeSiGn%20%20');
    expect(trimmed.status).toBe(200);
    expect(trimmed.body.data.map((c: { title: string }) => c.title)).toEqual(['Landing page redesign']);

    // 64-character query is accepted.
    const maxLen = await request(app).get(`/api/v1/contracts?q=${'a'.repeat(64)}`);
    expect(maxLen.status).toBe(200);
    expect(maxLen.body.data).toEqual([]);
  });

  it('paginates filtered q results with stable pages and cursors', async () => {
    const store = steppedStore();
    for (let i = 1; i <= 5; i++) {
      store.create({ title: `Design milestone ${i}`, client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
      store.create({ title: `Backend task ${i}`, client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    }
    const app = createApp(store);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      let url = '/api/v1/contracts?q=design&limit=2';
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      const res = await request(app).get(url);
      expect(res.status).toBe(200);
      for (const c of res.body.data) collected.push(c.title);
      cursor = res.body.page.nextCursor;
      if (!res.body.page.hasMore || !cursor) break;
    }
    expect(collected).toEqual([
      'Design milestone 5',
      'Design milestone 4',
      'Design milestone 3',
      'Design milestone 2',
      'Design milestone 1',
    ]);
  });

  it('includes q in the list ETag query string', async () => {
    const store = steppedStore();
    store.create({ title: 'Landing page redesign', client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] });
    const app = createApp(store);

    const a = await request(app).get('/api/v1/contracts?q=design').expect(200);
    const b = await request(app).get('/api/v1/contracts?q=landing').expect(200);
    expect(a.headers.etag).toBeDefined();
    expect(b.headers.etag).toBeDefined();
    expect(a.headers.etag).not.toBe(b.headers.etag);

    await request(app).get('/api/v1/contracts?q=design').set('If-None-Match', a.headers.etag).expect(304);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['overlong (65 chars)', 'a'.repeat(65)],
  ])('rejects %s q with 400 invalid_query', async (_label, value) => {
    const app = createApp(new EscrowStore().seed());
    const res = await request(app).get(`/api/v1/contracts?q=${encodeURIComponent(value)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_query');
  });
});

describe('pagination cursor signing secret', () => {
  const savedEnv = {
    CURSOR_SECRET: process.env.CURSOR_SECRET,
    AUTH_SECRET: process.env.AUTH_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('derives a shared cursor secret from AUTH_SECRET so two apps accept each other cursors', async () => {
    delete process.env.CURSOR_SECRET;
    process.env.AUTH_SECRET = 'shared-auth-secret-for-cursor-derivation';

    const store = steppedStore();
    makeContracts(store, 10);
    const app1 = createApp(store);
    const app2 = createApp(store);

    const first = await fetchPage(app1, 5);
    expect(first.status).toBe(200);
    const cursor = first.body.page.nextCursor as string;
    expect(cursor).toBeTruthy();

    const second = await fetchPage(app2, 5, cursor);
    expect(second.status).toBe(200);
    expect(second.body.data.length).toBe(5);
    const firstIds = first.body.data.map((c: { id: number }) => c.id);
    const secondIds = second.body.data.map((c: { id: number }) => c.id);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(10);

    // Tampered cursor still returns invalid_cursor
    const tampered = await fetchPage(app2, 5, cursor.slice(0, -1) + (cursor.endsWith('A') ? 'B' : 'A'));
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toBe('invalid_cursor');
  });

  it('gives explicit CURSOR_SECRET precedence over AUTH_SECRET', async () => {
    const store = steppedStore();
    makeContracts(store, 10);

    process.env.AUTH_SECRET = 'auth-secret-a';
    process.env.CURSOR_SECRET = 'explicit-cursor-secret';
    const app1 = createApp(store);

    // Different AUTH_SECRET, same explicit CURSOR_SECRET -> accepted
    process.env.AUTH_SECRET = 'auth-secret-b';
    process.env.CURSOR_SECRET = 'explicit-cursor-secret';
    const app2 = createApp(store);

    // Same AUTH_SECRET as app1, no CURSOR_SECRET -> rejected (proves CURSOR_SECRET took precedence)
    process.env.AUTH_SECRET = 'auth-secret-a';
    delete process.env.CURSOR_SECRET;
    const app3 = createApp(store);

    const first = await fetchPage(app1, 5);
    expect(first.status).toBe(200);
    const cursor = first.body.page.nextCursor as string;

    const fromApp2 = await fetchPage(app2, 5, cursor);
    expect(fromApp2.status).toBe(200);
    expect(fromApp2.body.data.length).toBe(5);

    const fromApp3 = await fetchPage(app3, 5, cursor);
    expect(fromApp3.status).toBe(400);
    expect(fromApp3.body.error).toBe('invalid_cursor');
  });

  it('logs a one-time warning in production when neither CURSOR_SECRET nor AUTH_SECRET is set', () => {
    delete process.env.CURSOR_SECRET;
    delete process.env.AUTH_SECRET;
    process.env.NODE_ENV = 'production';

    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    createApp({ store: new EscrowStore(), logger });
    createApp({ store: new EscrowStore(), logger });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/CURSOR_SECRET/);
  });
});
