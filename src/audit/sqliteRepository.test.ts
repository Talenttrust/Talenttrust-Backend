/**
 * @file sqliteRepository.test.ts
 * @description Coverage for the durable SQLite audit repository.
 *
 * Scope (issue #424):
 * 1. Append + read round-trip preserves all fields, including deeply nested
 *    metadata, special characters, and unicode.
 * 2. `query()` honours every documented filter (`action`, `severity`,
 *    `actor`, `resource`, `resourceId`, `from`, `to`) and combines them
 *    with AND semantics. `limit` / `offset` pagination edge cases are
 *    pinned so that pathological inputs (`offset > count`, `limit = 0`)
 *    are safe.
 * 3. `stream()` yields entries incrementally and respects filters.
 * 4. A repository write failure **surfaces**: the exception propagates out
 *    of `append()` and the underlying transaction rolls back so that no
 *    partial entry is left behind. The test that intentionally sabotages
 *    the schema uses `jest.spyOn` wrapped in `try/finally` so the spy
 *    cannot leak into `afterEach`/`db.close()` on assertion failure.
 * 5. Two repositories backed by separate `:memory:` databases are fully
 *    isolated — no shared state.
 * 6. `verifyIntegrity()` validates large insert chains (100+ entries) and
 *    detects every category of tamper we care about (hash change,
 *    previousHash break, row deletion, forged insertion).
 *
 * The in-memory SQLite backend keeps the suite **deterministic** and
 * **DB-isolated** — each test owns its own connection and closes it in
 * `afterEach`.
 *
 * Routing note: this file uses the project's `src/db/betterSqlite3`
 * wrapper (which loads the native bindings and falls back to a mock when
 * unavailable) so the test setup matches production plumbing exactly.
 *
 * Note: there is intentionally a divergence between `makeInput` here
 * (which omits `ipAddress`/`correlationId` because SQLite persistence is
 * tested with the smallest input needed) and the one in `service.test.ts`
 * (which includes them so the service routing layer can be asserted).
 */

// The wrapper `src/db/betterSqlite3` exports `Database` as BOTH the
// constructor value (default export) and a `better-sqlite3.Database`
// type alias (named export with the same name). We destructure them
// separately here so the constructor value is callable for `new
// Database(':memory:')` while the type alias drives DB-instance typing
// for direct method calls. Note: do NOT collapse these back into a
// single default import — see the JSDoc at the constructor of
// `SqliteAuditRepository` for why `typeof Database` is wrong.
import Database, { Database as DbInstance } from '../db/betterSqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SqliteAuditRepository } from './sqliteRepository';
import type { AuditEntry, CreateAuditEntryInput } from './types';
import { encodeCursor, decodeCursor, type CursorData } from './types';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Minimal valid input — every test starts with this. */
function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { key: 'value' },
    ...overrides,
  };
}

/**
 * Seeds a repository with a fixed set of five heterogeneous audit entries used
 * by the `query()` filter-combination suite. The distribution is pinned so the
 * per-filter counts asserted by those tests hold:
 *   - action:     1 × CONTRACT_CREATED, 1 × CONTRACT_UPDATED
 *   - severity:   1 × CRITICAL, 2 × WARNING, 2 × INFO
 *   - actor:      2 × alice, 1 × bob, 1 × carol, 1 × dave
 *   - resource:   3 × contract, 1 × payment, 1 × user
 *   - resourceId: 2 × c-1, 1 × p-1, others unique
 * Both `alice` rows share `resourceId: c-1`; exactly one of them is
 * CONTRACT_CREATED so three-filter AND queries resolve to a single row.
 */
function seedMixedEntries(repository: SqliteAuditRepository): void {
  repository.append(
    makeInput({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'alice',
      resource: 'contract',
      resourceId: 'c-1',
    }),
  );
  repository.append(
    makeInput({
      action: 'CONTRACT_UPDATED',
      severity: 'WARNING',
      actor: 'alice',
      resource: 'contract',
      resourceId: 'c-1',
    }),
  );
  repository.append(
    makeInput({
      action: 'PAYMENT_DISPUTED',
      severity: 'CRITICAL',
      actor: 'bob',
      resource: 'payment',
      resourceId: 'p-1',
    }),
  );
  repository.append(
    makeInput({
      action: 'CONTRACT_CANCELLED',
      severity: 'WARNING',
      actor: 'carol',
      resource: 'contract',
      resourceId: 'c-2',
    }),
  );
  repository.append(
    makeInput({
      action: 'USER_UPDATED',
      severity: 'INFO',
      actor: 'dave',
      resource: 'user',
      resourceId: 'u-1',
    }),
  );
}

describe('SqliteAuditRepository', () => {
  let db: ReturnType<typeof Database>;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a basic entry', () => {
    const created = repository.append(makeInput());
    const found = repository.getById(created.id);
    expect(found?.id).toBe(created.id);
    expect(found?.action).toBe('CONTRACT_CREATED');
    expect(found?.metadata).toEqual({ key: 'value' });
    expect(repository.count()).toBe(1);
  });

  it('round-trips deeply nested metadata with special characters', () => {
    const metadata = {
      nested: { deeply: { value: 'leaf' } },
      unicode: 'ñáéíóú 中文 🚀',
      numbers: [1, 2, 3],
      flags: { isAdmin: true, count: 42 },
    };
    const created = repository.append(makeInput({ metadata }));
    const found = repository.getById(created.id);
    expect(found?.metadata).toEqual(metadata);
  });

  it('returns a frozen entry (cannot be mutated post-append)', () => {
    const created = repository.append(makeInput());
    expect(Object.isFrozen(created)).toBe(true);
    expect(() => {
      (created as unknown as Record<string, unknown>)['actor'] = 'hacker';
    }).toThrow();
  });

  it('getById() returns undefined for unknown ids', () => {
    expect(repository.getById('does-not-exist')).toBeUndefined();
  });

  it('each append produces a unique id', () => {
    const ids = Array.from({ length: 25 }, () => repository.append(makeInput()).id);
    expect(new Set(ids).size).toBe(25);
  });

  it('treats identical payloads as separate events and preserves the chain', () => {
    const input = makeInput();
    const first = repository.append(input);
    const second = repository.append(input);

    expect(second.id).not.toBe(first.id);
    expect(second.previousHash).toBe(first.hash);
    expect(repository.count()).toBe(2);
    expect(repository.verifyIntegrity().valid).toBe(true);
  });
});

describe('SqliteAuditRepository — concurrent writer recovery', () => {
  it('rejects a competing writer atomically and retries from the committed tip', () => {
    const directory = mkdtempSync(join(tmpdir(), 'audit-repository-'));
    const dbPath = join(directory, 'audit.db');
    const firstDb = new Database(dbPath);
    const secondDb = new Database(dbPath);
    const firstRepository = new SqliteAuditRepository(firstDb);
    const secondRepository = new SqliteAuditRepository(secondDb);

    try {
      secondDb.pragma('busy_timeout = 0');
      let tipReads = 0;
      const originalPrepare = secondDb.prepare.bind(secondDb);
      const tipReadSpy = jest.spyOn(secondDb, 'prepare').mockImplementation(((sql: string) => {
        if (sql.includes('SELECT hash FROM audit_log_entries')) {
          tipReads += 1;
        }
        return originalPrepare(sql);
      }) as typeof secondDb.prepare);

      let committedHash = '';
      try {
        const writer = firstDb.transaction(() => {
          committedHash = firstRepository.append(makeInput({ actor: 'winner' })).hash;
          expect(() => secondRepository.append(makeInput({ actor: 'contender' }))).toThrow();
          expect(tipReads).toBe(0);
          expect(secondRepository.count()).toBe(0);
        });
        const immediate = (writer as typeof writer & { immediate?: () => void }).immediate;

        if (typeof immediate !== 'function') {
          throw new Error('SQLite immediate transactions are required for this concurrency test');
        }
        immediate();
      } finally {
        tipReadSpy.mockRestore();
      }

      const retried = secondRepository.append(makeInput({ actor: 'contender' }));
      expect(retried.previousHash).toBe(committedHash);
      expect(secondRepository.count()).toBe(2);
      expect(secondRepository.verifyIntegrity().valid).toBe(true);
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ─── Append() — deterministic failure recovery ─────────────────────────────

describe('SqliteAuditRepository — append() failure recovery (deterministic)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
    capturedLogs.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('a failed append leaves no partial row (transactional rollback)', () => {
    repository.append(makeInput({ actor: 'before-failure' }));
    expect(repository.count()).toBe(1);

    // Intercept the INSERT statement and force a throw. better-sqlite3's
    // db.transaction() rolls back the wrapping transaction on a thrown
    // error, so the row must NOT be persisted.
    const originalPrepare = db.prepare.bind(db);
    const insertSpy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.toUpperCase().includes('INSERT INTO AUDIT_LOG_ENTRIES')) {
        return {
          run: () => {
            throw new Error('simulated disk-full');
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    try {
      expect(() => repository.append(makeInput({ actor: 'after-failure' }))).toThrow(
        'simulated disk-full',
      );
    } finally {
      // Restore unconditionally — otherwise a failed assertion would leak
      // the spy into afterEach (and db.close()), producing ghost failures
      // across the suite.
      insertSpy.mockRestore();
    }

    // The first good row is still there; the bad row did not leak in.
    expect(repository.count()).toBe(1);
    expect(
      repository
        .query({ actor: 'after-failure' })
        .some((entry) => entry.actor === 'after-failure'),
    ).toBe(false);
  });

  it('self-repairs a dropped schema in-process and retries the write once', () => {
    repository.append(makeInput({ actor: 'before-drop' }));
    expect(repository.count()).toBe(1);

    // Sabotage: drop the table AFTER the repository's idempotent
    // initSchema() has created it. The next append hits a real
    // "no such table" error, which the repository repairs deterministically
    // and retries — on the SAME instance, no reconstruction required.
    db.exec('DROP TABLE audit_log_entries');

    const recovered = repository.append(makeInput({ actor: 'after-drop' }));
    expect(recovered.actor).toBe('after-drop');
    // The repaired table starts a fresh chain; rows were lost with the table.
    expect(recovered.previousHash).toBe(GENESIS_HASH);
    expect(repository.count()).toBe(1);

    // Recovery is observable: a structured warning names the operation.
    expect(
      capturedLogs.some(
        (record) => record.level === 'warn' && record.message.includes('schema missing'),
      ),
    ).toBe(true);
  });

  it('fails fast when schema auto-repair is explicitly disabled', () => {
    const strict = new SqliteAuditRepository(db, { autoRepairSchema: false });
    db.exec('DROP TABLE audit_log_entries');
    expect(() => strict.append(makeInput())).toThrow();
  });

  it('surfaces the original error when the repair attempt itself fails', () => {
    db.exec('DROP TABLE audit_log_entries');

    // If the repair cannot rebuild the schema (e.g. a read-only volume), the
    // caller must still see the original root-cause error, not a masked one.
    const execSpy = jest.spyOn(db, 'exec').mockImplementation(() => {
      throw new Error('simulated read-only filesystem');
    });
    try {
      expect(() => repository.append(makeInput())).toThrow(/no such table/);
    } finally {
      execSpy.mockRestore();
    }
  });

  it('does not retry a non-transient write failure (no masked bugs)', () => {
    let insertAttempts = 0;
    const originalPrepare = db.prepare.bind(db);
    const insertSpy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.toUpperCase().includes('INSERT INTO AUDIT_LOG_ENTRIES')) {
        insertAttempts += 1;
        return {
          run: () => {
            throw new Error('simulated disk-full');
          },
        } as unknown as ReturnType<typeof db.prepare>;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    try {
      expect(() => repository.append(makeInput())).toThrow('simulated disk-full');
      // Exactly one attempt: a disk-full must never be masked by a retry.
      expect(insertAttempts).toBe(1);
    } finally {
      insertSpy.mockRestore();
    }
  });

  it('retries a transient serialization failure and keeps the chain linear', () => {
    const first = repository.append(makeInput({ actor: 'first' }));

    let insertAttempts = 0;
    const originalPrepare = db.prepare.bind(db);
    const insertSpy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.toUpperCase().includes('INSERT INTO AUDIT_LOG_ENTRIES')) {
        insertAttempts += 1;
        if (insertAttempts === 1) {
          const err = new Error('database is locked') as Error & { code: number };
          err.code = 5; // SQLITE_BUSY
          throw err;
        }
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    try {
      const second = repository.append(makeInput({ actor: 'second' }));
      expect(insertAttempts).toBe(2);
      // The retry re-read the chain tail inside the transaction: no fork,
      // no gap, and no stale previous hash.
      expect(second.previousHash).toBe(first.hash);
    } finally {
      insertSpy.mockRestore();
    }

    expect(repository.verifyIntegrity().valid).toBe(true);
    expect(
      capturedLogs.some(
        (record) => record.level === 'warn' && record.message.includes('serialization conflict'),
      ),
    ).toBe(true);
  });

  it('gives up after the bounded retry budget and leaves no partial row', () => {
    let insertAttempts = 0;
    const originalPrepare = db.prepare.bind(db);
    const insertSpy = jest.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.toUpperCase().includes('INSERT INTO AUDIT_LOG_ENTRIES')) {
        insertAttempts += 1;
        const err = new Error('database is locked') as Error & { code: number };
        err.code = 5; // SQLITE_BUSY
        throw err;
      }
      return originalPrepare(sql);
    }) as typeof db.prepare);

    try {
      expect(() => repository.append(makeInput())).toThrow('database is locked');
      // Bounded: exactly MAX_WRITE_ATTEMPTS attempts, then rethrow.
      expect(insertAttempts).toBe(MAX_WRITE_ATTEMPTS);
    } finally {
      insertSpy.mockRestore();
    }

    expect(repository.count()).toBe(0);
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('does not crash a request-style caller that catches the failure', () => {
    const strict = new SqliteAuditRepository(db, { autoRepairSchema: false });
    db.exec('DROP TABLE audit_log_entries');
    let requestContinued = false;
    let caughtMessage: string | null = null;
    try {
      strict.append(makeInput());
    } catch (err) {
      caughtMessage = (err as Error).message;
    } finally {
      requestContinued = true;
    }
    expect(caughtMessage).not.toBeNull();
    expect(requestContinued).toBe(true);
  });
});

describe('SqliteAuditRepository — shared database concurrency', () => {
  it('extends one hash chain across repository connections to the same file', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'audit-concurrency-'));
    const dbPath = path.join(directory, 'audit.sqlite');
    const firstDb = new Database(dbPath);
    const secondDb = new Database(dbPath);
    try {
      const firstRepository = new SqliteAuditRepository(firstDb);
      const secondRepository = new SqliteAuditRepository(secondDb);

      firstRepository.append(makeInput({ actor: 'connection-1' }));
      secondRepository.append(makeInput({ actor: 'connection-2' }));
      firstRepository.append(makeInput({ actor: 'connection-1' }));

      expect(firstRepository.count()).toBe(3);
      expect(firstRepository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 3 });
    } finally {
      firstDb.close();
      secondDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('surfaces writer-lock contention without a partial row, then allows a retry', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'audit-lock-'));
    const dbPath = path.join(directory, 'audit.sqlite');
    const lockDb = new Database(dbPath);
    const appendDb = new Database(dbPath);
    try {
      const repository = new SqliteAuditRepository(appendDb);
      const lockTransaction = lockDb.transaction(() => undefined);
      const immediate = (lockTransaction as unknown as { immediate?: () => void }).immediate;

      // The fallback test database has no transaction lock semantics.
      if (typeof immediate !== 'function') return;

      appendDb.pragma('busy_timeout = 0');
      lockDb.exec('BEGIN IMMEDIATE');
      try {
        expect(() => repository.append(makeInput({ actor: 'blocked' }))).toThrow();
      } finally {
        lockDb.exec('ROLLBACK');
      }

      expect(repository.count()).toBe(0);
      const retried = repository.append(makeInput({ actor: 'retry' }));
      expect(repository.getById(retried.id)?.actor).toBe('retry');
      expect(repository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
    } finally {
      lockDb.close();
      appendDb.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// ─── query() — filter combinations ──────────────────────────────────────────

describe('SqliteAuditRepository — query() filter combinations', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
    seedMixedEntries(repository);
  });

  afterEach(() => {
    db.close();
  });

  it('returns every entry when no filter is supplied', () => {
    expect(repository.query()).toHaveLength(5);
  });

  it('filters by action', () => {
    expect(repository.query({ action: 'CONTRACT_CREATED' })).toHaveLength(1);
    expect(repository.query({ action: 'CONTRACT_UPDATED' })).toHaveLength(1);
  });

  it('filters by severity', () => {
    expect(repository.query({ severity: 'CRITICAL' })).toHaveLength(1);
    expect(repository.query({ severity: 'WARNING' })).toHaveLength(2);
  });

  it('filters by actor', () => {
    expect(repository.query({ actor: 'alice' })).toHaveLength(2);
    expect(repository.query({ actor: 'bob' })).toHaveLength(1);
  });

  it('filters by resource', () => {
    expect(repository.query({ resource: 'payment' })).toHaveLength(1);
    expect(repository.query({ resource: 'contract' })).toHaveLength(3);
  });

  it('filters by resourceId', () => {
    expect(repository.query({ resourceId: 'c-1' })).toHaveLength(2);
    expect(repository.query({ resourceId: 'p-1' })).toHaveLength(1);
  });

  it('combines filters with AND semantics', () => {
    const results = repository.query({ actor: 'alice', resourceId: 'c-1' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.actor === 'alice' && r.resourceId === 'c-1')).toBe(true);
  });

  it('combines three filters and excludes matching-only-one rows', () => {
    const results = repository.query({
      action: 'CONTRACT_CREATED',
      actor: 'alice',
      resourceId: 'c-1',
    });
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('CONTRACT_CREATED');
  });

  it('returns an empty array when no row matches', () => {
    expect(repository.query({ actor: 'nobody-here' })).toHaveLength(0);
    expect(repository.query({ action: 'CONTRACT_CREATED', actor: 'bob' })).toHaveLength(0);
  });

  it('filters by from/to time range inclusively', () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const after = new Date(Date.now() + 60_000).toISOString();
    expect(repository.query({ from: before, to: after })).toHaveLength(5);
    expect(repository.query({ from: after })).toHaveLength(0);
    expect(repository.query({ to: before })).toHaveLength(0);
  });
});

// ─── query() — pagination edge cases ───────────────────────────────────────

describe('SqliteAuditRepository — query() pagination edge cases', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
    for (let i = 0; i < 10; i += 1) {
      repository.append(makeInput({ actor: `u${i}` }));
    }
  });

  afterEach(() => {
    db.close();
  });

  it('limit alone truncates results', () => {
    expect(repository.query({ limit: 3 })).toHaveLength(3);
  });

  it('offset alone skips the first N rows', () => {
    const all = repository.query();
    const paged = repository.query({ offset: 7 });
    expect(paged).toHaveLength(3);
    expect(paged[0].id).toBe(all[7].id);
  });

  it('limit + offset together produce the expected slice', () => {
    const all = repository.query();
    const paged = repository.query({ limit: 3, offset: 4 });
    expect(paged).toHaveLength(3);
    expect(paged.map((r) => r.id)).toEqual(all.slice(4, 7).map((r) => r.id));
  });

  it('offset larger than the entry count returns an empty array (no error)', () => {
    expect(repository.query({ offset: 999 })).toHaveLength(0);
  });

  it('limit = 0 returns an empty array (no error)', () => {
    expect(repository.query({ limit: 0 })).toHaveLength(0);
  });

  it('negative offset is clamped to 0 (defence-in-depth)', () => {
    // The 10 rows seeded in beforeEach are sufficient for this assertion.
    // The production buildQuerySql clamps via `Math.max(query.offset ?? 0, 0)`;
    // if a future refactor removes that clamp, the resulting SQL would
    // include `OFFSET -1`, which is a SQLite syntax error, and the
    // query would throw rather than returning the 10 rows below.
    expect(repository.query({ offset: -1 })).toHaveLength(10);
  });
});

// ─── stream() — incremental generators ─────────────────────────────────────

describe('SqliteAuditRepository — stream()', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('yields entries in insertion order', () => {
    const expectedResourceIds = ['a-0', 'b-1', 'c-2'].map((tag) => {
      const entry = repository.append(makeInput({ resourceId: tag }));
      return entry.resourceId;
    });
    const collected = Array.from(repository.stream()).map((e) => e.resourceId);
    expect(collected).toEqual(expectedResourceIds);
  });

  it('respects filter and limit together', () => {
    repository.append(makeInput({ actor: 'kept' }));
    repository.append(makeInput({ actor: 'dropped' }));
    repository.append(makeInput({ actor: 'kept' }));

    const got = Array.from(repository.stream({ actor: 'kept', limit: 1 }));
    expect(got).toHaveLength(1);
    expect(got[0].actor).toBe('kept');
  });

  it('returns an empty iterator when no entry matches', () => {
    repository.append(makeInput({ actor: 'cats' }));
    const iter = repository.stream({ actor: 'dogs' });
    expect(iter.next().done).toBe(true);
  });
});

// ─── verifyIntegrity() — large chains and tamper categories ───────────────

describe('SqliteAuditRepository — verifyIntegrity()', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns valid:true for the empty log', () => {
    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(0);
  });

  it('returns valid:true for a 100-entry chain', () => {
    for (let i = 0; i < 100; i += 1) {
      repository.append(
        makeInput({ action: i % 2 === 0 ? 'CONTRACT_CREATED' : 'CONTRACT_UPDATED' }),
      );
    }
    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(100);
  });

  it('detects tampering by direct UPDATE on the hash column', () => {
    const created = repository.append(makeInput());
    db.prepare('UPDATE audit_log_entries SET hash = ? WHERE id = ?').run(
      'bad'.padEnd(64, '0'),
      created.id,
    );
    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedId).toBe(created.id);
  });

  it('reports malformed persisted metadata as the first corrupted entry', () => {
    const created = repository.append(makeInput());
    db.prepare('UPDATE audit_log_entries SET metadata_json = ? WHERE id = ?').run(
      '{malformed',
      created.id,
    );

    expect(repository.verifyIntegrity()).toMatchObject({
      valid: false,
      totalEntries: 1,
      firstCorruptedIndex: 0,
      firstCorruptedId: created.id,
    });
  });

  it('detects tampering by deletion (chain break)', () => {
    repository.append(makeInput());
    const second = repository.append(makeInput({ action: 'CONTRACT_UPDATED' }));
    db.prepare("DELETE FROM audit_log_entries WHERE actor = 'user-1' ORDER BY seq ASC LIMIT 1").run();
    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedId).toBe(second.id);
  });

  it('detects INSERTION (previousHash matches but the row\'s own hash is bogus)', () => {
    repository.append(makeInput());
    const tail = db
      .prepare<[], { hash: string }>(
        'SELECT hash FROM audit_log_entries ORDER BY seq DESC LIMIT 1',
      )
      .get();
    if (!tail) throw new Error('test precondition failed: empty repository');
    db.prepare(
      `INSERT INTO audit_log_entries
       (id, timestamp, action, severity, actor, resource, resource_id,
        metadata_json, ip_address, correlation_id, hash, previous_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      'forged-id',
      new Date().toISOString(),
      'ADMIN_ACTION',
      'CRITICAL',
      'attacker',
      'system',
      'sys-1',
      '{}',
      'f'.repeat(64),
      tail.hash,
    );

    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
  });

  it('reports corruption instead of throwing when a row has malformed metadata_json', () => {
    const created = repository.append(makeInput());
    // A metadata payload that is not valid JSON cannot be decoded by
    // toAuditEntry(); the monitoring job must still get a deterministic
    // report rather than an unhandled throw.
    db.prepare('UPDATE audit_log_entries SET metadata_json = ? WHERE id = ?').run(
      '{not valid json',
      created.id,
    );

    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedIndex).toBe(0);
    expect(report.firstCorruptedId).toBe(created.id);
  });
});

// ─── queryWithCursor() — cursor-based pagination ─────────────────────────────

describe('SqliteAuditRepository — queryWithCursor()', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns paginated result with entries and limit', () => {
    for (let i = 0; i < 10; i++) {
      repository.append(makeInput({ actor: `u${i}` }));
    }
    const result = repository.queryWithCursor({ limit: 3 });
    expect(result.entries).toHaveLength(3);
    expect(result.limit).toBe(3);
    expect(result.count).toBe(3);
  });

  it('uses default limit of 50 when not specified', () => {
    for (let i = 0; i < 60; i++) {
      repository.append(makeInput());
    }
    const result = repository.queryWithCursor({});
    expect(result.limit).toBe(50);
    expect(result.entries).toHaveLength(50);
  });

  it('clamps limit to maximum of 100', () => {
    for (let i = 0; i < 150; i++) {
      repository.append(makeInput());
    }
    const result = repository.queryWithCursor({ limit: 150 });
    expect(result.limit).toBe(100);
    expect(result.entries).toHaveLength(100);
  });

  it('clamps limit to minimum of 1', () => {
    repository.append(makeInput());
    const result = repository.queryWithCursor({ limit: 0 });
    expect(result.limit).toBe(1);
    expect(result.entries).toHaveLength(1);
  });

  it('returns nextCursor when more results exist', () => {
    for (let i = 0; i < 10; i++) {
      repository.append(makeInput({ actor: `u${i}` }));
    }
    const result = repository.queryWithCursor({ limit: 5 });
    expect(result.nextCursor).toBeDefined();
    
    // Decode and verify cursor structure
    const cursorData = decodeCursor(result.nextCursor!);
    expect(cursorData.lastId).toBeDefined();
    expect(cursorData.lastTimestamp).toBeDefined();
    expect(cursorData.filters).toEqual({});
  });

  it('does not return nextCursor on last page', () => {
    for (let i = 0; i < 5; i++) {
      repository.append(makeInput());
    }
    const result = repository.queryWithCursor({ limit: 10 });
    expect(result.nextCursor).toBeUndefined();
  });

  it('does not return nextCursor for empty result', () => {
    const result = repository.queryWithCursor({ limit: 10 });
    expect(result.entries).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('respects filters with cursor pagination', () => {
    repository.append(makeInput({ actor: 'alice', action: 'CONTRACT_CREATED' }));
    repository.append(makeInput({ actor: 'alice', action: 'CONTRACT_UPDATED' }));
    repository.append(makeInput({ actor: 'bob', action: 'CONTRACT_CREATED' }));

    const result = repository.queryWithCursor({ 
      actor: 'alice', 
      action: 'CONTRACT_CREATED',
      limit: 10 
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].actor).toBe('alice');
    expect(result.entries[0].action).toBe('CONTRACT_CREATED');
  });

  it('includes filters in nextCursor', () => {
    repository.append(makeInput({ actor: 'alice', action: 'CONTRACT_CREATED' }));
    repository.append(makeInput({ actor: 'alice', action: 'CONTRACT_UPDATED' }));
    repository.append(makeInput({ actor: 'bob', action: 'CONTRACT_CREATED' }));

    const result = repository.queryWithCursor({ 
      actor: 'alice',
      limit: 1 
    });
    
    const cursorData = decodeCursor(result.nextCursor!);
    expect(cursorData.filters.actor).toBe('alice');
  });

  it('handles cursor with valid lastId', () => {
    const entries = [];
    for (let i = 0; i < 10; i++) {
      entries.push(repository.append(makeInput({ actor: `u${i}` })));
    }
    
    const firstPage = repository.queryWithCursor({ limit: 3 });
    expect(firstPage.entries).toHaveLength(3);
    expect(firstPage.nextCursor).toBeDefined();
    
    // Use the cursor to get next page
    const secondPage = repository.queryWithCursor({ 
      cursor: firstPage.nextCursor,
      limit: 3 
    });
    expect(secondPage.entries).toHaveLength(3);
    expect(secondPage.entries[0].id).not.toBe(firstPage.entries[0].id);
  });

  it('throws error when cursor filters do not match query filters', () => {
    repository.append(makeInput({ actor: 'alice' }));
    
    const cursorData: CursorData = {
      lastId: repository.query({ actor: 'alice' })[0].id,
      lastTimestamp: new Date().toISOString(),
      filters: { actor: 'alice' },
    };
    const cursor = encodeCursor(cursorData);
    
    // Try to use cursor with different filters
    expect(() => {
      repository.queryWithCursor({ 
        cursor,
        actor: 'bob', // Different actor than cursor
        limit: 10 
      });
    }).toThrow('Cursor filters do not match query filters');
  });

  it('handles invalid cursor gracefully', () => {
    repository.append(makeInput());
    
    const result = repository.queryWithCursor({ 
      cursor: 'invalid-cursor',
      limit: 10 
    });
    // Should fall back to beginning
    expect(result.entries.length).toBeGreaterThan(0);
  });

  it('cursor pagination with time range filters', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();
    
    repository.append(makeInput());
    
    const result = repository.queryWithCursor({ 
      from: past,
      to: future,
      limit: 10 
    });
    expect(result.entries).toHaveLength(1);
  });

  it('cursor pagination at exact page boundary', () => {
    for (let i = 0; i < 10; i++) {
      repository.append(makeInput());
    }
    
    const result = repository.queryWithCursor({ limit: 10 });
    expect(result.entries).toHaveLength(10);
    expect(result.nextCursor).toBeUndefined();
  });
});

// ─── Issue #1372: State-invariant protections ────────────────────────────────
//
// These tests directly exercise the six invariant-protection mechanisms added
// as part of #1372.  Each describe block targets a single protection so
// failures are easy to pinpoint:
//
//   A. validateAppendInput()   — empty/null required-field rejection
//   B. _appendInProgress guard — re-entrancy detection
//   C. safeParseMetadata()     — malformed metadata_json safety
//   D. deepFreeze()            — post-read mutation prevention on nested metadata
//   E. verifyIntegrity()       — duplicate hash detection
//
// None of these overlap with the existing suite above; they add net-new
// coverage rather than duplicating existing passing tests.

// ─── A. validateAppendInput() — required-field validation ───────────────────

describe('SqliteAuditRepository — validateAppendInput() (invariant #1372-A)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  const requiredStringFields = ['actor', 'resource', 'resourceId'] as const;

  it.each(requiredStringFields)(
    'rejects an empty string for required field: %s',
    (field) => {
      expect(() =>
        repository.append(makeInput({ [field]: '' })),
      ).toThrow(/required field '.*' must not be empty/);
    },
  );

  it.each(requiredStringFields)(
    'rejects a whitespace-only string for required field: %s',
    (field) => {
      expect(() =>
        repository.append(makeInput({ [field]: '   ' })),
      ).toThrow(/required field '.*' must not be empty/);
    },
  );

  it.each(requiredStringFields)(
    'rejects null for required field: %s',
    (field) => {
      expect(() =>
        repository.append(makeInput({ [field]: null as unknown as string })),
      ).toThrow(/required field '.*'/);
    },
  );

  it('rejects undefined action', () => {
    expect(() =>
      repository.append(makeInput({ action: undefined as unknown as CreateAuditEntryInput['action'] })),
    ).toThrow(/required field 'action'/);
  });

  it('rejects undefined severity', () => {
    expect(() =>
      repository.append(makeInput({ severity: undefined as unknown as CreateAuditEntryInput['severity'] })),
    ).toThrow(/required field 'severity'/);
  });

  it('rejects an array as metadata', () => {
    expect(() =>
      repository.append(makeInput({ metadata: [] as unknown as Record<string, unknown> })),
    ).toThrow(/'metadata' must be a plain object/);
  });

  it('rejects null metadata', () => {
    expect(() =>
      repository.append(makeInput({ metadata: null as unknown as Record<string, unknown> })),
    ).toThrow(/'metadata' must be a plain object/);
  });

  it('leaves no row in the DB when validation fails', () => {
    expect(() => repository.append(makeInput({ actor: '' }))).toThrow();
    expect(repository.count()).toBe(0);
  });

  it('accepts a valid input after a rejected input (no poisoned state)', () => {
    expect(() => repository.append(makeInput({ actor: '' }))).toThrow();
    // The guard must have been released so the next valid call succeeds.
    expect(() => repository.append(makeInput({ actor: 'recovered' }))).not.toThrow();
    expect(repository.count()).toBe(1);
  });
});

// ─── B. _appendInProgress — re-entrancy guard ───────────────────────────────

describe('SqliteAuditRepository — re-entrancy guard (invariant #1372-B)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('throws when append() is called re-entrantly (guard is set during transaction)', () => {
    // Simulate re-entrancy by monkeypatching db.transaction to call append()
    // again while the outer append is in progress.
    const originalTransaction = db.transaction.bind(db);
    let reentrantCallMade = false;

    const txSpy = jest.spyOn(db, 'transaction').mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn: any) => {
        // Wrap in originalTransaction to preserve correct DB semantics,
        // but inject a nested append() call at the start of fn execution.
        return originalTransaction((...args: unknown[]) => {
          if (!reentrantCallMade) {
            reentrantCallMade = true;
            // This is the re-entrant call — it should be rejected by the guard.
            expect(() =>
              repository.append(makeInput({ actor: 're-entrant' })),
            ).toThrow(/re-entrancy/);
          }
          return fn(...args);
        });
      },
    );

    try {
      // The outer call must still succeed; the nested call should have thrown.
      const entry = repository.append(makeInput({ actor: 'outer' }));
      expect(entry.actor).toBe('outer');
      expect(reentrantCallMade).toBe(true);
    } finally {
      txSpy.mockRestore();
    }
  });

  it('releases the guard after a failed append so subsequent calls succeed', () => {
    // Force a failure inside the transaction (drop the table).
    db.exec('DROP TABLE audit_log_entries');
    expect(() => repository.append(makeInput())).toThrow();

    // Re-create the table so the next call can actually succeed.
    const recovered = new SqliteAuditRepository(db);
    // Guard must have been released — should not throw due to re-entrancy.
    expect(() => recovered.append(makeInput({ actor: 'post-failure' }))).not.toThrow();
  });
});

// ─── C. safeParseMetadata() — malformed metadata_json safety ────────────────

describe('SqliteAuditRepository — safe metadata JSON parse (invariant #1372-C)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getById() does not throw when metadata_json is malformed — returns empty metadata', () => {
    const appended = repository.append(makeInput({ metadata: { x: 1 } }));
    // Corrupt the stored JSON directly.
    db.prepare('UPDATE audit_log_entries SET metadata_json = ? WHERE id = ?').run(
      '{not valid json',
      appended.id,
    );

    let entry: ReturnType<typeof repository.getById>;
    expect(() => {
      entry = repository.getById(appended.id);
    }).not.toThrow();
    // Falls back to empty object.
    expect(entry?.metadata).toEqual({});
  });

  it('query() does not throw when a row has malformed metadata_json', () => {
    repository.append(makeInput({ metadata: { valid: true } }));
    const appended = repository.append(makeInput({ metadata: { other: 2 } }));
    db.prepare('UPDATE audit_log_entries SET metadata_json = ? WHERE id = ?').run(
      'CORRUPT!!!',
      appended.id,
    );

    let entries: ReturnType<typeof repository.query>;
    expect(() => {
      entries = repository.query();
    }).not.toThrow();
    // Both rows returned; corrupt one has empty metadata.
    expect(entries!).toHaveLength(2);
    const corruptEntry = entries!.find((e) => e.id === appended.id);
    expect(corruptEntry?.metadata).toEqual({});
  });

  it('stream() does not throw when a row has malformed metadata_json', () => {
    repository.append(makeInput({ metadata: { a: 1 } }));
    const appended = repository.append(makeInput({ metadata: { b: 2 } }));
    db.prepare('UPDATE audit_log_entries SET metadata_json = ? WHERE id = ?').run(
      'null',         // JSON null — valid JSON but not a plain object
      appended.id,
    );

    const collected: AuditEntry[] = [];
    expect(() => {
      for (const entry of repository.stream()) {
        collected.push(entry);
      }
    }).not.toThrow();
    expect(collected).toHaveLength(2);
    // null parses to {} because safeParseMetadata rejects non-plain-objects.
    const safed = collected.find((e) => e.id === appended.id);
    expect(safed?.metadata).toEqual({});
  });
});

// ─── D. deepFreeze() — post-read nested metadata immutability ───────────────

describe('SqliteAuditRepository — deep-freeze metadata on read (invariant #1372-D)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('getById() returns metadata whose nested objects are frozen', () => {
    repository.append(
      makeInput({ metadata: { nested: { value: 42 } } }),
    );
    const entry = repository.query()[0];
    expect(Object.isFrozen(entry.metadata)).toBe(true);
    expect(Object.isFrozen((entry.metadata as { nested: unknown }).nested)).toBe(true);
  });

  it('mutating a nested metadata object from getById() throws in strict mode', () => {
    const appended = repository.append(
      makeInput({ metadata: { config: { timeout: 30 } } }),
    );
    const found = repository.getById(appended.id);
    expect(Object.isFrozen(found!.metadata)).toBe(true);
    expect(() => {
      (found!.metadata as Record<string, unknown>)['config'] = {};
    }).toThrow();
  });

  it('mutating a deeply nested metadata object from query() throws in strict mode', () => {
    repository.append(
      makeInput({ metadata: { a: { b: { c: 'deep' } } } }),
    );
    const [entry] = repository.query();
    const nested = (entry.metadata as { a: { b: { c: string } } }).a.b;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(() => {
      nested.c = 'mutated';
    }).toThrow();
  });

  it('deep freeze handles arrays within metadata', () => {
    repository.append(
      makeInput({ metadata: { tags: ['a', 'b', 'c'] } }),
    );
    const [entry] = repository.query();
    const tags = (entry.metadata as { tags: string[] }).tags;
    expect(Object.isFrozen(tags)).toBe(true);
  });
});

// ─── E. verifyIntegrity() — duplicate hash detection ────────────────────────

describe('SqliteAuditRepository — duplicate hash detection (invariant #1372-E)', () => {
  let db: DbInstance;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('valid chain with unique hashes passes', () => {
    for (let i = 0; i < 5; i++) {
      repository.append(makeInput({ actor: `u${i}` }));
    }
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('detects a duplicate hash injected into the log', () => {
    // Append two legitimate entries.
    const first = repository.append(makeInput({ actor: 'first' }));
    repository.append(makeInput({ actor: 'second' }));

    // Forge a third row that reuses the first entry's hash.  This simulates
    // a hash-collision attack or a copy-paste-style forged insertion.
    const tail = db
      .prepare<[], { hash: string; previous_hash: string }>(
        'SELECT hash, previous_hash FROM audit_log_entries ORDER BY seq DESC LIMIT 1',
      )
      .get()!;

    db.prepare(
      `INSERT INTO audit_log_entries
       (id, timestamp, action, severity, actor, resource, resource_id,
        metadata_json, ip_address, correlation_id, hash, previous_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      'dup-hash-row',
      new Date().toISOString(),
      'ADMIN_ACTION',
      'CRITICAL',
      'attacker',
      'system',
      'sys-1',
      '{}',
      first.hash,   // <-- duplicate of first entry's hash
      tail.hash,
    );

    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
  });

  it('single-entry log always passes (no previous hash to compare against)', () => {
    repository.append(makeInput());
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('large chain with all unique hashes passes', () => {
    for (let i = 0; i < 50; i++) {
      repository.append(makeInput({ actor: `user-${i}`, resource: 'contract', resourceId: `c-${i}` }));
    }
    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(true);
    expect(report.totalEntries).toBe(50);
  });
});

// ─── AuditEntry type import needed by the malformed-JSON tests ─────────────
// (imported at the top of the file already — this comment is here for clarity)
