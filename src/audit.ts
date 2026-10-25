import { createHash } from 'crypto';

export type AuditAction =
  | 'create'
  | 'deposit'
  | 'release'
  | 'dispute'
  | 'resolve'
  | 'cancel'
  | 'rate';

export interface AuditState {
  status: string;
  /** @deprecated lossy above 2^53; use fundedAmountUnits */
  fundedAmount: number;
  /** @deprecated lossy above 2^53; use releasedAmountUnits */
  releasedAmount: number;
  fundedAmountUnits?: string;
  releasedAmountUnits?: string;
}

export interface AuditEntry {
  seq: number;
  contractId: number;
  action: AuditAction;
  actor: string | null;
  requestId: string | null;
  at: string;
  before: AuditState;
  after: AuditState;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditContext {
  actor?: string;
  requestId?: string;
}

export interface VerifyResult {
  valid: boolean;
  entries: number;
  brokenAt?: number;
}

/**
 * Canonical JSON serialization with sorted keys for stable hashing.
 */
function canonicalJSON(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((v) => (v === undefined ? 'null' : canonicalJSON(v))).join(',')}]`;
  }
  // Like JSON.stringify: skip undefined values so an entry hashes the same after a JSON round-trip.
  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(record[k])}`);
  return `{${pairs.join(',')}}`;
}

/**
 * Compute SHA-256 hash of a string, returned as hex.
 */
function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * Compute the hash for an audit entry (excluding the hash field itself).
 */
function computeEntryHash(entry: Omit<AuditEntry, 'hash'>): string {
  const { prevHash, ...withoutHash } = entry;
  const canonical = canonicalJSON(withoutHash);
  return sha256(prevHash + canonical);
}

export class AuditStore {
  private entries: AuditEntry[] = [];
  private nextSeq = 1;
  private prevHash = '0'.repeat(64); // Genesis hash
  private truncatedBeforeSeq: number | null = null;
  private readonly maxEntries = 100_000;

  /**
   * Append a new audit entry after a successful mutation.
   */
  append(params: {
    contractId: number;
    action: AuditAction;
    ctx?: AuditContext;
    before: AuditState;
    after: AuditState;
    details: Record<string, unknown>;
    /** Timestamp (defaults to now); the store passes its own clock. */
    at?: string;
  }): AuditEntry {
    const entry: Omit<AuditEntry, 'hash'> = {
      seq: this.nextSeq++,
      contractId: params.contractId,
      action: params.action,
      actor: params.ctx?.actor ?? null,
      requestId: params.ctx?.requestId ?? null,
      at: params.at ?? new Date().toISOString(),
      before: params.before,
      after: params.after,
      details: params.details,
      prevHash: this.prevHash,
    };

    const hash = computeEntryHash(entry);
    const fullEntry: AuditEntry = { ...entry, hash };

    this.entries.push(fullEntry);
    this.prevHash = hash;

    // Evict oldest entries if we exceed the limit
    if (this.entries.length > this.maxEntries) {
      const evicted = this.entries.shift();
      if (evicted && !this.truncatedBeforeSeq) {
        this.truncatedBeforeSeq = evicted.seq;
      }
    }

    return fullEntry;
  }

  /**
   * Get audit entries for a specific contract, paginated.
   */
  getContractHistory(contractId: number, limit?: number, cursor?: number): {
    data: AuditEntry[];
    nextCursor?: number;
  } {
    const contractEntries = this.entries.filter((e) => e.contractId === contractId);
    let startIndex = 0;
    if (cursor) {
      startIndex = contractEntries.findIndex((e) => e.seq > cursor);
      if (startIndex === -1) startIndex = contractEntries.length;
    }
    const slice = contractEntries.slice(startIndex);
    const limited = limit ? slice.slice(0, limit) : slice;

    const nextCursor = limited.length > 0 && limited.length < slice.length ? limited[limited.length - 1].seq : undefined;

    return { data: limited, nextCursor };
  }

  /**
   * Verify the integrity of the entire audit chain.
   */
  verify(): VerifyResult {
    if (this.entries.length === 0) {
      return { valid: true, entries: 0 };
    }

    // If entries were evicted, start verification from the first retained entry's prevHash
    let currentHash = this.truncatedBeforeSeq ? this.entries[0].prevHash : '0'.repeat(64);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const { hash, ...withoutHash } = entry;
      const expectedHash = computeEntryHash({ ...withoutHash, prevHash: currentHash });

      if (hash !== expectedHash) {
        return { valid: false, entries: this.entries.length, brokenAt: entry.seq };
      }

      currentHash = hash;
    }

    return { valid: true, entries: this.entries.length };
  }

  /**
   * Get the truncation sequence number (if any entries were evicted).
   */
  getTruncatedBeforeSeq(): number | null {
    return this.truncatedBeforeSeq;
  }

  /**
   * Internal method for testing: allow tampering with an entry.
   */
  _tamperWithEntry(seq: number, mutation: (entry: AuditEntry) => void): void {
    const entry = this.entries.find((e) => e.seq === seq);
    if (entry) {
      mutation(entry);
    }
  }
}
