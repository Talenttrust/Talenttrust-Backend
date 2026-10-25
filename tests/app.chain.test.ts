import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { ChainReader, OnChainStatus } from '../src/stellar/chain-status';

const snapshot = (partial: Partial<OnChainStatus> = {}): OnChainStatus => ({
  reachable: true,
  latestLedger: 5293191,
  version: '1',
  paused: false,
  contractCount: 3,
  admin: 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5',
  fetchedAt: '2026-10-20T10:00:00.000Z',
  stale: false,
  ...partial,
});

const fakeReader = (status: OnChainStatus = snapshot()): ChainReader & { refreshes: boolean[] } => {
  const refreshes: boolean[] = [];
  return {
    refreshes,
    getStatus: jest.fn(async ({ refresh = false }: { refresh?: boolean } = {}) => {
      refreshes.push(refresh);
      return status;
    }),
  };
};

describe('GET /api/v1/chain', () => {
  it('keeps the static deployment info and adds onChain from the injected reader', async () => {
    const reader = fakeReader();
    const app = createApp({ store: new EscrowStore(), chainStatusReader: reader });

    const res = await request(app).get('/api/v1/chain');
    expect(res.status).toBe(200);
    expect(res.body.network).toBeDefined();
    expect(res.body.rpcUrl).toBeDefined();
    expect(res.body.contractId).toBeDefined();
    expect(res.body.explorer).toContain('stellar.expert');
    expect(res.body.onChain).toEqual(snapshot());
  });

  it('passes refresh=true through to the reader', async () => {
    const reader = fakeReader();
    const app = createApp({ store: new EscrowStore(), chainStatusReader: reader });

    await request(app).get('/api/v1/chain?refresh=true');
    expect(reader.refreshes).toEqual([true]);

    await request(app).get('/api/v1/chain');
    expect(reader.refreshes).toEqual([true, false]);

    await request(app).get('/api/v1/chain?refresh=false');
    expect(reader.refreshes).toEqual([true, false, false]);

    await request(app).get('/api/v1/chain?refresh=1');
    expect(reader.refreshes).toEqual([true, false, false, false]);
  });

  it('still returns 200 when the contract is unreachable', async () => {
    const reader = fakeReader(
      snapshot({ reachable: false, stale: false, error: 'rpc request failed', latestLedger: undefined }),
    );
    const app = createApp({ store: new EscrowStore(), chainStatusReader: reader });

    const res = await request(app).get('/api/v1/chain');
    expect(res.status).toBe(200);
    expect(res.body.onChain.reachable).toBe(false);
    expect(res.body.onChain.error).toBe('rpc request failed');
  });

  it('serves stale snapshots with stale=true when the reader reports them', async () => {
    const reader = fakeReader(snapshot({ stale: true, error: 'simulate version timed out after 4000ms' }));
    const app = createApp({ store: new EscrowStore(), chainStatusReader: reader });

    const res = await request(app).get('/api/v1/chain');
    expect(res.status).toBe(200);
    expect(res.body.onChain.stale).toBe(true);
    expect(res.body.onChain.version).toBe('1');
    expect(res.body.onChain.error).toContain('timed out');
  });
});
