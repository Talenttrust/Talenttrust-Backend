import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, termsHash } from '../src/store';

describe('freelancer acceptance gate', () => {
  let store: EscrowStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new EscrowStore({ requireAcceptance: true });
    app = createApp({ store });
  });

  async function offer(client = 'GCLIENT', freelancer = 'GFREELANCER') {
    const response = await request(app)
      .post('/api/v1/contracts')
      .send({ client, freelancer, token: 'XLM', milestones: [{ title: 'Design', amount: 100 }, { title: 'Build', amount: 250 }] })
      .expect(201);
    return response.body;
  }

  it('uses the documented deterministic SHA-256 terms hash vector', () => {
    expect(termsHash({
      client: 'GCLIENT',
      freelancer: 'GFREELANCER',
      token: 'XLM',
      milestones: [{ title: 'Design', amount: 100 }, { title: 'Build', amount: 250 }],
    })).toBe('506bb82832289e652825e2e7e72c944300e1e795e789a7a270b1ad91011327be');
  });

  it('blocks funding until the freelancer accepts the exact offer', async () => {
    const contract = await offer();
    expect(contract.acceptance.status).toBe('pending');
    await request(app).post(`/api/v1/contracts/${contract.id}/deposit`).send({ amount: 350 })
      .expect(409).expect(({ body }) => expect(body.error).toBe('awaiting_acceptance'));
    await request(app).post(`/api/v1/contracts/${contract.id}/accept`)
      .send({ freelancer: 'GFREELANCER', termsHash: contract.acceptance.termsHash }).expect(200);
    await request(app).post(`/api/v1/contracts/${contract.id}/deposit`).send({ amount: 350 }).expect(200);
  });

  it('rejects wrong party, stale hashes and repeated responses', async () => {
    const contract = await offer();
    const path = `/api/v1/contracts/${contract.id}/accept`;
    await request(app).post(path).send({ freelancer: 'GOTHER', termsHash: contract.acceptance.termsHash }).expect(403);
    await request(app).post(path).send({ freelancer: 'GFREELANCER', termsHash: 'stale' }).expect(409);
    await request(app).post(path).send({ freelancer: 'GFREELANCER', termsHash: contract.acceptance.termsHash }).expect(200);
    await request(app).post(path).send({ freelancer: 'GFREELANCER', termsHash: contract.acceptance.termsHash }).expect(409);
  });

  it('lets the freelancer decline, cancels the offer and filters pending offers by party', async () => {
    const first = await offer();
    await offer('GCLIENT2', 'GOTHER');
    const pending = await request(app).get('/api/v1/contracts?acceptance=pending&party=GFREELANCER').expect(200);
    expect(pending.body.data.map((item: { id: number }) => item.id)).toEqual([first.id]);
    await request(app).post(`/api/v1/contracts/${first.id}/decline`)
      .send({ freelancer: 'GFREELANCER', reason: 'Unavailable' }).expect(200)
      .expect(({ body }) => {
        expect(body.status).toBe('Cancelled');
        expect(body.acceptance.status).toBe('declined');
      });
    await request(app).post(`/api/v1/contracts/${first.id}/deposit`).send({ amount: 350 }).expect(409);
  });
});
