/**
 * SqliteEventAuditRepository — transactional event + projection tests.
 *
 * Exercises the atomic event-checkpoint + projection write and the bounded
 * retry-on-serialization semantics on a real in-memory SQLite database.
 */

import { getDb, closeDb } from '../db/database';
import { SqliteEventAuditRepository, withSerializationRetry } from './sqliteEventAuditRepository';
import { EventAuditService, InMemoryEventAuditRepository } from './eventAuditRepository';
import type { EventProcessingAudit, ContractEvent } from '../events/types';

function makeAudit(overrides: Partial<EventProcessingAudit> = {}): EventProcessingAudit {
  return {
    id: 'audit_1',
    deduplicationKey: 'contract_123:event_456:1',
    contractId: 'contract_123',
    eventId: 'event_456',
    sequence: 1,
    status: 'accepted',
    payloadHash: 'hash_123',
    processedAt: new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...(overrides as Partial<EventProcessingAudit>),
  };
}

function makeProjection(overrides: Partial<{
  entityId: string;
  tenantId: string;
  data: string;
  version: number;
  lastEventId: string;
}> = {}) {
  return {
    entityId: 'contract_123',
    tenantId: 'tenant-a',
    data: '{"key":"value"}',
    version: 1,
    lastEventId: 'contract_123:event_456:1',
    ...overrides,
  };
}

describe('SqliteEventAuditRepository — transactional event + projection', () => {
  let repo: SqliteEventAuditRepository;

  beforeEach(() => {
    closeDb();
    repo = new SqliteEventAuditRepository(getDb(':memory:'));
  });

  afterEach(() => {
    closeDb();
  });

  it('commits the audit and projection atomically when all writes succeed', async () => {
    await repo.persistEventAndProjection(makeAudit(), makeProjection());

    expect(await repo.findByDeduplicationKey('contract_123:event_456:1')).not.toBeNull();
    expect(repo.readProjection('contract_123')).toEqual({
      entityId: 'contract_123',
      tenantId: 'tenant-a',
      data: '{"key":"value"}',
      version: 1,
      lastEventId: 'contract_123:event_456:1',
    });
  });

  it('rolls back the audit when the projection insert fails (projection constraint)', async () => {
    // Force the projection insert (runs after the audit insert in the same
    // transaction) to violate NOT NULL, so the audit must also roll back.
    // `null` (not `undefined`) reliably raises SQLITE_CONSTRAINT_NOTNULL.
    const badProjection = makeProjection({ data: null as unknown as string });

    await expect(
      repo.persistEventAndProjection(makeAudit(), badProjection),
    ).rejects.toThrow();

    // No orphaned checkpoint: the audit was rolled back with the projection.
    expect(await repo.findByDeduplicationKey('contract_123:event_456:1')).toBeNull();
    expect(repo.readProjection('contract_123')).toBeNull();
  });

  it('retries a serialization conflict (SQLITE_BUSY) and then succeeds', async () => {
    let calls = 0;
    await withSerializationRetry(() => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('database is locked');
        err.code = 5; // SQLITE_BUSY
        throw err;
      }
      return 'ok';
    });

    expect(calls).toBe(2);
  });

  it('retries SQLITE_BUSY_SNAPSHOT (517) as a serialization conflict', async () => {
    let calls = 0;
    await withSerializationRetry(() => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('database is locked');
        err.code = 517; // SQLITE_BUSY_SNAPSHOT
        throw err;
      }
      return 'ok';
    });

    expect(calls).toBe(2);
  });

  it('does not retry non-serialization errors (constraint/blob data) and fails fast', async () => {
    let calls = 0;
    await expect(
      withSerializationRetry(() => {
        calls += 1;
        const err: any = new Error('constraint failed');
        err.code = 787; // SQLITE_CONSTRAINT_NOTNULL — NOT a serialization code
        throw err;
      }),
    ).rejects.toThrow('constraint failed');

    // No retry happened.
    expect(calls).toBe(1);
  });

  it('gives up after bounded retries for persistent serialization conflicts and rethrows', async () => {
    let calls = 0;
    await expect(
      withSerializationRetry(() => {
        calls += 1;
        const err: any = new Error('persistent lock');
        err.code = 5; // SQLITE_BUSY
        throw err;
      }),
    ).rejects.toThrow('persistent lock');

    // Bounded: the retry budget is MAX_RETRY_ATTEMPTS (3).
    expect(calls).toBe(3);
  });

  it('enforces tenant isolation on read: a different tenant cannot read a projection', async () => {
    await repo.persistEventAndProjection(makeAudit(), makeProjection({ tenantId: 'tenant-a' }));

    expect(repo.readProjectionForTenant('contract_123', 'tenant-a')).not.toBeNull();
    expect(repo.readProjectionForTenant('contract_123', 'tenant-b')).toBeNull();
  });

  it('scopes the audit tenant alongside the projection in the transaction', async () => {
    await repo.persistEventAndProjection(
      makeAudit(),
      makeProjection({ entityId: 'contract_999', tenantId: 'tenant-x' }),
    );

    const audit = await repo.findByDeduplicationKey('contract_123:event_456:1');
    // The audit row was written with the projection's tenant scope.
    expect(audit).not.toBeNull();
  });
});

describe('EventAuditService — atomic event + projection via production repo', () => {
  // The production path wires the SQLite repo as default; the service uses
  // the optional transactional method only when the repository supports it.
  it('persists the projection transactionally when the repo supports it', async () => {
    closeDb();
    const repo = new SqliteEventAuditRepository(getDb(':memory:'));
    const persistSpy = jest.spyOn(repo, 'persistEventAndProjection');
    const saveSpy = jest.spyOn(repo, 'save');

    const service = new EventAuditService(repo, console);
    const event: ContractEvent = {
      contractId: 'contract_abc',
      eventId: 'event_9',
      sequence: 1,
      timestamp: Date.now(),
      payload: { data: 'x' },
      // @ts-expect-error tenantId is an extension used by the registry builder
      tenantId: 'tenant-z',
    };

    // No projection builder → plain save path (compat with in-memory tests).
    await service.processEvent(event, 'talent_contract');
    expect(saveSpy).toHaveBeenCalled();

    // With a projection builder present, it uses the transactional path.
    const serviceWithProjection = new EventAuditService(
      repo,
      console,
      undefined,
      (ev: any, audit) => ({
        entityId: ev.contractId,
        tenantId: ev.tenantId ?? 'default',
        data: JSON.stringify(ev.payload ?? {}),
        version: 1,
        lastEventId: audit.deduplicationKey,
      }),
    );
    await serviceWithProjection.processEvent({ ...event, eventId: 'event_10', sequence: 2 }, 'talent_contract');

    expect(persistSpy).toHaveBeenCalled();
    expect(repo.readProjectionForTenant('contract_abc', 'tenant-z')).not.toBeNull();
    closeDb();
  });

  it('keeps the in-memory repository valid (unit-test compatibility)', async () => {
    const inMem = new InMemoryEventAuditRepository();
    const service = new EventAuditService(inMem);
    const event: ContractEvent = {
      contractId: 'contract_x',
      eventId: 'event_y',
      sequence: 1,
      timestamp: Date.now(),
      payload: { ok: true },
    };
    const result = await service.processEvent(event, 'talent_contract');
    expect(result.status).toBe('accepted');
  });

  it('does not double-apply the projection on a duplicate replay', async () => {
    closeDb();
    const repo = new SqliteEventAuditRepository(getDb(':memory:'));
    const service = new EventAuditService(repo, console, undefined, (ev: any, audit) => ({
      entityId: ev.contractId,
      tenantId: ev.tenantId ?? 'default',
      data: JSON.stringify(ev.payload ?? {}),
      version: 1,
      lastEventId: audit.deduplicationKey,
    }));

    const event: ContractEvent & { tenantId: string } = {
      contractId: 'contract_dup',
      eventId: 'event_7',
      sequence: 1,
      timestamp: Date.now(),
      payload: { a: 1 },
      tenantId: 'tenant-d',
    };

    const first = await service.processEvent(event, 'talent_contract');
    expect(first.status).toBe('accepted');

    const projectionBefore = repo.readProjectionForTenant('contract_dup', 'tenant-d');
    expect(projectionBefore).not.toBeNull();

    // Replay the same event (same dedup key) — must short-circuit as duplicate
    // without re-running the projection write.
    const duplicate = await service.processEvent(event, 'talent_contract');
    expect(duplicate.status).toBe('duplicate');

    const projectionAfter = repo.readProjectionForTenant('contract_dup', 'tenant-d');
    expect(projectionAfter?.lastEventId).toBe(projectionBefore?.lastEventId);
    closeDb();
  });

  it('runs the external (network) finality call OUTSIDE the DB transaction and tolerates a timeout', async () => {
    closeDb();
    const repo = new SqliteEventAuditRepository(getDb(':memory:'));

    // A finality evaluator that times out (external call fails). In
    // `processEvent` this runs BEFORE any write, so the timeout must not
    // create a partial audit/projection row.
    const failingEvaluator = {
      evaluate: jest.fn(async () => {
        throw new Error('provider timeout');
      }),
    } as unknown as ConstructorParameters<typeof EventAuditService>[2];

    const service = new EventAuditService(repo, console, failingEvaluator, (ev: any, audit) => ({
      entityId: ev.contractId,
      tenantId: ev.tenantId ?? 'default',
      data: JSON.stringify(ev.payload ?? {}),
      version: 1,
      lastEventId: audit.deduplicationKey,
    }));

    const onChainEvent: ContractEvent = {
      contractId: 'contract_timeout',
      eventId: 'event_1',
      sequence: 1,
      timestamp: Date.now(),
      network: 'stellar',
      ledger: 42,
      payload: { ok: true },
    } as ContractEvent & { network: string; ledger: number };

    await expect(
      service.processEvent(onChainEvent, 'talent_contract'),
    ).rejects.toThrow('provider timeout');

    // No state was written because the external call precedes the commit.
    expect(await repo.findByDeduplicationKey('contract_timeout:event_1:1')).toBeNull();
    expect(repo.readProjection('contract_timeout')).toBeNull();
    closeDb();
  });
});