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
});
