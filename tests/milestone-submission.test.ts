import request from 'supertest';
import { createApp } from '../src/app';

describe('milestone submission and review windows', () => {
  let now: Date;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    now = new Date('2026-10-01T00:00:00.000Z');
    app = createApp({ now: () => now, authRequired: false });
  });

  async function funded(milestones: number[] = [100, 50], reviewWindowSeconds = 3600) {
    const created = await request(app).post('/api/v1/contracts')
      .send({ client: 'GCLIENT', freelancer: 'GFREELANCER', milestones, reviewWindowSeconds }).expect(201);
    await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`)
      .send({ amount: milestones.reduce((sum, value) => sum + value, 0) }).expect(200);
    return created.body.id as number;
  }

  async function expectBackingInvariant(id: number) {
    const contract = (await request(app).get(`/api/v1/contracts/${id}`).expect(200)).body;
    const submitted = contract.milestones.filter((m: { status: string }) => m.status === 'submitted')
      .reduce((sum: bigint, m: { amountUnits: string }) => sum + BigInt(m.amountUnits), 0n);
    expect(BigInt(contract.fundedAmountUnits) - BigInt(contract.releasedAmountUnits)).toBeGreaterThanOrEqual(submitted);
  }

  it('keeps a submission pending until the exact review-window boundary, then releases lazily', async () => {
    const id = await funded();
    const submitted = await request(app).post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer: 'GFREELANCER', note: 'Design ready', url: 'https://example.com/deliverable' }).expect(200);
    await expectBackingInvariant(id);
    expect(submitted.body.milestones[0]).toMatchObject({ status: 'submitted', released: false, deliverable: { note: 'Design ready' } });
    now = new Date(Date.parse(submitted.body.milestones[0].submittedAt) + 3599_000);
    expect((await request(app).get(`/api/v1/contracts/${id}`).expect(200)).body.milestones[0].status).toBe('submitted');
    now = new Date(Date.parse(submitted.body.milestones[0].submittedAt) + 3600_000);
    const settled = (await request(app).get(`/api/v1/contracts/${id}`).expect(200)).body;
    expect(settled.milestones[0]).toMatchObject({ status: 'released', released: true });
    expect(settled.releasedAmount).toBe(100);
  });

  it('refuses cancel clawback after delivery and completes cancellation after auto-release', async () => {
    const id = await funded();
    const submission = await request(app).post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer: 'GFREELANCER', note: 'Delivered' }).expect(200);
    await expectBackingInvariant(id);
    const cancelled = await request(app).post(`/api/v1/contracts/${id}/cancel`).send({}).expect(200);
    await expectBackingInvariant(id);
    expect(cancelled.body).toMatchObject({ status: 'Funded', refundableAmount: 50, cancelRequestedAt: expect.any(String) });
    expect(cancelled.body.fundedAmount - cancelled.body.releasedAmount).toBeGreaterThanOrEqual(100);
    now = new Date(Date.parse(submission.body.milestones[0].submittedAt) + 3600_000);
    const settled = (await request(app).get(`/api/v1/contracts/${id}`).expect(200)).body;
    await expectBackingInvariant(id);
    expect(settled.status).toBe('Cancelled');
    expect(settled.releasedAmount).toBe(100);
  });

  it('validates submission party, funding, milestone state, indexes and dispute freeze', async () => {
    const created = await request(app).post('/api/v1/contracts')
      .send({ client: 'GCLIENT', freelancer: 'GFREELANCER', milestones: [100] }).expect(201);
    const submit = `/api/v1/contracts/${created.body.id}/milestones/0/submit`;
    await request(app).post(submit).send({ freelancer: 'GOTHER', note: 'Done' }).expect(403);
    await request(app).post(submit).send({ freelancer: 'GFREELANCER', note: 'Done' }).expect(409);
    await request(app).post(`/api/v1/contracts/${created.body.id}/deposit`).send({ amount: 100 }).expect(200);
    await request(app).post(`/api/v1/contracts/${created.body.id}/milestones/1/submit`)
      .send({ freelancer: 'GFREELANCER', note: 'Done' }).expect(404);
    await request(app).post(submit).send({ freelancer: 'GFREELANCER', note: 'Done' }).expect(200);
    await request(app).post(submit).send({ freelancer: 'GFREELANCER', note: 'Again' }).expect(409);
    await request(app).post(`/api/v1/contracts/${created.body.id}/dispute`).send({ raisedBy: 'GCLIENT' }).expect(200);
    now = new Date(now.getTime() + 3600_000);
    expect((await request(app).get(`/api/v1/contracts/${created.body.id}`).expect(200)).body.milestones[0].status).toBe('submitted');
  });

  it('rejects submission after a milestone was released and validates review-window bounds', async () => {
    await request(app).post('/api/v1/contracts')
      .send({ client: 'GCLIENT', freelancer: 'GFREELANCER', milestones: [100], reviewWindowSeconds: 3599 })
      .expect(400).expect(({ body }) => expect(body.error).toBe('invalid_review_window'));
    const id = await funded([100]);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/submit`)
      .send({ freelancer: 'GFREELANCER', note: 'Too late' }).expect(409);
  });

  it('releases due milestones across contracts through the authenticated idempotent cron', async () => {
    const previous = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      await request(app).post('/api/cron/auto-release').expect(401);
      process.env.CRON_SECRET = 'test-cron-secret';
      const first = await funded([100]);
      const second = await funded([200]);
      const one = await request(app).post(`/api/v1/contracts/${first}/milestones/0/submit`).send({ freelancer: 'GFREELANCER', note: 'One' }).expect(200);
      const two = await request(app).post(`/api/v1/contracts/${second}/milestones/0/submit`).send({ freelancer: 'GFREELANCER', note: 'Two' }).expect(200);
      now = new Date(Date.parse(one.body.milestones[0].submittedAt) + 3600_000);
      const run = await request(app).post('/api/cron/auto-release').set('Authorization', 'Bearer test-cron-secret').expect(200);
      expect(run.body.released.sort()).toEqual([first, second].sort());
      await request(app).post('/api/cron/auto-release').set('Authorization', 'Bearer test-cron-secret').expect(200).expect(({ body }) => expect(body.released).toEqual([]));
      expect(two.body.milestones[0].status).toBe('submitted');
    } finally {
      if (previous === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previous;
    }
  });
});
