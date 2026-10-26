import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

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

// ---------------------------------------------------------------------------
// Sparse fieldsets (?fields=)
// ---------------------------------------------------------------------------
describe('sparse fieldsets (?fields=)', () => {
  const store = new EscrowStore();
  const created = store.create({
    title: 'Test contract',
    client: 'GA',
    freelancer: 'GB',
    milestones: [{ title: 'Phase 1', amount: 100 }, { title: 'Phase 2', amount: 200 }],
  });
  const app = createApp(store);

  it('GET /contracts returns only requested fields (id always included)', async () => {
    const res = await request(app).get('/api/v1/contracts?fields=title,status').expect(200);
    const contracts: object[] = res.body.data;
    expect(contracts.length).toBeGreaterThan(0);
    contracts.forEach((c) => {
      expect(Object.keys(c).sort()).toEqual(['id', 'status', 'title']);
    });
  });

  it('GET /contracts/:id returns only requested fields', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=title,status`)
      .expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['id', 'status', 'title']);
    expect(res.body.id).toBe(created.id);
    expect(res.body.title).toBe('Test contract');
    expect(res.body.status).toBe('Created');
  });

  it('milestones.amount returns milestones with only amount', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=milestones.amount`)
      .expect(200);
    expect(res.body.milestones).toBeDefined();
    res.body.milestones.forEach((m: object) => {
      expect(Object.keys(m)).toEqual(['amount']);
    });
    expect(res.body.milestones[0].amount).toBe(100);
    expect(res.body.milestones[1].amount).toBe(200);
  });

  it('unknown field returns 400 with invalid_fields code', async () => {
    const res = await request(app).get('/api/v1/contracts?fields=bogusField').expect(400);
    expect(res.body.error).toBe('invalid_fields');
    expect(res.body.message).toContain('bogusField');
  });

  it('unknown field on single contract returns 400', async () => {
    const res = await request(app)
      .get(`/api/v1/contracts/${created.id}?fields=title,xyz`)
      .expect(400);
    expect(res.body.error).toBe('invalid_fields');
  });

  it('projection does not mutate the stored contract', async () => {
    // Fetch a sparse view
    await request(app).get(`/api/v1/contracts/${created.id}?fields=title`).expect(200);
    // Subsequent full GET must still return all fields
    const full = await request(app).get(`/api/v1/contracts/${created.id}`).expect(200);
    expect(full.body.milestones).toBeDefined();
    expect(full.body.milestones.length).toBe(2);
    expect(full.body.client).toBe('GA');
    expect(full.body.freelancer).toBe('GB');
  });

  it('omitting ?fields= returns all fields', async () => {
    const res = await request(app).get(`/api/v1/contracts/${created.id}`).expect(200);
    // All required EscrowContract keys should be present
    ['id', 'title', 'client', 'freelancer', 'token', 'milestones', 'totalAmount',
      'fundedAmount', 'releasedAmount', 'status', 'reputationIssued', 'createdAt', 'updatedAt']
      .forEach((k) => expect(res.body).toHaveProperty(k));
  });
});

// ---------------------------------------------------------------------------
// Response compression
// ---------------------------------------------------------------------------
describe('response compression', () => {
  // 200 contracts ensures the response is well above the 1 KB threshold.
  const app = createApp(seededStore(200));

  it('compresses GET /contracts with Accept-Encoding: gzip', async () => {
    // supertest auto-decompresses the body, so we verify the headers and
    // that the parsed body is valid JSON with the expected structure.
    const res = await request(app)
      .get('/api/v1/contracts?limit=100')
      .set('Accept-Encoding', 'gzip')
      .expect(200);

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toMatch(/Accept-Encoding/i);

    // Body is valid JSON (supertest decompresses automatically). The list is
    // paginated (max 100 per page), so request the largest page.
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(100);
  });

  it('does not compress small responses (< 1 KB) even with Accept-Encoding: gzip', async () => {
    // A 404 response body is tiny and should not be compressed.
    const res = await request(app)
      .get('/nope')
      .set('Accept-Encoding', 'gzip')
      .expect(404);
    // May have Vary header but must NOT have content-encoding: gzip
    expect(res.headers['content-encoding']).not.toBe('gzip');
  });

  it('returns identity encoding when Accept-Encoding: identity is sent', async () => {
    // Explicitly request identity to bypass compression.
    const res = await request(app)
      .get('/api/v1/contracts')
      .set('Accept-Encoding', 'identity')
      .expect(200);
    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('unfunded contract edits and withdrawal', () => {
  let app = createApp(new EscrowStore());
  beforeEach(() => {
    app = createApp(new EscrowStore());
  });

  const createContract = () =>
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
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ error: 'contract_locked', message: 'Contract terms can only be edited before funding' }));

    const unfunded = await createContract().expect(201);
    const unfundedPath = `/api/v1/contracts/${unfunded.body.id}`;
    await request(app).patch(unfundedPath).send({ client: 'OTHER', title: 'No' }).expect(403);
    await request(app)
      .patch(unfundedPath)
      .send({ client: 'GCLIENT', milestones: [{ amount: 0 }] })
      .expect(400);
    await request(app).patch(unfundedPath).send({ client: 'GCLIENT' }).expect(400)
      .expect((r) => expect(r.body).toMatchObject({
      error: 'empty_patch',
      message: 'At least one of title or milestones must be provided',
    }));
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
      .expect(409)
      .expect((r) => expect(r.body).toMatchObject({ error: 'contract_locked', message: 'Contract can only be withdrawn before funding' }));
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



  describe('rate limiting', () => {
    it('returns 429 with Retry-After on the 11th rapid POST /api/v1/contracts from one client', async () => {
      process.env.RATE_LIMIT_ENABLED = 'true';
      process.env.RATE_LIMIT_WRITE_PER_MIN = '20';
      process.env.RATE_LIMIT_READ_PER_MIN = '120';
      const app2 = createApp(new EscrowStore());
      for (let i = 0; i < 10; i++) {
        const res = await request(app2)
          .post('/api/v1/contracts')
          .send({ client: `GA${i}`, freelancer: `GB${i}`, milestones: [{ amount: 100 }] });
        expect([201, 429]).toContain(res.status);
      }
      const res11 = await request(app2)
        .post('/api/v1/contracts')
        .send({ client: 'GA10', freelancer: 'GB10', milestones: [{ amount: 100 }] });
      expect(res11.status).toBe(429);
      expect(res11.headers['retry-after']).toBeDefined();
      expect(res11.body.error).toBe('rate_limited');
    });

    it('exposes rate limit headers', async () => {
      process.env.RATE_LIMIT_ENABLED = 'true';
      const app2 = createApp(new EscrowStore());
      const res = await request(app2).get('/api/v1/stats').expect(200);
      expect(res.headers['ratelimit-limit']).toBeDefined();
      expect(res.headers['ratelimit-remaining']).toBeDefined();
      expect(res.headers['ratelimit-reset']).toBeDefined();
    });

    it('never limits /health', async () => {
      process.env.RATE_LIMIT_ENABLED = 'true';
      const app2 = createApp(new EscrowStore());
      for (let i = 0; i < 30; i++) {
        const res = await request(app2).get('/health');
        expect(res.status).toBe(200);
      }
    });

    it('RATE_LIMIT_ENABLED=false disables rate limiting', async () => {
      process.env.RATE_LIMIT_ENABLED = 'false';
      const app2 = createApp(new EscrowStore());
      for (let i = 0; i < 25; i++) {
        const res = await request(app2)
          .post('/api/v1/contracts')
          .send({ client: `GC${i}`, freelancer: `GD${i}`, milestones: [{ amount: 100 }] });
        expect(res.status).not.toBe(429);
      }
      process.env.RATE_LIMIT_ENABLED = 'true';
    });
  });
