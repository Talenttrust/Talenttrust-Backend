import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { ChainReadClient, ChainReadError } from '../src/stellar/client';
import { decodeEscrow, decodeReputation } from '../src/stellar/decode';
import { EscrowStore } from '../src/store';
import reputationFixture from './fixtures/get-reputation-testnet.json';

const address = Keypair.random().publicKey();
const contract = {
  id: '9007199254740993', client: address, freelancer: address, token: 'CABC',
  milestones: [{ index: 0, amount: '9007199254740993', released: false }],
  totalAmount: '9007199254740993', fundedAmount: '0', releasedAmount: '0',
  status: 'Funded' as const, reputationIssued: false,
};

const client = (): jest.Mocked<ChainReadClient> => ({
  getContract: jest.fn().mockResolvedValue({ value: contract, latestLedger: 42 }),
  getReputation: jest.fn().mockResolvedValue({ value: { completedContracts: 2, totalRating: 9 }, latestLedger: 42 }),
});

describe('on-chain read-through decoding', () => {
  it.each(['Created', 'Funded', 'Completed', 'Disputed', 'Resolved', 'Cancelled'])('decodes %s status', (status) => {
    expect(decodeEscrow({ ...contract, status: [status] }).status).toBe(status);
  });

  it('keeps large i128 amounts exact', () => {
    expect(decodeEscrow(contract).totalAmount).toBe('9007199254740993');
    expect(decodeReputation({ completed_contracts: 2n, total_rating: 9n })).toEqual({ completedContracts: 2, totalRating: 9 });
    expect(decodeReputation(reputationFixture.native)).toEqual({ completedContracts: 0, totalRating: 0 });
  });

  it('rejects malformed contract data', () => {
    expect(() => decodeEscrow({ ...contract, status: ['Unknown'] })).toThrow('invalid contract status');
  });
});

describe('on-chain read-through routes', () => {
  afterEach(() => {
    delete process.env.CHAIN_READ_TTL_MS;
    jest.useRealTimers();
  });

  it('reads contracts and reputation through the injected client', async () => {
    const rpc = client();
    const app = createApp(new EscrowStore(), rpc);
    const contractResponse = await request(app).get('/api/v1/chain/contracts/9007199254740993').expect(200);
    expect(contractResponse.body.totalAmount).toBe('9007199254740993');
    expect(contractResponse.body.source).toBe('chain');
    const reputationResponse = await request(app).get(`/api/v1/chain/reputation/${address}`).expect(200);
    expect(reputationResponse.body.averageRating).toBe(4.5);
  });

  it.each(['0', '-1', 'abc', '18446744073709551616'])('rejects invalid chain id %s', async (id) => {
    await request(createApp(new EscrowStore(), client())).get(`/api/v1/chain/contracts/${id}`).expect(400);
  });

  it('rejects invalid Stellar addresses', async () => {
    await request(createApp(new EscrowStore(), client())).get('/api/v1/chain/reputation/not-an-address').expect(400);
  });

  it('maps not-found, contract, and transport errors to sanitized responses', async () => {
    const notFound = client();
    notFound.getContract.mockRejectedValue(new ChainReadError('not_found'));
    await request(createApp(new EscrowStore(), notFound)).get('/api/v1/chain/contracts/1').expect(404);

    const contractFailure = client();
    contractFailure.getContract.mockRejectedValue(new ChainReadError('contract', { name: 'ContractError', code: 77 }));
    const bad = await request(createApp(new EscrowStore(), contractFailure)).get('/api/v1/chain/contracts/1').expect(502);
    expect(bad.body).toMatchObject({ error: 'chain_error', message: 'On-chain read failed', contractError: { name: 'ContractError', code: 77 } });

    const unavailable = client();
    unavailable.getContract.mockRejectedValue(new ChainReadError('unavailable'));
    const down = await request(createApp(new EscrowStore(), unavailable)).get('/api/v1/chain/contracts/1').expect(503);
    expect(down.headers['retry-after']).toBe('1');
    expect(JSON.stringify(down.body)).not.toContain('soroban-testnet');
  });

  it('single-flights identical reads and expires them at the configured TTL', async () => {
    process.env.CHAIN_READ_TTL_MS = '20';
    const rpc = client();
    const app = createApp(new EscrowStore(), rpc);
    await Promise.all([
      request(app).get('/api/v1/chain/contracts/1'),
      request(app).get('/api/v1/chain/contracts/1'),
    ]);
    expect(rpc.getContract).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    rpc.getContract.mockResolvedValue({ value: contract, latestLedger: 2 });
    await request(app).get('/api/v1/chain/contracts/1').expect(200);
    expect(rpc.getContract).toHaveBeenCalledTimes(2);
  });

  it('bounds repeated chain reads per client', async () => {
    const rpc = client();
    const app = createApp(new EscrowStore(), rpc);
    for (let index = 0; index < 60; index += 1) {
      await request(app).get(`/api/v1/chain/contracts/${index + 1}`).expect(200);
    }
    const limited = await request(app).get('/api/v1/chain/contracts/61').expect(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body).toEqual(
      expect.objectContaining({ error: 'chain_rate_limited', message: 'Too many chain read requests' }),
    );
    expect(limited.body.requestId).toEqual(expect.any(String));
  });
});
