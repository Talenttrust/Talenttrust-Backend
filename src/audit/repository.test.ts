/**
 * @file repository.test.ts
 * @description Focused coverage for the audit storage failure-recovery contract
 * in `./repository.ts` (issue #1353).
 *
 * The scenarios map one-to-one onto the contract documented in that module:
 *
 * | Test group                       | Contract clause                                  |
 * |----------------------------------|--------------------------------------------------|
 * | configuration resolution         | unknown values fail fast with a typed error      |
 * | path resolution                  | empty `AUDIT_DB_PATH` cannot crash start-up      |
 * | dependency failure               | typed `AuditStorageError`, no path in the message |
 * | retry                            | only provably rolled-back failures are retried   |
 * | partial completion + recovery    | a failed write lands in the fallback, not nowhere |
 * | concurrency                      | retries cannot duplicate an entry                |
 * | user-visible / operator-visible  | stable codes, sanitized logs, health snapshot    |
 */

import path from 'path';
import { Registry } from 'prom-client';
import {
  AUDIT_STORAGE_BACKENDS,
  AUDIT_STORAGE_ERROR_CODES,
  AUDIT_STORAGE_FALLBACKS,
  AuditStorageError,
  DEFAULT_AUDIT_STORAGE_APPEND_ATTEMPTS,
  FallbackAuditRepository,
  RetryingAuditRepository,
  createAuditStorageMetrics,
  createDefaultAuditRepository,
  getAuditRepositoryStatus,
  isRetryableStorageError,
  openSqliteAuditRepository,
  resolveAuditDbPath,
  resolveAuditStorageAppendAttempts,
  resolveAuditStorageBackend,
  resolveAuditStorageFallback,
  type AuditLogRepository,
  type AuditStorageMetrics,
  type AuditStorageRetryOptions,
} from './repository';
import { AuditStore, auditStore } from './store';
import { writeRecordImpl, setWriteRecordImpl } from '../logger';
import type { AuditEntry, AuditQuery, AuditQueryResult, CreateAuditEntryInput } from './types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A SQLite-shaped failure: better-sqlite3 puts `SQLITE_*` in `code`. */
function sqliteError(code: string): Error {
  const error = new Error(`SqliteError: ${code}: /srv/audit/secret-path.db is not a database`);
  (error as Error & { code: string }).code = code;
  return error;
}

function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: {},
    ...overrides,
  };
}

/** Collects log records instead of writing them, so assertions can inspect them. */
interface CapturedLog {
  events: Array<{ message: string; fields: Record<string, unknown> }>;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function captureLog(): CapturedLog {
  const events: CapturedLog['events'] = [];
  const record = (message: string, fields?: Record<string, unknown>): void => {
    events.push({ message, fields: fields ?? {} });
  };

  return {
    events,
    info: record,
    warn: record,
    error: record,
  };
}

function eventNames(log: CapturedLog): string[] {
  return log.events.map((event) => event.message);
}

/**
 * In-memory stand-in for a repository, scriptable per call: an entry in
 * `script` is thrown instead of writing, `undefined` writes normally. Backed
 * by a real {@link AuditStore} so chain integrity is meaningful rather than
 * asserted against a stub.
 */
function makeFakeRepository(script?: Array<Error | undefined>): AuditLogRepository & {
  appendCalls: number;
  entries: AuditEntry[];
} {
  const store = new AuditStore();
  const pending = [...(script ?? [])];

  const fake = {
    appendCalls: 0,
    entries: [] as AuditEntry[],
    append(input: CreateAuditEntryInput): AuditEntry {
      fake.appendCalls += 1;
      const failure = pending.shift();
      if (failure) throw failure;
      const entry = store.append(input);
      fake.entries.push(entry);
      return entry;
    },
    getById(id: string): AuditEntry | undefined {
      return store.getById(id);
    },
    query(query?: AuditQuery): AuditEntry[] {
      return store.query(query);
    },
    queryWithCursor(query?: AuditQuery): AuditQueryResult {
      return store.queryWithCursor(query);
    },
    *stream(query?: AuditQuery): IterableIterator<AuditEntry> {
      yield* store.stream(query);
    },
    count(): number {
      return store.count();
    },
    verifyIntegrity() {
      return store.verifyIntegrity();
    },
  };

  return fake;
}

function metricsFixture(): AuditStorageMetrics {
  return createAuditStorageMetrics(new Registry());
}

/** Reads a counter's value out of a fixture registry. */
async function counterValue(
  metrics: AuditStorageMetrics,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const text = await metrics.registry.metrics();
  const line = text
    .split('\n')
    .find((entry) => entry.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => entry.includes(`${k}="${v}"`)));
  if (!line) return 0;
  return Number(line.trim().split(/\s+/).pop());
}

// ── Configuration resolution ─────────────────────────────────────────────────

describe('resolveAuditStorageBackend', () => {
  it('defaults to memory when unset', () => {
    expect(resolveAuditStorageBackend({})).toBe('memory');
  });

  it.each(AUDIT_STORAGE_BACKENDS)('accepts the %s backend', (backend) => {
    expect(resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: backend })).toBe(backend);
  });

  it('tolerates surrounding whitespace and letter case', () => {
    expect(resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: ' SQLite ' })).toBe('sqlite');
    expect(resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: 'MEMORY' })).toBe('memory');
  });

  it('treats an empty value as unset rather than as a configuration error', () => {
    expect(resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: '' })).toBe('memory');
    expect(resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: '   ' })).toBe('memory');
  });

  it.each(['postgres', 'sql', 'sqlite3', 'memory,sqlite'])(
    'rejects the unknown backend %p with a typed error',
    (value) => {
      try {
        resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: value });
        throw new Error('expected resolveAuditStorageBackend to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AuditStorageError);
        expect((error as AuditStorageError).code).toBe(
          AUDIT_STORAGE_ERROR_CODES.UNSUPPORTED_BACKEND,
        );
        // Message text is preserved verbatim for existing log greps.
        expect((error as AuditStorageError).message).toBe(
          `Unsupported AUDIT_STORAGE_BACKEND: ${value}`,
        );
      }
    },
  );

  it('is still catchable as a plain Error', () => {
    expect(() => resolveAuditStorageBackend({ AUDIT_STORAGE_BACKEND: 'nope' })).toThrow(Error);
  });
});

describe('resolveAuditStorageFallback', () => {
  it('defaults to none so a durable failure is never silently downgraded', () => {
    expect(resolveAuditStorageFallback({})).toBe('none');
  });

  it.each(AUDIT_STORAGE_FALLBACKS)('accepts the %s policy', (policy) => {
    expect(resolveAuditStorageFallback({ AUDIT_STORAGE_FALLBACK: policy })).toBe(policy);
  });

  it('normalises case and treats an empty value as unset', () => {
    expect(resolveAuditStorageFallback({ AUDIT_STORAGE_FALLBACK: ' MEMORY ' })).toBe('memory');
    expect(resolveAuditStorageFallback({ AUDIT_STORAGE_FALLBACK: '' })).toBe('none');
  });

  it('rejects an unknown policy with a typed error', () => {
    try {
      resolveAuditStorageFallback({ AUDIT_STORAGE_FALLBACK: 'sqlite' });
      throw new Error('expected resolveAuditStorageFallback to throw');
    } catch (error) {
      expect((error as AuditStorageError).code).toBe(
        AUDIT_STORAGE_ERROR_CODES.UNSUPPORTED_FALLBACK,
      );
    }
  });
});

describe('resolveAuditStorageAppendAttempts', () => {
  it('defaults when unset', () => {
    expect(resolveAuditStorageAppendAttempts({})).toBe(DEFAULT_AUDIT_STORAGE_APPEND_ATTEMPTS);
  });

  it.each(['1', '3', '10', ' 4 '])('accepts %p', (value) => {
    expect(resolveAuditStorageAppendAttempts({ AUDIT_STORAGE_APPEND_ATTEMPTS: value })).toBe(
      Number(value.trim()),
    );
  });

  it.each(['0', '-1', '11', 'abc', '2.5', ''])(
    'rejects the unusable value %p instead of silently defaulting',
    (value) => {
      try {
        resolveAuditStorageAppendAttempts({ AUDIT_STORAGE_APPEND_ATTEMPTS: value });
        throw new Error('expected resolveAuditStorageAppendAttempts to throw');
      } catch (error) {
        expect((error as AuditStorageError).code).toBe(
          AUDIT_STORAGE_ERROR_CODES.INVALID_CONFIG,
        );
      }
    },
  );
});

describe('resolveAuditDbPath', () => {
  it('prefers an explicit AUDIT_DB_PATH', () => {
    expect(resolveAuditDbPath({ AUDIT_DB_PATH: '/data/audit.db' })).toBe('/data/audit.db');
  });

  it.each(['', '   '])(
    'falls back to the default when AUDIT_DB_PATH is %p',
    (value) => {
      // An empty variable previously reached the driver verbatim, which failed
      // to open and took the process down at start-up.
      expect(resolveAuditDbPath({ AUDIT_DB_PATH: value, NODE_ENV: 'production' })).toBe(
        path.join(process.cwd(), 'talenttrust-audit.db'),
      );
    },
  );

  it('uses an in-memory database under NODE_ENV=test', () => {
    expect(resolveAuditDbPath({ NODE_ENV: 'test' })).toBe(':memory:');
  });
});

// ── Retry classification ─────────────────────────────────────────────────────

describe('isRetryableStorageError', () => {
  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_PROTOCOL'])(
    'retries %s, which is rolled back before the error surfaces',
    (code) => {
      expect(isRetryableStorageError(sqliteError(code))).toBe(true);
    },
  );

  it.each([
    'SQLITE_IOERR',
    'SQLITE_FULL',
    'SQLITE_READONLY',
    'SQLITE_CONSTRAINT',
    'SQLITE_CORRUPT',
  ])('does not retry %s, whose commit may already be on disk', (code) => {
    expect(isRetryableStorageError(sqliteError(code))).toBe(false);
  });

  it.each([
    ['a plain Error', new Error('boom')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    [
      'an already-classified AuditStorageError',
      new AuditStorageError(AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED, 'x'),
    ],
  ])('does not retry %s', (_label, error) => {
    expect(isRetryableStorageError(error)).toBe(false);
  });
});

// ── Dependency failure: construction ─────────────────────────────────────────

describe('createDefaultAuditRepository — memory backend', () => {
  it('returns the shared singleton so existing in-memory entries survive', () => {
    const repository = createDefaultAuditRepository({ env: {} });
    expect(repository).toBe(auditStore);

    const entry = repository.append(makeInput({ resourceId: 'pre-existing' }));
    const reloaded = createDefaultAuditRepository({ env: { AUDIT_STORAGE_BACKEND: 'memory' } });

    expect(reloaded.getById(entry.id)).toBeDefined();
  });

  it('reports a healthy status for a repository without a status() member', () => {
    const status = getAuditRepositoryStatus(new AuditStore(), 'memory');
    expect(status).toMatchObject({ backend: 'memory', durable: false, health: 'ok' });
    expect(status.fallbackActivations).toBe(0);
  });
});

describe('createDefaultAuditRepository — sqlite backend', () => {
  const env = { AUDIT_STORAGE_BACKEND: 'sqlite', AUDIT_DB_PATH: '/srv/audit/secret-path.db' };

  it('wraps a healthy backend in the retrying repository', () => {
    const fake = makeFakeRepository();
    const repository = createDefaultAuditRepository({
      env,
      openSqlite: () => fake,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    expect(repository).toBeInstanceOf(RetryingAuditRepository);
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      backend: 'sqlite',
      durable: true,
      health: 'ok',
    });
  });

  it('propagates every read and write to the underlying repository', () => {
    const fake = makeFakeRepository();
    const repository = createDefaultAuditRepository({
      env,
      openSqlite: () => fake,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    const entry = repository.append(makeInput());

    expect(repository.getById(entry.id)).toEqual(entry);
    expect(repository.query()).toHaveLength(1);
    expect(repository.queryWithCursor()).toMatchObject({ count: 1, limit: 50 });
    expect([...repository.stream()]).toHaveLength(1);
    expect(repository.count()).toBe(1);
    expect(repository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
  });

  it('throws a typed open_failed error when the dependency cannot be opened', () => {
    const cause = sqliteError('SQLITE_CANTOPEN');

    try {
      createDefaultAuditRepository({
        env,
        openSqlite: () => {
          throw cause;
        },
        metrics: metricsFixture(),
        log: captureLog(),
      });
      throw new Error('expected createDefaultAuditRepository to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuditStorageError);
      expect((error as AuditStorageError).code).toBe(AUDIT_STORAGE_ERROR_CODES.OPEN_FAILED);
      expect((error as AuditStorageError).cause).toBe(cause);
      // The operator learns the driver code from the log, never from the API.
      expect((error as AuditStorageError).message).toBe(
        'Audit storage backend could not be opened',
      );
      expect((error as AuditStorageError).message).not.toContain('/srv');
    }
  });

  it('rethrows an AuditStorageError from a custom opener unchanged', () => {
    const thrown = new AuditStorageError(AUDIT_STORAGE_ERROR_CODES.OPEN_FAILED, 'custom');
    expect(() =>
      createDefaultAuditRepository({
        env,
        openSqlite: () => {
          throw thrown;
        },
      }),
    ).toThrow(thrown);
  });
});

// ── Retry ────────────────────────────────────────────────────────────────────

describe('RetryingAuditRepository — retry', () => {
  function build(
    failures: Error[],
    maxAttempts: number,
  ): { repository: RetryingAuditRepository; fake: ReturnType<typeof makeFakeRepository>; metrics: AuditStorageMetrics; log: CapturedLog } {
    const fake = makeFakeRepository(failures);
    const metrics = metricsFixture();
    const log = captureLog();
    const options: AuditStorageRetryOptions = { maxAttempts, dbPath: '/srv/audit/app.db', metrics, log };
    return {
      repository: new RetryingAuditRepository(fake, 'sqlite', options),
      fake,
      metrics,
      log,
    };
  }

  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])('recovers transparently from a transient %s', (code) => {
    const { repository, fake, log } = build([sqliteError(code)], 2);

    const entry = repository.append(makeInput());

    expect(entry).toBeDefined();
    expect(fake.appendCalls).toBe(2);
    expect(fake.entries).toHaveLength(1);
    const status = getAuditRepositoryStatus(repository);
    expect(status).toMatchObject({
      health: 'ok',
      appendAttempts: 2,
      appendRetries: 1,
      appendFailures: 0,
    });
    // A recovered append must not leave a failure code behind for the next
    // health probe to trip over.
    expect(status.lastFailureCode).toBeUndefined();
    expect(eventNames(log)).toEqual(['audit_storage_append_retry']);
  });

  it('reports a retry without disclosing the database directory', () => {
    const { repository, log } = build([sqliteError('SQLITE_BUSY')], 2);
    repository.append(makeInput());

    const retry = log.events[0];
    expect(retry.fields).toMatchObject({ backend: 'sqlite', dbFile: 'app.db', driverCode: 'SQLITE_BUSY' });
    expect(JSON.stringify(retry.fields)).not.toContain('/srv');
  });

  it('counts retries in the metric sink', async () => {
    const { repository, metrics } = build([sqliteError('SQLITE_BUSY')], 2);
    repository.append(makeInput());

    expect(await counterValue(metrics, 'audit_storage_append_retries_total', { backend: 'sqlite', driver_code: 'SQLITE_BUSY' })).toBe(1);
    expect(await counterValue(metrics, 'audit_storage_append_attempts_total', { backend: 'sqlite' })).toBe(2);
    expect(await counterValue(metrics, 'audit_storage_append_failures_total', { backend: 'sqlite' })).toBe(0);
  });

  it('fails after exhausting its attempts, with nothing half-written', () => {
    const busy = sqliteError('SQLITE_BUSY');
    const { repository, fake, log } = build([busy, busy, busy], 2);

    try {
      repository.append(makeInput());
      throw new Error('expected append to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuditStorageError);
      expect((error as AuditStorageError).code).toBe(AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED);
      expect((error as AuditStorageError).attempts).toBe(2);
      expect((error as AuditStorageError).cause).toBe(busy);
    }

    expect(fake.appendCalls).toBe(2);
    expect(fake.entries).toHaveLength(0);
    expect(eventNames(log)).toEqual([
      'audit_storage_append_retry',
      'audit_storage_append_failed',
    ]);
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      appendFailures: 1,
      lastFailureCode: AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED,
    });
  });

  it('never retries a non-retryable failure', () => {
    const { repository, fake, log } = build([sqliteError('SQLITE_READONLY'), sqliteError('SQLITE_BUSY')], 2);

    expect(() => repository.append(makeInput())).toThrow(AuditStorageError);
    expect(fake.appendCalls).toBe(1);
    expect(eventNames(log)).toEqual(['audit_storage_append_failed']);
  });

  it('performs no retry when configured for a single attempt', () => {
    const { repository, fake } = build([sqliteError('SQLITE_BUSY')], 1);

    expect(() => repository.append(makeInput())).toThrow(AuditStorageError);
    expect(fake.appendCalls).toBe(1);
  });

  it('never surfaces a driver message to the caller', () => {
    const { repository } = build([sqliteError('SQLITE_BUSY')], 1);

    try {
      repository.append(makeInput());
      throw new Error('expected append to throw');
    } catch (error) {
      expect((error as Error).message).toBe(
        'Audit entry could not be persisted after 1 attempt(s)',
      );
    }
  });

  it('keeps every concurrent append distinct and the chain intact', async () => {
    // append() is synchronous by contract, so "concurrent" callers serialise;
    // this pins that no interleaving can fork the chain or duplicate an entry.
    const fake = makeFakeRepository();
    const repository = new RetryingAuditRepository(fake, 'sqlite', {
      maxAttempts: 2,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    await Promise.all(
      Array.from({ length: 25 }, async (_unused, index) => {
        await new Promise((resolve) => setImmediate(resolve));
        return repository.append(makeInput({ resourceId: `contract-${index}` }));
      }),
    );

    expect(fake.entries).toHaveLength(25);
    expect(new Set(fake.entries.map((entry) => entry.id)).size).toBe(25);
    expect(fake.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 25 });
  });
});

// ── Partial failure and recovery ─────────────────────────────────────────────

describe('FallbackAuditRepository — degradation and recovery', () => {
  function build(
    primaryScript: Array<Error | undefined>,
  ): {
    repository: FallbackAuditRepository;
    primary: ReturnType<typeof makeFakeRepository>;
    fallback: AuditStore;
    metrics: AuditStorageMetrics;
    log: CapturedLog;
  } {
    const primary = makeFakeRepository(primaryScript);
    const fallback = new AuditStore();
    const metrics = metricsFixture();
    const log = captureLog();
    const repository = new FallbackAuditRepository(primary, fallback, 'sqlite', '/srv/audit/app.db', {
      metrics,
      log,
      now: () => new Date('2026-03-01T00:00:00.000Z'),
    });
    return { repository, primary, fallback, metrics, log };
  }

  it('writes to the durable backend while it is healthy', () => {
    const { repository, primary, fallback } = build([]);

    const entry = repository.append(makeInput());

    expect(primary.entries).toEqual([entry]);
    expect(fallback.count()).toBe(0);
    expect(repository.isDegraded).toBe(false);
    expect(repository.activeBackend).toBe('sqlite');
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      backend: 'sqlite',
      durable: true,
      health: 'ok',
      fallbackActivations: 0,
      fallbackWrites: 0,
    });
  });

  it('recovers a failed write into the fallback instead of losing it', () => {
    const { repository, primary, fallback } = build([sqliteError('SQLITE_READONLY')]);

    const entry = repository.append(makeInput());

    expect(primary.appendCalls).toBe(1);
    expect(fallback.count()).toBe(1);
    expect(fallback.getById(entry.id)).toEqual(entry);
    expect(repository.isDegraded).toBe(true);
    expect(repository.activeBackend).toBe('memory');
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      backend: 'memory',
      durable: false,
      health: 'degraded',
      degradedSince: '2026-03-01T00:00:00.000Z',
      fallbackActivations: 1,
      fallbackWrites: 1,
      lastFailureCode: AUDIT_STORAGE_ERROR_CODES.APPEND_FAILED,
    });
    // The fallback chain is internally consistent even though it is not durable.
    expect(repository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
  });

  it('preserves entries already persisted before degrading', () => {
    const { repository, primary, fallback } = build([undefined, sqliteError('SQLITE_READONLY')]);

    const durable = repository.append(makeInput({ resourceId: 'before-failure' }));
    const volatile = repository.append(makeInput({ resourceId: 'after-failure' }));

    // Both are retained: the first in the durable chain, the second in memory.
    expect(primary.getById(durable.id)).toBeDefined();
    expect(fallback.getById(volatile.id)).toBeDefined();
    expect(primary.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
    expect(repository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
  });

  it('serves reads and writes from one source once degraded', () => {
    const { repository } = build([sqliteError('SQLITE_READONLY')]);

    const entry = repository.append(makeInput());
    repository.append(makeInput({ resourceId: 'contract-2' }));

    // A repository that wrote to memory but read from SQLite would report the
    // entry it just accepted as missing.
    expect(repository.getById(entry.id)).toEqual(entry);
    expect(repository.query()).toHaveLength(2);
    expect(repository.count()).toBe(2);
    expect([...repository.stream()]).toHaveLength(2);
    expect(repository.queryWithCursor()).toMatchObject({ count: 2 });
  });

  it('engages the fallback once, however many writes fail afterwards', () => {
    const { repository, log } = build([sqliteError('SQLITE_READONLY')]);

    repository.append(makeInput());
    repository.append(makeInput({ resourceId: 'contract-2' }));
    repository.append(makeInput({ resourceId: 'contract-3' }));

    expect(getAuditRepositoryStatus(repository).fallbackActivations).toBe(1);
    expect(eventNames(log)).toEqual(['audit_storage_degraded']);
  });

  it('records the first degradation with sanitized diagnostics', () => {
    const { repository, log } = build([sqliteError('SQLITE_READONLY')]);
    repository.append(makeInput());

    const degraded = log.events[0];
    expect(degraded.fields).toMatchObject({
      backend: 'sqlite',
      dbFile: 'app.db',
      driverCode: 'SQLITE_READONLY',
      activeBackend: 'memory',
      durable: false,
    });
    expect(JSON.stringify(degraded.fields)).not.toContain('/srv');
  });

  it('counts degradation and fallback writes', async () => {
    const { repository, metrics } = build([sqliteError('SQLITE_READONLY')]);
    repository.append(makeInput());
    repository.append(makeInput({ resourceId: 'contract-2' }));

    expect(await counterValue(metrics, 'audit_storage_fallback_activations_total', { backend: 'sqlite' })).toBe(1);
    expect(await counterValue(metrics, 'audit_storage_fallback_writes_total', { backend: 'sqlite' })).toBe(2);
  });

  it('can be degraded explicitly by a supervisor', () => {
    const { repository, fallback } = build([]);

    repository.degrade();

    expect(repository.isDegraded).toBe(true);
    repository.append(makeInput());
    expect(fallback.count()).toBe(1);
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      fallbackActivations: 1,
      lastFailureCode: AUDIT_STORAGE_ERROR_CODES.DEPENDENCY_FAILED,
    });
  });

  it('surfaces a typed error when the fallback itself cannot accept a write', () => {
    const metrics = metricsFixture();
    const log = captureLog();
    const repository = new FallbackAuditRepository(
      new RetryingAuditRepository(
        makeFakeRepository([sqliteError('SQLITE_READONLY')]),
        'sqlite',
        { maxAttempts: 1, metrics, log: captureLog() },
      ),
      makeFakeRepository([new Error('memory exhausted')]),
      'sqlite',
      '/srv/audit/app.db',
      { metrics, log },
    );

    try {
      repository.append(makeInput());
      throw new Error('expected append to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AuditStorageError);
      expect((error as AuditStorageError).code).toBe(
        AUDIT_STORAGE_ERROR_CODES.WRITE_UNAVAILABLE,
      );
    }

    expect(eventNames(log)).toContain('audit_storage_write_unavailable');
    expect(getAuditRepositoryStatus(repository).health).toBe('degraded');
  });
});

// ── Opt-in degradation at construction ───────────────────────────────────────

describe('createDefaultAuditRepository — AUDIT_STORAGE_FALLBACK=memory', () => {
  const baseEnv = { AUDIT_STORAGE_BACKEND: 'sqlite', AUDIT_DB_PATH: '/srv/audit/app.db' };

  it('serves from memory when the durable backend cannot be opened', () => {
    const fallback = new AuditStore();
    const repository = createDefaultAuditRepository({
      env: { ...baseEnv, AUDIT_STORAGE_FALLBACK: 'memory' },
      openSqlite: () => {
        throw sqliteError('SQLITE_CANTOPEN');
      },
      fallbackRepository: fallback,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    expect(repository).toBeInstanceOf(FallbackAuditRepository);
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      backend: 'memory',
      durable: false,
      health: 'degraded',
      fallbackActivations: 1,
    });

    const entry = repository.append(makeInput());
    expect(fallback.getById(entry.id)).toEqual(entry);
    expect(repository.verifyIntegrity()).toMatchObject({ valid: true, totalEntries: 1 });
  });

  it('keeps entries that were already in memory before the open failure', () => {
    const fallback = new AuditStore();
    const before = fallback.append(makeInput({ resourceId: 'written-earlier' }));

    const repository = createDefaultAuditRepository({
      env: { ...baseEnv, AUDIT_STORAGE_FALLBACK: 'memory' },
      openSqlite: () => {
        throw sqliteError('SQLITE_CANTOPEN');
      },
      fallbackRepository: fallback,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    // Nothing already recorded may vanish because the durable backend failed.
    expect(repository.getById(before.id)).toEqual(before);
    expect(repository.count()).toBe(1);
  });

  it('records one sanitized diagnostic for a failed start-up', () => {
    const log = captureLog();

    createDefaultAuditRepository({
      env: { ...baseEnv, AUDIT_STORAGE_FALLBACK: 'memory' },
      openSqlite: () => {
        throw sqliteError('SQLITE_CANTOPEN');
      },
      fallbackRepository: new AuditStore(),
      metrics: metricsFixture(),
      log,
    });

    // One record, not two: degrade() is the single reporting point.
    expect(eventNames(log)).toEqual(['audit_storage_degraded']);
    expect(log.events[0].fields).toMatchObject({
      code: AUDIT_STORAGE_ERROR_CODES.OPEN_FAILED,
      driverCode: 'SQLITE_CANTOPEN',
      dbFile: 'app.db',
      activeBackend: 'memory',
      durable: false,
    });
    expect(JSON.stringify(log.events[0].fields)).not.toContain('/srv');
  });

  it('retries transient append failures against the durable backend when healthy', () => {
    const primary = makeFakeRepository([sqliteError('SQLITE_BUSY')]);
    const fallback = new AuditStore();
    const repository = createDefaultAuditRepository({
      env: { ...baseEnv, AUDIT_STORAGE_FALLBACK: 'memory' },
      openSqlite: () => primary,
      fallbackRepository: fallback,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    const entry = repository.append(makeInput());

    expect(primary.entries).toEqual([entry]);
    expect(fallback.count()).toBe(0);
    expect(getAuditRepositoryStatus(repository).health).toBe('ok');
  });

  it('degrades mid-flight and keeps writing rather than dropping the entry', () => {
    const primary = makeFakeRepository([sqliteError('SQLITE_READONLY')]);
    const fallback = new AuditStore();
    const repository = createDefaultAuditRepository({
      env: { ...baseEnv, AUDIT_STORAGE_FALLBACK: 'memory' },
      openSqlite: () => primary,
      fallbackRepository: fallback,
      metrics: metricsFixture(),
      log: captureLog(),
    });

    const entry = repository.append(makeInput());

    expect(fallback.getById(entry.id)).toEqual(entry);
    expect(getAuditRepositoryStatus(repository)).toMatchObject({
      health: 'degraded',
      fallbackWrites: 1,
    });
  });
});

// ── Observability of the module logger ───────────────────────────────────────

describe('openSqliteAuditRepository', () => {
  let previousImpl: typeof writeRecordImpl;

  beforeEach(() => {
    previousImpl = writeRecordImpl;
  });

  afterEach(() => {
    setWriteRecordImpl(previousImpl);
  });

  it('logs the driver code and file name, never the database path', () => {
    const records: Array<Record<string, unknown>> = [];
    setWriteRecordImpl((record) => {
      records.push(record as unknown as Record<string, unknown>);
    });

    // A directory cannot be opened as a database file.
    expect(() => openSqliteAuditRepository('/srv/audit')).toThrow(AuditStorageError);

    const openFailure = records.find((record) => record['message'] === 'audit_storage_open_failed');
    expect(openFailure).toBeDefined();
    expect(openFailure).toMatchObject({ backend: 'sqlite', dbFile: 'audit' });
    expect(openFailure?.['driverCode']).toBe('SQLITE_CANTOPEN');
    expect(JSON.stringify(openFailure)).not.toContain('/srv/audit"');
    expect(String(openFailure?.['dbFile'])).toBe('audit');
  });
});
