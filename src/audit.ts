import { createHash } from 'crypto';
import { config } from './config';

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
  truncatedBeforeSeq: number | null;
  maxEntries: number;
  brokenAt?: number;
}

export interface AuditSnapshot {
  entries: AuditEntry[];
  nextSeq: number;
  prevHash: string;
  truncatedBeforeSeq: number | null;
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

interface ContractBucket {
  entries: (AuditEntry | undefined)[];
  head: number;
}

export class AuditStore {
  private ring: (AuditEntry | undefined)[];
  private head = 0;
  private count = 0;
  private byContract = new Map<number, ContractBucket>();
  private nextSeq = 1;
  private prevHash = '0'.repeat(64); // Genesis hash
  private truncatedBeforeSeq: number | null = null;
  constructor(private readonly maxEntries: number = config.auditMaxEntries) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error(`Invalid audit maxEntries: "${maxEntries}". Must be a positive integer.`);
    }
    this.ring = new Array<AuditEntry | undefined>(maxEntries);
  }

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

    this.prevHash = hash;

    // Insert into ring buffer, evicting oldest entry in O(1) when at capacity
    if (this.count === this.maxEntries) {
      const evicted = this.ring[this.head];
      this.ring[this.head] = fullEntry;
      this.head = (this.head + 1) % this.maxEntries;

      if (evicted) {
        if (!this.truncatedBeforeSeq) {
          this.truncatedBeforeSeq = evicted.seq;
        }
        this.evictFromContractIndex(evicted);
      }
    } else {
      const tail = (this.head + this.count) % this.maxEntries;
      this.ring[tail] = fullEntry;
      this.count++;
    }

    // Index entry per contract
    let bucket = this.byContract.get(fullEntry.contractId);
    if (!bucket) {
      bucket = { entries: [], head: 0 };
      this.byContract.set(fullEntry.contractId, bucket);
    }
    bucket.entries.push(fullEntry);

    return fullEntry;
  }

  private evictFromContractIndex(evicted: AuditEntry): void {
    const bucket = this.byContract.get(evicted.contractId);
    if (!bucket) return;

    if (bucket.head < bucket.entries.length && bucket.entries[bucket.head]?.seq === evicted.seq) {
      bucket.entries[bucket.head] = undefined;
      bucket.head++;

      if (bucket.head === bucket.entries.length) {
        this.byContract.delete(evicted.contractId);
      } else if (bucket.head >= 1024 && bucket.head * 2 >= bucket.entries.length) {
        bucket.entries = bucket.entries.slice(bucket.head);
        bucket.head = 0;
      }
    }
  }

  /**
   * Get audit entries for a specific contract, paginated.
   */
  getContractHistory(contractId: number, limit?: number, cursor?: number): {
    data: AuditEntry[];
    nextCursor?: number;
  } {
    const bucket = this.byContract.get(contractId);
    if (!bucket) {
      return { data: [], nextCursor: undefined };
    }

    const { entries, head } = bucket;
    const len = entries.length;
    let startIndex = head;

    if (cursor) {
      let lo = head;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if ((entries[mid] as AuditEntry).seq <= cursor) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      startIndex = lo;
    }

    const remaining = len - startIndex;
    const endIndex = limit ? Math.min(startIndex + limit, len) : len;
    const data = entries.slice(startIndex, endIndex) as AuditEntry[];
    const nextCursor = data.length > 0 && data.length < remaining ? data[data.length - 1].seq : undefined;

    return { data, nextCursor };
  }

  /**
   * Verify the integrity of the entire audit chain.
   */
  verify(): VerifyResult {
    if (this.count === 0) {
      return { valid: true, entries: 0, truncatedBeforeSeq: this.truncatedBeforeSeq, maxEntries: this.maxEntries };
    }

    // If entries were evicted, start verification from the first retained entry's prevHash
    const firstEntry = this.ring[this.head] as AuditEntry;
    let currentHash = this.truncatedBeforeSeq ? firstEntry.prevHash : '0'.repeat(64);

    for (let i = 0; i < this.count; i++) {
      const entry = this.ring[(this.head + i) % this.maxEntries] as AuditEntry;
      const { hash, ...withoutHash } = entry;
      const expectedHash = computeEntryHash({ ...withoutHash, prevHash: currentHash });

      if (hash !== expectedHash) {
        return {
          valid: false,
          entries: this.count,
          truncatedBeforeSeq: this.truncatedBeforeSeq,
          maxEntries: this.maxEntries,
          brokenAt: entry.seq,
        };
      }

      currentHash = hash;
    }

    return {
      valid: true,
      entries: this.count,
      truncatedBeforeSeq: this.truncatedBeforeSeq,
      maxEntries: this.maxEntries,
    };
  }

  /**
   * Get the truncation sequence number (if any entries were evicted).
   */
  getTruncatedBeforeSeq(): number | null {
    return this.truncatedBeforeSeq;
  }

  /**
   * Export a deep-cloned snapshot of the audit store state.
   */
  toSnapshot(): AuditSnapshot {
    const entries: AuditEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      entries.push(this.ring[(this.head + i) % this.maxEntries] as AuditEntry);
    }
    return {
      entries: structuredClone(entries),
      nextSeq: this.nextSeq,
      prevHash: this.prevHash,
      truncatedBeforeSeq: this.truncatedBeforeSeq,
    };
  }

  /**
   * Restore audit store state from a snapshot.
   */
  loadSnapshot(snapshot: AuditSnapshot): void {
    const entries = structuredClone(snapshot.entries);
    const retained = entries.length > this.maxEntries ? entries.slice(-this.maxEntries) : entries;
    this.ring = new Array<AuditEntry | undefined>(this.maxEntries);
    this.head = 0;
    this.count = retained.length;
    this.byContract.clear();
    for (let i = 0; i < retained.length; i++) {
      const entry = retained[i];
      this.ring[i] = entry;
      let bucket = this.byContract.get(entry.contractId);
      if (!bucket) {
        bucket = { entries: [], head: 0 };
        this.byContract.set(entry.contractId, bucket);
      }
      bucket.entries.push(entry);
    }
    this.nextSeq = snapshot.nextSeq;
    this.prevHash = snapshot.prevHash;
    this.truncatedBeforeSeq = snapshot.truncatedBeforeSeq;
  }

  /**
   * Internal method for testing: allow tampering with an entry.
   */
  _tamperWithEntry(seq: number, mutation: (entry: AuditEntry) => void): void {
    if (this.count === 0) return;
    const firstEntry = this.ring[this.head] as AuditEntry;
    const offset = seq - firstEntry.seq;
    if (offset < 0 || offset >= this.count) return;
    const entry = this.ring[(this.head + offset) % this.maxEntries];
    if (entry && entry.seq === seq) {
      mutation(entry);
    }
  }
}
