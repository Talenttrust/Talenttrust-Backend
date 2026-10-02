export enum EventType {
  EscrowCreated = 'escrow:created',
  EscrowCompleted = 'escrow:completed',
  DisputeInitiated = 'dispute:initiated',
  DisputeResolved = 'dispute:resolved',
}

export interface SmartContractEvent {
  contractId: string;
  eventType: EventType;
  idempotencyKey?: string;
  payload: any;
  timestamp: string;
  /** On-chain network the event was observed on (retention class key). */
  network?: string;
  /** Ledger sequence the event was observed at (on-chain events). */
  ledger?: number;
}

import { getDb } from '../db/database';
import type BetterSqlite3 from 'better-sqlite3';

export class EventIndexerService {
  private db: BetterSqlite3.Database;

  constructor() {
    this.db = getDb();
  }

  /**
   * Process and index a smart contract event
   */
  public async processEvent(event: SmartContractEvent): Promise<{ status: string; eventId: string }> {
    if (!event.contractId || !event.eventType) {
      throw new Error('Invalid event data');
    }
    // Log event type for debugging
    switch (event.eventType) {
      case EventType.EscrowCreated:
        console.log(`[Indexer] New escrow created for contract: ${event.contractId}`);
        break;
      case EventType.EscrowCompleted:
        console.log(`[Indexer] Escrow completed for contract: ${event.contractId}`);
        break;
      case EventType.DisputeInitiated:
        console.log(`[Indexer] Dispute initiated for contract: ${event.contractId}`);
        break;
      case EventType.DisputeResolved:
        console.log(`[Indexer] Dispute resolved for contract: ${event.contractId}`);
        break;
      default:
        console.log(`[Indexer] Processing generic event: ${event.eventType}`);
    }
    const deterministicKey = `${event.contractId}:${event.eventType}:${event.idempotencyKey ?? ''}`;
    const eventId = deterministicKey;
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO smart_contract_events
        (eventId, contractId, eventType, idempotencyKey, payload, timestamp, network, ledger, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      eventId,
      event.contractId,
      event.eventType,
      event.idempotencyKey ?? null,
      JSON.stringify(event.payload),
      event.timestamp,
      event.network ?? null,
      event.ledger ?? null,
      new Date().toISOString(),
    );
    return { status: 'indexed', eventId };
  }

  /**
   * Fetch all indexed events
   */
  public getEvents(): SmartContractEvent[] {
    const rows = this.db.prepare('SELECT contractId, eventType, idempotencyKey, payload, timestamp FROM smart_contract_events').all();
    return rows.map((row: any) => ({
      contractId: row.contractId,
      eventType: row.eventType as EventType,
      idempotencyKey: row.idempotencyKey ?? undefined,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
    }));
  }

  /**
   * Fetch events for a specific contract ID
   */
  public getEventsByContractId(contractId: string): SmartContractEvent[] {
    const rows = this.db.prepare('SELECT contractId, eventType, idempotencyKey, payload, timestamp FROM smart_contract_events WHERE contractId = ?').all(contractId);
    return rows.map((row: any) => ({
      contractId: row.contractId,
      eventType: row.eventType as EventType,
      idempotencyKey: row.idempotencyKey ?? undefined,
      payload: JSON.parse(row.payload),
      timestamp: row.timestamp,
    }));
  }
}

export const indexerService = new EventIndexerService();
