/**
 * Types for the event indexer.
 * Decoded contract events from the Soroban escrow contract.
 */

export interface EventMetadata {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

export type EscrowEvent =
  | { type: 'Created'; data: CreatedEvent }
  | { type: 'Deposit'; data: DepositEvent }
  | { type: 'Release'; data: ReleaseEvent }
  | { type: 'Dispute'; data: DisputeEvent }
  | { type: 'Resolved'; data: ResolvedEvent }
  | { type: 'Cancel'; data: CancelEvent }
  | { type: 'Reputation'; data: ReputationEvent }
  | { type: 'Paused'; data: PausedEvent }
  | { type: 'Init'; data: InitEvent }
  | { type: 'Unknown'; data: UnknownEvent };

export interface CreatedEvent {
  escrowId: string;
  client: string;
  freelancer: string;
  total: string;
}

export interface DepositEvent {
  escrowId: string;
  amount: string;
}

export interface ReleaseEvent {
  escrowId: string;
  index: number;
  amount: string;
}

export interface DisputeEvent {
  escrowId: string;
  caller: string;
}

export interface ResolvedEvent {
  escrowId: string;
  toFreelancer: string;
  toClient: string;
}

export interface CancelEvent {
  escrowId: string;
  refund: string;
}

export interface ReputationEvent {
  escrowId: string;
  freelancer: string;
  rating: number;
}

export interface PausedEvent {
  paused: boolean;
}

export interface InitEvent {
  admin: string;
}

export interface UnknownEvent {
  topics: string[];
  value: string;
}

export interface IndexedEvent extends EventMetadata {
  event: EscrowEvent;
}

export interface EventStore {
  getCursor(): string | null;
  setCursor(cursor: string): void;
  append(events: IndexedEvent[]): void;
  query(filter: {
    escrowId?: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): { data: IndexedEvent[]; nextCursor?: string };
}

export interface IndexerState {
  cursor: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  eventsStored: number;
  lagLedgers: number;
}

export interface GetEventsResponse {
  events: Array<{
    id: string;
    ledger: number;
    ledgerClosedAt: string;
    txHash: string;
    topic: string[];
    value: string;
  }>;
  cursor: string;
  latestLedger: number;
}
