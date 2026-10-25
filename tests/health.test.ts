import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { NETWORK_PASSPHRASES, type HealthRpcClient } from '../src/health';

type Rpc = HealthRpcClient & { calls: Record<string, number> };

function fakeRpc(overrides: Partial<HealthRpcClient> = {}): Rpc {
  const calls = { getHealth: 0, getNetworkPassphrase: 0, hasContractInstance: 0 };
  return {
    calls,
    getHealth: async () => {
      calls.getHealth += 1;
      return 'healthy';
    },
    getNetworkPassphrase: async () => {
      calls.getNetworkPassphrase += 1;
      return NETWORK_PASSPHRASES.testnet;
    },
    hasContractInstance: async () => {
      calls.hasContractInstance += 1;
      return true;
    },
    ...overrides,
  };
}

const appWith = (rpc: HealthRpcClient, health?: { timeoutMs?: number; cacheMs?: number }) =>
  createApp({
    store: new EscrowStore(),
    health: { rpc, ...health },
  });

describe('liveness and readiness probes', () => {
  it('GET /health/live is 200 without touching any dependency', async () => {
    const rpc = fakeRpc({
      getHealth: async () => {
        throw new Error('must not be called');
      },
    });
    const res = await request(appWith(rpc)).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(rpc.calls).toEqual({ getHealth: 0, getNetworkPassphrase: 0, hasContractInstance: 0 });
  });

  it('GET /health/ready is 200 ready when every check passes', async () => {
    const res = await request(appWith(fakeRpc())).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(Object.keys(res.body.checks).sort()).toEqual(['contract', 'network', 'rpc', 'storage']);
    for (const check of Object.values(res.body.checks) as { status: string; latencyMs: number }[]) {
      expect(check.status).toBe('pass');
      expect(check.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(typeof res.body.checkedAt).toBe('string');
  });

  it('GET /health/ready is 503 when the RPC reports unhealthy', async () => {
    const res = await request(appWith(fakeRpc({ getHealth: async () => 'unhealthy' }))).get(
      '/health/ready',
    );

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unready');
    expect(res.body.checks.rpc).toMatchObject({ status: 'fail', detail: "rpc reported 'unhealthy'" });
  });

  it('names both networks when the passphrase does not match', async () => {
    const res = await request(
      appWith(
        fakeRpc({
          getNetworkPassphrase: async () => NETWORK_PASSPHRASES.public,
        }),
      ),
    ).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.checks.network.detail).toBe(
      "passphrase mismatch: configured 'testnet', rpc reported 'Public Global Stellar Network ; September 2015'",
    );
  });

  it('is 503 when the contract ledger entry is missing', async () => {
    const res = await request(
      appWith(fakeRpc({ hasContractInstance: async () => false })),
    ).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.checks.contract).toMatchObject({
      status: 'fail',
      detail: 'contract instance ledger entry not found',
    });
  });

  it('times out a slow RPC check and still answers within the timeout budget', async () => {
    const rpc = fakeRpc({
      getHealth: () => new Promise((resolve) => setTimeout(() => resolve('healthy'), 500)),
    });
    const started = Date.now();
    const res = await request(appWith(rpc, { timeoutMs: 50 })).get('/health/ready');
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    expect(res.body.checks.rpc).toMatchObject({ status: 'fail', detail: 'timeout' });
    expect(res.body.checks.storage.status).toBe('pass');
    expect(elapsed).toBeLessThan(400);
  });

  it('serves concurrent probes from a single flight of RPC calls', async () => {
    const rpc = fakeRpc();
    const app = appWith(rpc, { cacheMs: 60_000 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => request(app).get('/health/ready')),
    );

    for (const res of responses) expect(res.status).toBe(200);
    expect(rpc.calls).toEqual({ getHealth: 1, getNetworkPassphrase: 1, hasContractInstance: 1 });

    await request(app).get('/health/ready');
    expect(rpc.calls.getHealth).toBe(1);
  });

  it('re-runs the checks after the cache expires', async () => {
    const rpc = fakeRpc();
    const app = appWith(rpc, { cacheMs: 20 });

    await request(app).get('/health/ready');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await request(app).get('/health/ready');

    expect(rpc.calls.getHealth).toBe(2);
  });

  it('GET /health keeps every existing field and gains the last checks summary', async () => {
    const app = appWith(fakeRpc());

    const before = await request(app).get('/health');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      status: 'ok',
      storage: 'in-memory',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
    expect(before.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(before.body.checks).toBeUndefined();

    await request(app).get('/health/ready');

    const after = await request(app).get('/health');
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      status: 'ok',
      storage: 'in-memory',
      version: expect.any(String),
      timestamp: expect.any(String),
    });
    expect(Object.keys(after.body.checks).sort()).toEqual(['contract', 'network', 'rpc', 'storage']);
  });

  it('never leaks the RPC URL or raw error text in failure details', async () => {
    const secretUrl = 'https://soroban-testnet.stellar.org/secret-project';
    const rpc = fakeRpc({
      getHealth: async () => {
        throw new Error(`connect ECONNREFUSED ${secretUrl}`);
      },
      hasContractInstance: async () => {
        throw new Error(`getaddrinfo ENOTFOUND ${secretUrl}`);
      },
    });

    const res = await request(appWith(rpc, { timeoutMs: 50 })).get('/health/ready');

    expect(res.status).toBe(503);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('soroban');
    expect(serialized).not.toContain('secret-project');
    expect(res.body.checks.rpc.detail).toBe('check raised');
  });
});
