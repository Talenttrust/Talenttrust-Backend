/**
 * Tests for events API endpoint.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryEventStore } from '../src/indexer/store';
import { EventIndexer } from '../src/indexer/indexer';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

describe('Events API', () => {
  it('returns events with pagination', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(100n, { type: 'u128' });

    for (let i = 0; i < 10; i++) {
      eventStore.append([
        {
          id: `event-${i}`,
          ledger: 100 + i,
          ledgerClosedAt: '2024-01-01T00:00:00Z',
          txHash: `hash-${i}`,
          event: {
            type: 'Created',
            data: {
              escrowId: '1',
              client: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              freelancer: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              total: '100',
            },
          },
        },
      ]);
    }

    const response = await request(app).get('/api/v1/chain/events?limit=5');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(5);
    expect(response.body.nextCursor).toBeDefined();
  });

  it('filters by escrowId', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    eventStore.append([
      {
        id: 'event-1',
        ledger: 100,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'hash-1',
        event: {
          type: 'Created',
          data: {
            escrowId: '1',
            client: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            freelancer: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            total: '100',
          },
        },
      },
      {
        id: 'event-2',
        ledger: 101,
        ledgerClosedAt: '2024-01-01T00:01:00Z',
        txHash: 'hash-2',
        event: {
          type: 'Created',
          data: {
            escrowId: '2',
            client: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            freelancer: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            total: '200',
          },
        },
      },
    ]);

    const response = await request(app).get('/api/v1/chain/events?escrowId=1');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].event.data.escrowId).toBe('1');
  });

  it('filters by type', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    eventStore.append([
      {
        id: 'event-1',
        ledger: 100,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'hash-1',
        event: {
          type: 'Created',
          data: {
            escrowId: '1',
            client: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            freelancer: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            total: '100',
          },
        },
      },
      {
        id: 'event-2',
        ledger: 101,
        ledgerClosedAt: '2024-01-01T00:01:00Z',
        txHash: 'hash-2',
        event: {
          type: 'Deposit',
          data: {
            escrowId: '1',
            amount: '50',
          },
        },
      },
    ]);

    const response = await request(app).get('/api/v1/chain/events?type=Deposit');
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].event.type).toBe('Deposit');
  });

  it('paginates with cursor', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    for (let i = 0; i < 10; i++) {
      eventStore.append([
        {
          id: `event-${i}`,
          ledger: 100 + i,
          ledgerClosedAt: '2024-01-01T00:00:00Z',
          txHash: `hash-${i}`,
          event: {
            type: 'Created',
            data: {
              escrowId: '1',
              client: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              freelancer: 'GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
              total: '100',
            },
          },
        },
      ]);
    }

    const page1 = await request(app).get('/api/v1/chain/events?limit=5');
    expect(page1.body.data).toHaveLength(5);
    const cursor = page1.body.nextCursor;

    const page2 = await request(app).get(`/api/v1/chain/events?limit=5&cursor=${cursor}`);
    expect(page2.body.data).toHaveLength(5);
    expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
  });

  it('returns indexer status', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).get('/api/v1/chain/indexer');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('cursor');
    expect(response.body).toHaveProperty('lastRunAt');
    expect(response.body).toHaveProperty('lastError');
    expect(response.body).toHaveProperty('eventsStored');
    expect(response.body).toHaveProperty('lagLedgers');
  });
});
