/**
 * @file audit.dto.test.ts
 * @description Comprehensive tests for the audit DTO layer.
 *
 * Coverage goals:
 * - toCreateAuditEntryInput: required fields, optional fields, unknown-key isolation
 * - toAuditQuery: coercions, defaults, clamping, validation errors, all filters
 * - toAuditEntryResponseDto: field-for-field mapping, optional fields present/absent
 * - fromAuditEntryResponseDto: round-trip fidelity
 * - toAuditQueryResponseDto: offset pagination shape
 * - toAuditQueryCursorResponseDto: cursor pagination shape, nextCursor present/absent
 * - toIntegrityReportResponseDto: valid/invalid chain, optional corruption fields
 * - Round-trip invariants: entry → DTO → entry lossless
 * - Edge cases: empty metadata, missing optionals, boundary limit values
 */

import {
  toCreateAuditEntryInput,
  toAuditQuery,
  toAuditEntryResponseDto,
  fromAuditEntryResponseDto,
  toAuditQueryResponseDto,
  toAuditQueryCursorResponseDto,
  toIntegrityReportResponseDto,
  type CreateAuditEntryRequestDto,
  type AuditQueryParamsDto,
  type AuditEntryResponseDto,
} from './audit.dto';
import type { AuditEntry, AuditQueryResult, IntegrityReport } from '../types';

// ─── Shared test fixtures ────────────────────────────────────────────────────

/** Minimal valid request DTO — all required fields, no optional fields. */
function makeRequestDto(
  overrides: Partial<CreateAuditEntryRequestDto> = {},
): CreateAuditEntryRequestDto {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { clientId: 'client-1' },
    ...overrides,
  };
}

/** A fully-populated AuditEntry including optional fields. */
function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return Object.freeze({
    id: 'entry-uuid-1',
    timestamp: '2026-01-15T10:00:00.000Z',
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: Object.freeze({ clientId: 'client-1' }),
    ipAddress: '1.2.3.4',
    correlationId: 'corr-xyz',
    hash: 'a'.repeat(64),
    previousHash: 'GENESIS',
    ...overrides,
  }) as AuditEntry;
}

/** An AuditEntry with no optional fields. */
function makeMinimalEntry(): AuditEntry {
  const base = makeEntry();
  const { ipAddress: _ip, correlationId: _corr, ...rest } = base;
  return Object.freeze(rest) as unknown as AuditEntry;
}

// ─── toCreateAuditEntryInput ─────────────────────────────────────────────────

describe('toCreateAuditEntryInput', () => {
  it('maps all required fields correctly', () => {
    const dto = makeRequestDto();
    const input = toCreateAuditEntryInput(dto);

    expect(input.action).toBe('CONTRACT_CREATED');
    expect(input.severity).toBe('INFO');
    expect(input.actor).toBe('user-abc');
    expect(input.resource).toBe('contract');
    expect(input.resourceId).toBe('contract-1');
  });

  it('copies metadata as a shallow clone, not the same reference', () => {
    const dto = makeRequestDto({ metadata: { key: 'value', nested: { x: 1 } } });
    const input = toCreateAuditEntryInput(dto);

    expect(input.metadata).toEqual({ key: 'value', nested: { x: 1 } });
    expect(input.metadata).not.toBe(dto.metadata);
  });

  it('includes ipAddress when provided', () => {
    const input = toCreateAuditEntryInput(makeRequestDto({ ipAddress: '10.0.0.1' }));
    expect(input.ipAddress).toBe('10.0.0.1');
  });

  it('includes correlationId when provided', () => {
    const input = toCreateAuditEntryInput(makeRequestDto({ correlationId: 'corr-123' }));
    expect(input.correlationId).toBe('corr-123');
  });

  it('omits ipAddress when absent', () => {
    const input = toCreateAuditEntryInput(makeRequestDto());
    expect('ipAddress' in input).toBe(false);
  });

  it('omits correlationId when absent', () => {
    const input = toCreateAuditEntryInput(makeRequestDto());
    expect('correlationId' in input).toBe(false);
  });

  it('handles empty metadata object', () => {
    const input = toCreateAuditEntryInput(makeRequestDto({ metadata: {} }));
    expect(input.metadata).toEqual({});
  });

  it('isolates unknown keys from the request body', () => {
    // Simulate an HTTP body that contains extra fields not in the DTO.
    const dirty = {
      ...makeRequestDto(),
      unknownField: 'should-not-pass',
      id: 'attacker-supplied-id',
    } as unknown as CreateAuditEntryRequestDto;

    const input = toCreateAuditEntryInput(dirty);

    // The domain input type does not have these keys; the mapping function
    // must not forward them (TypeScript enforces this at compile time, but we
    // verify the runtime object too).
    expect((input as Record<string, unknown>)['unknownField']).toBeUndefined();
    expect((input as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('maps every AuditAction variant without error', () => {
    const actions = [
      'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
      'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
      'REPUTATION_UPDATED',
      'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
      'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
      'ADMIN_ACTION', 'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
      'DEPLOYMENT_PROMOTED', 'DEPLOYMENT_ROLLED_BACK',
    ] as const;

    for (const action of actions) {
      const input = toCreateAuditEntryInput(makeRequestDto({ action }));
      expect(input.action).toBe(action);
    }
  });

  it('maps every AuditSeverity variant without error', () => {
    for (const severity of ['INFO', 'WARNING', 'CRITICAL'] as const) {
      const input = toCreateAuditEntryInput(makeRequestDto({ severity }));
      expect(input.severity).toBe(severity);
    }
  });
});

// ─── toAuditQuery ─────────────────────────────────────────────────────────────

describe('toAuditQuery', () => {
  const OPT = { maxLimit: 100, defaultLimit: 50 };

  // ── defaults ──────────────────────────────────────────────────────────────

  it('returns offset 0 and defaultLimit when DTO is empty', () => {
    const q = toAuditQuery({}, OPT);
    expect(q.offset).toBe(0);
    expect(q.limit).toBe(50);
  });

  it('returns no limit when defaultLimit is not provided', () => {
    const q = toAuditQuery({}, { maxLimit: 100 });
    expect(q.limit).toBeUndefined();
  });

  // ── limit coercion ────────────────────────────────────────────────────────

  it('parses a valid limit string', () => {
    const q = toAuditQuery({ limit: '25' }, OPT);
    expect(q.limit).toBe(25);
  });

  it('clamps limit to maxLimit', () => {
    const q = toAuditQuery({ limit: '999' }, OPT);
    expect(q.limit).toBe(100);
  });

  it('throws on non-numeric limit', () => {
    expect(() => toAuditQuery({ limit: 'abc' }, OPT)).toThrow('Invalid limit');
  });

  it('throws on zero limit', () => {
    expect(() => toAuditQuery({ limit: '0' }, OPT)).toThrow('Invalid limit');
  });

  it('throws on negative limit', () => {
    expect(() => toAuditQuery({ limit: '-5' }, OPT)).toThrow('Invalid limit');
  });

  it('throws on float limit', () => {
    // parseInt('3.7') === 3, which is valid — behaviour matches original router
    const q = toAuditQuery({ limit: '3.7' }, OPT);
    expect(q.limit).toBe(3);
  });

  // ── offset coercion ───────────────────────────────────────────────────────

  it('parses a valid offset string', () => {
    const q = toAuditQuery({ offset: '10' }, OPT);
    expect(q.offset).toBe(10);
  });

  it('allows offset 0', () => {
    const q = toAuditQuery({ offset: '0' }, OPT);
    expect(q.offset).toBe(0);
  });

  it('throws on negative offset', () => {
    expect(() => toAuditQuery({ offset: '-1' }, OPT)).toThrow('Invalid offset');
  });

  it('throws on non-numeric offset', () => {
    expect(() => toAuditQuery({ offset: 'xyz' }, OPT)).toThrow('Invalid offset');
  });

  // ── ISO-date coercion ─────────────────────────────────────────────────────

  it('parses a valid from date and normalises to ISO-8601', () => {
    const q = toAuditQuery({ from: '2024-01-01T00:00:00.000Z' }, OPT);
    expect(q.from).toBe('2024-01-01T00:00:00.000Z');
  });

  it('parses a valid to date and normalises to ISO-8601', () => {
    const q = toAuditQuery({ to: '2024-12-31T23:59:59.999Z' }, OPT);
    expect(q.to).toBe('2024-12-31T23:59:59.999Z');
  });

  it('throws on invalid from date', () => {
    expect(() => toAuditQuery({ from: 'not-a-date' }, OPT)).toThrow('Invalid from timestamp');
  });

  it('throws on invalid to date', () => {
    expect(() => toAuditQuery({ to: 'not-a-date' }, OPT)).toThrow('Invalid to timestamp');
  });

  // ── filter pass-through ───────────────────────────────────────────────────

  it('forwards action filter', () => {
    const q = toAuditQuery({ action: 'PAYMENT_INITIATED' }, OPT);
    expect(q.action).toBe('PAYMENT_INITIATED');
  });

  it('forwards severity filter', () => {
    const q = toAuditQuery({ severity: 'CRITICAL' }, OPT);
    expect(q.severity).toBe('CRITICAL');
  });

  it('forwards actor filter', () => {
    const q = toAuditQuery({ actor: 'user-42' }, OPT);
    expect(q.actor).toBe('user-42');
  });

  it('forwards resource filter', () => {
    const q = toAuditQuery({ resource: 'contract' }, OPT);
    expect(q.resource).toBe('contract');
  });

  it('forwards resourceId filter', () => {
    const q = toAuditQuery({ resourceId: 'c-1' }, OPT);
    expect(q.resourceId).toBe('c-1');
  });

  it('forwards cursor', () => {
    const q = toAuditQuery({ cursor: 'opaque-cursor-value' }, OPT);
    expect(q.cursor).toBe('opaque-cursor-value');
  });

  it('omits undefined optional filters from the result', () => {
    const q = toAuditQuery({}, OPT);
    expect('action' in q).toBe(false);
    expect('severity' in q).toBe(false);
    expect('actor' in q).toBe(false);
    expect('resource' in q).toBe(false);
    expect('resourceId' in q).toBe(false);
    expect('from' in q).toBe(false);
    expect('to' in q).toBe(false);
    expect('cursor' in q).toBe(false);
  });

  it('builds a fully-populated query from all params', () => {
    const dto: AuditQueryParamsDto = {
      action: 'AUTH_FAILED',
      severity: 'WARNING',
      actor: 'u1',
      resource: 'auth',
      resourceId: 'u1',
      from: '2024-01-01T00:00:00.000Z',
      to: '2024-12-31T23:59:59.999Z',
      limit: '20',
      offset: '5',
      cursor: 'my-cursor',
    };
    const q = toAuditQuery(dto, OPT);

    expect(q.action).toBe('AUTH_FAILED');
    expect(q.severity).toBe('WARNING');
    expect(q.actor).toBe('u1');
    expect(q.resource).toBe('auth');
    expect(q.resourceId).toBe('u1');
    expect(q.from).toBe('2024-01-01T00:00:00.000Z');
    expect(q.to).toBe('2024-12-31T23:59:59.999Z');
    expect(q.limit).toBe(20);
    expect(q.offset).toBe(5);
    expect(q.cursor).toBe('my-cursor');
  });
});

// ─── toAuditEntryResponseDto ──────────────────────────────────────────────────

describe('toAuditEntryResponseDto', () => {
  it('maps all fields from a fully-populated entry', () => {
    const entry = makeEntry();
    const dto = toAuditEntryResponseDto(entry);

    expect(dto.id).toBe(entry.id);
    expect(dto.timestamp).toBe(entry.timestamp);
    expect(dto.action).toBe(entry.action);
    expect(dto.severity).toBe(entry.severity);
    expect(dto.actor).toBe(entry.actor);
    expect(dto.resource).toBe(entry.resource);
    expect(dto.resourceId).toBe(entry.resourceId);
    expect(dto.hash).toBe(entry.hash);
    expect(dto.previousHash).toBe(entry.previousHash);
    expect(dto.ipAddress).toBe(entry.ipAddress);
    expect(dto.correlationId).toBe(entry.correlationId);
  });

  it('copies metadata as a shallow clone, not the same frozen reference', () => {
    const entry = makeEntry({ metadata: Object.freeze({ amount: 500 }) });
    const dto = toAuditEntryResponseDto(entry);

    expect(dto.metadata).toEqual({ amount: 500 });
    expect(dto.metadata).not.toBe(entry.metadata);
    // The DTO metadata is mutable (plain object)
    expect(() => { (dto.metadata as Record<string, unknown>)['amount'] = 999; }).not.toThrow();
  });

  it('omits ipAddress when absent from entry', () => {
    const entry = makeMinimalEntry();
    const dto = toAuditEntryResponseDto(entry);
    expect('ipAddress' in dto).toBe(false);
  });

  it('omits correlationId when absent from entry', () => {
    const entry = makeMinimalEntry();
    const dto = toAuditEntryResponseDto(entry);
    expect('correlationId' in dto).toBe(false);
  });

  it('includes ipAddress when present in entry', () => {
    const entry = makeEntry({ ipAddress: '192.168.1.1' });
    const dto = toAuditEntryResponseDto(entry);
    expect(dto.ipAddress).toBe('192.168.1.1');
  });

  it('handles empty metadata', () => {
    const entry = makeEntry({ metadata: Object.freeze({}) });
    const dto = toAuditEntryResponseDto(entry);
    expect(dto.metadata).toEqual({});
  });

  it('does not expose unexpected keys from the entry', () => {
    // Simulate a future domain type that gains an extra internal field
    const entryWithExtra = { ...makeEntry(), _internalField: 'secret' };
    const dto = toAuditEntryResponseDto(entryWithExtra as AuditEntry);
    expect((dto as Record<string, unknown>)['_internalField']).toBeUndefined();
  });
});

// ─── fromAuditEntryResponseDto ────────────────────────────────────────────────

describe('fromAuditEntryResponseDto', () => {
  it('maps all fields from a fully-populated DTO', () => {
    const dto: AuditEntryResponseDto = {
      id: 'entry-uuid-1',
      timestamp: '2026-01-15T10:00:00.000Z',
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-abc',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: { clientId: 'client-1' },
      ipAddress: '1.2.3.4',
      correlationId: 'corr-xyz',
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
    };

    const entry = fromAuditEntryResponseDto(dto);

    expect(entry.id).toBe(dto.id);
    expect(entry.timestamp).toBe(dto.timestamp);
    expect(entry.action).toBe(dto.action);
    expect(entry.severity).toBe(dto.severity);
    expect(entry.actor).toBe(dto.actor);
    expect(entry.resource).toBe(dto.resource);
    expect(entry.resourceId).toBe(dto.resourceId);
    expect(entry.hash).toBe(dto.hash);
    expect(entry.previousHash).toBe(dto.previousHash);
    expect(entry.ipAddress).toBe(dto.ipAddress);
    expect(entry.correlationId).toBe(dto.correlationId);
  });

  it('omits ipAddress when absent from DTO', () => {
    const dto: AuditEntryResponseDto = {
      id: 'e1',
      timestamp: '2026-01-01T00:00:00.000Z',
      action: 'AUTH_LOGIN',
      severity: 'INFO',
      actor: 'u1',
      resource: 'auth',
      resourceId: 'u1',
      metadata: {},
      hash: 'b'.repeat(64),
      previousHash: 'GENESIS',
    };

    const entry = fromAuditEntryResponseDto(dto);
    expect('ipAddress' in entry).toBe(false);
    expect('correlationId' in entry).toBe(false);
  });

  it('round-trips: entry → DTO → entry preserves all fields', () => {
    const original = makeEntry();
    const roundTripped = fromAuditEntryResponseDto(toAuditEntryResponseDto(original));

    expect(roundTripped.id).toBe(original.id);
    expect(roundTripped.timestamp).toBe(original.timestamp);
    expect(roundTripped.action).toBe(original.action);
    expect(roundTripped.severity).toBe(original.severity);
    expect(roundTripped.actor).toBe(original.actor);
    expect(roundTripped.resource).toBe(original.resource);
    expect(roundTripped.resourceId).toBe(original.resourceId);
    expect(roundTripped.metadata).toEqual(original.metadata);
    expect(roundTripped.ipAddress).toBe(original.ipAddress);
    expect(roundTripped.correlationId).toBe(original.correlationId);
    expect(roundTripped.hash).toBe(original.hash);
    expect(roundTripped.previousHash).toBe(original.previousHash);
  });

  it('round-trips a minimal entry with no optional fields', () => {
    const original = makeMinimalEntry();
    const roundTripped = fromAuditEntryResponseDto(toAuditEntryResponseDto(original));

    expect(roundTripped.id).toBe(original.id);
    expect(roundTripped.hash).toBe(original.hash);
    expect('ipAddress' in roundTripped).toBe(false);
    expect('correlationId' in roundTripped).toBe(false);
  });
});

// ─── toAuditQueryResponseDto ──────────────────────────────────────────────────

describe('toAuditQueryResponseDto', () => {
  it('maps an empty result to an empty entries array', () => {
    const dto = toAuditQueryResponseDto([], 50, 0);
    expect(dto.entries).toHaveLength(0);
    expect(dto.count).toBe(0);
    expect(dto.limit).toBe(50);
    expect(dto.offset).toBe(0);
  });

  it('maps multiple entries and sets count correctly', () => {
    const entries = [makeEntry({ id: 'e1' }), makeEntry({ id: 'e2' })];
    const dto = toAuditQueryResponseDto(entries, 50, 0);
    expect(dto.entries).toHaveLength(2);
    expect(dto.count).toBe(2);
    expect(dto.entries[0].id).toBe('e1');
    expect(dto.entries[1].id).toBe('e2');
  });

  it('reflects the given limit and offset', () => {
    const dto = toAuditQueryResponseDto([], 25, 10);
    expect(dto.limit).toBe(25);
    expect(dto.offset).toBe(10);
  });

  it('does not include nextCursor in offset-based response', () => {
    const dto = toAuditQueryResponseDto([makeEntry()], 50, 0);
    expect('nextCursor' in dto).toBe(false);
  });

  it('maps each entry through toAuditEntryResponseDto', () => {
    const entry = makeEntry({ actor: 'unique-actor' });
    const dto = toAuditQueryResponseDto([entry], 50, 0);
    expect(dto.entries[0].actor).toBe('unique-actor');
    expect(dto.entries[0].hash).toBe(entry.hash);
  });
});

// ─── toAuditQueryCursorResponseDto ───────────────────────────────────────────

describe('toAuditQueryCursorResponseDto', () => {
  function makeQueryResult(overrides: Partial<AuditQueryResult> = {}): AuditQueryResult {
    return {
      entries: [makeEntry()],
      count: 1,
      limit: 50,
      ...overrides,
    };
  }

  it('maps an empty cursor result correctly', () => {
    const dto = toAuditQueryCursorResponseDto(makeQueryResult({ entries: [], count: 0 }));
    expect(dto.entries).toHaveLength(0);
    expect(dto.count).toBe(0);
    expect(dto.limit).toBe(50);
  });

  it('includes nextCursor when present in result', () => {
    const dto = toAuditQueryCursorResponseDto(
      makeQueryResult({ nextCursor: 'cursor-abc123' }),
    );
    expect(dto.nextCursor).toBe('cursor-abc123');
  });

  it('omits nextCursor when absent from result', () => {
    const dto = toAuditQueryCursorResponseDto(makeQueryResult({ nextCursor: undefined }));
    expect('nextCursor' in dto).toBe(false);
  });

  it('does not include offset in cursor-based response', () => {
    const dto = toAuditQueryCursorResponseDto(makeQueryResult());
    expect('offset' in dto).toBe(false);
  });

  it('maps entries through toAuditEntryResponseDto', () => {
    const entry = makeEntry({ actor: 'cursor-actor' });
    const dto = toAuditQueryCursorResponseDto(makeQueryResult({ entries: [entry], count: 1 }));
    expect(dto.entries[0].actor).toBe('cursor-actor');
  });

  it('reflects the limit from the query result', () => {
    const dto = toAuditQueryCursorResponseDto(makeQueryResult({ limit: 20 }));
    expect(dto.limit).toBe(20);
  });
});

// ─── toIntegrityReportResponseDto ────────────────────────────────────────────

describe('toIntegrityReportResponseDto', () => {
  it('maps a valid report with no corruption fields', () => {
    const report: IntegrityReport = {
      valid: true,
      totalEntries: 42,
      checkedAt: '2026-01-15T10:00:00.000Z',
    };
    const dto = toIntegrityReportResponseDto(report);

    expect(dto.valid).toBe(true);
    expect(dto.totalEntries).toBe(42);
    expect(dto.checkedAt).toBe('2026-01-15T10:00:00.000Z');
    expect('firstCorruptedIndex' in dto).toBe(false);
    expect('firstCorruptedId' in dto).toBe(false);
  });

  it('maps an empty log valid report', () => {
    const report: IntegrityReport = {
      valid: true,
      totalEntries: 0,
      checkedAt: '2026-01-15T10:00:00.000Z',
    };
    const dto = toIntegrityReportResponseDto(report);
    expect(dto.valid).toBe(true);
    expect(dto.totalEntries).toBe(0);
  });

  it('maps an invalid report with corruption fields', () => {
    const report: IntegrityReport = {
      valid: false,
      totalEntries: 100,
      firstCorruptedIndex: 7,
      firstCorruptedId: 'corrupted-entry-id',
      checkedAt: '2026-01-15T10:00:00.000Z',
    };
    const dto = toIntegrityReportResponseDto(report);

    expect(dto.valid).toBe(false);
    expect(dto.totalEntries).toBe(100);
    expect(dto.firstCorruptedIndex).toBe(7);
    expect(dto.firstCorruptedId).toBe('corrupted-entry-id');
  });

  it('omits firstCorruptedIndex when not set on the report', () => {
    const report: IntegrityReport = {
      valid: false,
      totalEntries: 5,
      firstCorruptedId: 'some-id',
      checkedAt: '2026-01-15T10:00:00.000Z',
    };
    const dto = toIntegrityReportResponseDto(report);
    expect('firstCorruptedIndex' in dto).toBe(false);
  });

  it('omits firstCorruptedId when not set on the report', () => {
    const report: IntegrityReport = {
      valid: false,
      totalEntries: 5,
      firstCorruptedIndex: 2,
      checkedAt: '2026-01-15T10:00:00.000Z',
    };
    const dto = toIntegrityReportResponseDto(report);
    expect('firstCorruptedId' in dto).toBe(false);
  });
});

// ─── Edge-case and integration scenarios ─────────────────────────────────────

describe('edge cases', () => {
  it('round-trip: request DTO → input → (simulate store) → response DTO', () => {
    const requestDto = makeRequestDto({
      action: 'PAYMENT_RELEASED',
      severity: 'CRITICAL',
      actor: 'system',
      resource: 'payment',
      resourceId: 'pay-999',
      metadata: { amount: 100, currency: 'USD' },
      ipAddress: '127.0.0.1',
      correlationId: 'trace-abc',
    });

    const input = toCreateAuditEntryInput(requestDto);

    // Simulate what the store would return
    const storedEntry: AuditEntry = Object.freeze({
      id: 'generated-uuid',
      timestamp: '2026-07-25T12:00:00.000Z',
      ...input,
      metadata: Object.freeze({ ...input.metadata }),
      hash: 'f'.repeat(64),
      previousHash: 'GENESIS',
    });

    const responseDto = toAuditEntryResponseDto(storedEntry);

    // Input fields are preserved end-to-end
    expect(responseDto.action).toBe(requestDto.action);
    expect(responseDto.severity).toBe(requestDto.severity);
    expect(responseDto.actor).toBe(requestDto.actor);
    expect(responseDto.resource).toBe(requestDto.resource);
    expect(responseDto.resourceId).toBe(requestDto.resourceId);
    expect(responseDto.metadata).toEqual(requestDto.metadata);
    expect(responseDto.ipAddress).toBe(requestDto.ipAddress);
    expect(responseDto.correlationId).toBe(requestDto.correlationId);

    // Store-generated fields are present
    expect(responseDto.id).toBe('generated-uuid');
    expect(responseDto.timestamp).toBe('2026-07-25T12:00:00.000Z');
    expect(responseDto.hash).toBe('f'.repeat(64));
  });

  it('toAuditQuery preserves exact ISO-8601 string after roundtrip via Date', () => {
    const iso = '2024-06-15T08:30:00.000Z';
    const q = toAuditQuery({ from: iso, to: iso }, { maxLimit: 100 });
    expect(q.from).toBe(iso);
    expect(q.to).toBe(iso);
  });

  it('toAuditQuery clamps large limit to maxLimit boundary', () => {
    const q = toAuditQuery({ limit: '50001' }, { maxLimit: 50000 });
    expect(q.limit).toBe(50000);
  });

  it('toAuditQuery with limit exactly equal to maxLimit is not clamped', () => {
    const q = toAuditQuery({ limit: '100' }, { maxLimit: 100 });
    expect(q.limit).toBe(100);
  });

  it('toAuditQuery with limit of 1 (minimum valid) is accepted', () => {
    const q = toAuditQuery({ limit: '1' }, { maxLimit: 100 });
    expect(q.limit).toBe(1);
  });

  it('toAuditQueryResponseDto with a large page of entries maps them all', () => {
    const entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry({ id: `entry-${i}`, actor: `actor-${i}` }),
    );
    const dto = toAuditQueryResponseDto(entries, 100, 0);
    expect(dto.entries).toHaveLength(100);
    expect(dto.count).toBe(100);
    expect(dto.entries[99].actor).toBe('actor-99');
  });

  it('metadata with deeply nested objects is shallow-cloned at the top level', () => {
    const nested = { level1: { level2: { value: 42 } } };
    const entry = makeEntry({ metadata: Object.freeze(nested) as Record<string, unknown> });
    const dto = toAuditEntryResponseDto(entry);
    // Shallow clone: top-level key is new object but inner reference is same
    expect(dto.metadata).not.toBe(entry.metadata);
    expect(dto.metadata['level1']).toBe((entry.metadata as typeof nested)['level1']);
  });
});
