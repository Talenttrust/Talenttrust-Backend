import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { account } from './helpers/addresses';

const TOKEN = 'adm1n-t0ken-f0r-t3sts';
const HOUR = 3_600_000;
const SLA_MS = 72 * HOUR;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

describe('Admin dispute queue', () => {
  let currentMs: number;
  let app: ReturnType<typeof createApp>;
  let store: EscrowStore;

  const clock = () => new Date(currentMs);
  const advance = (ms: number) => {
    currentMs += ms;
  };
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${TOKEN}`);

  const openDispute = async (opts: {
    client?: string;
    freelancer?: string;
    amount?: number;
    raisedBy?: string;
    reason?: string;
  }) => {
    const client = opts.client ?? account('GCLIENTAAA');
    const freelancer = opts.freelancer ?? account('GFREELANCERAAA');
    const amount = opts.amount ?? 100;
    const raisedBy = opts.raisedBy ?? client;
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client, freelancer, milestones: [{ amount }] });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount }).expect(200);
    const disputed = await request(app)
      .post(`/api/v1/contracts/${id}/dispute`)
      .send({ raisedBy, reason: opts.reason ?? 'late delivery' });
    expect(disputed.status).toBe(200);
    return { id, openedAt: disputed.body.dispute.openedAt as string };
  };

  beforeEach(() => {
    currentMs = T0;
    store = new EscrowStore(clock);
    app = createApp({ store, now: clock });
    process.env.ADMIN_READ_TOKEN = TOKEN;
  });

  afterEach(() => {
    delete process.env.ADMIN_READ_TOKEN;
  });

  describe('authentication', () => {
    it('returns 404 on both routes when ADMIN_READ_TOKEN is unset', async () => {
      delete process.env.ADMIN_READ_TOKEN;
      expect((await admin(request(app).get('/api/v1/disputes'))).status).toBe(404);
      expect((await admin(request(app).get('/api/v1/disputes/1'))).status).toBe(404);
    });

    it('returns 401 for missing, malformed, or incorrect credentials', async () => {
      expect((await request(app).get('/api/v1/disputes')).status).toBe(401);
      expect((await request(app).get('/api/v1/disputes/1')).status).toBe(401);
      expect((await request(app).get('/api/v1/disputes').set('Authorization', TOKEN)).status).toBe(401);
      expect(
        (await request(app).get('/api/v1/disputes').set('Authorization', 'Basic dXNlcjpwYXNz')).status,
      ).toBe(401);
      expect(
        (await request(app).get('/api/v1/disputes').set('Authorization', 'Bearer wrong-token')).status,
      ).toBe(401);
      expect((await request(app).get('/api/v1/disputes/1').set('Authorization', 'Bearer ')).status).toBe(401);
      expect(
        (await request(app).get('/api/v1/disputes/1').set('Authorization', 'Bearer wrong-token')).status,
      ).toBe(401);
    });

    it('accepts the correct bearer token and never echoes it', async () => {
      const res = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);
      expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
    });
  });

  describe('queue contents, sorting, and summary', () => {
    it('lists three disputes with correct ages, roles, held values, and sorts', async () => {
      const a = await openDispute({ amount: 100, reason: 'missed deadline' });
      advance(24 * HOUR);
      const b = await openDispute({ client: account('GCLIENTBBB'), freelancer: account('GFREELANCERBBB'), amount: 300, raisedBy: account('GFREELANCERBBB') });
      advance(24 * HOUR);
      const c = await openDispute({ client: account('GCLIENTCCC'), freelancer: account('GFREELANCERCCC'), amount: 200 });
      advance(2 * HOUR); // t0 + 50h

      const oldest = await admin(request(app).get('/api/v1/disputes?sort=oldest')).expect(200);
      expect(oldest.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([a.id, b.id, c.id]);
      expect(oldest.body.data.map((d: { ageHours: number }) => d.ageHours)).toEqual([50, 26, 2]);
      expect(oldest.body.data.map((d: { held: number }) => d.held)).toEqual([100, 300, 200]);
      expect(oldest.body.data.map((d: { raisedByRole: string }) => d.raisedByRole)).toEqual([
        'client',
        'freelancer',
        'client',
      ]);
      expect(oldest.body.data[0]).toMatchObject({
        contractId: a.id,
        title: 'Untitled engagement',
        client: account('GCLIENTAAA'),
        freelancer: account('GFREELANCERAAA'),
        raisedBy: account('GCLIENTAAA'),
        reason: 'missed deadline',
        openedAt: a.openedAt,
        held: 100,
        slaDeadline: new Date(T0 + SLA_MS).toISOString(),
        overdue: false,
      });
      expect(oldest.body.data[0].resolvedAt).toBeUndefined();
      expect(oldest.body.data[0].freelancerBps).toBeUndefined();

      const newest = await admin(request(app).get('/api/v1/disputes?sort=newest')).expect(200);
      expect(newest.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([c.id, b.id, a.id]);

      const value = await admin(request(app).get('/api/v1/disputes?sort=value')).expect(200);
      expect(value.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([b.id, c.id, a.id]);

      const def = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(def.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([a.id, b.id, c.id]);

      expect(oldest.body.summary).toEqual({ open: 3, overdue: 0, totalHeld: 600 });
      expect(oldest.body.page).toEqual({ limit: 20, count: 3, nextCursor: null });
    });

    it('marks disputes overdue only strictly after the SLA deadline', async () => {
      await openDispute({ amount: 100 });
      advance(24 * HOUR);
      const b = await openDispute({ client: account('GCLIENTBBB'), freelancer: account('GFREELANCERBBB'), amount: 50 });
      advance(48 * HOUR); // exactly a's SLA deadline (t0 + 72h)

      const atDeadline = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(atDeadline.body.data[0].overdue).toBe(false);
      expect(atDeadline.body.summary).toEqual({ open: 2, overdue: 0, totalHeld: 150 });

      advance(1); // strictly past a's deadline
      const pastDeadline = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(pastDeadline.body.data[0].overdue).toBe(true);
      expect(pastDeadline.body.data[1].overdue).toBe(false); // b's deadline is t0 + 96h
      expect(pastDeadline.body.summary).toEqual({ open: 2, overdue: 1, totalHeld: 150 });

      const overdueOnly = await admin(request(app).get('/api/v1/disputes?overdue=true')).expect(200);
      expect(overdueOnly.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([1]);
      expect(overdueOnly.body.page.count).toBe(1);
      expect(overdueOnly.body.page.nextCursor).toBeNull();

      advance(SLA_MS); // well past b's deadline too
      const allOverdue = await admin(request(app).get('/api/v1/disputes?overdue=true')).expect(200);
      expect(allOverdue.body.page.count).toBe(2);
      expect(allOverdue.body.summary.overdue).toBe(2);
    });

    it('tracks resolved disputes with resolvedAt and freelancerBps', async () => {
      await openDispute({ amount: 100 });
      advance(24 * HOUR);
      const b = await openDispute({ client: account('GCLIENTBBB'), freelancer: account('GFREELANCERBBB'), amount: 300 });
      advance(HOUR);
      const resolved = await request(app)
        .post(`/api/v1/contracts/${b.id}/resolve`)
        .send({ freelancerBps: 6000 })
        .expect(200);
      expect(resolved.body.status).toBe('Resolved');
      expect(resolved.body.dispute.resolvedAt).toBeDefined();

      const all = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(all.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([1, b.id]);
      const view = all.body.data[1];
      expect(view.resolvedAt).toBe(resolved.body.dispute.resolvedAt);
      expect(view.freelancerBps).toBe(6000);
      expect(view.held).toBe(0);
      expect(view.overdue).toBe(false);

      const openOnly = await admin(request(app).get('/api/v1/disputes?status=open')).expect(200);
      expect(openOnly.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([1]);
      expect(openOnly.body.summary).toEqual({ open: 1, overdue: 0, totalHeld: 100 });

      const resolvedOnly = await admin(request(app).get('/api/v1/disputes?status=resolved')).expect(200);
      expect(resolvedOnly.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([b.id]);
      expect(resolvedOnly.body.data[0].resolvedAt).toBeDefined();
      expect(resolvedOnly.body.data[0].freelancerBps).toBe(6000);
      // summary always covers ALL disputes, not the filtered subset
      expect(resolvedOnly.body.summary).toEqual({ open: 1, overdue: 0, totalHeld: 100 });

      // a resolved dispute is never overdue, even long past its SLA
      advance(SLA_MS * 2);
      const later = await admin(request(app).get('/api/v1/disputes?overdue=true')).expect(200);
      expect(later.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([1]);
      expect(later.body.summary).toEqual({ open: 1, overdue: 1, totalHeld: 100 });
    });
  });

  describe('detail route', () => {
    it('returns the dispute view for a contract that has one', async () => {
      const a = await openDispute({ amount: 250, reason: 'scope dispute' });
      advance(HOUR);
      const res = await admin(request(app).get(`/api/v1/disputes/${a.id}`)).expect(200);
      expect(res.body).toMatchObject({
        contractId: a.id,
        client: account('GCLIENTAAA'),
        freelancer: account('GFREELANCERAAA'),
        raisedBy: account('GCLIENTAAA'),
        raisedByRole: 'client',
        reason: 'scope dispute',
        openedAt: a.openedAt,
        ageHours: 1,
        held: 250,
        slaDeadline: new Date(T0 + SLA_MS).toISOString(),
        overdue: false,
      });
    });

    it('returns 404 for contracts without a dispute and 400 for invalid ids', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 10 }] });
      const plain = await admin(request(app).get(`/api/v1/disputes/${created.body.id}`)).expect(404);
      expect(plain.body.error).toBe('dispute_not_found');
      await admin(request(app).get('/api/v1/disputes/99999')).expect(404);
      await admin(request(app).get('/api/v1/disputes/0')).expect(400);
      await admin(request(app).get('/api/v1/disputes/abc')).expect(400);
    });
  });

  describe('pagination', () => {
    it('paginates deterministically with no duplicates or gaps, including ties', async () => {
      const d1 = await openDispute({ amount: 100 });
      const d2 = await openDispute({ client: account('GCLIENTBBB'), freelancer: account('GFREELANCERBBB'), amount: 100 });
      advance(HOUR);
      const d3 = await openDispute({ client: account('GCLIENTCCC'), freelancer: account('GFREELANCERCCC'), amount: 100 });
      advance(HOUR);
      const d4 = await openDispute({ client: account('GCLIENTDDD'), freelancer: account('GFREELANCERDDD'), amount: 100 });

      const full = await admin(request(app).get('/api/v1/disputes?sort=oldest')).expect(200);
      const fullOrder = full.body.data.map((d: { contractId: number }) => d.contractId);
      // d1 and d2 share openedAt: tie must break by contractId ascending
      expect(fullOrder).toEqual([d1.id, d2.id, d3.id, d4.id]);

      const collected: number[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const url: string = `/api/v1/disputes?sort=oldest&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page = await admin(request(app).get(url)).expect(200);
        expect(page.body.page.limit).toBe(2);
        expect(page.body.page.count).toBeLessThanOrEqual(2);
        collected.push(...page.body.data.map((d: { contractId: number }) => d.contractId));
        cursor = page.body.page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(cursor).toBeNull();
      expect(pages).toBe(2);
      expect(collected).toEqual(fullOrder);
      expect(new Set(collected).size).toBe(4);

      // same held value for all: value sort ties also break by contractId
      const value = await admin(request(app).get('/api/v1/disputes?sort=value&limit=3')).expect(200);
      expect(value.body.data.map((d: { contractId: number }) => d.contractId)).toEqual([d1.id, d2.id, d3.id]);
      expect(value.body.page.nextCursor).not.toBeNull();
    });

    it('supports limit=1 paging and rejects invalid limits and cursors', async () => {
      await openDispute({ amount: 100 });
      advance(HOUR);
      await openDispute({ client: account('GCLIENTBBB'), freelancer: account('GFREELANCERBBB'), amount: 100 });

      const p1 = await admin(request(app).get('/api/v1/disputes?limit=1')).expect(200);
      expect(p1.body.page).toEqual({ limit: 1, count: 1, nextCursor: expect.any(String) });
      const p2 = await admin(
        request(app).get(`/api/v1/disputes?limit=1&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`),
      ).expect(200);
      expect(p2.body.data[0].contractId).toBe(2);
      expect(p2.body.page.nextCursor).toBeNull();

      for (const bad of ['0', '101', 'abc', '2.5', '-1']) {
        const res = await admin(request(app).get(`/api/v1/disputes?limit=${bad}`));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_limit');
      }
      const badCursor = await admin(request(app).get('/api/v1/disputes?cursor=not-a-cursor'));
      expect(badCursor.status).toBe(400);
      expect(badCursor.body.error).toBe('invalid_cursor');
      const mismatched = await admin(
        request(app).get(`/api/v1/disputes?sort=newest&cursor=${encodeURIComponent(p1.body.page.nextCursor)}`),
      );
      expect(mismatched.status).toBe(400);
      expect(mismatched.body.error).toBe('invalid_cursor');
    });
  });

  describe('validation and data safety', () => {
    it('rejects invalid filters and repeated parameters without mutating data', async () => {
      await openDispute({ amount: 100 });
      const before = await admin(request(app).get('/api/v1/disputes')).expect(200);

      const invalid = [
        '/api/v1/disputes?status=weird',
        '/api/v1/disputes?status=Open',
        '/api/v1/disputes?status=open&status=resolved',
        '/api/v1/disputes?sort=ascending',
        '/api/v1/disputes?overdue=yes',
        '/api/v1/disputes?overdue=',
      ];
      for (const url of invalid) {
        const res = await admin(request(app).get(url));
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/^invalid_/);
      }

      const after = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(after.body).toEqual(before.body);
      expect(store.stats().contracts).toBe(1);
      expect(store.get(1).status).toBe('Disputed');
      expect(store.get(1).dispute?.reason).toBe('late delivery');
    });

    it('does not mutate stored data when dispute attempts are rejected', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 100 }] });
      const id = created.body.id;
      await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
      await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: account('GX') }).expect(403);
      await request(app).post(`/api/v1/contracts/${id}/dispute`).send({}).expect(403);
      const after = store.get(id);
      expect(after.status).toBe('Funded');
      expect(after.dispute).toBeUndefined();
      const queue = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(queue.body.data).toEqual([]);
      expect(queue.body.summary).toEqual({ open: 0, overdue: 0, totalHeld: 0 });
    });

    it('does not expose dispute reasons through public contract endpoints', async () => {
      const a = await openDispute({ amount: 100, reason: 'confidential details' });
      const detail = await request(app).get(`/api/v1/contracts/${a.id}`).expect(200);
      expect(detail.body.dispute).toBeDefined();
      expect(detail.body.dispute.reason).toBeUndefined();
      expect(detail.body.dispute.openedAt).toBe(a.openedAt);
      const list = await request(app).get('/api/v1/contracts').expect(200);
      for (const c of list.body.data) {
        if (c.dispute) expect(c.dispute.reason).toBeUndefined();
      }
      const queue = await admin(request(app).get('/api/v1/disputes')).expect(200);
      expect(queue.body.data[0].reason).toBe('confidential details');

      // mutation responses are sanitized too; the reason only comes back from the admin routes
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: account('GCLIENTZZZ'), freelancer: account('GFREELANCERZZZ'), milestones: [{ amount: 10 }] });
      const id = created.body.id;
      await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 10 }).expect(200);
      const opened = await request(app)
        .post(`/api/v1/contracts/${id}/dispute`)
        .send({ raisedBy: account('GCLIENTZZZ'), reason: 'mutation reason' })
        .expect(200);
      expect(opened.body.dispute.reason).toBeUndefined();
      const resolved = await request(app)
        .post(`/api/v1/contracts/${id}/resolve`)
        .send({ freelancerBps: 5000 })
        .expect(200);
      expect(resolved.body.dispute.reason).toBeUndefined();
      expect((await request(app).get(`/api/v1/contracts/${id}`).expect(200)).body.dispute.reason).toBeUndefined();
      const adminDetail = await admin(request(app).get(`/api/v1/disputes/${id}`)).expect(200);
      expect(adminDetail.body.reason).toBe('mutation reason');
    });
  });
});
