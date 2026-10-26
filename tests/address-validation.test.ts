import request from 'supertest';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { config } from '../src/config';

const account = () => Keypair.random().publicKey();
const contract = () => StrKey.encodeContract(Buffer.alloc(32, 7));
const muxed = () => {
  const base = Keypair.random().publicKey();
  return StrKey.encodeMed25519PublicKey(
    Buffer.concat([StrKey.decodeEd25519PublicKey(base), Buffer.alloc(8)]),
  );
};
const flipLast = (value: string) => value.slice(0, -1) + (value.endsWith('A') ? 'B' : 'A');

const validContract = (client: string, freelancer: string, extra: Record<string, unknown> = {}) => ({
  client,
  freelancer,
  milestones: [{ amount: 100 }],
  ...extra,
});

describe('Stellar address validation', () => {
  const app = createApp(new EscrowStore());

  it('rejects a short/non-strkey address as invalid_address', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract('GA', 'GB'))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
  });

  it('compares parties after normalisation', async () => {
    const client = account();
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(client, client.toLowerCase()))
      .expect(400);
    expect(res.body.error).toBe('invalid_parties');
  });

  it('rejects a bad checksum', async () => {
    const client = account();
    const bad = flipLast(client);
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(bad, account()))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
  });

  it('rejects a secret seed without echoing it', async () => {
    const secret = Keypair.random().secret();
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(secret, account()))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
    expect(JSON.stringify(res.body)).not.toContain(secret);
  });

  it('rejects muxed accounts with a clear message', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(muxed(), account()))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
    expect(res.body.message).toContain('muxed accounts are not supported');
    expect(res.body.message).toContain('G…');
  });

  it('rejects a contract address used as a party', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(contract(), account()))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
  });

  it('rejects an account address used as a token', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(account(), account(), { token: account() }))
      .expect(400);
    expect(res.body.error).toBe('invalid_address');
  });

  it('normalises trimmed lower-case accounts before storing them', async () => {
    const client = account();
    const freelancer = account();
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(`  ${client.toLowerCase()}  `, ` ${freelancer.toLowerCase()} `))
      .expect(201);
    expect(res.body.client).toBe(client);
    expect(res.body.freelancer).toBe(freelancer);
  });

  it('resolves the native aliases to the SAC id and keeps the symbol', async () => {
    for (const token of ['native', 'XLM', undefined]) {
      const body: Record<string, unknown> = validContract(account(), account());
      if (token !== undefined) body.token = token;
      const res = await request(app).post('/api/v1/contracts').send(body).expect(201);
      expect(res.body.token).toBe(config.nativeTokenContractId);
      expect(res.body.tokenSymbol).toBe('XLM');
    }
  });

  it('stores a C… token and reports a null symbol', async () => {
    const token = contract();
    const res = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(account(), account(), { token }))
      .expect(201);
    expect(res.body.token).toBe(token);
    expect(res.body.tokenSymbol).toBeNull();
  });

  it('validates and normalises GET /contracts?party=', async () => {
    const client = account();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(client, account()))
      .expect(201);

    const bad = await request(app).get('/api/v1/contracts?party=not-an-address').expect(400);
    expect(bad.body.error).toBe('invalid_address');

    const found = await request(app)
      .get(`/api/v1/contracts?party=${client.toLowerCase()}`)
      .expect(200);
    expect(found.body.data.map((c: { id: number }) => c.id)).toContain(created.body.id);
  });

  it('validates and normalises openDispute.raisedBy', async () => {
    const client = account();
    const freelancer = account();
    const created = await request(app)
      .post('/api/v1/contracts')
      .send(validContract(client, freelancer))
      .expect(201);
    const id = created.body.id;
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 100 }).expect(200);

    const bad = await request(app)
      .post(`/api/v1/contracts/${id}/dispute`)
      .send({ raisedBy: 'GA', reason: 'late' })
      .expect(400);
    expect(bad.body.error).toBe('invalid_address');

    const opened = await request(app)
      .post(`/api/v1/contracts/${id}/dispute`)
      .send({ raisedBy: freelancer.toLowerCase(), reason: 'late' })
      .expect(200);
    expect(opened.body.dispute.raisedBy).toBe(freelancer);
  });

  it('rejects invalid reputation addresses and returns zeros for an unknown valid one', async () => {
    const bad = await request(app).get('/api/v1/reputation/not-an-address').expect(400);
    expect(bad.body.error).toBe('invalid_address');

    const unknown = account();
    const res = await request(app).get(`/api/v1/reputation/${unknown.toLowerCase()}`).expect(200);
    expect(res.body).toMatchObject({
      address: unknown,
      completedContracts: 0,
      totalRating: 0,
      averageRating: 0,
      rank: null,
      histogram: [0, 0, 0, 0, 0],
      lastRatedAt: null,
    });
  });

  it('seeds only checksum-valid demo accounts and a resolvable native token', () => {
    const store = new EscrowStore().seed();
    for (const c of store.list()) {
      expect(StrKey.isValidEd25519PublicKey(c.client)).toBe(true);
      expect(StrKey.isValidEd25519PublicKey(c.freelancer)).toBe(true);
      expect(StrKey.isValidContract(c.token)).toBe(true);
      expect(c.tokenSymbol).toBe('XLM');
    }
  });
});
