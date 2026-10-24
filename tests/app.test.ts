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

  describe('ETag and optimistic concurrency', () => {
    it('serves ETag and Cache-Control: no-cache, supports If-None-Match 304, and bumps after mutation', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'G1', freelancer: 'G2', milestones: [{ amount: 500 }] });
      expect(created.status).toBe(201);
      const contractId = created.body.id;
      expect(created.body.version).toBe(1);
      expect(created.header.etag).toBe(`"${contractId}-1"`);

      // First GET /contracts/:id
      const res1 = await request(app).get(`/api/v1/contracts/${contractId}`);
      expect(res1.status).toBe(200);
      expect(res1.header['cache-control']).toBe('no-cache');
      const etag1 = res1.header.etag;
      expect(etag1).toBe(`"${contractId}-1"`);

      // Second GET with If-None-Match -> 304 with no body
      const res2 = await request(app)
        .get(`/api/v1/contracts/${contractId}`)
        .set('If-None-Match', etag1);
      expect(res2.status).toBe(304);
      expect(res2.text).toBe('');

      // Deposit bumps mutation and version
      const depRes = await request(app)
        .post(`/api/v1/contracts/${contractId}/deposit`)
        .set('If-Match', etag1)
        .send({ amount: 500 });
      expect(depRes.status).toBe(200);
      expect(depRes.body.version).toBe(2);
      expect(depRes.header.etag).toBe(`"${contractId}-2"`);

      // Same previous If-None-Match now returns 200 with new ETag
      const res3 = await request(app)
        .get(`/api/v1/contracts/${contractId}`)
        .set('If-None-Match', etag1);
      expect(res3.status).toBe(200);
      expect(res3.header.etag).toBe(`"${contractId}-2"`);
      expect(res3.body.version).toBe(2);
    });

    it('rejects stale If-Match on release with 412 and does not release', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GCLIENT', freelancer: 'GFREE', milestones: [{ amount: 750 }] });
      const contractId = created.body.id;
      await request(app).post(`/api/v1/contracts/${contractId}/deposit`).send({ amount: 750 });

      // Stale If-Match (e.g. initial version "id-1" or "1-0")
      const staleEtag = `"${contractId}-1"`;
      const res412 = await request(app)
        .post(`/api/v1/contracts/${contractId}/milestones/0/release`)
        .set('If-Match', staleEtag);

      expect(res412.status).toBe(412);
      expect(res412.header.etag).toBe(`"${contractId}-2"`);
      expect(res412.body).toEqual({
        error: 'precondition_failed',
        message: 'Precondition failed',
        currentVersion: 2,
      });

      // Verify contract was not released and version did not bump
      const check = await request(app).get(`/api/v1/contracts/${contractId}`);
      expect(check.body.milestones[0].released).toBe(false);
      expect(check.body.version).toBe(2);
    });

    it('always passes with If-Match: *', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GAX', freelancer: 'GBX', milestones: [{ amount: 300 }] });
      const contractId = created.body.id;

      const dep = await request(app)
        .post(`/api/v1/contracts/${contractId}/deposit`)
        .set('If-Match', '*')
        .send({ amount: 300 });
      expect(dep.status).toBe(200);
      expect(dep.body.version).toBe(2);
      expect(dep.header.etag).toBe(`"${contractId}-2"`);
    });

    it('failed mutation does not bump version', async () => {
      const created = await request(app)
        .post('/api/v1/contracts')
        .send({ client: 'GA1', freelancer: 'GB1', milestones: [{ amount: 100 }] });
      const contractId = created.body.id;

      // Fail deposit with negative amount
      await request(app)
        .post(`/api/v1/contracts/${contractId}/deposit`)
        .send({ amount: -50 })
        .expect(400);

      const check = await request(app).get(`/api/v1/contracts/${contractId}`);
      expect(check.body.version).toBe(1);
    });

    it('list ETag supports 304, changes when any listed contract changes, and changes when filter changes', async () => {
      const listStore = new EscrowStore();
      const testApp = createApp(listStore);

      const c1 = await request(testApp)
        .post('/api/v1/contracts')
        .send({ client: 'CL1', freelancer: 'FR1', milestones: [{ amount: 100 }] });
      const c2 = await request(testApp)
        .post('/api/v1/contracts')
        .send({ client: 'CL2', freelancer: 'FR2', milestones: [{ amount: 200 }] });

      // List all
      const list1 = await request(testApp).get('/api/v1/contracts');
      expect(list1.status).toBe(200);
      const etagList1 = list1.header.etag;
      expect(etagList1).toBeDefined();

      // List with If-None-Match -> 304
      const list304 = await request(testApp)
        .get('/api/v1/contracts')
        .set('If-None-Match', etagList1);
      expect(list304.status).toBe(304);
      expect(list304.text).toBe('');

      // Filter changes -> list ETag changes
      const listFilter = await request(testApp).get('/api/v1/contracts?party=CL1');
      expect(listFilter.status).toBe(200);
      const etagFilter = listFilter.header.etag;
      expect(etagFilter).not.toBe(etagList1);

      // Any listed contract changes -> list ETag changes
      await request(testApp).post(`/api/v1/contracts/${c1.body.id}/deposit`).send({ amount: 50 });
      const listAfterMut = await request(testApp).get('/api/v1/contracts');
      expect(listAfterMut.header.etag).not.toBe(etagList1);
    });

    it('enforces REQUIRE_IF_MATCH -> 428 when enabled', async () => {
      const originalEnv = process.env.REQUIRE_IF_MATCH;
      try {
        process.env.REQUIRE_IF_MATCH = 'true';
        const requireApp = createApp(new EscrowStore());

        const created = await request(requireApp)
          .post('/api/v1/contracts')
          .send({ client: 'C_REQ', freelancer: 'F_REQ', milestones: [{ amount: 100 }] });
        const contractId = created.body.id;

        // Mutation without If-Match should fail with 428
        const res428 = await request(requireApp)
          .post(`/api/v1/contracts/${contractId}/deposit`)
          .send({ amount: 50 });
        expect(res428.status).toBe(428);
        expect(res428.body).toEqual({
          error: 'precondition_required',
          message: 'If-Match header is required',
        });

        // Mutation with valid If-Match succeeds
        const resOk = await request(requireApp)
          .post(`/api/v1/contracts/${contractId}/deposit`)
          .set('If-Match', `"${contractId}-1"`)
          .send({ amount: 50 });
        expect(resOk.status).toBe(200);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.REQUIRE_IF_MATCH;
        } else {
          process.env.REQUIRE_IF_MATCH = originalEnv;
        }
      }
    });
  });
});
