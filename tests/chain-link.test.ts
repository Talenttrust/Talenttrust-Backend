import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import {
  ChainReader,
  ChainReaderResult,
  ChainUnavailableError,
  DEMO_ESCROW_3,
  isDemoChainFixtureEnabled,
  OnChainEscrow,
  SorobanRpcChainReader,
} from '../src/chain';
import { RpcTransport } from '../src/stellar/rpc';

const DEFAULT_TOKEN = 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
        client: 'GCLIENT11111111111111111111111111111111111111111111111111',
        freelancer: 'GFREELANCER111111111111111111111111111111111111111111111',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 500 }, { amount: 1000 }],
      });

      fakeChain.escrows.set('101', {
        client: 'GCLIENT11111111111111111111111111111111111111111111111111',
        freelancer: 'GFREELANCER111111111111111111111111111111111111111111111',
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
        client: 'GCLIENT',
        freelancer: 'GFREELANCER',
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
        client: 'GCLIENT',
        freelancer: 'GFREELANCER',
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
        client: 'GA',
        freelancer: 'GB',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }],
      });
      fakeChain.escrows.set('1', {
        client: 'GA',
        freelancer: 'GB',
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
      const c1 = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const c2 = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });

      fakeChain.escrows.set('SHARED_ESCROW', {
        client: 'GA',
        freelancer: 'GB',
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
      const c = store.create({ client: 'API_CLIENT', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('E1', {
        client: 'CHAIN_CLIENT',
        freelancer: 'GB',
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
        api: 'API_CLIENT',
        chain: 'CHAIN_CLIENT',
      });
      expect(store.get(c.id).chain).toBeUndefined();
    });

    it('returns 409 chain_mismatch for freelancer mismatch', async () => {
      const c = store.create({ client: 'GA', freelancer: 'API_FREELANCER', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('E2', {
        client: 'GA',
        freelancer: 'CHAIN_FREELANCER',
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
        api: 'API_FREELANCER',
        chain: 'CHAIN_FREELANCER',
      });
    });

    it('returns 409 chain_mismatch for token mismatch', async () => {
      const c = store.create({
        client: 'GA',
        freelancer: 'GB',
        token: 'TOKEN_A',
        milestones: [{ amount: 100 }],
      });
      fakeChain.escrows.set('E3', {
        client: 'GA',
        freelancer: 'GB',
        token: 'TOKEN_B',
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
        api: 'TOKEN_A',
        chain: 'TOKEN_B',
      });
    });

    it('returns 409 chain_mismatch for milestone count mismatch', async () => {
      const c = store.create({
        client: 'GA',
        freelancer: 'GB',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }, { amount: 200 }],
      });
      fakeChain.escrows.set('E4', {
        client: 'GA',
        freelancer: 'GB',
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
        client: 'GA',
        freelancer: 'GB',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 100 }, { amount: 200 }],
      });
      fakeChain.escrows.set('E5', {
        client: 'GA',
        freelancer: 'GB',
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
        client: 'GA',
        freelancer: 'GB',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: hugeApiAmount }],
      });

      fakeChain.escrows.set('HUGE_DIFF', {
        client: 'GA',
        freelancer: 'GB',
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
        client: 'GA',
        freelancer: 'GB',
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
      const c = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.throwUnavailable = true;

      const res = await request(app).post(`/api/v1/contracts/${c.id}/link`).send({ escrowId: 'ANY' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('chain_unavailable');
      expect(store.get(c.id).chain).toBeUndefined();
    });
  });

  describe('GET /api/v1/contracts/:id/parity', () => {
    it('returns 409 not_linked when checking parity on unlinked contract', async () => {
      const c = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const res = await request(app).get(`/api/v1/contracts/${c.id}/parity`);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('not_linked');
    });

    it('returns in_sync when API and on-chain state perfectly match', async () => {
      const c = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 500 }] });
      store.deposit(c.id, 500);

      fakeChain.escrows.set('P1', {
        client: 'GA',
        freelancer: 'GB',
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
      const c = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 500 }] });
      store.deposit(c.id, 500); // status is now 'Funded' in API

      fakeChain.escrows.set('P2', {
        client: 'GA',
        freelancer: 'GB',
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
        client: 'GA',
        freelancer: 'GB',
        token: DEFAULT_TOKEN,
        milestones: [{ amount: 200 }, { amount: 300 }],
      });
      store.deposit(c.id, 200); // API fundedAmount is 200
      store.release(c.id, 0); // API milestone 0 is released

      fakeChain.escrows.set('P3', {
        client: 'GA',
        freelancer: 'GB',
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
      const c = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      fakeChain.escrows.set('P4', {
        client: 'GA',
        freelancer: 'GB',
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
      const c1 = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });
      const c2 = store.create({ client: 'GA', freelancer: 'GB', token: DEFAULT_TOKEN, milestones: [{ amount: 100 }] });

      fakeChain.escrows.set('L1', {
        client: 'GA',
        freelancer: 'GB',
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

describe('SorobanRpcChainReader demo fixture gating', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_DEMO_CHAIN_FIXTURE;

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    if (originalFlag === undefined) {
      delete process.env.ENABLE_DEMO_CHAIN_FIXTURE;
    } else {
      process.env.ENABLE_DEMO_CHAIN_FIXTURE = originalFlag;
    }
    jest.restoreAllMocks();
  });

  it('defaults fixture to false in production and true in development/test, with explicit flag override', () => {
    expect(isDemoChainFixtureEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(isDemoChainFixtureEnabled({ NODE_ENV: 'production', ENABLE_DEMO_CHAIN_FIXTURE: 'true' })).toBe(true);
    expect(isDemoChainFixtureEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(isDemoChainFixtureEnabled({ NODE_ENV: 'test' })).toBe(true);
    expect(isDemoChainFixtureEnabled({ NODE_ENV: 'test', ENABLE_DEMO_CHAIN_FIXTURE: 'false' })).toBe(false);
    expect(isDemoChainFixtureEnabled({})).toBe(false);
  });

  it('returns DEMO_ESCROW_3 in test mode without performing any outbound fetch', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ENABLE_DEMO_CHAIN_FIXTURE;

    const fetchSpy = jest.spyOn(global, 'fetch');
    const reader = new SorobanRpcChainReader();

    const result = await reader.getContract('3');
    expect(result).not.toBeNull();
    expect(result?.contract).toEqual(DEMO_ESCROW_3);
    expect(result?.latestLedger).toBe(1000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses the shared RPC transport getLatestLedger for the demo fixture when provided', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_DEMO_CHAIN_FIXTURE = 'true';

    const transport: RpcTransport = {
      getLatestLedger: jest.fn().mockResolvedValue({ sequence: 987654 }),
      simulateTransaction: jest.fn(),
    };
    const fetchSpy = jest.spyOn(global, 'fetch');
    const reader = new SorobanRpcChainReader(
      'https://soroban-testnet.stellar.org',
      'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
      undefined,
      transport,
    );

    const result = await reader.getContract('3');
    expect(result?.contract).toEqual(DEMO_ESCROW_3);
    expect(result?.latestLedger).toBe(987654);
    expect(transport.getLatestLedger).toHaveBeenCalledTimes(1);
    expect(transport.simulateTransaction).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads escrow id 3 from the chain in production mode when flag is unset', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ENABLE_DEMO_CHAIN_FIXTURE;

    const transport: RpcTransport = {
      getLatestLedger: jest.fn(),
      simulateTransaction: jest.fn().mockResolvedValue({
        id: '1',
        latestLedger: 555555,
        error: 'Error(Contract, #5)',
      }),
    };
    const reader = new SorobanRpcChainReader(
      'https://soroban-testnet.stellar.org',
      'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
      undefined,
      transport,
    );

    const result = await reader.getContract('3');
    expect(result).toBeNull();
    expect(transport.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(transport.getLatestLedger).not.toHaveBeenCalled();
  });

  it('reads escrow id 3 from the chain when ENABLE_DEMO_CHAIN_FIXTURE=false in test mode', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ENABLE_DEMO_CHAIN_FIXTURE = 'false';

    const transport: RpcTransport = {
      getLatestLedger: jest.fn(),
      simulateTransaction: jest.fn().mockResolvedValue({
        id: '1',
        latestLedger: 555555,
        error: 'Error(Contract, #5)',
      }),
    };
    const reader = new SorobanRpcChainReader(
      'https://soroban-testnet.stellar.org',
      'CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W',
      undefined,
      transport,
    );

    const result = await reader.getContract('3');
    expect(result).toBeNull();
    expect(transport.simulateTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('EscrowStore.reconcileParity', () => {
  it('reports in-sync and drifted linked contracts and continues when one chain read fails', async () => {
    const store = new EscrowStore();
    const fakeChain = new FakeChainReader();
    const token = DEFAULT_TOKEN;

    const inSync = store.create({ client: 'GA', freelancer: 'GB', token, milestones: [{ amount: 100 }] });
    const drifted = store.create({ client: 'GA', freelancer: 'GB', token, milestones: [{ amount: 100 }] });
    const unreachable = store.create({ client: 'GA', freelancer: 'GB', token, milestones: [{ amount: 100 }] });

    fakeChain.escrows.set('R1', {
      client: 'GA', freelancer: 'GB', token,
      totalAmount: '100', fundedAmount: '0', releasedAmount: '0', status: 'Created',
      milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
    });
    fakeChain.escrows.set('R2', {
      client: 'GA', freelancer: 'GB', token,
      totalAmount: '100', fundedAmount: '0', releasedAmount: '0', status: 'Created',
      milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
    });
    fakeChain.escrows.set('R3', {
      client: 'GA', freelancer: 'GB', token,
      totalAmount: '100', fundedAmount: '0', releasedAmount: '0', status: 'Created',
      milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
    });

    await store.linkToChain(inSync.id, 'R1', fakeChain);
    await store.linkToChain(drifted.id, 'R2', fakeChain);
    await store.linkToChain(unreachable.id, 'R3', fakeChain);

    // introduce drift and make one contract unreachable during reconciliation
    fakeChain.escrows.set('R2', {
      client: 'GA', freelancer: 'GB', token,
      totalAmount: '100', fundedAmount: '100', releasedAmount: '0', status: 'Funded',
      milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
    });
    const originalGet = fakeChain.getContract.bind(fakeChain);
    fakeChain.getContract = async (escrowId: string) => {
      if (escrowId === 'R3') throw new Error('simulated rpc failure');
      return originalGet(escrowId);
    };

    const driftEvents: any[] = [];
    store.events.on((evt: any) => {
      if (evt.eventType === 'contract.drift_detected') driftEvents.push(evt);
    });

    const result = await store.reconcileParity(fakeChain, { concurrency: 5, timeBudgetMs: 1000 });
    expect(result.checked).toBe(3);
    expect(result.inSync).toBe(1);
    expect(result.drifted).toBe(1);
    expect(result.unreachable).toBe(1);
    expect(result.driftedContractIds).toEqual([drifted.id]);
    expect(result.timedOut).toBe(false);
    expect(driftEvents).toHaveLength(1);
    expect(driftEvents[0].data.contractId).toBe(drifted.id);
  });

  it('enforces concurrency and time budget options', async () => {
    const store = new EscrowStore();
    const token = DEFAULT_TOKEN;
    class SlowReader implements ChainReader {
      active = 0;
      maxActive = 0;
      async getContract(escrowId: string): Promise<ChainReaderResult | null> {
        this.active++;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((r) => setTimeout(r, escrowId.startsWith('B') ? 80 : 30));
        this.active--;
        const c = store.list({ linked: true }).find((x) => x.chain?.escrowId === escrowId)?.chain;
        return {
          contract: {
            client: 'GA', freelancer: 'GB', token,
            totalAmount: '100', fundedAmount: '0', releasedAmount: '0', status: 'Created',
            milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
          },
          latestLedger: 1,
        };
      }
    }
    const reader = new SlowReader() as any;
    // seed 6 linked contracts
    for (let i = 1; i <= 6; i++) {
      const c = store.create({ client: 'GA', freelancer: 'GB', token, milestones: [{ amount: 100 }] });
      (store as any).contracts.get(c.id).chain = {
        escrowId: C, linkedAt: new Date().toISOString(), status: 'in_sync', drift: [], lastVerifiedAt: new Date().toISOString(),
      };
    }
    const conc = await store.reconcileParity(reader, { concurrency: 5, timeBudgetMs: 2000 });
    expect(conc.checked).toBe(6);
    expect(reader.maxActive).toBeLessThanOrEqual(5);

    // time budget: slow reader and tiny budget
    const store2 = new EscrowStore();
    class VerySlowReader implements ChainReader {
      async getContract(): Promise<ChainReaderResult | null> {
        await new Promise((r) => setTimeout(r, 100));
        return {
          contract: {
            client: 'GA', freelancer: 'GB', token,
            totalAmount: '100', fundedAmount: '0', releasedAmount: '0', status: 'Created',
            milestones: [{ index: 0, amount: '100', released: false }], reputationIssued: false,
          },
          latestLedger: 1,
        };
      }
    }
    for (let i = 1; i <= 5; i++) {
      const c = store2.create({ client: 'GA', freelancer: 'GB', token, milestones: [{ amount: 100 }] });
      (store2 as any).contracts.get(c.id).chain = {
        escrowId: B, linkedAt: new Date().toISOString(), status: 'in_sync', drift: [], lastVerifiedAt: new Date().toISOString(),
      };
    }
    const timed = await store2.reconcileParity(new VerySlowReader() as any, { concurrency: 5, timeBudgetMs: 10 });
    expect(timed.checked).toBeLessThan(5);
    expect(timed.timedOut).toBe(true);
  });
});
