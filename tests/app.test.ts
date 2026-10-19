import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('TalentTrust API', () => {
  const app = createApp(new EscrowStore());

  it('serves health and root', async () => {
    const h = await request(app).get('/health');
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
    await request(app)
      .post('/api/v1/contracts/1/dispute')
      .send({ raisedBy: 'GA', reason: 'test', unknown: true })
      .expect(400);
  });

  it('validates boundary values for title, milestones, and freelancerBps', async () => {
    const title120 = 'a'.repeat(120);
    const title121 = 'a'.repeat(121);
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }], title: title120 })
      .expect(201);
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 1 }], title: title121 })
      .expect(400);

    const milestones20 = Array(20).fill({ amount: 1 });
    const milestones21 = Array(21).fill({ amount: 1 });
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: milestones20 })
      .expect(201);
    await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GA', freelancer: 'GB', milestones: milestones21 })
      .expect(400);

    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC', freelancer: 'GD', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body.id}/dispute`).send({ raisedBy: 'GD', reason: 'late' }).expect(200);
    await request(app).post(`/api/v1/contracts/${body.id}/resolve`).send({ freelancerBps: 0 }).expect(200);

    const { body: body2 } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GE', freelancer: 'GF', milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body2.id}/deposit`).send({ amount: 200 });
    await request(app).post(`/api/v1/contracts/${body2.id}/dispute`).send({ raisedBy: 'GF', reason: 'late' }).expect(200);
    await request(app).post(`/api/v1/contracts/${body2.id}/resolve`).send({ freelancerBps: 10000 }).expect(200);
  });

  it('validates status query param', async () => {
    await request(app).get('/api/v1/contracts?status=bogus').expect(400);
    await request(app).get('/api/v1/contracts?status=Created').expect(200);
    await request(app).get('/api/v1/contracts?status=Funded').expect(200);
    await request(app).get('/api/v1/contracts?status=Completed').expect(200);
    await request(app).get('/api/v1/contracts?status=Disputed').expect(200);
    await request(app).get('/api/v1/contracts?status=Resolved').expect(200);
    await request(app).get('/api/v1/contracts?status=Cancelled').expect(200);
  });

  it('reports multiple validation errors in details array', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send({ freelancer: 'GB', milestones: [{ amount: -1 }] })
      .expect(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.details).toBeInstanceOf(Array);
    const paths = res.body.details.map((d: { path: string }) => d.path);
    expect(paths).toContain('body.client');
    expect(paths).toContain('body.milestones.0.amount');
  });
});