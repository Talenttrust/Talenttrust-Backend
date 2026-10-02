/**
 * @file store.contract.test.ts
 * @description Makes the public behaviour of the audit repositories *explicit*
 * and *shared* (issue #1380). The same behavioural spec is executed against
 * both backends selected by `AUDIT_STORAGE_BACKEND` — the in-memory
 * `AuditStore` and `SqliteAuditRepository` — so a caller cannot observe
 * different results (or failure modes) depending on which one is wired in.
 *
 * Two regressions the in-memory store had, both caught here:
 *  1. It anchored cursor pagination in the *raw log* index space but sliced the
 *     *filtered* array, so filtered pagination skipped (or re-served) entries.
 *  2. It swallowed "Cursor filters do not match query filters" in a catch-all,
 *     silently restarting pagination instead of rejecting filter drift the way
 *     the SQLite backend does.
 */

import Database, { Database as DbInstance } from '../db/betterSqlite3';
import { AuditStore, CURSOR_FILTER_MISMATCH_MESSAGE, GENESIS_HASH, computeEntryHash } from './store';
import { SqliteAuditRepository } from './sqliteRepository';
import type { AuditLogRepository } from './repository';
import type { AuditEntry, CreateAuditEntryInput } from './types';

interface RepositoryHarness {
  repo: AuditLogRepository;
  dispose: () => void;
}

const memoryHarness = (): RepositoryHarness => ({
  repo: new AuditStore(),
  dispose: () => undefined,
});

const sqliteHarness = (): RepositoryHarness => {
  const db: DbInstance = new Database(':memory:');
  const repo = new SqliteAuditRepository(db);
  return { repo, dispose: () => db.close() };
};

const input = (overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput => ({
  action: 'CONTRACT_CREATED',
  severity: 'INFO',
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'contract-1',
  metadata: {},
  ...overrides,
});

function describeAuditRepositoryContract(name: string, factory: () => RepositoryHarness): void {
  describe(`${name} — AuditLogRepository contract`, () => {
    let repo: AuditLogRepository;
    let dispose: () => void;

    beforeEach(() => {
      ({ repo, dispose } = factory());
    });

    afterEach(() => {
      dispose();
    });

    it('empty store: query -> [], count 0, integrity valid, unknown id undefined', () => {
      expect(repo.query()).toEqual([]);
      expect(repo.count()).toBe(0);
      expect(repo.getById('missing')).toBeUndefined();
      expect(repo.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 0 });
      expect(repo.queryWithCursor()).toMatchObject({ entries: [], count: 0, limit: 50, nextCursor: undefined });
    });

    it('append links each entry to its predecessor and returns a frozen entry', () => {
      const first = repo.append(input());
      const second = repo.append(input({ actor: 'user-2' }));

      expect(first.previousHash).toBe(GENESIS_HASH);
      expect(second.previousHash).toBe(first.hash);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.metadata)).toBe(true);

      const { hash, ...rest } = first;
      expect(computeEntryHash(rest)).toBe(hash);

      expect(repo.count()).toBe(2);
      expect(repo.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 2 });
    });

    it('getById round-trips an appended entry', () => {
      const entry = repo.append(input({ resourceId: 'lookup-me' }));
      expect(repo.getById(entry.id)).toMatchObject({ id: entry.id, resourceId: 'lookup-me' });
    });

    it('query applies every filter with AND semantics and honours limit/offset', () => {
      const a = repo.append(input({ actor: 'alice', resource: 'contract', action: 'CONTRACT_CREATED' }));
      const b = repo.append(input({ actor: 'alice', resource: 'payment', action: 'PAYMENT_INITIATED' }));
      const c = repo.append(input({ actor: 'bob', resource: 'contract', action: 'CONTRACT_UPDATED' }));

      expect(repo.query({ actor: 'alice' }).map((e) => e.id)).toEqual([a.id, b.id]);
      expect(repo.query({ actor: 'alice', resource: 'contract' }).map((e) => e.id)).toEqual([a.id]);
      expect(repo.query({ action: 'PAYMENT_INITIATED' }).map((e) => e.id)).toEqual([b.id]);
      expect(repo.query({}).map((e) => e.id)).toEqual([a.id, b.id, c.id]);

      const paged = repo.query({ limit: 1, offset: 1 });
      expect(paged.map((e) => e.id)).toEqual([b.id]);
    });

    it('queryWithCursor clamps limit to [1, 100] and defaults to 50', () => {
      for (let i = 0; i < 60; i += 1) repo.append(input({ resourceId: `c${i}` }));

      expect(repo.queryWithCursor({}).limit).toBe(50);
      expect(repo.queryWithCursor({ limit: 500 }).limit).toBe(100);
      expect(repo.queryWithCursor({ limit: 0 }).limit).toBe(1);
      expect(repo.queryWithCursor({ limit: 1000 }).limit).toBe(100);
      expect(repo.queryWithCursor({ limit: 5 }).entries).toHaveLength(5);
    });

    it('queryWithCursor pages through every entry exactly once', () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) ids.push(repo.append(input({ resourceId: `c${i}` })).id);

      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = repo.queryWithCursor({ limit: 2, ...(cursor ? { cursor } : {}) });
        seen.push(...page.entries.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toEqual(ids);
    });

    it('regression: filtered pagination never skips or duplicates entries', () => {
      // Interleave so the filtered sequence's indices differ from the raw log.
      // payment, contract, payment, contract, payment, contract
      repo.append(input({ resource: 'payment', resourceId: 'p0' }));
      const c0 = repo.append(input({ resource: 'contract', resourceId: 'c0' }));
      repo.append(input({ resource: 'payment', resourceId: 'p1' }));
      const c1 = repo.append(input({ resource: 'contract', resourceId: 'c1' }));
      repo.append(input({ resource: 'payment', resourceId: 'p2' }));
      const c2 = repo.append(input({ resource: 'contract', resourceId: 'c2' }));

      const page1 = repo.queryWithCursor({ resource: 'contract', limit: 1 });
      expect(page1.entries.map((e) => e.id)).toEqual([c0.id]);

      const page2 = repo.queryWithCursor({ resource: 'contract', limit: 1, cursor: page1.nextCursor });
      expect(page2.entries.map((e) => e.id)).toEqual([c1.id]);

      const page3 = repo.queryWithCursor({ resource: 'contract', limit: 1, cursor: page2.nextCursor });
      expect(page3.entries.map((e) => e.id)).toEqual([c2.id]);
      expect(page3.nextCursor).toBeUndefined();
    });

    it('queryWithCursor throws on filter drift instead of silently restarting', () => {
      repo.append(input({ resource: 'contract', resourceId: 'c0' }));
      repo.append(input({ resource: 'contract', resourceId: 'c1' }));
      repo.append(input({ resource: 'payment', resourceId: 'p0' }));
      const page1 = repo.queryWithCursor({ resource: 'contract', limit: 1 });
      expect(page1.nextCursor).toBeDefined();

      expect(() =>
        repo.queryWithCursor({ resource: 'payment', limit: 1, cursor: page1.nextCursor }),
      ).toThrow(CURSOR_FILTER_MISMATCH_MESSAGE);
    });

    it('queryWithCursor recovers from an undecodable cursor by restarting at page one', () => {
      const first = repo.append(input({ resourceId: 'a' }));
      repo.append(input({ resourceId: 'b' }));

      const page = repo.queryWithCursor({ cursor: 'not-a-valid-cursor!!', limit: 2 });
      expect(page.entries[0].id).toBe(first.id);
      expect(page.entries).toHaveLength(2);
    });
  });
}

describeAuditRepositoryContract('AuditStore (memory)', memoryHarness);
describeAuditRepositoryContract('SqliteAuditRepository', sqliteHarness);

describe('AuditStore — documented in-memory-only behaviour', () => {
  it('getAll returns a copy; mutating it does not affect the store', () => {
    const store = new AuditStore();
    store.append(input());
    store.append(input());

    const all = store.getAll();
    all.pop();

    expect(all).toHaveLength(1);
    expect(store.count()).toBe(2);
    for (const entry of store.getAll()) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it('_reset empties the store and restores the empty-store contract', () => {
    const store = new AuditStore();
    store.append(input());
    store._reset();

    expect(store.count()).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(store.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 0 });
  });

  it('an appended entry is frozen including nested metadata', () => {
    const store = new AuditStore();
    const entry: AuditEntry = store.append(input({ metadata: { nested: { a: 1 } } }));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.metadata)).toBe(true);
  });
});
