import Database from 'better-sqlite3';
import { SqliteAuditRepository } from './sqliteRepository';
import type { CreateAuditEntryInput } from './types';

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

describe('SqliteAuditRepository', () => {
  let db: Database.Database;
  let repository: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it('appends and reads entries', () => {
    const created = repository.append(makeInput());
    const found = repository.getById(created.id);

    expect(found?.id).toBe(created.id);
    expect(repository.count()).toBe(1);
  });

  it('builds a valid hash chain', () => {
    const first = repository.append(makeInput());
    const second = repository.append(makeInput({ action: 'CONTRACT_UPDATED' }));

    expect(second.previousHash).toBe(first.hash);
    expect(repository.verifyIntegrity().valid).toBe(true);
  });

  it('queries with filters and pagination', () => {
    repository.append(makeInput({ actor: 'alice' }));
    repository.append(makeInput({ actor: 'bob', action: 'AUTH_FAILED', severity: 'WARNING' }));

    const filtered = repository.query({ actor: 'alice' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].actor).toBe('alice');

    const paged = repository.query({ limit: 1, offset: 1 });
    expect(paged).toHaveLength(1);
  });

  it('streams entries incrementally', () => {
    repository.append(makeInput({ resourceId: 'c-1' }));
    repository.append(makeInput({ resourceId: 'c-2' }));
    repository.append(makeInput({ resourceId: 'c-3' }));

    const stream = repository.stream({ limit: 2 });
    const first = stream.next();
    const second = stream.next();
    const third = stream.next();

    expect(first.value?.resourceId).toBe('c-1');
    expect(second.value?.resourceId).toBe('c-2');
    expect(third.done).toBe(true);
  });

  it('detects tampering during integrity verification', () => {
    const created = repository.append(makeInput());
    db.prepare('UPDATE audit_log_entries SET hash = ? WHERE id = ?').run('bad'.padEnd(64, '0'), created.id);

    const report = repository.verifyIntegrity();
    expect(report.valid).toBe(false);
    expect(report.firstCorruptedId).toBe(created.id);
  });
});
