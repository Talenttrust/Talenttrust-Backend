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
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).post('/api/cron/index-events');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('returns 401 with wrong secret', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer wrong-secret');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
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
    expect(response.status).toBe(401);
  });
});
