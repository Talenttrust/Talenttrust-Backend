/**
 * Tests for event indexer with fake RPC.
 */

import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { EventIndexer } from '../src/indexer/indexer';
import { InMemoryEventStore } from '../src/indexer/store';

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
      cursor: page.length > 0 ? `cursor-${start + page.length}` : this.cursor,
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

describe('EventIndexer', () => {
  it('paginates across 3 pages', async () => {
    const store = new InMemoryEventStore();
    const fakeServer = new FakeServer() as any;
    const indexer = new EventIndexer(store, undefined);
    (indexer as any).rpc = fakeServer;

    const symbol = xdr.ScVal.scvSymbol('created');
    const u64 = xdr.ScVal.scvU64(xdr.Uint64.fromString('1'));
    const address = xdr.ScVal.scvString('GTESTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const amount = nativeToScVal(100n, { type: 'u128' });

    for (let i = 0; i < 15; i++) {
      fakeServer.addEvent({
        id: `event-${i}`,
        ledger: 100 + i,
        ledgerClosedAt: '2024-01-01T00:00:00Z',
        txHash: `hash-${i}`,
        topic: [symbol, u64, address, address],
        value: amount,
      });
    }

    const result1 = await indexer.runOnce({ limit: 5 });
    expect(result1.processed).toBe(5);
    expect(store.getEventsStored()).toBe(5);

    const result2 = await indexer.runOnce({ limit: 5 });
    expect(result2.processed).toBe(5);
    expect(store.getEventsStored()).toBe(10);

    const result3 = await indexer.runOnce({ limit: 5 });
    expect(result3.processed).toBe(5);
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
});
