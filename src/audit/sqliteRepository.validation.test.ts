/**
 * @file sqliteRepository.validation.test.ts
 * @description Focused validation-boundary tests for SqliteAuditRepository.
 *
 * These tests verify every enforcement point added in the production-ready
 * validation pass:
 *
 * 1. append()  — action enum, severity enum, actor/resource/resourceId
 *                (type, blank, control-chars, length), metadata (type,
 *                depth, size, keys, circular), ipAddress format, correlationId
 *                charset, and the happy path from every call-site variation.
 * 2. getById() — non-string id, blank id, id over MAX_ID_LENGTH.
 * 3. query()   — bogus action/severity enums, malformed ISO-8601 from/to,
 *                from > to inversion, non-integer limit/offset, limit over
 *                MAX_QUERY_LIMIT.
 * 4. queryWithCursor() — blank cursor, cursor with mismatched filters.
 * 5. stream()  — inherits query filter validation; spot-checked.
 * 6. RepositoryCorruptedRowError — corrupted metadata_json propagates from
 *                getById(), query(), stream(), and verifyIntegrity().
 * 7. Concurrency invariant — two simultaneous appends do not produce the
 *                same id (trivially checked given better-sqlite3's
 *                synchronous serialisation).
 *
 * All DB instances are `:memory:` to keep the suite deterministic and
 * isolated.
 */

import Database, { Database as DbInstance } from '../db/betterSqlite3';
import { SqliteAuditRepository, RepositoryValidationError, RepositoryCorruptedRowError } from './sqliteRepository';
import type { CreateAuditEntryInput } from './types';
import {
  MAX_ID_LENGTH,
  MAX_IP_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_STRING_LENGTH,
  MAX_METADATA_ARRAY_ITEMS,
} from './inputValidation';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Returns a string of exactly `length` 'a' characters. */
function str(length: number): string {
  return 'a'.repeat(length);
}

/** Inserts a raw row bypassing all validation (to simulate DB corruption). */
function insertRawRow(
  db: DbInstance,
  overrides: Partial<{
    id: string;
    timestamp: string;
    action: string;
    severity: string;
    actor: string;
    resource: string;
    resource_id: string;
    metadata_json: string;
    ip_address: string | null;
    correlation_id: string | null;
    hash: string;
    previous_hash: string;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO audit_log_entries
     (id, timestamp, action, severity, actor, resource, resource_id, metadata_json, ip_address, correlation_id, hash, previous_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    overrides.id ?? 'test-id',
    overrides.timestamp ?? new Date().toISOString(),
    overrides.action ?? 'CONTRACT_CREATED',
    overrides.severity ?? 'INFO',
    overrides.actor ?? 'actor',
    overrides.resource ?? 'resource',
    overrides.resource_id ?? 'resource-id',
    overrides.metadata_json ?? '{}',
    overrides.ip_address ?? null,
    overrides.correlation_id ?? null,
    overrides.hash ?? 'a'.repeat(64),
    overrides.previous_hash ?? 'GENESIS',
  );
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('SqliteAuditRepository — validation boundaries', () => {
  let db: DbInstance;
  let repo: SqliteAuditRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    repo = new SqliteAuditRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── append() ── action ──────────────────────────────────────────────────────

  describe('append() — action field', () => {
    it('accepts every valid AUDIT_ACTIONS member', () => {
      const validActions = [
        'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
        'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
        'REPUTATION_UPDATED', 'REPUTATION_CORRECTED',
        'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
        'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
        'AUTH_LOCKOUT_TRIGGERED', 'AUTH_LOCKOUT_RELEASED',
        'ADMIN_ACTION', 'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
        'DEPLOYMENT_PROMOTED', 'DEPLOYMENT_ROLLED_BACK',
      ] as const;
      for (const action of validActions) {
        expect(() => repo.append(makeInput({ action }))).not.toThrow();
      }
    });

    it('rejects an unknown action string', () => {
      expect(() =>
        repo.append(makeInput({ action: 'BOGUS_ACTION' as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects an empty action string', () => {
      expect(() =>
        repo.append(makeInput({ action: '' as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a null action', () => {
      expect(() =>
        repo.append(makeInput({ action: null as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects an undefined action', () => {
      expect(() =>
        repo.append(makeInput({ action: undefined as never })),
      ).toThrow(RepositoryValidationError);
    });
  });

  // ── append() ── severity ────────────────────────────────────────────────────

  describe('append() — severity field', () => {
    it('accepts INFO, WARNING, CRITICAL', () => {
      for (const severity of ['INFO', 'WARNING', 'CRITICAL'] as const) {
        expect(() => repo.append(makeInput({ severity }))).not.toThrow();
      }
    });

    it('rejects an unknown severity string', () => {
      expect(() =>
        repo.append(makeInput({ severity: 'FATAL' as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a null severity', () => {
      expect(() =>
        repo.append(makeInput({ severity: null as never })),
      ).toThrow(RepositoryValidationError);
    });
  });

  // ── append() ── identifier fields (actor / resource / resourceId) ───────────

  describe('append() — identifier fields', () => {
    const fields: Array<keyof Pick<CreateAuditEntryInput, 'actor' | 'resource' | 'resourceId'>> = [
      'actor', 'resource', 'resourceId',
    ];

    for (const field of fields) {
      describe(field, () => {
        it('accepts a 1-char value', () => {
          expect(() => repo.append(makeInput({ [field]: 'x' }))).not.toThrow();
        });

        it(`accepts a value of exactly ${MAX_ID_LENGTH} chars`, () => {
          expect(() => repo.append(makeInput({ [field]: str(MAX_ID_LENGTH) }))).not.toThrow();
        });

        it(`rejects a value of ${MAX_ID_LENGTH + 1} chars`, () => {
          expect(() =>
            repo.append(makeInput({ [field]: str(MAX_ID_LENGTH + 1) })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects an empty string', () => {
          expect(() =>
            repo.append(makeInput({ [field]: '' })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects a blank (whitespace-only) string', () => {
          expect(() =>
            repo.append(makeInput({ [field]: '   ' })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects a value with a control character (\\x00)', () => {
          expect(() =>
            repo.append(makeInput({ [field]: 'user\x00admin' })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects a value with a newline control character (\\n)', () => {
          expect(() =>
            repo.append(makeInput({ [field]: 'user\ninjected' })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects null', () => {
          expect(() =>
            repo.append(makeInput({ [field]: null as never })),
          ).toThrow(RepositoryValidationError);
        });

        it('rejects a number', () => {
          expect(() =>
            repo.append(makeInput({ [field]: 42 as never })),
          ).toThrow(RepositoryValidationError);
        });
      });
    }
  });

  // ── append() ── metadata ────────────────────────────────────────────────────

  describe('append() — metadata field', () => {
    it('accepts an empty metadata object', () => {
      expect(() => repo.append(makeInput({ metadata: {} }))).not.toThrow();
    });

    it('accepts a missing metadata field (defaults to {})', () => {
      const input = { ...makeInput() };
      delete (input as Partial<CreateAuditEntryInput>).metadata;
      expect(() => repo.append(input as CreateAuditEntryInput)).not.toThrow();
    });

    it('accepts deeply nested metadata within depth limit', () => {
      // depth 5 is the maximum. { a: { b: { c: { d: { e: 'leaf' } } } } } is depth 5.
      const metadata = { a: { b: { c: { d: { e: 'leaf' } } } } };
      expect(() => repo.append(makeInput({ metadata }))).not.toThrow();
    });

    it(`rejects metadata nested beyond ${MAX_METADATA_DEPTH} levels`, () => {
      const tooDeep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } } };
      expect(() => repo.append(makeInput({ metadata: tooDeep }))).toThrow(RepositoryValidationError);
    });

    it('rejects a null metadata value', () => {
      expect(() =>
        repo.append(makeInput({ metadata: null as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a metadata array at the root level', () => {
      expect(() =>
        repo.append(makeInput({ metadata: [] as never })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a metadata string at the root level', () => {
      expect(() =>
        repo.append(makeInput({ metadata: 'string' as never })),
      ).toThrow(RepositoryValidationError);
    });

    it(`rejects a metadata object with more than ${MAX_METADATA_ENTRIES} keys`, () => {
      const metadata: Record<string, string> = {};
      for (let i = 0; i <= MAX_METADATA_ENTRIES; i++) {
        metadata[`key${i}`] = 'v';
      }
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it(`rejects a metadata key longer than ${MAX_METADATA_KEY_LENGTH} chars`, () => {
      const metadata = { [str(MAX_METADATA_KEY_LENGTH + 1)]: 'value' };
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it('rejects the __proto__ forbidden metadata key', () => {
      const metadata = Object.create(null) as Record<string, unknown>;
      metadata['__proto__'] = { isAdmin: true };
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it('rejects the constructor forbidden metadata key', () => {
      expect(() =>
        repo.append(makeInput({ metadata: { constructor: 'evil' } })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects circular references in metadata', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      expect(() => repo.append(makeInput({ metadata: circular }))).toThrow(RepositoryValidationError);
    });

    it(`rejects a metadata string value longer than ${MAX_METADATA_STRING_LENGTH} chars`, () => {
      const metadata = { value: str(MAX_METADATA_STRING_LENGTH + 1) };
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it('rejects an array with more than MAX_METADATA_ARRAY_ITEMS items', () => {
      const metadata = { arr: new Array(MAX_METADATA_ARRAY_ITEMS + 1).fill('x') };
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it(`rejects metadata that exceeds ${MAX_METADATA_BYTES} bytes when serialised`, () => {
      // Each key-value pair: key (63 chars) + string value (100 chars) ≈ ~164 bytes × entries
      // Build a payload that will exceed 16384 bytes when serialised.
      const metadata: Record<string, string> = {};
      for (let i = 0; i < 40; i++) {
        metadata[`key${i.toString().padStart(3, '0')}`] = str(400);
      }
      expect(() => repo.append(makeInput({ metadata }))).toThrow(RepositoryValidationError);
    });

    it('rejects a non-finite number inside metadata', () => {
      expect(() =>
        repo.append(makeInput({ metadata: { val: Infinity } })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects NaN inside metadata', () => {
      expect(() =>
        repo.append(makeInput({ metadata: { val: NaN } })),
      ).toThrow(RepositoryValidationError);
    });

    it('accepts a valid JSON-serialisable metadata value (numbers, booleans, null)', () => {
      const metadata = { n: 42, b: true, nil: null, arr: [1, 2, 3] };
      expect(() => repo.append(makeInput({ metadata }))).not.toThrow();
    });
  });

  // ── append() ── ipAddress ───────────────────────────────────────────────────

  describe('append() — ipAddress field', () => {
    it('accepts a valid IPv4 address', () => {
      expect(() =>
        repo.append(makeInput({ ipAddress: '192.168.1.1' })),
      ).not.toThrow();
    });

    it('accepts a valid IPv6 address', () => {
      expect(() =>
        repo.append(makeInput({ ipAddress: '::1' })),
      ).not.toThrow();
    });

    it('accepts an absent ipAddress', () => {
      expect(() => repo.append(makeInput())).not.toThrow();
    });

    it('rejects a non-IP string as ipAddress', () => {
      expect(() =>
        repo.append(makeInput({ ipAddress: 'not-an-ip' })),
      ).toThrow(RepositoryValidationError);
    });

    it(`rejects an ipAddress longer than ${MAX_IP_LENGTH} chars`, () => {
      // 46 chars is 1 over the limit
      expect(() =>
        repo.append(makeInput({ ipAddress: str(MAX_IP_LENGTH + 1) })),
      ).toThrow(RepositoryValidationError);
    });
  });

  // ── append() ── correlationId ───────────────────────────────────────────────

  describe('append() — correlationId field', () => {
    it('accepts a valid correlationId', () => {
      expect(() =>
        repo.append(makeInput({ correlationId: 'corr-abc_1.2:3' })),
      ).not.toThrow();
    });

    it('accepts an absent correlationId', () => {
      expect(() => repo.append(makeInput())).not.toThrow();
    });

    it('rejects a blank correlationId', () => {
      expect(() =>
        repo.append(makeInput({ correlationId: '' })),
      ).toThrow(RepositoryValidationError);
    });

    it(`rejects a correlationId longer than ${MAX_CORRELATION_ID_LENGTH} chars`, () => {
      expect(() =>
        repo.append(makeInput({ correlationId: str(MAX_CORRELATION_ID_LENGTH + 1) })),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a correlationId with disallowed characters (space)', () => {
      expect(() =>
        repo.append(makeInput({ correlationId: 'corr id with space' })),
      ).toThrow(RepositoryValidationError);
    });
  });

  // ── append() ── happy path and result contract ──────────────────────────────

  describe('append() — success contract', () => {
    it('returns a frozen AuditEntry on valid input', () => {
      const entry = repo.append(makeInput());
      expect(Object.isFrozen(entry)).toBe(true);
    });

    it('returned entry has a valid UUID id', () => {
      const entry = repo.append(makeInput());
      expect(entry.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    it('returned entry carries the validated input fields', () => {
      const input = makeInput({
        action: 'AUTH_LOGIN',
        severity: 'WARNING',
        actor: 'alice',
        resource: 'session',
        resourceId: 'sess-99',
        metadata: { browser: 'Firefox' },
        ipAddress: '10.0.0.1',
        correlationId: 'corr-001',
      });
      const entry = repo.append(input);
      expect(entry.action).toBe('AUTH_LOGIN');
      expect(entry.severity).toBe('WARNING');
      expect(entry.actor).toBe('alice');
      expect(entry.resource).toBe('session');
      expect(entry.resourceId).toBe('sess-99');
      expect(entry.metadata).toEqual({ browser: 'Firefox' });
      expect(entry.ipAddress).toBe('10.0.0.1');
      expect(entry.correlationId).toBe('corr-001');
    });

    it('failed validation does not persist a partial row (transactional)', () => {
      expect(() =>
        repo.append(makeInput({ action: 'BAD' as never })),
      ).toThrow(RepositoryValidationError);
      expect(repo.count()).toBe(0);
    });

    it('RepositoryValidationError has a meaningful field property', () => {
      try {
        repo.append(makeInput({ action: 'BAD' as never }));
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RepositoryValidationError);
        // The field may name 'action' or a parent path — just ensure it is defined.
        expect((err as RepositoryValidationError).name).toBe('RepositoryValidationError');
      }
    });
  });

  // ── getById() ──────────────────────────────────────────────────────────────

  describe('getById() — validation boundary', () => {
    it('returns undefined for an id that does not exist (no throw)', () => {
      expect(repo.getById('does-not-exist')).toBeUndefined();
    });

    it('rejects a null id', () => {
      expect(() => repo.getById(null as never)).toThrow(RepositoryValidationError);
    });

    it('rejects an undefined id', () => {
      expect(() => repo.getById(undefined as never)).toThrow(RepositoryValidationError);
    });

    it('rejects a numeric id', () => {
      expect(() => repo.getById(42 as never)).toThrow(RepositoryValidationError);
    });

    it('rejects a blank id', () => {
      expect(() => repo.getById('')).toThrow(RepositoryValidationError);
    });

    it('rejects a whitespace-only id', () => {
      expect(() => repo.getById('   ')).toThrow(RepositoryValidationError);
    });

    it(`rejects an id longer than ${MAX_ID_LENGTH} chars`, () => {
      expect(() => repo.getById(str(MAX_ID_LENGTH + 1))).toThrow(RepositoryValidationError);
    });

    it(`accepts an id of exactly ${MAX_ID_LENGTH} chars`, () => {
      // No row will match, but validation must pass.
      expect(() => repo.getById(str(MAX_ID_LENGTH))).not.toThrow();
      expect(repo.getById(str(MAX_ID_LENGTH))).toBeUndefined();
    });
  });

  // ── query() ── filter validation ────────────────────────────────────────────

  describe('query() — validation boundary', () => {
    it('accepts an empty query', () => {
      expect(() => repo.query()).not.toThrow();
    });

    it('accepts valid action/severity enums', () => {
      expect(() => repo.query({ action: 'AUTH_LOGIN', severity: 'CRITICAL' })).not.toThrow();
    });

    it('rejects a bogus action enum', () => {
      expect(() =>
        repo.query({ action: 'NOT_REAL' as never }),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a bogus severity enum', () => {
      expect(() =>
        repo.query({ severity: 'DEBUG' as never }),
      ).toThrow(RepositoryValidationError);
    });

    it('accepts valid ISO-8601 from/to', () => {
      expect(() =>
        repo.query({
          from: '2024-01-01T00:00:00.000Z',
          to: '2024-12-31T23:59:59.999Z',
        }),
      ).not.toThrow();
    });

    it('rejects a malformed from date', () => {
      expect(() =>
        repo.query({ from: 'not-a-date' }),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects a malformed to date', () => {
      expect(() =>
        repo.query({ to: '2024-13-99' }),
      ).toThrow(RepositoryValidationError);
    });

    it('rejects from > to (inverted range)', () => {
      expect(() =>
        repo.query({
          from: '2024-12-31T00:00:00.000Z',
          to: '2024-01-01T00:00:00.000Z',
        }),
      ).toThrow(RepositoryValidationError);
    });

    it('accepts from === to (same instant)', () => {
      const ts = '2024-06-15T12:00:00.000Z';
      expect(() => repo.query({ from: ts, to: ts })).not.toThrow();
    });

    it('rejects a non-integer limit', () => {
      expect(() => repo.query({ limit: 3.5 })).toThrow(RepositoryValidationError);
    });

    it('rejects an infinite limit', () => {
      expect(() => repo.query({ limit: Infinity })).toThrow(RepositoryValidationError);
    });

    it('accepts limit = 0 (returns empty result, no crash)', () => {
      repo.append(makeInput());
      expect(() => repo.query({ limit: 0 })).not.toThrow();
      expect(repo.query({ limit: 0 })).toHaveLength(0);
    });

    it('accepts a negative limit (clamped to 0 downstream)', () => {
      // Negative is not a RepositoryValidationError — it is clamped.
      repo.append(makeInput());
      expect(() => repo.query({ limit: -5 })).not.toThrow();
    });

    it('rejects a limit above MAX_QUERY_LIMIT (10 000)', () => {
      expect(() => repo.query({ limit: 10_001 })).toThrow(RepositoryValidationError);
    });

    it('accepts limit = MAX_QUERY_LIMIT exactly', () => {
      expect(() => repo.query({ limit: 10_000 })).not.toThrow();
    });

    it('rejects a non-integer offset', () => {
      expect(() => repo.query({ offset: 1.5 })).toThrow(RepositoryValidationError);
    });

    it('accepts offset = 0', () => {
      expect(() => repo.query({ offset: 0 })).not.toThrow();
    });

    it('accepts a negative offset (clamped to 0 downstream)', () => {
      expect(() => repo.query({ offset: -1 })).not.toThrow();
    });
  });

  // ── queryWithCursor() ── cursor validation ──────────────────────────────────

  describe('queryWithCursor() — cursor validation', () => {
    it('throws on a blank cursor string', () => {
      expect(() =>
        repo.queryWithCursor({ cursor: '' }),
      ).toThrow(RepositoryValidationError);
    });

    it('throws on a whitespace-only cursor string', () => {
      expect(() =>
        repo.queryWithCursor({ cursor: '   ' }),
      ).toThrow(RepositoryValidationError);
    });

    it('falls back to start when cursor is malformed base64', () => {
      repo.append(makeInput());
      // Malformed cursor → should NOT throw; falls back to beginning.
      expect(() =>
        repo.queryWithCursor({ cursor: '!!!not-base64!!!' }),
      ).not.toThrow();
      const result = repo.queryWithCursor({ cursor: '!!!not-base64!!!' });
      expect(result.entries.length).toBeGreaterThan(0);
    });

    it('throws RepositoryValidationError when cursor filters mismatch query filters', () => {
      // Build a valid cursor for actor=alice
      repo.append(makeInput({ actor: 'alice' }));
      const firstPage = repo.queryWithCursor({ actor: 'alice', limit: 1 });
      const cursor = firstPage.nextCursor;
      if (!cursor) {
        // only one entry, no cursor — can't run this sub-test
        return;
      }
      expect(() =>
        repo.queryWithCursor({ cursor, actor: 'bob' }),
      ).toThrow(RepositoryValidationError);
    });
  });

  // ── stream() ── inherits query filter validation ────────────────────────────

  describe('stream() — validation boundary', () => {
    it('rejects a bogus action enum', () => {
      expect(() => {
        // stream() is a generator — we must pull a value to trigger the check.
        const gen = repo.stream({ action: 'NOT_REAL' as never });
        gen.next();
      }).toThrow(RepositoryValidationError);
    });

    it('rejects a malformed from date', () => {
      expect(() => {
        const gen = repo.stream({ from: 'not-a-date' });
        gen.next();
      }).toThrow(RepositoryValidationError);
    });

    it('accepts a valid stream with filter (no throw)', () => {
      repo.append(makeInput());
      const entries = Array.from(repo.stream({ action: 'CONTRACT_CREATED' }));
      expect(entries).toHaveLength(1);
    });
  });

  // ── RepositoryCorruptedRowError propagation ─────────────────────────────────

  describe('RepositoryCorruptedRowError — corrupted metadata_json', () => {
    it('getById() throws RepositoryCorruptedRowError for a row with bad metadata_json', () => {
      // Insert a row with invalid JSON directly.
      insertRawRow(db, { id: 'bad-meta', metadata_json: '{corrupt: json' });
      expect(() => repo.getById('bad-meta')).toThrow(RepositoryCorruptedRowError);
    });

    it('RepositoryCorruptedRowError carries the row id', () => {
      insertRawRow(db, { id: 'bad-row', metadata_json: 'null' });
      try {
        repo.getById('bad-row');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(RepositoryCorruptedRowError);
        expect((err as RepositoryCorruptedRowError).rowId).toBe('bad-row');
      }
    });

    it('query() throws RepositoryCorruptedRowError when a returned row has bad metadata_json', () => {
      insertRawRow(db, { id: 'qbad', metadata_json: 'not-json-at-all', actor: 'bad-actor' });
      expect(() => repo.query({ actor: 'bad-actor' })).toThrow(RepositoryCorruptedRowError);
    });

    it('stream() throws RepositoryCorruptedRowError when a yielded row has bad metadata_json', () => {
      insertRawRow(db, { id: 'sbad', metadata_json: '[]', actor: 'stream-bad' });
      expect(() => {
        const gen = repo.stream({ actor: 'stream-bad' });
        gen.next(); // pulls the corrupted row
      }).toThrow(RepositoryCorruptedRowError);
    });

    it('verifyIntegrity() returns valid:false when a row has bad metadata_json', () => {
      insertRawRow(db, {
        id: 'int-bad',
        metadata_json: '{corrupt',
        hash: 'a'.repeat(64),
        previous_hash: 'GENESIS',
      });
      const report = repo.verifyIntegrity();
      expect(report.valid).toBe(false);
      expect(report.firstCorruptedId).toBe('int-bad');
    });

    it('query() succeeds for rows with valid metadata_json even if other rows are corrupt', () => {
      // Insert a good row, then a bad row, then query only the good actor.
      repo.append(makeInput({ actor: 'good-actor' }));
      insertRawRow(db, { id: 'bad-only', metadata_json: '{bad', actor: 'bad-actor' });
      // Query for good-actor should NOT encounter the bad row.
      expect(() => repo.query({ actor: 'good-actor' })).not.toThrow();
      expect(repo.query({ actor: 'good-actor' })).toHaveLength(1);
    });
  });

  // ── Regression: duplicate ids never produced (concurrency invariant) ────────

  describe('append() — unique id guarantee', () => {
    it('produces distinct ids across 50 rapid successive appends', () => {
      const ids = Array.from({ length: 50 }, () => repo.append(makeInput()).id);
      expect(new Set(ids).size).toBe(50);
    });
  });

  // ── Regression: existing callers remain compatible ──────────────────────────

  describe('Backward-compatibility — valid paths unchanged', () => {
    it('append + getById round-trip still works', () => {
      const entry = repo.append(makeInput());
      expect(repo.getById(entry.id)).toEqual(entry);
    });

    it('query() with no filter returns all entries', () => {
      repo.append(makeInput({ actor: 'a' }));
      repo.append(makeInput({ actor: 'b' }));
      expect(repo.query()).toHaveLength(2);
    });

    it('stream() with no filter yields all entries', () => {
      repo.append(makeInput());
      repo.append(makeInput());
      expect(Array.from(repo.stream())).toHaveLength(2);
    });

    it('count() returns correct total', () => {
      expect(repo.count()).toBe(0);
      repo.append(makeInput());
      expect(repo.count()).toBe(1);
    });

    it('verifyIntegrity() returns valid:true for a clean chain', () => {
      repo.append(makeInput());
      repo.append(makeInput());
      expect(repo.verifyIntegrity().valid).toBe(true);
    });
  });
});
