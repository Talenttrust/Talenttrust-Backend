/**
 * Tests for events API endpoint.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryEventStore } from '../src/indexer/store';
import { EventIndexer } from '../src/indexer/indexer';
import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { EscrowStore } from '../src/store';
import { StoreEventEmitter, type EscrowEvent } from '../src/events';

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

  it('returns 400 invalid_cursor for unknown cursor', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).get('/api/v1/chain/events?cursor=does-not-exist');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_cursor');
  });

  it('returns 400 invalid_cursor for cursor not in filtered set', async () => {
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

    // event-2 is for escrowId 2, not 1
    const resEscrow = await request(app).get('/api/v1/chain/events?escrowId=1&cursor=event-2');
    expect(resEscrow.status).toBe(400);
    expect(resEscrow.body.error).toBe('invalid_cursor');

    // event-1 is Created, not Deposit
    const resType = await request(app).get('/api/v1/chain/events?type=Deposit&cursor=event-1');
    expect(resType.status).toBe(400);
    expect(resType.body.error).toBe('invalid_cursor');
  });

  it('returns 400 invalid_type for unknown event type', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).get('/api/v1/chain/events?type=NonExistentType');
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_type');
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

describe('contract.updated and reputation.updated over HTTP', () => {
  const setup = () => {
    const events = new StoreEventEmitter();
    const seen: EscrowEvent[] = [];
    events.on((event) => seen.push(event));
    const store = new EscrowStore(events);
    return { app: createApp(store), seen };
  };
  const create = async (app: ReturnType<typeof createApp>) =>
    (await request(app).post('/api/v1/contracts').send({ client: 'GCLIENT', freelancer: 'GFREELANCER', milestones: [{ amount: 10 }] }).expect(201)).body;

  it('PATCH emits contract.updated exactly once with the revision', async () => {
    const { app, seen } = setup();
    const contract = await create(app);
    seen.length = 0;
    const res = await request(app).patch(`/api/v1/contracts/${contract.id}`).send({ client: 'GCLIENT', milestones: [{ amount: 20 }] }).expect(200);
    expect(seen.map((event) => event.eventType)).toEqual(['contract.updated']);
    expect(seen[0].data.contract).toMatchObject({ id: contract.id, revision: res.body.revision });
    expect(seen[0].data.revision).toMatchObject({ revision: res.body.revision, changes: [{ field: 'milestones' }] });
  });

  it('extend-deadline emits contract.updated exactly once', async () => {
    const { app, seen } = setup();
    const contract = await create(app);
    seen.length = 0;
    const fundingDeadline = new Date(Date.parse(contract.fundingDeadline) + 86_400_000).toISOString();
    await request(app).post(`/api/v1/contracts/${contract.id}/extend-deadline`).send({ client: 'GCLIENT', fundingDeadline }).expect(200);
    expect(seen.map((event) => event.eventType)).toEqual(['contract.updated']);
    expect(seen[0].data.contract).toMatchObject({ id: contract.id, fundingDeadline });
  });

  it('failed PATCH and extend-deadline requests emit nothing', async () => {
    const { app, seen } = setup();
    const contract = await create(app);
    seen.length = 0;
    await request(app).patch(`/api/v1/contracts/${contract.id}`).send({ client: 'GOTHER', title: 'x' }).expect(403);
    await request(app).patch(`/api/v1/contracts/${contract.id}`).send({ client: 'GCLIENT' }).expect(400);
    await request(app).post(`/api/v1/contracts/${contract.id}/extend-deadline`).send({ client: 'GCLIENT', fundingDeadline: 'soon' }).expect(400);
    expect(seen).toEqual([]);
  });

  it('a freelancer-to-client review emits reputation.updated', async () => {
    const { app, seen } = setup();
    const contract = await create(app);
    await request(app).post(`/api/v1/contracts/${contract.id}/deposit`).send({ amount: 10 }).expect(200);
    await request(app).post(`/api/v1/contracts/${contract.id}/milestones/0/release`).send({}).expect(200);
    seen.length = 0;
    await request(app).post(`/api/v1/contracts/${contract.id}/reviews`).send({ reviewer: 'GFREELANCER', rating: 5 }).expect(201);
    expect(seen.map((event) => event.eventType)).toEqual(['reputation.updated']);
    expect(seen[0].data.reputation).toMatchObject({ address: 'GCLIENT', asClient: { completedContracts: 1, averageRating: 5 } });
    await request(app).post(`/api/v1/contracts/${contract.id}/reviews`).send({ reviewer: 'GFREELANCER', rating: 5 }).expect(409);
    expect(seen).toHaveLength(1);
  });
});
