/**
 * @file service.concurrency.test.ts
 * @description Concurrency and cache-coherence tests for `AuditService` (issue #1369).
 *
 * `AuditService` is a process-wide singleton shared by every concurrent
 * request, and its read cache is the only piece of per-process mutable state it
 * owns. The invariants exercised here are:
 *
 * 1. **Write ⇒ no stale reads.** A completed write invalidates every cached read
 *    that could have contained the new entry — including unfiltered and
 *    differently-filtered query caches whose key does not mention the new
 *    `resourceId`.
 * 2. **No cross-request mutation.** A cached array/entry is a snapshot owned by
 *    the cache; every reader receives its own copy, so one request cannot
 *    corrupt what a concurrent reader observes.
 * 3. **Concurrent writers.** Interleaved writes all persist and leave the cache
 *    coherent with the repository.
 */

import { AuditService, AuditServiceOptions } from './service';
import type { AuditLogRepository } from './repository';
import type {
  AuditEntry,
  AuditQuery,
  AuditQueryResult,
  CreateAuditEntryInput,
  IntegrityReport,
} from './types';

const CACHE_OPTIONS: AuditServiceOptions = { cache: { ttlMs: 60_000, maxEntries: 100 } };

/** Deterministic in-memory repository used to make the service the unit under test. */
class InMemoryAuditRepository implements AuditLogRepository {
  readonly entries: AuditEntry[] = [];
  private sequence = 0;

  append(input: CreateAuditEntryInput): AuditEntry {
    this.sequence += 1;
    const entry: AuditEntry = {
      id: `entry-${this.sequence}`,
      timestamp: new Date(this.sequence * 1000).toISOString(),
      hash: `hash-${this.sequence}`,
      previousHash: this.sequence === 1 ? 'GENESIS' : `hash-${this.sequence - 1}`,
      ...input,
    };
    this.entries.push(entry);
    return entry;
  }

  getById(id: string): AuditEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  query(query: AuditQuery = {}): AuditEntry[] {
    return this.filter(query);
  }

  queryWithCursor(query: AuditQuery = {}): AuditQueryResult {
    const entries = this.filter(query);
    return { entries, count: entries.length, limit: query.limit ?? entries.length };
  }

  stream(query: AuditQuery = {}): IterableIterator<AuditEntry> {
    return this.filter(query)[Symbol.iterator]();
  }

  count(): number {
    return this.entries.length;
  }

  verifyIntegrity(): IntegrityReport {
    return {
      valid: true,
      totalEntries: this.entries.length,
      checkedAt: new Date(0).toISOString(),
    };
  }

  private filter(query: AuditQuery): AuditEntry[] {
    return this.entries.filter((entry) => {
      if (query.action && entry.action !== query.action) return false;
      if (query.resource && entry.resource !== query.resource) return false;
      if (query.resourceId && entry.resourceId !== query.resourceId) return false;
      if (query.actor && entry.actor !== query.actor) return false;
      return true;
    });
  }
}

function makeInput(
  resourceId: string,
  overrides: Partial<CreateAuditEntryInput> = {},
): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'actor-1',
    resource: 'contract',
    resourceId,
    metadata: {},
    ...overrides,
  };
}

describe('AuditService — cache coherence across concurrent readers/writers', () => {
  it('invalidates an unfiltered query cache after a write', () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);

    // Prime the unfiltered cache with the empty result.
    expect(service.query({})).toEqual([]);

    service.log(makeInput('contract-1'));

    const afterWrite = service.query({});
    expect(afterWrite).toHaveLength(1);
    expect(afterWrite[0].resourceId).toBe('contract-1');
  });

  it('invalidates a filtered cache whose key does not mention the new resourceId', () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);

    // Cache an empty result for a filter that has nothing to do with the write
    // below. `invalidateByResourceId` would not have matched this key, so the
    // stale empty result would have been served until the TTL expired.
    expect(service.query({ action: 'PAYMENT_RELEASED' })).toEqual([]);

    service.log(makeInput('contract-9', { action: 'PAYMENT_RELEASED' }));

    expect(service.query({ action: 'PAYMENT_RELEASED' })).toHaveLength(1);
  });

  it('hands every reader an independent copy of a cached query result', () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);
    service.log(makeInput('contract-1'));

    const first = service.query({});
    const second = service.query({});

    expect(first).not.toBe(second);

    // A caller mutating its result must not affect the cache or other readers.
    first.length = 0;
    first.push({ ...second[0], id: 'injected' });

    expect(service.query({})).toHaveLength(1);
    expect(service.query({})[0].id).toBe('entry-1');
  });

  it('does not let a caller mutate the entry returned by getById', () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);
    const created = service.log(makeInput('contract-1'));

    const first = service.getById(created.id);
    expect(first).toBeDefined();
    (first as AuditEntry & { actor: string }).actor = 'mutated';

    const second = service.getById(created.id);
    expect(second?.actor).toBe('actor-1');
  });

  it('hands every reader an independent copy of a cached cursor result', () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);
    service.log(makeInput('contract-1'));

    const first = service.queryWithCursor({});
    expect(first.entries).toHaveLength(1);

    first.entries.pop();

    expect(service.queryWithCursor({}).entries).toHaveLength(1);
  });

  it('keeps the cache coherent when many writers interleave', async () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);

    // Prime the cache so every subsequent write has something to invalidate.
    expect(service.query({})).toEqual([]);

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        Promise.resolve().then(() => service.log(makeInput(`contract-${index}`))),
      ),
    );

    expect(service.count()).toBe(50);
    expect(service.query({})).toHaveLength(50);
  });

  it('serves a coherent count across interleaved rapid reads', async () => {
    const service = new AuditService(new InMemoryAuditRepository(), CACHE_OPTIONS);
    service.log(makeInput('contract-1'));

    const reads = await Promise.all(
      Array.from({ length: 25 }, () => Promise.resolve(service.query({}).length)),
    );

    expect(reads.every((count) => count === 1)).toBe(true);
  });
});

describe('AuditService — cache disabled', () => {
  it('delegates every read straight to the repository', () => {
    const repository = new InMemoryAuditRepository();
    const service = new AuditService(repository);

    expect(service.query({})).toEqual([]);
    service.log(makeInput('contract-1'));
    expect(service.query({})).toHaveLength(1);
  });
});
