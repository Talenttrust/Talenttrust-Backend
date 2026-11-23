/**
 * Tests for cron endpoint.
 */

import request from 'supertest';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { createApp } from '../src/app';
import { InMemoryEventStore } from '../src/indexer/store';
import { EventIndexer } from '../src/indexer/indexer';

describe('Cron endpoint', () => {
  it('returns 401 without authorization header', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).post('/api/cron/index-events');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('cron_unauthorized');
    delete process.env.CRON_SECRET;
  });

  it('returns 401 with wrong secret', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer wrong-secret');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('cron_unauthorized');
    delete process.env.CRON_SECRET;
  });

  it('returns 200 with correct secret', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    // Fake RPC: tests never reach the network.
    (indexer as any).rpc = { getEvents: async () => ({ events: [], cursor: 'cursor-0', latestLedger: 100 }) };
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('processed');
    expect(response.body).toHaveProperty('pages');
    expect(response.body).toHaveProperty('cursor');
    expect(response.body).toHaveProperty('latestLedger');
    expect(response.body.pages).toBe(1);
    expect(response.body.processed).toBe(0);
    delete process.env.CRON_SECRET;
  });

  it('drains multiple pages through cron endpoint and includes pages in response', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);

    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(100n, { type: 'u128' });

    const allEvents: Array<any> = [];
    for (let i = 0; i < 250; i++) {
      allEvents.push({
        id: `event-${i}`,
        ledger: 100 + i,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: `hash-${i}`,
        topic: [symbol.toXDR('base64'), u64.toXDR('base64'), address.toXDR('base64'), address.toXDR('base64')],
        value: amount.toXDR('base64'),
      });
    }

    (indexer as any).rpc = {
      getEvents: async (opts: any) => {
        const limit = opts.limit || 100;
        const start = opts.cursor ? parseInt(opts.cursor.split('-')[1]) : 0;
        const page = allEvents.slice(start, start + limit);
        return {
          events: page,
          cursor: page.length > 0 ? `cursor-${start + page.length}` : (opts.cursor ?? 'cursor-0'),
          latestLedger: 100,
        };
      },
    };

    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .get('/api/cron/index-events')
      .set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(200);
    expect(response.body.pages).toBe(3);
    expect(response.body.processed).toBe(250);
    expect(response.body.cursor).toBe('cursor-250');
    expect(response.body.latestLedger).toBe(100);
    expect(eventStore.getEventsStored()).toBe(250);
    delete process.env.CRON_SECRET;
  });

  it('returns 409 when indexer is busy', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    (indexer as any).isRunning = true;
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('indexer_busy');
    delete process.env.CRON_SECRET;
  });

  it('fails closed when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer any-token');
    expect(response.status).toBe(404);
    expect(response.body.error).toBe('not_found');

    const getRes = await request(app)
      .get('/api/cron/index-events')
      .set('Authorization', 'Bearer any-token');
    expect(getRes.status).toBe(404);
    expect(getRes.body.error).toBe('not_found');
  });
});

describe('Parity reconciliation cron endpoint', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalMetricsToken = process.env.METRICS_TOKEN;
  const originalBudget = process.env.PARITY_RECONCILE_TIME_BUDGET_MS;
  const DEFAULT_TOKEN = 'CDEMOTOKENAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

  type OnChainEscrow = {
    client: string;
    freelancer: string;
    token: string;
    totalAmount: string;
    fundedAmount: string;
    releasedAmount: string;
    status: 'Created' | 'Funded' | 'Completed' | 'Disputed' | 'Cancelled';
    milestones: Array<{ index: number; amount: string; released: boolean }>;
    reputationIssued: boolean;
  };

  class ReconcileFakeChainReader {
    public escrows = new Map<string, OnChainEscrow>();
    public latestLedger = 42000;
    public throwFor = new Set<string>();
    public delays = new Map<string, number>();
    public active = 0;
    public maxActive = 0;

    async getContract(escrowId: string): Promise<{ contract: OnChainEscrow; latestLedger: number } | null> {
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        const delay = this.delays.get(escrowId) ?? 0;
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
        if (this.throwFor.has(escrowId)) {
          throw new Error(`Simulated chain read failure for ${escrowId}`);
        }
        const contract = this.escrows.get(escrowId);
        if (!contract) return null;
        return {
          contract: JSON.parse(JSON.stringify(contract)),
          latestLedger: this.latestLedger,
        };
      } finally {
        this.active -= 1;
      }
    }
  }

  function metricValue(body: string, name: string, labels: Record<string, string> = {}): number | undefined {
    const pairs = Object.entries(labels);
    for (const line of body.split('\n')) {
      if (!line.startsWith(name)) continue;
      if (pairs.length === 0) {
        // unlabeled gauge/counter: name <value>
        const m = line.match(new RegExp(`^${name}\\s+([-+eE0-9.]+)$`));
        if (m) return parseFloat(m[1]);
      }
      if (pairs.every(([k, v]) => line.includes(`${k}="${v}"`))) {
        return parseFloat(line.trim().split(/\s+/).pop()!);
      }
    }
    return undefined;
  }

  async function createLinkedContract(
    app: any,
    store: any,
    chain: ReconcileFakeChainReader,
    escrowId: string,
    overrides: Partial<OnChainEscrow> = {},
  ) {
    const created = store.create({
      client: overrides.client ?? 'GCLIENT',
      freelancer: overrides.freelancer ?? 'GFREELANCER',
      token: overrides.token ?? DEFAULT_TOKEN,
      milestones: (overrides.milestones ?? [{ index: 0, amount: '100', released: false }]).map((m: any) => ({ amount: Number(m.amount) })),
    });
    chain.escrows.set(escrowId, {
      client: overrides.client ?? 'GCLIENT',
      freelancer: overrides.freelancer ?? 'GFREELANCER',
      token: overrides.token ?? DEFAULT_TOKEN,
      totalAmount: overrides.totalAmount ?? '100',
      fundedAmount: overrides.fundedAmount ?? '0',
      releasedAmount: overrides.releasedAmount ?? '0',
      status: overrides.status ?? 'Created',
      milestones: overrides.milestones ?? [{ index: 0, amount: '100', released: false }],
      reputationIssued: overrides.reputationIssued ?? false,
    });
    const res = await request(app).post(`/api/v1/contracts/${created.id}/link`).send({ escrowId });
    expect(res.status).toBe(200);
    return created.id as number;
  }

  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.METRICS_TOKEN;
    delete process.env.PARITY_RECONCILE_TIME_BUDGET_MS;
  });

  afterEach(() => {
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalCronSecret;
    if (originalMetricsToken === undefined) delete process.env.METRICS_TOKEN;
    else process.env.METRICS_TOKEN = originalMetricsToken;
    if (originalBudget === undefined) delete process.env.PARITY_RECONCILE_TIME_BUDGET_MS;
    else process.env.PARITY_RECONCILE_TIME_BUDGET_MS = originalBudget;
  });

  it('returns 404 when CRON_SECRET is unset (same as requireCronSecret)', async () => {
    const chain = new ReconcileFakeChainReader();
    const store = new (require('../src/store').EscrowStore)();
    const app = createApp(store, chain as any);
    const res = await request(app).post('/api/cron/reconcile-parity');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('returns 401 without authorization header', async () => {
    process.env.CRON_SECRET = 'reconcile-secret';
    const chain = new ReconcileFakeChainReader();
    const store = new (require('../src/store').EscrowStore)();
    const app = createApp(store, chain as any);
    const res = await request(app).post('/api/cron/reconcile-parity');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('cron_unauthorized');
  });

  it('returns 401 with wrong secret', async () => {
    process.env.CRON_SECRET = 'reconcile-secret';
    const chain = new ReconcileFakeChainReader();
    const store = new (require('../src/store').EscrowStore)();
    const app = createApp(store, chain as any);
    const res = await request(app)
      .post('/api/cron/reconcile-parity')
      .set('Authorization', 'Bearer wrong-secret');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('cron_unauthorized');
  });

  it('reports in-sync and drifted contracts with injected chain reader, emits drift event, and updates metrics', async () => {
    process.env.CRON_SECRET = 'reconcile-secret';
    process.env.METRICS_TOKEN = 'metrics-secret';
    const chain = new ReconcileFakeChainReader();
    const { EscrowStore } = require('../src/store');
    const store = new EscrowStore();
    const app = createApp(store, chain as any);

    const inSyncId = await createLinkedContract(app, store, chain, 'E_IN_SYNC');
    const driftId = await createLinkedContract(app, store, chain, 'E_DRIFT', {
      totalAmount: '100',
      fundedAmount: '0',
      releasedAmount: '0',
      status: 'Created',
      milestones: [{ index: 0, amount: '100', released: false }],
    });

    // Introduce drift on-chain for one contract.
    chain.escrows.set('E_DRIFT', {
      client: 'GCLIENT',
      freelancer: 'GFREELANCER',
      token: DEFAULT_TOKEN,
      totalAmount: '100',
      fundedAmount: '100',
      releasedAmount: '0',
      status: 'Funded',
      milestones: [{ index: 0, amount: '100', released: false }],
      reputationIssued: false,
    });

    const driftEvents: any[] = [];
    store.events.on((evt: any) => {
      if (evt.eventType === 'contract.drift_detected') driftEvents.push(evt);
    });

    const res = await request(app)
      .get('/api/cron/reconcile-parity')
      .set('Authorization', 'Bearer reconcile-secret');

    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(2);
    expect(res.body.inSync).toBe(1);
    expect(res.body.drifted).toBe(1);
    expect(res.body.unreachable).toBe(0);
    expect(res.body.timedOut).toBe(false);
    expect(res.body.driftedContractIds).toEqual([driftId]);
    expect(driftEvents.length).toBe(1);
    expect(driftEvents[0].data.contractId).toBe(driftId);
    expect(driftEvents[0].data.escrowId).toBe('E_DRIFT');

    const metrics = await request(app).get('/metrics').set('authorization', 'Bearer metrics-secret');
    expect(metrics.status).toBe(200);
    expect(metricValue(metrics.text, 'escrow_parity_drift_contracts')).toBe(1);
    const lastRun = metricValue(metrics.text, 'escrow_parity_last_run_timestamp_seconds');
    expect(typeof lastRun).toBe('number');
    expect(lastRun!).toBeGreaterThan(0);

    // inSync contract should remain linked and in sync.
    expect(store.get(inSyncId).chain?.status).toBe('in_sync');
    expect(store.get(driftId).chain?.status).toBe('drift');
  });

  it('does not abort the run when one contract chain read is unreachable', async () => {
    process.env.CRON_SECRET = 'reconcile-secret';
    const chain = new ReconcileFakeChainReader();
    const { EscrowStore } = require('../src/store');
    const store = new EscrowStore();
    const app = createApp(store, chain as any);

    const okId = await createLinkedContract(app, store, chain, 'E_OK');
    const badId = await createLinkedContract(app, store, chain, 'E_BAD');
    const driftId = await createLinkedContract(app, store, chain, 'E_DRIFT2', {
      fundedAmount: '0',
      status: 'Created',
    });
    chain.escrows.set('E_DRIFT2', {
      client: 'GCLIENT',
      freelancer: 'GFREELANCER',
      token: DEFAULT_TOKEN,
      totalAmount: '100',
      fundedAmount: '100',
      releasedAmount: '0',
      status: 'Funded',
      milestones: [{ index: 0, amount: '100', released: false }],
      reputationIssued: false,
    });
    chain.throwFor.add('E_BAD');

    const res = await request(app)
      .post('/api/cron/reconcile-parity')
      .set('Authorization', 'Bearer reconcile-secret');

    expect(res.status).toBe(200);
    expect(res.body.checked).toBe(3);
    expect(res.body.inSync).toBe(1);
    expect(res.body.drifted).toBe(1);
    expect(res.body.unreachable).toBe(1);
    expect(res.body.driftedContractIds).toEqual([driftId]);
    expect(res.body.timedOut).toBe(false);
    // Unreachable contract should not prevent others from being reported.
    expect(store.get(okId).chain?.status).toBe('in_sync');
    expect(store.get(badId).id).toBe(badId);
  });

  it('enforces concurrency bound (5) and time budget', async () => {
    process.env.CRON_SECRET = 'reconcile-secret';
    // Concurrency: 7 linked contracts with delays, max concurrent reads must be <= 5.
    const chain = new ReconcileFakeChainReader();
    const { EscrowStore } = require('../src/store');
    const store = new EscrowStore();
    const app = createApp(store, chain as any);
    for (let i = 1; i <= 7; i++) {
      const escrowId = `E_C${i}`;
      await createLinkedContract(app, store, chain, escrowId);
      chain.delays.set(escrowId, 40);
    }
    const concRes = await request(app)
      .post('/api/cron/reconcile-parity')
      .set('Authorization', 'Bearer reconcile-secret');
    expect(concRes.status).toBe(200);
    expect(concRes.body.checked).toBe(7);
    expect(chain.maxActive).toBeLessThanOrEqual(5);
    expect(chain.maxActive).toBeGreaterThan(1);

    // Time budget: force a very short budget so run cannot complete all checks.
    process.env.PARITY_RECONCILE_TIME_BUDGET_MS = '10';
    const chain2 = new ReconcileFakeChainReader();
    const store2 = new EscrowStore();
    const app2 = createApp(store2, chain2 as any);
    for (let i = 1; i <= 6; i++) {
      const escrowId = `E_T${i}`;
      await createLinkedContract(app2, store2, chain2, escrowId);
      chain2.delays.set(escrowId, 60);
    }
    const budgetRes = await request(app2)
      .post('/api/cron/reconcile-parity')
      .set('Authorization', 'Bearer reconcile-secret');
    expect(budgetRes.status).toBe(200);
    expect(budgetRes.body.checked).toBeLessThan(6);
    expect(budgetRes.body.timedOut).toBe(true);
  });
});
