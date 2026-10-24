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

describe('unfunded contract edits and withdrawal', () => {
  let app = createApp(new EscrowStore());
  beforeEach(() => {
    app = createApp(new EscrowStore());
  });

  const createContract = async () =>
    request(app)
      .post('/api/v1/contracts')
      .send({
        client: 'GCLIENT',
        freelancer: 'GFREELANCER',
        title: 'Original terms',
        milestones: [{ title: 'Design', amount: 100 }, { title: 'Build', amount: 200 }],
      });

  it('edits terms and records a revision diff', async () => {
    const created = await createContract().expect(201);
    const updated = await request(app)
      .patch(`/api/v1/contracts/${created.body.id}`)
      .send({
        client: 'GCLIENT',
        title: 'Revised terms',
        milestones: [{ title: 'Specification', amount: 150 }],
      })
      .expect(200);

    expect(updated.body.title).toBe('Revised terms');
    expect(updated.body.totalAmount).toBe(150);
    expect(updated.body.totalAmountUnits).toBe('150');
    expect(updated.body.revision).toBe(2);
    expect(updated.body.milestones).toEqual([
      { index: 0, title: 'Specification', amount: 150, amountUnits: '150', released: false },
    ]);
    const revisions = await request(app).get(`/api/v1/contracts/${created.body.id}/revisions`).expect(200);
    expect(revisions.body).toEqual([
      {
        revision: 2,
        at: expect.any(String),
        changes: [
          { field: 'title', from: 'Original terms', to: 'Revised terms' },
          {
            field: 'milestones',
            from: [
              { index: 0, title: 'Design', amount: 100, amountUnits: '100', released: false },
              { index: 1, title: 'Build', amount: 200, amountUnits: '200', released: false },
            ],
            to: [{ index: 0, title: 'Specification', amount: 150, amountUnits: '150', released: false }],
          },
        ],
      },
    ]);
  });

  it('rejects edits after funding and invalid or empty patches', async () => {
    const created = await createContract().expect(201);
    const contractPath = `/api/v1/contracts/${created.body.id}`;
    await request(app).post(`${contractPath}/deposit`).send({ amount: 10 }).expect(200);
    await request(app)
      .patch(contractPath)
      .send({ client: 'GCLIENT', title: 'Too late' })
      .expect(409, { error: 'contract_locked', message: 'Contract terms can only be edited before funding' });

    const unfunded = await createContract().expect(201);
    const unfundedPath = `/api/v1/contracts/${unfunded.body.id}`;
    await request(app).patch(unfundedPath).send({ client: 'OTHER', title: 'No' }).expect(403);
    await request(app)
      .patch(unfundedPath)
      .send({ client: 'GCLIENT', milestones: [{ amount: 0 }] })
      .expect(400);
    await request(app).patch(unfundedPath).send({ client: 'GCLIENT' }).expect(400, {
      error: 'empty_patch',
      message: 'At least one of title or milestones must be provided',
    });
  });

  it('withdraws unfunded contracts from reads, lists, and stats', async () => {
    const created = await createContract().expect(201);
    const contractPath = `/api/v1/contracts/${created.body.id}`;
    await request(app).delete(contractPath).send({ client: 'GCLIENT' }).expect(204);
    await request(app).get(contractPath).expect(404);
    const list = await request(app).get('/api/v1/contracts').expect(200);
    expect(list.body.data.some((contract: { id: number }) => contract.id === created.body.id)).toBe(false);
    const stats = await request(app).get('/api/v1/stats').expect(200);
    expect(stats.body.contracts).toBe(0);
  });

  it('rejects withdrawal after funding', async () => {
    const created = await createContract().expect(201);
    const contractPath = `/api/v1/contracts/${created.body.id}`;
    await request(app).post(`${contractPath}/deposit`).send({ amount: 10 }).expect(200);
    await request(app)
      .delete(contractPath)
      .send({ client: 'GCLIENT' })
      .expect(409, { error: 'contract_locked', message: 'Contract can only be withdrawn before funding' });
  });

  it('keeps only the most recent 50 revisions', async () => {
    const created = await createContract().expect(201);
    const contractPath = `/api/v1/contracts/${created.body.id}`;
    for (let edit = 1; edit <= 51; edit += 1) {
      await request(app)
        .patch(contractPath)
        .send({ client: 'GCLIENT', title: `Revision ${edit}` })
        .expect(200);
    }
    const revisions = await request(app).get(`${contractPath}/revisions`).expect(200);
    expect(revisions.body).toHaveLength(50);
    expect(revisions.body[0].revision).toBe(3);
    expect(revisions.body[49].revision).toBe(52);
  });
});
