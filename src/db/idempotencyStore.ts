export interface IdempotencyRecord<TResult = unknown> {
  key: string;
  payloadHash: string;
  result: TResult;
  createdAt: Date;
}

export interface IdempotencyStore {
  get<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined;
  set<TResult>(record: IdempotencyRecord<TResult>): void;
  clear(): void;
}

/**
 * Stores idempotency records for event ingestion.
 *
 * @remarks
 * This implementation is intentionally small and process-local for the current
 * backend scaffold. A production adapter should preserve the same key,
 * payloadHash, and result fields in durable storage with a unique index on key.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  get<TResult = unknown>(key: string): IdempotencyRecord<TResult> | undefined {
    return this.records.get(key) as IdempotencyRecord<TResult> | undefined;
  }

  set<TResult>(record: IdempotencyRecord<TResult>): void {
    this.records.set(record.key, record);
  }

  clear(): void {
    this.records.clear();
  }
}

export const defaultIdempotencyStore = new InMemoryIdempotencyStore();
