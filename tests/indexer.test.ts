/**
 * Tests for event indexer with fake RPC.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { EventIndexer } from '../src/indexer/indexer';
import { InMemoryEventStore } from '../src/indexer/store';
import { IndexedEvent, escrowIdOf } from '../src/indexer/types';

class FakeServer {
  private events: Array<{
    id: string;
    ledger: number;
    ledgerClosedAt: string;
    txHash: string;
    topic: string[];
    value: string;
  }> = [];
  private cursor: string = 'cursor-0';
  private latestLedger: number = 100;

  addEvent(event: {
    id: string;
    ledger: number;
    ledgerClosedAt: string;
    txHash: string;
    topic: xdr.ScVal[];
    value: xdr.ScVal;
  }) {
    this.events.push({
      ...event,
      topic: event.topic.map((t) => t.toXDR('base64')),
      value: event.value.toXDR('base64'),
    });
  }

  async getEvents(_options: any) {
    const limit = _options.limit || 100;
    const start = _options.cursor ? parseInt(_options.cursor.split('-')[1]) : 0;
    const page = this.events.slice(start, start + limit);

    return {
      events: page,
      cursor: page.length > 0 ? `cursor-${start + page.length}` : (_options.cursor ?? this.cursor),
      latestLedger: this.latestLedger,
    };
  }

  async getLatestLedger() {
    return { sequence: this.latestLedger };
  }

  setLatestLedger(ledger: number) {
    this.latestLedger = ledger;
  }
}

function populateEvents(server: FakeServer, count: number) {
  const symbol = xdr.ScVal.scvSymbol('created');
  const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
  const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const amount = nativeToScVal(100n, { type: 'u128' });

  for (let i = 0; i < count; i++) {
    server.addEvent({
      id: `event-${i}`,
      ledger: 100 + i,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: `hash-${i}`,
      topic: [symbol, u64, address, address],
      value: amount,
    });
  }
}

describe('EventIndexer', () => {
  it('drains a backlog of 250 events across 3 pages in one run', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 250);

    const result = await indexer.runOnce({ limit: 100 });
    expect(result.processed).toBe(250);
    expect(result.pages).toBe(3);
    expect(result.cursor).toBe('cursor-250');
    expect(result.latestLedger).toBe(100);
    expect(store.getEventsStored()).toBe(250);
    expect(store.getCursor()).toBe('cursor-250');
  });

  it('stops when maxPages is reached', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 250);

    const result1 = await indexer.runOnce({ limit: 50, maxPages: 2 });
    expect(result1.pages).toBe(2);
    expect(result1.processed).toBe(100);
    expect(store.getEventsStored()).toBe(100);
    expect(store.getCursor()).toBe('cursor-100');

    const result2 = await indexer.runOnce({ limit: 50, maxPages: 2 });
    expect(result2.pages).toBe(2);
    expect(result2.processed).toBe(100);
    expect(store.getEventsStored()).toBe(200);
    expect(store.getCursor()).toBe('cursor-200');
  });

  it('stops when time budget is exceeded', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 250);

    const originalGetEvents = fakeServer.getEvents.bind(fakeServer);
    fakeServer.getEvents = async (opts: any) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return originalGetEvents(opts);
    };

    const result = await indexer.runOnce({ limit: 50, timeBudgetMs: 30 });
    expect(result.pages).toBe(1);
    expect(result.processed).toBe(50);
    expect(store.getEventsStored()).toBe(50);
    expect(store.getCursor()).toBe('cursor-50');
  });

  it('stops when time budget from INDEXER_MAX_RUN_MS environment variable is exceeded', async () => {
    process.env.INDEXER_MAX_RUN_MS = '30';
    try {
      const store = new InMemoryEventStore();
      const fakeServer = new FakeServer() as any;
      const indexer = new EventIndexer(store, undefined);
      (indexer as any).rpc = fakeServer;

      populateEvents(fakeServer, 250);

      const originalGetEvents = fakeServer.getEvents.bind(fakeServer);
      fakeServer.getEvents = async (opts: any) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return originalGetEvents(opts);
      };

      const result = await indexer.runOnce({ limit: 50 });
      expect(result.pages).toBe(1);
      expect(result.processed).toBe(50);
      expect(store.getEventsStored()).toBe(50);
      expect(store.getCursor()).toBe('cursor-50');
    } finally {
      delete process.env.INDEXER_MAX_RUN_MS;
    }
  });

  it('persists cursor after each page so a failure keeps progress', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 150);

    let calls = 0;
    const originalGetEvents = fakeServer.getEvents.bind(fakeServer);
    fakeServer.getEvents = async (opts: any) => {
      calls++;
      if (calls === 2) {
        throw new Error('RPC transient drop');
      }
      return originalGetEvents(opts);
    };

    await expect(indexer.runOnce({ limit: 50 })).rejects.toThrow('RPC transient drop');
    expect(store.getCursor()).toBe('cursor-50');
    expect(store.getEventsStored()).toBe(50);
    expect(indexer.getState().lastError).toBe('RPC transient drop');

    // Resuming completes the remaining 100 events across 2 pages
    const resume = await indexer.runOnce({ limit: 50 });
    expect(resume.pages).toBe(2);
    expect(resume.processed).toBe(100);
    expect(store.getEventsStored()).toBe(150);
    expect(store.getCursor()).toBe('cursor-150');
  });

  it('drains across 3 pages in a single run', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 15);

    const result = await indexer.runOnce({ limit: 5 });
    expect(result.processed).toBe(15);
    expect(result.pages).toBe(3);
    expect(store.getEventsStored()).toBe(15);
  });

  it('can be constrained to single-page runs via maxPages: 1', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    populateEvents(fakeServer, 15);

    const result1 = await indexer.runOnce({ limit: 5, maxPages: 1 });
    expect(result1.processed).toBe(5);
    expect(result1.pages).toBe(1);
    expect(store.getEventsStored()).toBe(5);

    const result2 = await indexer.runOnce({ limit: 5, maxPages: 1 });
    expect(result2.processed).toBe(5);
    expect(result2.pages).toBe(1);
    expect(store.getEventsStored()).toBe(10);

    const result3 = await indexer.runOnce({ limit: 5, maxPages: 1 });
    expect(result3.processed).toBe(5);
    expect(result3.pages).toBe(1);
    expect(store.getEventsStored()).toBe(15);
  });

  it('persists cursor only after successful append', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(100n, { type: 'u128' });

    fakeServer.addEvent({
      id: 'event-1',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: 'hash-1',
      topic: [symbol, u64, address, address],
      value: amount,
    });

    const originalAppend = store.append;
    let callCount = 0;
    store.append = function (events) {
      callCount++;
      if (callCount === 1) {
        throw new Error('Simulated failure');
      }
      return originalAppend.call(this, events);
    };

    await expect(indexer.runOnce()).rejects.toThrow('Simulated failure');
    expect(store.getCursor()).toBeNull();

    store.append = originalAppend;
    const result = await indexer.runOnce();
    expect(result.processed).toBe(1);
    expect(store.getCursor()).toBeDefined();
  });

  it('is idempotent on re-run', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(100n, { type: 'u128' });

    fakeServer.addEvent({
      id: 'event-1',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: 'hash-1',
      topic: [symbol, u64, address, address],
      value: amount,
    });

    await indexer.runOnce();
    expect(store.getEventsStored()).toBe(1);

    await indexer.runOnce();
    expect(store.getEventsStored()).toBe(1);
  });

  it('handles RPC errors with backoff and sets lastError', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    fakeServer.getEvents = async () => {
      throw new Error('RPC error');
    };

    await expect(indexer.runOnce()).rejects.toThrow('RPC error');
    const state = indexer.getState();
    expect(state.lastError).toBe('RPC error');
  });

  it('preserves unknown topics', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    const symbol = xdr.ScVal.scvSymbol('unknown_type');
    const value = xdr.ScVal.scvU32(42);

    fakeServer.addEvent({
      id: 'event-unknown',
      ledger: 100,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: 'hash-unknown',
      topic: [symbol],
      value,
    });

    const result = await indexer.runOnce();
    expect(result.processed).toBe(1);

    const events = store.query({});
    expect(events.data[0].event.type).toBe('Unknown');
  });

  describe('lagLedgers', () => {
    it('is 0 when the last processed ledger equals latestLedger', async () => {
      const store = new InMemoryEventStore();
      const fakeServer = new FakeServer() as any;
      const indexer = new EventIndexer(store, undefined);
      (indexer as any).rpc = fakeServer;

      const symbol = xdr.ScVal.scvSymbol('created');
      const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
      const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const amount = nativeToScVal(100n, { type: 'u128' });

      // Event sits exactly at the chain head (ledger 100 == latestLedger 100).
      fakeServer.addEvent({
        id: 'event-head',
        ledger: 100,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'hash-head',
        topic: [symbol, u64, address, address],
        value: amount,
      });
      fakeServer.setLatestLedger(100);

      await indexer.runOnce();

      expect(indexer.getState().lagLedgers).toBe(0);
    });

    it('is positive and correct after a run that returns events below the chain head', async () => {
      const store = new InMemoryEventStore();
      const fakeServer = new FakeServer() as any;
      const indexer = new EventIndexer(store, undefined);
      (indexer as any).rpc = fakeServer;

      const symbol = xdr.ScVal.scvSymbol('created');
      const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
      const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const amount = nativeToScVal(100n, { type: 'u128' });

      // Last event is at ledger 90; chain head is at 100 → lag = 10.
      fakeServer.addEvent({
        id: 'event-behind',
        ledger: 90,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'hash-behind',
        topic: [symbol, u64, address, address],
        value: amount,
      });
      fakeServer.setLatestLedger(100);

      await indexer.runOnce();

      expect(indexer.getState().lagLedgers).toBe(10);
    });

    it('never goes negative', async () => {
      const store = new InMemoryEventStore();
      const fakeServer = new FakeServer() as any;
      const indexer = new EventIndexer(store, undefined);
      (indexer as any).rpc = fakeServer;

      const symbol = xdr.ScVal.scvSymbol('created');
      const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
      const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      const amount = nativeToScVal(100n, { type: 'u128' });

      // Event ledger is ahead of reported latestLedger (edge case / clock skew).
      fakeServer.addEvent({
        id: 'event-ahead',
        ledger: 110,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: 'hash-ahead',
        topic: [symbol, u64, address, address],
        value: amount,
      });
      fakeServer.setLatestLedger(100);

      await indexer.runOnce();

      expect(indexer.getState().lagLedgers).toBeGreaterThanOrEqual(0);
    });

    it('reports correct lag with a stored cursor and no new events', async () => {
      const store = new InMemoryEventStore();
      const fakeServer = new FakeServer() as any;
      const indexer = new EventIndexer(store, undefined);
      (indexer as any).rpc = fakeServer;

      // Pre-seed a cursor so the first runOnce uses cursor-based pagination.
      store.setCursor('cursor-0');
      fakeServer.setLatestLedger(200);

      // No events in the response — the indexer is caught up.
      await indexer.runOnce();

      // lagLedgers should NOT equal the whole chain height (the old bug).
      // It should be 0 or at most a small number based on getStartLedger().
      const { lagLedgers } = indexer.getState();
      expect(lagLedgers).toBeGreaterThanOrEqual(0);
      // Specifically, it must NOT be 200 (the full latestLedger value).
      expect(lagLedgers).not.toBe(200);
    });
  });
});

describe('InMemoryEventStore', () => {
  const makeEvent = (
    id: string,
    ledger: number,
    type: 'Created' | 'Deposit' | 'Paused' | 'Unknown' = 'Created',
    escrowId = 'escrow-1',
  ): IndexedEvent => {
    const base = {
      id,
      ledger,
      ledgerClosedAt: '2024-01-01T00:00:00Z',
      txHash: `tx-${id}`,
    };
    if (type === 'Created') {
      return {
        ...base,
        event: {
          type: 'Created',
          data: { escrowId, client: 'C', freelancer: 'F', total: '100' },
        },
      };
    }
    if (type === 'Deposit') {
      return {
        ...base,
        event: {
          type: 'Deposit',
          data: { escrowId, amount: '50' },
        },
      };
    }
    if (type === 'Paused') {
      return {
        ...base,
        event: {
          type: 'Paused',
          data: { paused: true },
        },
      };
    }
    return {
      ...base,
      event: {
        type: 'Unknown',
        data: { topics: [], value: '' },
      },
    };
  };

  it('orders out-of-order inserts newest-first with id tie-break', () => {
    const store = new InMemoryEventStore();
    store.append([
      makeEvent('e-2', 10),
      makeEvent('e-1', 10),
      makeEvent('e-3', 5),
      makeEvent('e-4', 20),
    ]);

    const { data } = store.query({});
    expect(data.map((e) => e.id)).toEqual(['e-4', 'e-2', 'e-1', 'e-3']);
  });

  it('filters by escrowId, type, and both using indexes', () => {
    const store = new InMemoryEventStore();
    store.append([
      makeEvent('e-1', 10, 'Created', 'esc-1'),
      makeEvent('e-2', 11, 'Deposit', 'esc-1'),
      makeEvent('e-3', 12, 'Created', 'esc-2'),
      makeEvent('e-4', 13, 'Paused'),
      makeEvent('e-5', 14, 'Unknown'),
    ]);

    expect(store.query({ escrowId: 'esc-1' }).data.map((e) => e.id)).toEqual(['e-2', 'e-1']);
    expect(store.query({ type: 'Created' }).data.map((e) => e.id)).toEqual(['e-3', 'e-1']);
    expect(store.query({ escrowId: 'esc-1', type: 'Deposit' }).data.map((e) => e.id)).toEqual([
      'e-2',
    ]);
    expect(store.query({ escrowId: 'nonexistent' }).data).toEqual([]);
  });

  it('paginates with cursor across unfiltered and filtered queries', () => {
    const store = new InMemoryEventStore();
    store.append([
      makeEvent('e-1', 1, 'Created', 'esc-1'),
      makeEvent('e-2', 2, 'Deposit', 'esc-1'),
      makeEvent('e-3', 3, 'Created', 'esc-2'),
      makeEvent('e-4', 4, 'Deposit', 'esc-1'),
      makeEvent('e-5', 5, 'Created', 'esc-1'),
    ]);

    const p1 = store.query({ limit: 2 });
    expect(p1.data.map((e) => e.id)).toEqual(['e-5', 'e-4']);
    expect(p1.nextCursor).toBe('e-4');

    const p2 = store.query({ limit: 2, cursor: p1.nextCursor });
    expect(p2.data.map((e) => e.id)).toEqual(['e-3', 'e-2']);
    expect(p2.nextCursor).toBe('e-2');

    const p3 = store.query({ limit: 2, cursor: p2.nextCursor });
    expect(p3.data.map((e) => e.id)).toEqual(['e-1']);
    expect(p3.nextCursor).toBe('e-1');

    const p4 = store.query({ limit: 2, cursor: p3.nextCursor });
    expect(p4.data).toEqual([]);
    expect(p4.nextCursor).toBeUndefined();

    // Filtered cursor pagination
    const f1 = store.query({ escrowId: 'esc-1', limit: 2 });
    expect(f1.data.map((e) => e.id)).toEqual(['e-5', 'e-4']);
    const f2 = store.query({ escrowId: 'esc-1', limit: 2, cursor: f1.nextCursor });
    expect(f2.data.map((e) => e.id)).toEqual(['e-2', 'e-1']);

    // Unknown cursor falls back to start
    const unknown = store.query({ limit: 2, cursor: 'does-not-exist' });
    expect(unknown.data.map((e) => e.id)).toEqual(['e-5', 'e-4']);
  });

  it('evicts oldest events beyond MAX_EVENTS from all indexes', () => {
    const store = new InMemoryEventStore();
    const batch: IndexedEvent[] = [];
    for (let i = 0; i < 10_005; i++) {
      batch.push(makeEvent(`e-${String(i).padStart(5, '0')}`, i, 'Created', i < 5 ? 'old-esc' : 'new-esc'));
    }
    store.append(batch);

    expect(store.getEventsStored()).toBe(10_000);
    expect(store.query({ escrowId: 'old-esc' }).data).toEqual([]);
    const newest = store.query({ limit: 1 });
    expect(newest.data[0].id).toBe('e-10004');
  });

  it('escrowIdOf extracts escrowId only for escrow-scoped events', () => {
    expect(escrowIdOf(makeEvent('1', 1, 'Created', 'esc-9').event)).toBe('esc-9');
    expect(escrowIdOf(makeEvent('2', 1, 'Deposit', 'esc-9').event)).toBe('esc-9');
    expect(escrowIdOf(makeEvent('3', 1, 'Paused').event)).toBeUndefined();
    expect(escrowIdOf(makeEvent('4', 1, 'Unknown').event)).toBeUndefined();
  });
});
