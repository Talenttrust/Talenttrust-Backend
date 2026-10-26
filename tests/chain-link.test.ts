import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { ChainReader, ChainReaderResult, ChainUnavailableError, OnChainEscrow } from '../src/chain';
import { account, contract } from './helpers/addresses';

const DEFAULT_TOKEN = contract('DEFAULT_TOKEN');

class FakeChainReader implements ChainReader {
  public escrows = new Map<string, OnChainEscrow>();
  public latestLedger = 42000;
  public throwUnavailable = false;

  async getContract(escrowId: string): Promise<ChainReaderResult | null> {
    if (this.throwUnavailable) {
      throw new ChainUnavailableError('Simulated RPC network timeout');
    }
    const contract = this.escrows.get(escrowId);
    if (!contract) return null;
    return {
      contract: JSON.parse(JSON.stringify(contract)),
      latestLedger: this.latestLedger,
    };
  }
}

describe('Soroban Escrow Linking & Parity Verification', () => {
  let store: EscrowStore;
  let fakeChain: FakeChainReader;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new EscrowStore();
    fakeChain = new FakeChainReader();
    app = createApp(store, fakeChain);
  });

  describe('POST /api/v1/contracts/:id/link', () => {
    it('successfully links contract when parties, token, and milestones match', async () => {
      const created = store.create({
        title: 'Design audit',
        client: account('GCLIENT11111111111111111111111111111111111111111111111111'),
        freelancer: account('GFREELANCER111111111111111111111111111111111111111111111'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 500 }, { amount: 1000 }],
      });

      fakeChain.escrows.set('101', {
        client: account('GCLIENT11111111111111111111111111111111111111111111111111'),
        freelancer: account('GFREELANCER111111111111111111111111111111111111111111111'),
        token: DEFAULT_TOKEN,
        totalAmount: '1500',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [
          { index: 0, amount: '500', released: false },
          { index: 1, amount: '1000', released: false },
        ],
        reputationIssued: false,
      });

      const res = await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({ escrowId: '101' });

      expect(res.status).toBe(200);
      expect(res.body.chain).toBeDefined();
      expect(res.body.chain.escrowId).toBe('101');
      expect(res.body.chain.status).toBe('in_sync');
      expect(res.body.chain.drift).toEqual([]);
      expect(typeof res.body.chain.linkedAt).toBe('string');
      expect(typeof res.body.chain.lastVerifiedAt).toBe('string');
    });

    it('rejects missing or empty escrowId with 400', async () => {
      const created = store.create({
        client: account('GCLIENT'),
        freelancer: account('GFREELANCER'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }],
      });

      const res1 = await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({});
      expect(res1.status).toBe(400);
      expect(res1.body.error).toBe('invalid_escrow_id');

      const res2 = await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({ escrowId: '   ' });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('invalid_escrow_id');
    });

    it('returns 404 when on-chain contract does not exist', async () => {
      const created = store.create({
        client: account('GCLIENT'),
        freelancer: account('GFREELANCER'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }],
      });

      const res = await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({ escrowId: '999999' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('chain_contract_not_found');
      expect(store.get(created.id).chain).toBeUndefined();
    });

    it('returns 409 already_linked when contract is already linked', async () => {
      const created = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }],
      });
      fakeChain.escrows.set('1', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({ escrowId: '1' })
        .expect(200);

      const res = await request(app)
        .post(`/api/v1/contracts/${created.id}/link`)
        .send({ escrowId: '1' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('already_linked');
    });

    it('returns 409 chain_escrow_taken when same on-chain escrow is linked to another contract', async () => {
      const c1 = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const c2 = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });

      fakeChain.escrows.set('SHARED_ESCROW', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      await request(app)
        .post(`/api/v1/contracts/${c1.id}/link`)
        .send({ escrowId: 'SHARED_ESCROW' })
        .expect(200);

      const res = await request(app)
        .post(`/api/v1/contracts/${c2.id}/link`)
        .send({ escrowId: 'SHARED_ESCROW' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_escrow_taken');
    });

    it('returns 409 chain_mismatch for client mismatch', async () => {
      const c = store.create({ client: account('API_CLIENT'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('E1', {
        client: account('CHAIN_CLIENT'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'E1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'client',
        api: account('API_CLIENT'),
        chain: account('CHAIN_CLIENT'),
      });
      expect(store.get(c.id).chain).toBeUndefined();
    });

    it('returns 409 chain_mismatch for freelancer mismatch', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('API_FREELANCER'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('E2', {
        client: account('GA'),
        freelancer: account('CHAIN_FREELANCER'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'E2' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'freelancer',
        api: account('API_FREELANCER'),
        chain: account('CHAIN_FREELANCER'),
      });
    });

    it('returns 409 chain_mismatch for token mismatch', async () => {
      const c = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: contract('TOKEN_A'),
        milestones: [{ amount: 100 }],
      });
      fakeChain.escrows.set('E3', {
        client: account('GA'),
        freelancer: account('GB'),
        token: contract('TOKEN_B'),
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'E3' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'token',
        api: contract('TOKEN_A'),
        chain: contract('TOKEN_B'),
      });
    });

    it('returns 409 chain_mismatch for milestone count mismatch', async () => {
      const c = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }, { amount: 200 }],
      });
      fakeChain.escrows.set('E4', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'E4' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'milestones.count',
        api: 2,
        chain: 1,
      });
    });

    it('returns 409 chain_mismatch for milestone amount mismatch', async () => {
      const c = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }, { amount: 200 }],
      });
      fakeChain.escrows.set('E5', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '350',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [
          { index: 0, amount: '100', released: false },
          { index: 1, amount: '250', released: false },
        ],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'E5' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'milestones[1].amount',
        api: '200',
        chain: '250',
      });
    });

    it('handles exact amount comparisons for values above 2^53 without precision loss', async () => {
      // 9007199254740993 and 9007199254740994 both round to 9007199254740992 in standard JS Number
      const hugeApiAmount = '9007199254740993';
      const hugeChainAmount = '9007199254740994';

      const c = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: hugeApiAmount }],
      });

      fakeChain.escrows.set('HUGE_DIFF', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: hugeChainAmount,
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: hugeChainAmount, released: false }],
        reputationIssued: false,
      });

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'HUGE_DIFF' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('chain_mismatch');
      expect(res.body.mismatches).toContainEqual({
        field: 'milestones[0].amount',
        api: hugeApiAmount,
        chain: hugeChainAmount,
      });

      // Now with exact match above 2^53
      fakeChain.escrows.set('HUGE_MATCH', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: hugeApiAmount,
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: hugeApiAmount, released: false }],
        reputationIssued: false,
      });

      const matchRes = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'HUGE_MATCH' });
      expect(matchRes.status).toBe(200);
      expect(matchRes.body.chain.status).toBe('in_sync');
    });

    it('returns 503 chain_unavailable when RPC errors and leaves record unchanged', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.throwUnavailable = true;

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'ANY' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('chain_unavailable');
      expect(store.get(c.id).chain).toBeUndefined();
    });
  });

  describe('GET /api/v1/contracts/:id/parity', () => {
    it('returns 409 not_linked when checking parity on unlinked contract', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('not_linked');
    });

    it('returns in_sync when API and on-chain state perfectly match', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 500 }] });
      store.deposit(c.id, 500);

      fakeChain.escrows.set('P1', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '500',
        fundedAmount: '500',
        releasedAmount: '0',
        status: 'Funded',
        milestones: [{ index: 0, amount: '500', released: false }],
        reputationIssued: false,
      });

      await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'P1' }).expect(200);

      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('in_sync');
      expect(res.body.drift).toEqual([]);
      expect(res.body.latestLedger).toBe(fakeChain.latestLedger);
      expect(typeof res.body.checkedAt).toBe('string');
    });

    it('detects status drift (API Funded vs chain Created)', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 500 }] });
      store.deposit(c.id, 500); // status is now 'Funded' in API

      fakeChain.escrows.set('P2', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '500',
        fundedAmount: '500',
        releasedAmount: '0',
        status: 'Created', // Still Created on-chain
        milestones: [{ index: 0, amount: '500', released: false }],
        reputationIssued: false,
      });

      await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'P2' }).expect(200);

      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('drift');
      expect(res.body.drift).toContainEqual({
        field: 'status',
        api: 'Funded',
        chain: 'Created',
      });

      const updated = store.get(c.id);
      expect(updated.chain?.status).toBe('drift');
      expect(updated.chain?.drift.length).toBeGreaterThan(0);
    });

    it('detects funding drift and per-milestone release drift', async () => {
      const c = store.create({
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 200 }, { amount: 300 }],
      });
      store.deposit(c.id, 200); // API fundedAmount is 200
      store.release(c.id, 0); // API milestone 0 is released

      fakeChain.escrows.set('P3', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '500',
        fundedAmount: '0', // On chain 0 funded
        releasedAmount: '0', // On chain 0 released
        status: 'Funded',
        milestones: [
          { index: 0, amount: '200', released: false }, // Not released on chain
          { index: 1, amount: '300', released: false },
        ],
        reputationIssued: false,
      });

      await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'P3' }).expect(200);

      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('drift');

      expect(res.body.drift).toContainEqual({
        field: 'fundedAmount',
        api: '200',
        chain: '0',
      });
      expect(res.body.drift).toContainEqual({
        field: 'releasedAmount',
        api: '200',
        chain: '0',
      });
      expect(res.body.drift).toContainEqual({
        field: 'milestones[0].released',
        api: true,
        chain: false,
      });
    });

    it('returns 503 chain_unavailable during parity check when RPC fails', async () => {
      const c = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('P4', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'P4' }).expect(200);

      fakeChain.throwUnavailable = true;
      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('chain_unavailable');
    });
  });

  describe('GET /api/v1/contracts?linked=true|false', () => {
    it('correctly filters contracts by linked on-chain state', async () => {
      const c1 = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const c2 = store.create({ client: account('GA'), freelancer: account('GB'), token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });

      fakeChain.escrows.set('L1', {
        client: account('GA'),
        freelancer: account('GB'),
        token: DEFAULT_TOKEN,
        totalAmount: '100',
        fundedAmount: '0',
        releasedAmount: '0',
        status: 'Created',
        milestones: [{ index: 0, amount: '100', released: false }],
        reputationIssued: false,
      });

      await request(app).post(`/api/v1/contracts/${c1.id}/link`).send({ escrowId: 'L1' }).expect(200);

      const all = await request(app).get('/api/v1/contracts');
      expect(all.body.data.length).toBe(2);

      const linked = await request(app).get('/api/v1/contracts?linked=true');
      expect(linked.body.data.length).toBe(1);
      expect(linked.body.data[0].id).toBe(c1.id);

      const unlinked = await request(app).get('/api/v1/contracts?linked=false');
      expect(unlinked.body.data.length).toBe(1);
      expect(unlinked.body.data[0].id).toBe(c2.id);
    });
  });
});
