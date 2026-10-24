import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
  });

  it('serves docs and openapi', async () => {
    expect((await request(app).get('/docs')).status).toBe(200);
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
  });

  it('runs the escrow lifecycle', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }, { amount: 50 }] });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 })).body.status).toBe(
      'Funded',
    );
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const done = await request(app).post(`/api/v1/contracts/${id}/milestones/1/release`).expect(200);
    expect(done.body.status).toBe('Completed');
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 4 }).expect(200);
    expect(rep.body.averageRating).toBe(4);
  });

  it('rejects invalid input and unknown routes', async () => {
    await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GA', milestones: [1] }).expect(400);
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).get('/nope').expect(404);
  });

  it('handles disputes', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GX' }).expect(403);
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    const r = await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(r.body.releasedAmount).toBe(100);
    expect(r.body.status).toBe('Resolved');
  });

  it('records refunds on cancel (deposit 1500, release 250)', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GE1', freelancer: 'GF1', milestones: [{ amount: 250 }, { amount: 1250 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 1500 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const res = await request(app).post(`/api/v1/contracts/${id}/cancel`).expect(200);
    expect(res.body.depositedAmount).toBe(1500);
    expect(res.body.releasedAmount).toBe(250);
    expect(res.body.refundedAmount).toBe(1250);
    expect(res.body.settlement).toMatchObject({ kind: 'cancel', toFreelancer: 0, toClient: 1250 });
  });

  it('records dispute settlement breakdown', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GE2', freelancer: 'GF2', milestones: [{ amount: 200 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GF2' }).expect(200);
    const res = await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(res.body.settlement).toMatchObject({ kind: 'dispute', toFreelancer: 100, toClient: 100 });
    expect(res.body.refundedAmount).toBe(100);
  });

  it('rounds dispute payouts like the contract for odd amounts', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GE3', freelancer: 'GF3', milestones: [{ amount: 201 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 201 });
    await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GF3' }).expect(200);
    const res = await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    expect(res.body.settlement.toFreelancer).toBe(100);
    expect(res.body.settlement.toClient).toBe(101);
  });

  it('returns ledger entries in order summing to depositedAmount', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GE4', freelancer: 'GF4', milestones: [{ amount: 100 }, { amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 200 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const ledger = await request(app).get(`/api/v1/contracts/${id}/ledger`).expect(200);
    expect(ledger.body.data.map((e: { type: string }) => e.type)).toEqual(['deposit', 'release']);
    const sum = ledger.body.data
      .filter((e: { type: string }) => e.type === 'deposit')
      .reduce((s: number, e: { amount: number }) => s + e.amount, 0);
    const contract = await request(app).get(`/api/v1/contracts/${id}`).expect(200);
    expect(sum).toBe(contract.body.depositedAmount);
  });

  it('reports new totals in stats', async () => {
    const store = new EscrowStore();
    const app2 = createApp(store);
    const a = await request(app2).post('/api/v1/contracts').send({ client: 'GS1', freelancer: 'GS2', milestones: [{ amount: 100 }] });
    await request(app2).post(`/api/v1/contracts/${a.body.id}/deposit`).send({ amount: 100 });
    await request(app2).post(`/api/v1/contracts/${a.body.id}/milestones/0/release`).expect(200);
    const b = await request(app2).post('/api/v1/contracts').send({ client: 'GS3', freelancer: 'GS4', milestones: [{ amount: 200 }] });
    await request(app2).post(`/api/v1/contracts/${b.body.id}/deposit`).send({ amount: 200 });
    await request(app2).post(`/api/v1/contracts/${b.body.id}/dispute`).send({ raisedBy: 'GS4' });
    await request(app2).post(`/api/v1/contracts/${b.body.id}/resolve`).send({ freelancerBps: 5000 });
    const c = await request(app2).post('/api/v1/contracts').send({ client: 'GS5', freelancer: 'GS6', milestones: [{ amount: 500 }] });
    await request(app2).post(`/api/v1/contracts/${c.body.id}/deposit`).send({ amount: 500 });
    await request(app2).post(`/api/v1/contracts/${c.body.id}/cancel`).expect(200);
    const stats = await request(app2).get('/api/v1/stats').expect(200);
    expect(stats.body.totalDeposited).toBe(800);
    expect(stats.body.totalRefunded).toBe(600);
    expect(stats.body.releasedViaMilestones).toBe(100);
    expect(stats.body.releasedViaDisputes).toBe(100);
    expect(stats.body.totalReleased).toBe(200);
  });

  it('keeps the ledger balanced across random operation sequences', () => {
    const store = new EscrowStore();
    // Deterministic pseudo-random generator for reproducible property tests.
    let seed = 123456789;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483647;
      return seed / 2147483647;
    };
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
    for (let iter = 0; iter < 50; iter++) {
      const milestones = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => ({ amount: 1 + Math.floor(rand() * 500) }));
      const c = store.create({ client: 'CL' + Math.floor(rand() * 1e9), freelancer: 'FR' + Math.floor(rand() * 1e9), milestones });
      const total = milestones.reduce((s, m) => s + m.amount, 0);
      store.deposit(c.id, total);
      const ops = Math.floor(rand() * 4);
      for (let i = 0; i < ops; i++) {
        const cur = store.get(c.id);
        const open = cur.milestones.filter(m => !m.released);
        const action = pick(['release', 'dispute', 'cancel'] as const);
        if (action === 'release' && cur.status === 'Funded' && open.length > 0) {
          store.release(c.id, pick(open).index);
        } else if (action === 'dispute' && cur.status === 'Funded') {
          store.openDispute(c.id, cur.client);
          store.resolveDispute(c.id, Math.floor(rand() * 10001));
        } else if (action === 'cancel' && (cur.status === 'Funded' || cur.status === 'Created')) {
          store.cancel(c.id);
        }
      }
      const final = store.get(c.id);
      const ledger = store.ledger(c.id);
      const depositSum = ledger.filter((e: { type: string }) => e.type === 'deposit').reduce((s: number, e: { amount: number }) => s + e.amount, 0);
      expect(depositSum).toBe(final.depositedAmount);
      expect(final.depositedAmount).toBe(final.releasedAmount + final.refundedAmount + (final.fundedAmount - final.releasedAmount));
    }
  });
});
