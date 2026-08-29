export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface EventEnvelope<TPayload extends JsonValue = JsonValue> {
  id: string;
  type: string;
  payload: TPayload;
}

export interface IdempotentEventResult<TResult> {
  result: TResult;
  replayed: boolean;
  payloadHash: string;
}

export interface ContractEvent {
  contractId: string;
  eventId: string;
  sequence: number;
  timestamp: number;
  payload: Record<string, any>;
  signature?: string;
  /**
   * On-chain network the event was observed on (e.g. `soroban`,
   * `stellar`). Present for on-chain events; absent for off-chain
   * events which carry no finality risk.
   */
  network?: string;
  /**
   * Ledger/block sequence the event was observed at. Together with
   * `network` this drives the finality evaluation — an event is only
   * exposed through public reads once it has accumulated the network's
   * configured confirmation depth.
   */
  ledger?: number;
}

export interface EventIngestionResult {
  deduplicationKey: string;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason?: string;
  processedAt: Date;
  statusCode?: number;
  code?: string;
}

export interface EventProcessingAudit {
  id: string;
  deduplicationKey: string;
  contractId: string;
  eventId: string;
  sequence: number;
  status: 'accepted' | 'rejected' | 'duplicate';
  reason?: string;
  payloadHash: string;
  processedAt: Date;
  createdAt: Date;
  /** Optional correlation ID for distributed tracing across service boundaries. */
  correlationId?: string;
  /** On-chain network the event was observed on, if any. */
  network?: string;
  /** Ledger/block sequence the event was observed at, if any. */
  ledger?: number;
  /**
   * Internal finality state. `undefined` for legacy records and
   * off-chain events, which are treated as finalized by public reads.
   */
  finalityStatus?: import('../finality/types').FinalityStatus;
  /** ISO-8601 timestamp when the event became finalized (if it has). */
  finalizedAt?: string;
}

/**
 * Incoming event for idempotency processing.
 */
export interface IncomingEvent {
  providerId: string;
  eventType: string;
  eventId: string;
  timestamp: number;
  payload: JsonValue;
}

/**
 * Stored idempotency entry.
 */
export interface IdempotencyEntry {
  idempotencyKey: string;
  providerId: string;
  eventType: string;
  eventId: string;
  responseBody: string;
  createdAt: number;
  expiresAt: number;
}

/**
 * Idempotency configuration.
 */
export interface IdempotencyConfig {
  ttlMs: number;
  gracePeriodMs: number;
  maxRetries: number;
  retryDelayMs: number;
  timestampWindowMs: number;
}