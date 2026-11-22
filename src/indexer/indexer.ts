/**
 * Event indexer for Soroban contract events.
 * Polls the RPC for events, decodes them, and stores them in memory.
 */

import * as sdk from '@stellar/stellar-sdk';
import { xdr } from '@stellar/stellar-sdk';
import { EventStore, IndexerState, IndexedEvent } from './types';
import { decodeEvent } from './decode';
import { config } from '../config';

const RPC_RETENTION_LEDGERS = 17280;
const DEFAULT_LIMIT = 100;

export class EventIndexer {
  private store: EventStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rpc: any;
  private isRunning = false;
  private lastError: string | null = null;
  private lastRunAt: string | null = null;
  private latestLedger: number = 0;
  /** Highest raw.ledger seen across all processed events. -1 means no run has completed yet. */
  private lastIndexedLedger: number = -1;

  constructor(store: EventStore, rpcUrl?: string) {
    this.store = store;
    // Soroban RPC client (constructing it does no I/O; tests replace it with a fake).
    this.rpc = new sdk.rpc.Server(rpcUrl || config.rpcUrl, { allowHttp: (rpcUrl || config.rpcUrl).startsWith('http://') });
  }

  async runOnce(options: { limit?: number } = {}): Promise<{ processed: number; cursor: string; latestLedger: number }> {
    if (this.isRunning) {
      throw new Error('indexer_busy');
    }

    this.isRunning = true;
    this.lastError = null;

    try {
      const limit = options.limit ?? DEFAULT_LIMIT;
      const cursor = this.store.getCursor();
      const startLedger = this.getStartLedger();

      const response = await this.rpc.getEvents({
        filters: [{ type: 'contract', contractIds: [config.contractId] }],
        ...(cursor ? { cursor } : { startLedger }),
        limit,
      });

      this.latestLedger = response.latestLedger;

      const rawEvents = response.events;
      const decodedEvents: IndexedEvent[] = [];

      for (const raw of rawEvents) {
        const topics = raw.topic.map((t: any) => xdr.ScVal.fromXDR(t, 'base64'));
        const value = xdr.ScVal.fromXDR(raw.value, 'base64');

        const decoded = decodeEvent({
          id: raw.id,
          ledger: raw.ledger,
          ledgerClosedAt: raw.ledgerClosedAt,
          txHash: raw.txHash,
          topic: topics,
          value,
        });

        decodedEvents.push(decoded);
      }

      this.store.append(decodedEvents);

      // Track the highest ledger we have actually processed so that
      // getState() can report an accurate lag instead of using the
      // cursor presence as a proxy for "fully caught up".
      for (const raw of rawEvents) {
        if (raw.ledger > this.lastIndexedLedger) {
          this.lastIndexedLedger = raw.ledger;
        }
      }
      // When the response contained no events:
      //   - If a cursor was present we were already caught up, so the
      //     last indexed ledger equals the chain head.
      //   - Otherwise initialise to the start ledger so the lag reflects
      //     the distance from the configured start point.
      if (this.lastIndexedLedger === -1) {
        this.lastIndexedLedger = cursor ? response.latestLedger : this.getStartLedger();
      }

      if (response.cursor) {
        this.store.setCursor(response.cursor);
      }

      this.lastRunAt = new Date().toISOString();

      return {
        processed: decodedEvents.length,
        cursor: response.cursor,
        latestLedger: response.latestLedger,
      };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.isRunning = false;
    }
  }

  getState(): IndexerState {
    // Use the highest ledger we have actually processed.  Before any run
    // completes, fall back to getStartLedger() so the lag reflects the
    // distance from the configured start, not the full chain height.
    const anchor = this.lastIndexedLedger >= 0
      ? this.lastIndexedLedger
      : this.getStartLedger();
    const lagLedgers = this.latestLedger > 0
      ? Math.max(0, this.latestLedger - anchor)
      : 0;

    return {
      cursor: this.store.getCursor(),
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      eventsStored: (this.store as any).getEventsStored?.() ?? 0,
      lagLedgers,
    };
  }

  private getStartLedger(): number {
    const envStart = process.env.INDEXER_START_LEDGER;
    if (envStart) {
      return Number(envStart);
    }

    if (this.latestLedger > 0) {
      return Math.max(0, this.latestLedger - RPC_RETENTION_LEDGERS);
    }

    return 0;
  }

  async getLatestLedger(): Promise<number> {
    try {
      const response = await this.rpc.getLatestLedger();
      this.latestLedger = response.sequence;
      return this.latestLedger;
    } catch (err) {
      return this.latestLedger;
    }
  }
}

export async function withBackoff<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  let attempt = 0;
  let delay = 1000;

  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }

  throw new Error('Max retries exceeded');
}
