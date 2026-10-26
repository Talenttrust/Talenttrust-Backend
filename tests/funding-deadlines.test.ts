import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { account } from './helpers/addresses';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const START = Date.parse('2026-01-01T00:00:00.000Z');

describe('funding deadlines and expiry', () => {
  let now = START;
  let store: EscrowStore;
  let app: ReturnType<typeof createApp>;

  const create = (extra: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/contracts').send({ client: account('client'), freelancer: account('freelancer'), milestones: [{ amount: 100 }], ...extra });

  beforeEach(() => {
    delete process.env.CRON_SECRET;
    now = START;
    store = new EscrowStore(() => new Date(now));
    app = createApp(store);
  });

  describe('creation validation and lazy expiry', () => {
    it('accepts an explicit deadline and defaults to exactly 14 days', async () => {
      const explicit = await create({ fundingDeadline: new Date(START + DAY).toISOString() });
      expect(explicit.status).toBe(201);
      expect(explicit.body.fundingDeadline).toBe(new Date(START + DAY).toISOString());

      const defaulted = await request(app).post('/api/v1/contracts').send({ client: account('c2'), freelancer: account('f2'), milestones: [100] });
      expect(defaulted.body.fundingDeadline).toBe(new Date(START + 14 * DAY).toISOString());
    });

    it.each([
      ['malformed', 'not-a-date'],
      ['past', new Date(START - 1).toISOString()],
      ['too soon', new Date(START + HOUR - 1).toISOString()],
      ['too distant', new Date(START + 90 * DAY + 1).toISOString()],
    ])('rejects a %s deadline', async (_label, fundingDeadline) => {
      const response = await create({ fundingDeadline });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_deadline');
    });

    it('keeps a contract created one millisecond before the deadline and expires at the deadline', async () => {
      const response = await create({ fundingDeadline: new Date(START + HOUR).toISOString() });
      const id = response.body.id;
      now = START + HOUR - 1;
      expect((await request(app).get(`/api/v1/contracts/${id}`)).body.status).toBe('Created');
      now = START + HOUR;
      const expired = await request(app).get(`/api/v1/contracts/${id}`);
      expect(expired.status).toBe(200);
      expect(expired.body.status).toBe('Expired');
      expect(expired.body.expiredAt).toBe(new Date(now).toISOString());
      expect((await request(app).get('/api/v1/stats')).body.byStatus.Expired).toBe(1);
    });

    it('expires an unfunded contract and rejects later deposits', async () => {
      const id = (await create()).body.id;
      now = START + 14 * DAY;
      const expired = await request(app).get(`/api/v1/contracts/${id}`);
      expect(expired.body.refundableAmount).toBe(0);
      const deposit = await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 10 });
      expect(deposit.status).toBe(409);
      expect(deposit.body.error).toBe('contract_expired');
    });

    it('preserves funded contracts and accounts for partial funding on expiry', async () => {
      const fundedId = (await create({ client: account('funded-client'), freelancer: account('funded-freelancer') })).body.id;
      await request(app).post(`/api/v1/contracts/${fundedId}/deposit`).send({ amount: 100 });
      const partialId = (await create({ client: account('partial-client'), freelancer: account('partial-freelancer') })).body.id;
      await request(app).post(`/api/v1/contracts/${partialId}/deposit`).send({ amount: 40 });
      now = START + 14 * DAY;

      expect((await request(app).get(`/api/v1/contracts/${fundedId}`)).body.status).toBe('Funded');
      const partial = (await request(app).get(`/api/v1/contracts/${partialId}`)).body;
      expect(partial.status).toBe('Expired');
      expect(partial.refundableAmount).toBe(40);
      expect(partial.fundedAmount).toBe(0);
      expect(partial.releasedAmount).toBe(0);
      const again = (await request(app).get(`/api/v1/contracts/${partialId}`)).body;
      expect(again.expiredAt).toBe(partial.expiredAt);
      expect(again.refundableAmount).toBe(40);
    });
  });

  describe('cron sweep', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'development-secret';
    });

    afterEach(() => {
      delete process.env.CRON_SECRET;
    });

    it.each([
      ['missing', undefined],
      ['wrong', 'Bearer wrong-secret'],
      ['malformed', 'Basic development-secret'],
    ])('rejects %s authorization', async (_label, authorization) => {
      const response = await request(app).get('/api/cron/expire-contracts').set('Authorization', authorization ?? '');
      expect(response.status).toBe(401);
      expect(response.body.error).toBe('cron_unauthorized');
    });

    it('fails closed when CRON_SECRET is unset', async () => {
      delete process.env.CRON_SECRET;
      const response = await request(app).post('/api/cron/expire-contracts');
      expect(response.status).toBe(404);
      expect(response.body.error).toBe('not_found');
    });

    it('sweeps multiple contracts and is idempotent', async () => {
      const first = (await create({ client: account('cron-client-1'), freelancer: account('cron-freelancer-1') })).body.id;
      const second = (await create({ client: account('cron-client-2'), freelancer: account('cron-freelancer-2') })).body.id;
      now = START + 14 * DAY;
      const firstRun = await request(app).post('/api/cron/expire-contracts').set('Authorization', 'Bearer development-secret');
      expect(firstRun.status).toBe(200);
      expect(firstRun.body.expired).toEqual([first, second]);
      expect(firstRun.body.checkedAt).toBe(new Date(now).toISOString());
      const secondRun = await request(app).get('/api/cron/expire-contracts').set('Authorization', 'Bearer development-secret');
      expect(secondRun.body.expired).toEqual([]);
    });
  });

  describe('deadline extension', () => {
    it('allows only the client to extend to a later valid deadline', async () => {
      const id = (await create()).body.id;
      const deadline = new Date(START + 30 * DAY).toISOString();
      const extended = await request(app).post(`/api/v1/contracts/${id}/extend-deadline`).send({ client: account('client'), fundingDeadline: deadline });
      expect(extended.status).toBe(200);
      expect(extended.body.fundingDeadline).toBe(deadline);
      const unauthorized = await request(app).post(`/api/v1/contracts/${id}/extend-deadline`).send({ client: account('freelancer'), fundingDeadline: new Date(START + 31 * DAY).toISOString() });
      expect(unauthorized.status).toBe(403);
    });

    it.each([
      new Date(START + 14 * DAY).toISOString(),
      new Date(START + 90 * DAY + 1).toISOString(),
      'invalid',
    ])('rejects an invalid or non-later extension', async (fundingDeadline) => {
      const id = (await create()).body.id;
      const response = await request(app).post(`/api/v1/contracts/${id}/extend-deadline`).send({ client: account('client'), fundingDeadline });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_deadline');
    });

    it('returns contract_expired when extending after lazy expiry', async () => {
      const id = (await create()).body.id;
      now = START + 14 * DAY;
      const response = await request(app).post(`/api/v1/contracts/${id}/extend-deadline`).send({ client: account('client'), fundingDeadline: new Date(START + 30 * DAY).toISOString() });
      expect(response.status).toBe(409);
      expect(response.body.error).toBe('contract_expired');
    });
  });

  it('documents the new status and routes in OpenAPI', async () => {
    const spec = (await request(app).get('/openapi.json')).body;
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.paths['/api/cron/expire-contracts']).toBeDefined();
    expect(spec.paths['/api/v1/contracts/{id}/extend-deadline']).toBeDefined();
    expect(spec.components.schemas.EscrowContract.properties.status.enum).toContain('Expired');
  });
});
