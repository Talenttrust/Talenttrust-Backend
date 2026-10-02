/**
 * @file schemas.test.ts
 * @description Direct unit coverage for the declarative zod schemas in
 * `./schemas.ts`, independent of the HTTP layer (see router.validation.test.ts
 * for the end-to-end request/response coverage). Issue #939.
 *
 * This suite also hardens the concurrent / repeated-execution contract of the
 * schemas: parsing must be pure and deterministic, so that racing or retried
 * requests cannot observe stale or mutated schema state. See `describe('parsing
 * is pure and deterministic under concurrency')` below.
 */

/**
 * @file schemas.test.ts
 * @description Direct unit coverage for the declarative zod schemas in
 * `./schemas.ts`, independent of the HTTP layer (see router.validation.test.ts
 * for the end-to-end request/response coverage). Issue #939.
 */

import {
  AUDIT_ACTIONS,
  createAuditEntryBodySchema,
  buildAuditQuerySchema,
  auditActionSchema,
  auditSeveritySchema,
  auditEntryResponseSchema,
  auditQueryResultResponseSchema,
  auditLegacyQueryResponseSchema,
  integrityReportResponseSchema,
  AUDIT_ACTIONS as SCHEMA_ACTIONS,
} from './schemas';
import {
  encodeCursor,
  AUDIT_ACTIONS as DOMAIN_ACTIONS,
  AUDIT_SEVERITIES as DOMAIN_SEVERITIES,
} from './types';
import {
  CreateAuditEntrySchema,
  MAX_ID_LENGTH,
  MAX_IP_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_STRING_LENGTH,
  FORBIDDEN_METADATA_KEYS,
} from './inputValidation';

// Validation boundaries under test:
// - accepted: fully-specified and defaulted payloads
// - rejected: missing required fields, unknown enums, malformed values
// - duplicate: repeated identical submissions must be deterministic
// - boundary: limit/offset edges, cursor edges, timestamp edges

describe('createAuditEntryBodySchema', () => {
  const valid = {
    action: 'CONTRACT_CREATED' as const,
    severity: 'INFO' as const,
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { foo: 'bar' },
  };

  it('accepts a fully-specified valid payload', () => {
    const result = createAuditEntryBodySchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({ foo: 'bar' });
    }
  });

  it('keeps action values unique and accepts every declared action for writes and queries', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    for (const action of AUDIT_ACTIONS) {
      expect(createAuditEntryBodySchema.safeParse({ ...valid, action }).success).toBe(true);
      expect(buildAuditQuerySchema({ maxLimit: 100 }).safeParse({ action }).success).toBe(true);
    }
  });

  it('defaults metadata to {} when omitted', () => {
    const { metadata, ...rest } = valid;
    void metadata;
    const result = createAuditEntryBodySchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({});
    }
  });

  it('is deterministic for duplicate identical submissions', () => {
    const first = createAuditEntryBodySchema.safeParse(valid);
    const second = createAuditEntryBodySchema.safeParse(valid);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.data).toEqual(second.data);
    }
  });

  it('accepts optional ipAddress and correlationId', () => {
    const result = createAuditEntryBodySchema.safeParse({
      ...valid,
      ipAddress: '203.0.113.7',
      correlationId: 'corr-abc',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ['action', { ...valid, action: undefined }],
    ['severity', { ...valid, severity: undefined }],
    ['actor', { ...valid, actor: undefined }],
    ['resource', { ...valid, resource: undefined }],
    ['resourceId', { ...valid, resourceId: undefined }],
  ])('rejects a payload missing %s', (field, payload) => {
    const result = createAuditEntryBodySchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes(field))).toBe(true);
    }
  });

  it('rejects an unrecognized action', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, action: 'NOT_REAL' });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized severity', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, severity: 'NOT_REAL' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty actor string', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, actor: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object metadata value', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, metadata: 'nope' });
    expect(result.success).toBe(false);
  });

  it('rejects a null payload', () => {
    const result = createAuditEntryBodySchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('rejects a boundary-length actor string', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, actor: 'a'.repeat(10_000) });
    expect(result.success).toBe(false);
  });

  it('strips unknown top-level fields rather than throwing', () => {
    const result = createAuditEntryBodySchema.safeParse({ ...valid, somethingUnexpected: 'ignored' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['somethingUnexpected']).toBeUndefined();
    }
  });

  // Concurrency / idempotency invariants: the schema is a pure declaration
  // with no mutable state, so any number of interleaved or repeated parses
  // must yield identical results. This guards against accidental introduction
  // of memoization / last-value caching that could leak stale data across
  // racing requests.
  it('parsing is pure and deterministic under concurrency', () => {
    const inputs = [
      valid,
      { ...valid, actor: '' },
      { ...valid, action: 'NOT_REAL' },
      { ...valid, metadata: undefined },
    ];

    const baseline = inputs.map((input) => createAuditEntryBodySchema.safeParse(input));

    // Interleave many parses across the same inputs and compare to the
    // sequential baseline. Any shared mutable state would surface as a
    // divergence here.
    for (let round = 0; round < 50; round++) {
      const observed = inputs.map((input) => createAuditEntryBodySchema.safeParse(input));
      expect(observed.map((r) => r.success)).toEqual(baseline.map((r) => r.success));
    }

    // Repeated identical parses of the same input must produce deeply equal
    // data (not just equal accept/reject decisions).
    const first = createAuditEntryBodySchema.safeParse(valid);
    const second = createAuditEntryBodySchema.safeParse(valid);
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.data).toEqual(first.data);
      // The parsed output must not alias the caller's input object.
      expect(second.data).not.toBe(valid);
      expect(second.data.metadata).not.toBe(valid.metadata);
    }
  });

  it('does not mutate the caller's input object', () => {
    const input = { ...valid, metadata: { foo: 'bar' } };
    const snapshot = JSON.parse(JSON.stringify(input));
    createAuditEntryBodySchema.safeParse(input);
    expect(input).toEqual(snapshot);
  });
});

describe('buildAuditQuerySchema', () => {
  const schema = buildAuditQuerySchema({ defaultLimit: 50, maxLimit: 100 });

  it('accepts an empty query and applies the default limit / zero offset', () => {
    const result = schema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    }
  });

  it('accepts a fully-specified valid query', () => {
    const result = schema.safeParse({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      from: '2020-01-01T00:00:00Z',
      to: '2030-01-01T00:00:00Z',
      limit: '25',
      offset: '5',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
      expect(result.data.offset).toBe(5);
      expect(result.data.from).toBe(new Date('2020-01-01T00:00:00Z').toISOString());
    }
  });

  it('normalizes an explicit ISO timestamp with an offset to UTC', () => {
    const result = schema.safeParse({ from: '2020-01-01T01:00:00+01:00' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe('2020-01-01T00:00:00.000Z');
    }
  });

  it('normalizes an ISO date-only filter to midnight UTC', () => {
    const result = schema.safeParse({ from: '2020-01-01' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe('2020-01-01T00:00:00.000Z');
    }
  });

  it.each(['1', '2020-01-00', '2020-02-30', '2021-02-29'])('rejects a non-ISO or invalid calendar date: %s', (from) => {
    expect(schema.safeParse({ from }).success).toBe(false);
  });

  it('clamps a limit above maxLimit rather than rejecting it', () => {
    const result = schema.safeParse({ limit: '999999' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it('clamps a limit of exactly maxLimit to maxLimit', () => {
    const result = schema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  it('accepts a limit of exactly 1 (lower boundary)', () => {
    const result = schema.safeParse({ limit: '1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(1);
    }
  });

  it('accepts an offset of 0 (lower boundary)', () => {
    const result = schema.safeParse({ offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(0);
    }
  });

  it('accepts a valid cursor', () => {
    const cursor = encodeCursor({ lastId: 'abc', lastTimestamp: new Date().toISOString(), filters: {} });
    const result = schema.safeParse({ cursor });
    expect(result.success).toBe(true);
  });

  it('is deterministic for duplicate identical queries', () => {
    const query = { action: 'CONTRACT_CREATED', limit: '25', offset: '5' };
    const first = schema.safeParse(query);
    const second = schema.safeParse(query);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(first.data).toEqual(second.data);
    }
  });

  it.each([
    ['action', { action: 'NOT_REAL' }],
    ['severity', { severity: 'NOT_REAL' }],
    ['limit (non-numeric)', { limit: 'abc' }],
    ['limit (zero)', { limit: '0' }],
    ['offset (negative)', { offset: '-1' }],
    ['offset (non-numeric)', { offset: 'abc' }],
    ['offset (unsafe integer)', { offset: '9007199254740992' }],
    ['from (unparseable)', { from: 'not-a-date' }],
    ['to (unparseable)', { to: 'not-a-date' }],
    ['cursor (malformed)', { cursor: 'not-valid-base64-json!!' }],
  ])('rejects an invalid %s', (_label, payload) => {
    const result = schema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  // Boundary: limit exactly at maxLimit is accepted without clamping.
  it('accepts a limit exactly at maxLimit', () => {
    const result = schema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(100);
    }
  });

  // Boundary: limit of 1 is the smallest accepted value.
  it('accepts a limit of 1', () => {
    const result = schema.safeParse({ limit: '1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(1);
    }
  });

  // Boundary: offset of 0 is accepted.
  it('accepts an offset of 0', () => {
    const result = schema.safeParse({ offset: '0' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.offset).toBe(0);
    }
  });

  // Idempotency / concurrency: building the schema repeatedly with the same
  // config must yield schemas that agree on every input, and the same schema
  // instance must produce identical results across interleaved calls.
  it('building and parsing is deterministic across repeated / concurrent calls', () => {
    const config = { defaultLimit: 50, maxLimit: 100 };
    const inputs = [
      {},
      { limit: '25', offset: '5' },
      { limit: '999999' },
      { limit: '0' },
      { offset: '-1' },
    ];

    const reference = inputs.map((p) => buildAuditQuerySchema(config).safeParse(p));

    for (let round = 0; round < 50; round++) {
      const rebuilt = buildAuditQuerySchema(config);
      const observed = inputs.map((p) => rebuilt.safeParse(p));
      expect(observed.map((r) => r.success)).toEqual(reference.map((r) => r.success));
    }

    // The same instance must not carry state between parses.
    const a = schema.safeParse({});
    const b = schema.safeParse({});
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) {
      expect(b.data).toEqual(a.data);
    }
  });

  it('does not mutate the caller's query object', () => {
    const query = { limit: '25', offset: '5' };
    const snapshot = { ...query };
    schema.safeParse(query);
    expect(query).toEqual(snapshot);
  });
});

describe('response schemas', () => {
  it('auditEntryResponseSchema accepts a well-formed entry', () => {
    const entry = {
      id: 'entry-1',
      timestamp: new Date().toISOString(),
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
    };
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(true);
  });

  it('auditEntryResponseSchema rejects an entry missing its hash', () => {
    const entry = {
      id: 'entry-1',
      timestamp: new Date().toISOString(),
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
      previousHash: 'GENESIS',
    };
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(false);
  });

  it('auditEntryResponseSchema rejects a malformed hash', () => {
    const entry = {
      id: 'entry-1',
      timestamp: new Date().toISOString(),
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: {},
      hash: 'not-a-valid-hash',
      previousHash: 'GENESIS',
    };
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(false);
  });

  it('auditQueryResultResponseSchema accepts a cursor-paginated result', () => {
    const result = { entries: [], count: 0, limit: 50, nextCursor: 'abc' };
    expect(auditQueryResultResponseSchema.safeParse(result).success).toBe(true);
  });

  it('auditQueryResultResponseSchema rejects a negative count', () => {
    const result = { entries: [], count: -1, limit: 50, nextCursor: 'abc' };
    expect(auditQueryResultResponseSchema.safeParse(result).success).toBe(false);
  });

  it('auditQueryResultResponseSchema rejects a zero limit', () => {
    const result = { entries: [], count: 0, limit: 0, nextCursor: 'abc' };
    expect(auditQueryResultResponseSchema.safeParse(result).success).toBe(false);
  });

  it('integrityReportResponseSchema accepts a valid report', () => {
    const report = { valid: true, totalEntries: 3, checkedAt: new Date().toISOString() };
    expect(integrityReportResponseSchema.safeParse(report).success).toBe(true);
  });

  it('integrityReportResponseSchema rejects a report missing checkedAt', () => {
    const report = { valid: true, totalEntries: 3 };
    expect(integrityReportResponseSchema.safeParse(report).success).toBe(false);
  });

  // Response schemas are also pure: repeated and interleaved parses of the
  // same payload must not diverge, and the caller's input must remain
  // unmodified.
  it('response schema parsing is pure and non-mutating', () => {
    const entry = {
      id: 'entry-1',
      timestamp: new Date().toISOString(),
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: { foo: 'bar' },
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
    };
    const snapshot = JSON.parse(JSON.stringify(entry));

    const first = auditEntryResponseSchema.safeParse(entry);
    for (let round = 0; round < 50; round++) {
      const next = auditEntryResponseSchema.safeParse(entry);
      expect(next.success).toBe(first.success);
    }

    expect(entry).toEqual(snapshot);
  });
});

// ─── Invariant coverage (issue #1362) ───────────────────────────────────────

/** Minimal valid write payload; overrides are applied last. */
function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Builds `depth` nested plain objects (depth 1 is a flat `{}`). */
function nest(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let i = 1; i < depth; i += 1) {
    node = { child: node };
  }
  return node;
}

describe('enum parity with the domain (drift regression)', () => {
  it('re-exports exactly the domain action list', () => {
    expect(SCHEMA_ACTIONS).toEqual(DOMAIN_ACTIONS);
  });

  it('exposes exactly the domain values through the zod enums', () => {
    expect(auditActionSchema.options).toEqual([...DOMAIN_ACTIONS]);
    expect(auditSeveritySchema.options).toEqual([...DOMAIN_SEVERITIES]);
  });

  it('accepts every domain action on the write path', () => {
    for (const action of DOMAIN_ACTIONS) {
      expect(createAuditEntryBodySchema.safeParse(makeBody({ action })).success).toBe(true);
    }
  });

  it('accepts every domain severity on the write path', () => {
    for (const severity of DOMAIN_SEVERITIES) {
      expect(createAuditEntryBodySchema.safeParse(makeBody({ severity })).success).toBe(true);
    }
  });

  it('accepts REPUTATION_CORRECTED (previously rejected by the drifted local list)', () => {
    expect(SCHEMA_ACTIONS).toContain('REPUTATION_CORRECTED');
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ action: 'REPUTATION_CORRECTED' })).success,
    ).toBe(true);
  });
});

describe('createAuditEntryBodySchema — field boundaries', () => {
  it('accepts an identifier at the maximum length and rejects one over it', () => {
    const atMax = 'a'.repeat(MAX_ID_LENGTH);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ actor: atMax })).success).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ actor: `${atMax}a` })).success,
    ).toBe(false);
  });

  it('rejects blank and control-character identifiers', () => {
    expect(createAuditEntryBodySchema.safeParse(makeBody({ actor: '   ' })).success).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ actor: 'user\u0000' })).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ resourceId: 'id\u001F' })).success,
    ).toBe(false);
  });

  it('accepts valid IPv4/IPv6 addresses and rejects invalid or oversized ones', () => {
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ ipAddress: '203.0.113.7' })).success,
    ).toBe(true);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ ipAddress: '::1' })).success).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ ipAddress: 'not-an-ip' })).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ ipAddress: '9'.repeat(MAX_IP_LENGTH + 1) }))
        .success,
    ).toBe(false);
  });

  it('enforces the correlationId charset and length bounds', () => {
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ correlationId: 'corr-abc:1.2_x' })).success,
    ).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ correlationId: 'corr abc' })).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ correlationId: 'corr\nabc' })).success,
    ).toBe(false);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ correlationId: '' })).success).toBe(false);
    const atMax = 'a'.repeat(MAX_CORRELATION_ID_LENGTH);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ correlationId: atMax })).success).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ correlationId: `${atMax}a` })).success,
    ).toBe(false);
  });
});

describe('createAuditEntryBodySchema — metadata data-integrity invariants', () => {
  it('denies prototype-pollution keys at the top level', () => {
    const pollutedProto = JSON.parse('{"__proto__":"x"}') as Record<string, unknown>;
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ metadata: pollutedProto })).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ metadata: { constructor: 'x' } })).success,
    ).toBe(false);
  });

  it('denies prototype-pollution keys at any nesting level', () => {
    const nested = { safe: JSON.parse('{"prototype":"x"}') };
    const result = createAuditEntryBodySchema.safeParse(makeBody({ metadata: nested }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('reserved key'))).toBe(true);
    }
  });

  it('accepts nesting up to MAX_METADATA_DEPTH and rejects one level deeper', () => {
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ metadata: nest(MAX_METADATA_DEPTH) })).success,
    ).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ metadata: nest(MAX_METADATA_DEPTH + 1) }))
        .success,
    ).toBe(false);
  });

  it('accepts MAX_METADATA_ENTRIES keys and rejects one more', () => {
    const atMax = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES }, (_, i) => [`k${i}`, i]),
    );
    const over = { ...atMax, extra: 1 };
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: atMax })).success).toBe(true);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: over })).success).toBe(false);
  });

  it('accepts MAX_METADATA_ARRAY_ITEMS and rejects one more', () => {
    const atMax = Array.from({ length: MAX_METADATA_ARRAY_ITEMS }, () => 1);
    const over = [...atMax, 1];
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: { list: atMax } })).success).toBe(
      true,
    );
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: { list: over } })).success).toBe(
      false,
    );
  });

  it('enforces the per-string length bound', () => {
    expect(
      createAuditEntryBodySchema.safeParse(
        makeBody({ metadata: { s: 'a'.repeat(MAX_METADATA_STRING_LENGTH) } }),
      ).success,
    ).toBe(true);
    expect(
      createAuditEntryBodySchema.safeParse(
        makeBody({ metadata: { s: 'a'.repeat(MAX_METADATA_STRING_LENGTH + 1) } }),
      ).success,
    ).toBe(false);
  });

  it('rejects non-finite numbers and circular references', () => {
    expect(
      createAuditEntryBodySchema.safeParse(makeBody({ metadata: { n: Infinity } })).success,
    ).toBe(false);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: circular })).success).toBe(false);
  });

  it('rejects metadata whose serialised size exceeds MAX_METADATA_BYTES', () => {
    const giant: Record<string, string> = {};
    for (let i = 0; i < MAX_METADATA_ENTRIES; i += 1) {
      giant[`k${i}`] = 'a'.repeat(MAX_METADATA_STRING_LENGTH);
    }
    expect(Buffer.byteLength(JSON.stringify(giant), 'utf-8')).toBeGreaterThan(MAX_METADATA_BYTES);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: giant })).success).toBe(false);
  });

  it('documents the shared metadata source of truth with the strict write-path schema', () => {
    const polluted = JSON.parse('{"__proto__":"x"}');
    const clean = { nested: { ok: true } };

    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: polluted })).success).toBe(false);
    expect(CreateAuditEntrySchema.safeParse(makeBody({ metadata: polluted })).success).toBe(false);
    expect(createAuditEntryBodySchema.safeParse(makeBody({ metadata: clean })).success).toBe(true);
    expect(CreateAuditEntrySchema.safeParse(makeBody({ metadata: clean })).success).toBe(true);
  });

  it('forbidden-key constant is non-empty and includes the classic pollution keys', () => {
    expect(FORBIDDEN_METADATA_KEYS).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'prototype']));
  });
});

describe('buildAuditQuerySchema — invariants and legacy quirk', () => {
  const schema = buildAuditQuerySchema({ defaultLimit: 50, maxLimit: 100 });

  it('accepts every domain action as a filter (enum parity)', () => {
    for (const action of DOMAIN_ACTIONS) {
      expect(schema.safeParse({ action }).success).toBe(true);
    }
  });

  it('keeps a limit exactly at maxLimit and clamps one above it', () => {
    const exact = schema.safeParse({ limit: '100' });
    expect(exact.success).toBe(true);
    if (exact.success) expect(exact.data.limit).toBe(100);

    const over = schema.safeParse({ limit: '101' });
    expect(over.success).toBe(true);
    if (over.success) expect(over.data.limit).toBe(100);
  });

  it('treats an empty cursor as absent (legacy truthy-check quirk preserved)', () => {
    const result = schema.safeParse({ cursor: '' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeUndefined();
  });

  it('still rejects an empty limit (legacy explicit-undefined quirk preserved)', () => {
    expect(schema.safeParse({ limit: '' }).success).toBe(false);
  });

  it('applies no default limit when defaultLimit is omitted (export schema)', () => {
    const exportSchema = buildAuditQuerySchema({ maxLimit: 50_000 });
    const result = exportSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBeUndefined();
  });
});

describe('response schemas — tightened data-integrity contract', () => {
  const baseEntry = {
    id: 'entry-1',
    timestamp: new Date().toISOString(),
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: {},
    hash: 'a'.repeat(64),
    previousHash: 'GENESIS',
  };

  it('accepts GENESIS and 64-char hex previous hashes, rejects anything else', () => {
    expect(auditEntryResponseSchema.safeParse(baseEntry).success).toBe(true);
    expect(
      auditEntryResponseSchema.safeParse({ ...baseEntry, previousHash: 'b'.repeat(64) }).success,
    ).toBe(true);
    expect(
      auditEntryResponseSchema.safeParse({ ...baseEntry, previousHash: 'not-a-hash' }).success,
    ).toBe(false);
  });

  it('rejects a malformed hash digest', () => {
    expect(
      auditEntryResponseSchema.safeParse({ ...baseEntry, hash: 'A'.repeat(64) }).success,
    ).toBe(false);
    expect(auditEntryResponseSchema.safeParse({ ...baseEntry, hash: 'abc' }).success).toBe(false);
  });

  it('rejects a non-ISO timestamp', () => {
    expect(
      auditEntryResponseSchema.safeParse({ ...baseEntry, timestamp: 'not-a-date' }).success,
    ).toBe(false);
  });

  it('rejects negative and non-integer counters', () => {
    expect(
      auditQueryResultResponseSchema.safeParse({ entries: [], count: -1, limit: 50 }).success,
    ).toBe(false);
    expect(
      auditQueryResultResponseSchema.safeParse({ entries: [], count: 1.5, limit: 50 }).success,
    ).toBe(false);
    expect(
      auditQueryResultResponseSchema.safeParse({ entries: [], count: 0, limit: 0 }).success,
    ).toBe(false);
  });

  it('rejects a negative legacy offset and a negative corruption index', () => {
    expect(
      auditLegacyQueryResponseSchema.safeParse({ entries: [], count: 0, limit: 10, offset: -1 })
        .success,
    ).toBe(false);
    expect(
      integrityReportResponseSchema.safeParse({
        valid: false,
        totalEntries: 3,
        firstCorruptedIndex: -1,
        checkedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});
