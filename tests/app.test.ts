import request from 'supertest';
import { createApp } from '../src/app';
import type { AppOptions } from '../src/app';
import { EscrowStore } from '../src/store';

const opts = (seedDemoData: boolean): Parameters<typeof createApp>[1] =>
  ({ seedDemoData } as unknown as Parameters<typeof createApp>[1]);

// Helper: build a store seeded with N contracts for bulk tests.
function seededStore(n: number): EscrowStore {
  const s = new EscrowStore();
  for (let i = 0; i < n; i++) {
    s.create({
      title: `Engagement ${i}`,
      client: `GC${i.toString().padStart(5, '0')}`,
      freelancer: `GF${i.toString().padStart(5, '0')}`,
      milestones: Array.from({ length: 5 }, (_, j) => ({ title: `M${j}`, amount: 100 + j })),
    });
  }
  return s;
}

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore(), opts(false));

  it('serves health and root', async () => {
    const h = await request(app).get('/health');
    expect(h.status).toBe(200);
    expect(h.body.status).toBe('ok');
    expect(h.body.demoData).toBe(false);
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.body.endpoints.length).toBeGreaterThan(5);
    expect(root.body.demoData).toBe(false);
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
    expect(created.body.demo).toBe(false);
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

  it('supports two-sided reviews on a completed contract', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT', freelancer: 'GREVFREELANCER', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);

    const c2f = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 5, comment: '  Clear scope, fast payment  ' })
      .expect(201);
    expect(c2f.body.role).toBe('client_to_freelancer');
    expect(c2f.body.comment).toBe('Clear scope, fast payment');

    const f2c = await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVFREELANCER', rating: 4 })
      .expect(201);
    expect(f2c.body.role).toBe('freelancer_to_client');

    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT', rating: 3 })
      .expect(409);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GSTRANGER', rating: 3 })
      .expect(403);

    const clientRep = await request(app).get('/api/v1/reputation/GREVCLIENT').expect(200);
    expect(clientRep.body.asClient.completedContracts).toBe(1);
    expect(clientRep.body.asClient.averageRating).toBe(4);

    const feed = await request(app).get('/api/v1/reputation/GREVCLIENT/reviews').expect(200);
    expect(feed.body.reviews.length).toBe(1);
    expect(feed.body.reviews[0].role).toBe('freelancer_to_client');
  });

  it('rejects reviews on non-completed contracts and validates comments', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT2', freelancer: 'GREVFREELANCER2', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5 })
      .expect(409);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'x'.repeat(1001) })
      .expect(400);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT2', rating: 5, comment: 'bad\u0007char' })
      .expect(400);
  });

  it('marks reviews of resolved contracts as disputed', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT3', freelancer: 'GREVFREELANCER3', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 }).expect(200);
    await request(app)
      .post(`/api/v1/contracts/${body.id}/dispute`)
      .send({ raisedBy: 'GREVFREELANCER3', reason: 'late' })
      .expect(200);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    const review = await request(app)
      .post(`/api/v1/contracts/${body.id}/reviews`)
      .send({ reviewer: 'GREVCLIENT3', rating: 2 })
      .expect(201);
    expect(review.body.context).toBe('disputed');
  });

  it('keeps the reputation endpoint backward compatible with reviews', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GREVCLIENT4', freelancer: 'GREVFREELANCER4', milestones: [{ amount: 100 }] });
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    const rep = await request(app).post(`/api/v1/contracts/${id}/reputation`).send({ rating: 5 }).expect(200);
    expect(rep.body.averageRating).toBe(5);
    await request(app)
      .post(`/api/v1/contracts/${id}/reviews`)
      .send({ reviewer: 'GREVCLIENT4', rating: 5 })
      .expect(409);
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

  it('starts empty with seeding disabled', async () => {
    const emptyApp = createApp(new EscrowStore(), opts(false));
    const list = await request(emptyApp).get('/api/v1/contracts');
    expect(list.body.data).toHaveLength(0);
    expect((new EscrowStore() as unknown as { hasDemoData: boolean }).hasDemoData).toBe(false);
  });

  it('marks seeded contracts as demo and excludes them from stats by default', async () => {
    const seededApp = createApp(new EscrowStore(), opts(true));
    const list = await request(seededApp).get('/api/v1/contracts?includeDemo=true');
    expect(list.body.data).toHaveLength(2);
    for (const c of list.body.data) {
      expect(c.demo).toBe(true);
    }
    const real = await request(seededApp)
      .post('/api/v1/contracts')
      .send({ client: 'GE', freelancer: 'GF', milestones: [{ amount: 10 }] });
    expect(real.body.demo).toBe(false);
    const defaultStats = await request(seededApp).get('/api/v1/stats');
    const withDemo = await request(seededApp).get('/api/v1/stats?includeDemo=true');
    expect(defaultStats.body.totalEscrowed).toBeLessThan(withDemo.body.totalEscrowed);
  });

  it('rejects coerced and malformed values in resolve', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);

    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: null }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: true }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: '5000' }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: -1 }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 10001 }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 0 }).expect(200);
    expect((await request(app).get(`/api/v1/contracts/${body.id}`)).body.status).toBe('Resolved');
  });

  it('rejects coerced and malformed values in rate', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/milestones/0/release`).expect(200);

    await request(app).post(`/api/v1/contracts/${body.id}/reputation`).send({ rating: true }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/reputation`).send({ rating: '5' }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/reputation`).send({ rating: 0 }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/reputation`).send({ rating: 6 }).expect(400);
    await request(app).post(`/api/v1/contracts/${body.id}/reputation`).send({ rating: 3 }).expect(200);
  });

  it('rejects invalid path params', async () => {
    await request(app).get('/api/v1/contracts/0x1').expect(400);
    await request(app).get('/api/v1/contracts/1e0').expect(400);
    await request(app).get('/api/v1/contracts/0').expect(400);
    await request(app).get('/api/v1/contracts/-1').expect(400);
    await request(app).post('/api/v1/contracts/1/milestones/abc/release').expect(400);
    await request(app).post('/api/v1/contracts/1/milestones/20/release').expect(400);
    await request(app).post('/api/v1/contracts/1/milestones/-1/release').expect(400);
  });

  it('rejects unknown body keys', async () => {
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }], foo: 1 })
      .expect(400);
    await request(app)
      .post('/api/v1/contracts/1/deposit')
      .send({ amount: 100, extra: 'field' })
      .expect(400);
  });
});
