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

type ContractBody = {
  id: number;
  status: string;
  fundedAmount: number;
  releasedAmount: number;
  reviewWindowSeconds: number;
  cancelRequestedAt?: string;
  milestones: Array<{
    index: number;
    amount: number;
    status: string;
    released: boolean;
    submittedAt?: string;
    deliverable?: { note: string; url?: string };
  }>;
};

const assertInvariant = (c: ContractBody) => {
  const submitted = c.milestones
    .filter((m) => m.status === 'submitted')
    .reduce((sum, m) => sum + m.amount, 0);
  expect(c.fundedAmount - c.releasedAmount).toBeGreaterThanOrEqual(submitted);
};

describe('milestone review window', () => {
  const setup = (startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) => {
    let nowMs = startMs;
    const store = new EscrowStore();
    const app = createApp({ store, now: () => new Date(nowMs), cronSecret: 'cron-secret' });
    return {
      app,
      store,
      advance: (seconds: number) => {
        nowMs += seconds * 1000;
      },
    };
  };

  const createFunded = async (
    app: ReturnType<typeof createApp>,
    opts: {
      client?: string;
      freelancer?: string;
      milestones?: Array<{ amount: number }>;
      reviewWindowSeconds?: number;
    } = {},
  ) => {
    const client = opts.client ?? 'GCLIENT';
    const freelancer = opts.freelancer ?? 'GFREELANCER';
    const milestones = opts.milestones ?? [{ amount: 100 }];
    const body: Record<string, unknown> = { client, freelancer, milestones };
    if (opts.reviewWindowSeconds !== undefined) body.reviewWindowSeconds = opts.reviewWindowSeconds;
    const created = await request(app).post('/api/v1/contracts').send(body);
    expect(created.status).toBe(201);
    const total = milestones.reduce((sum, m) => sum + m.amount, 0);
    const funded = await request(app)
      .post(`/api/v1/contracts/${created.body.id}/deposit`)
      .send({ amount: total });
    expect(funded.status).toBe(200);
    expect(funded.body.status).toBe('Funded');
    return { id: created.body.id as number, freelancer, milestones };
  };

  it('does not let cancel claw back a submitted milestone', async () => {
    const { app, advance } = setup();
    const { id, freelancer } = await createFunded(app, {
      milestones: [{ amount: 100 }, { amount: 50 }],
      reviewWindowSeconds: 3600,
    });

    const submitted = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'designs', url: 'https://example.com/deliverable' });
    expect(submitted.status).toBe(200);
    expect(submitted.body.milestones[0].status).toBe('submitted');
    expect(submitted.body.milestones[0].released).toBe(false);
    expect(submitted.body.milestones[0].deliverable).toEqual({
      note: 'designs',
      url: 'https://example.com/deliverable',
    });
    assertInvariant(submitted.body);

    const cancelled = await request(app).post(`/api/v1/contracts/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('Funded');
    expect(cancelled.body.cancelRequestedAt).toBeTruthy();
    expect(cancelled.body.fundedAmount).toBe(100);
    expect(cancelled.body.releasedAmount).toBe(0);
    expect(cancelled.body.milestones[0].status).toBe('submitted');
    expect(cancelled.body.milestones[1].status).toBe('pending');
    assertInvariant(cancelled.body);

    const blocked = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/1/submit`)
      .send({ freelancer, note: 'more work' });
    expect(blocked.status).toBe(409);
    assertInvariant((await request(app).get(`/api/v1/contracts/${id}`)).body);

    advance(3600);
    const settled = await request(app).get(`/api/v1/contracts/${id}`);
    expect(settled.status).toBe(200);
    expect(settled.body.milestones[0].status).toBe('released');
    expect(settled.body.milestones[0].released).toBe(true);
    expect(settled.body.releasedAmount).toBe(100);
    expect(settled.body.fundedAmount).toBe(100);
    expect(settled.body.status).toBe('Cancelled');
    assertInvariant(settled.body);
  });

  it('auto-releases exactly at the review window boundary', async () => {
    const { app, advance } = setup();
    const { id, freelancer } = await createFunded(app, {
      milestones: [{ amount: 75 }],
      reviewWindowSeconds: 3600,
    });

    await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'done' })
      .expect(200);

    advance(3599);
    const before = await request(app).get(`/api/v1/contracts/${id}`);
    expect(before.body.milestones[0].status).toBe('submitted');
    expect(before.body.releasedAmount).toBe(0);
    assertInvariant(before.body);

    advance(1);
    const at = await request(app).get(`/api/v1/contracts/${id}`);
    expect(at.body.milestones[0].status).toBe('released');
    expect(at.body.releasedAmount).toBe(75);
    expect(at.body.status).toBe('Completed');
    assertInvariant(at.body);
  });

  it('rejects invalid submissions', async () => {
    const { app, store } = setup();
    const { id, freelancer } = await createFunded(app, {
      milestones: [{ amount: 100 }, { amount: 50 }],
      reviewWindowSeconds: 3600,
    });

    const wrongFreelancer = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer: 'GSOMEONEELSE', note: 'done' });
    expect(wrongFreelancer.status).toBe(403);
    expect(wrongFreelancer.body.error).toBe('forbidden');

    const outOfRange = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/9/submit`)
      .send({ freelancer, note: 'done' });
    expect(outOfRange.status).toBe(404);
    expect(outOfRange.body.error).toBe('milestone_not_found');

    const longNote = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'x'.repeat(1001) });
    expect(longNote.status).toBe(400);
    expect(longNote.body.error).toBe('invalid_deliverable');

    const insecureUrl = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'done', url: 'http://example.com' });
    expect(insecureUrl.status).toBe(400);
    expect(insecureUrl.body.error).toBe('invalid_deliverable');

    await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'done' })
      .expect(200);

    const alreadySubmitted = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'again' });
    expect(alreadySubmitted.status).toBe(409);
    expect(alreadySubmitted.body.error).toBe('invalid_milestone_status');

    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);

    const alreadyReleased = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer, note: 'again' });
    expect(alreadyReleased.status).toBe(409);
    expect(alreadyReleased.body.error).toBe('invalid_milestone_status');

    const disputed = await request(app)
      .post(`/api/v1/contracts/${id}/dispute`)
      .send({ raisedBy: freelancer, reason: 'quality' });
    expect(disputed.status).toBe(200);
    const whileDisputed = await request(app)
      .post(`/api/v1/contracts/${id}/milestones/1/submit`)
      .send({ freelancer, note: 'done' });
    expect(whileDisputed.status).toBe(409);
    expect(whileDisputed.body.error).toBe('invalid_status');

    const notFunded = await request(app)
      .post('/api/v1/contracts')
      .send({ client: 'GC2', freelancer: 'GF2', milestones: [{ amount: 10 }] });
    const notFundedSubmit = await request(app)
      .post(`/api/v1/contracts/${notFunded.body.id}/milestones/0/submit`)
      .send({ freelancer: 'GF2', note: 'done' });
    expect(notFundedSubmit.status).toBe(409);
    expect(notFundedSubmit.body.error).toBe('invalid_status');

    const underfunded = await createFunded(app, {
      client: 'GC3',
      freelancer: 'GF3',
      milestones: [{ amount: 100 }],
    });
    store.get(underfunded.id).fundedAmount = 50;
    const insufficient = await request(app)
      .post(`/api/v1/contracts/${underfunded.id}/milestones/0/submit`)
      .send({ freelancer: 'GF3', note: 'done' });
    expect(insufficient.status).toBe(409);
    expect(insufficient.body.error).toBe('insufficient_funds');
  });

  it('validates reviewWindowSeconds', async () => {
    const { app } = setup();
    const base = { client: 'GA', freelancer: 'GB', milestones: [{ amount: 10 }] };

    const defaulted = await request(app).post('/api/v1/contracts').send(base);
    expect(defaulted.status).toBe(201);
    expect(defaulted.body.reviewWindowSeconds).toBe(259200);

    for (const value of [3599, 2592001, 3600.5, 'nope']) {
      const res = await request(app)
        .post('/api/v1/contracts')
        .send({ ...base, reviewWindowSeconds: value });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_review_window');
    }

    await request(app)
      .post('/api/v1/contracts')
      .send({ ...base, reviewWindowSeconds: 3600 })
      .expect(201);
    await request(app)
      .post('/api/v1/contracts')
      .send({ ...base, reviewWindowSeconds: 2592000 })
      .expect(201);
  });

  it('sweeps due milestones across contracts and is idempotent', async () => {
    const { app, advance } = setup();
    const a = await createFunded(app, {
      client: 'GC1',
      freelancer: 'GF1',
      milestones: [{ amount: 100 }],
      reviewWindowSeconds: 3600,
    });
    const b = await createFunded(app, {
      client: 'GC2',
      freelancer: 'GF2',
      milestones: [{ amount: 200 }],
      reviewWindowSeconds: 3600,
    });
    const c = await createFunded(app, {
      client: 'GC3',
      freelancer: 'GF3',
      milestones: [{ amount: 300 }],
      reviewWindowSeconds: 7200,
    });

    for (const x of [a, b, c]) {
      await request(app)
        .post(`/api/v1/contracts/${x.id}/milestones/0/submit`)
        .send({ freelancer: x.freelancer, note: 'done' })
        .expect(200);
    }

    advance(3600);
    await request(app).post('/api/cron/auto-release').expect(401);
    await request(app)
      .post('/api/cron/auto-release')
      .set('Authorization', 'Bearer wrong-secret')
      .expect(401);

    const first = await request(app)
      .post('/api/cron/auto-release')
      .set('Authorization', 'Bearer cron-secret');
    expect(first.status).toBe(200);
    expect(first.body.released).toBe(2);

    const ga = await request(app).get(`/api/v1/contracts/${a.id}`);
    const gb = await request(app).get(`/api/v1/contracts/${b.id}`);
    const gc = await request(app).get(`/api/v1/contracts/${c.id}`);
    expect(ga.body.status).toBe('Completed');
    expect(gb.body.status).toBe('Completed');
    expect(gc.body.milestones[0].status).toBe('submitted');
    assertInvariant(ga.body);
    assertInvariant(gb.body);
    assertInvariant(gc.body);

    const second = await request(app)
      .post('/api/cron/auto-release')
      .set('Authorization', 'Bearer cron-secret');
    expect(second.status).toBe(200);
    expect(second.body.released).toBe(0);
    expect((await request(app).get(`/api/v1/contracts/${a.id}`)).body.releasedAmount).toBe(100);

    advance(3600);
    const third = await request(app)
      .post('/api/cron/auto-release')
      .set('Authorization', 'Bearer cron-secret');
    expect(third.status).toBe(200);
    expect(third.body.released).toBe(1);
    assertInvariant((await request(app).get(`/api/v1/contracts/${c.id}`)).body);
  });
});
