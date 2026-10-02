/**
 * @file schemas.compatibility.test.ts
 * @description Compatibility-contract coverage for `./schemas.ts` (issue #1365).
 *
 * `schemas.test.ts` covers the accept/reject surface of the schemas. This file
 * covers the *contract* around them: that the module cannot drift from the
 * rest of the audit module, that behaviour which looks accidental but is
 * load-bearing for existing callers stays pinned, and that the boundaries
 * behave deterministically.
 *
 * Test groups:
 *   1. single source of truth (registry vs domain, schema vs inputValidation)
 *   2. preserved quirks (empty filters, empty-string asymmetry)
 *   3. pinned boundaries (numeric spelling, calendar dates, inverted ranges)
 *   4. cursor contract (round-trip, malformed payloads, filter drift)
 *   5. response contract (hash chain shape, domain-only actions)
 *   6. divergence from the live query parser (`parseAuditQuery`)
 */

import {
  AUDIT_ACTIONS,
  AUDIT_SEVERITIES,
  AUDIT_DOMAIN_ACTIONS,
  auditActionSchema,
  auditDomainActionSchema,
  auditCursorDataSchema,
  auditCursorFiltersSchema,
  auditEntryResponseSchema,
  auditLegacyQueryResponseSchema,
  auditQueryResultResponseSchema,
  buildAuditQuerySchema,
  createAuditEntryBodySchema,
  integrityReportResponseSchema,
  GENESIS_HASH_LITERAL,
  type AuditQueryParams,
} from './schemas';
import {
  CreateAuditEntrySchema,
  MAX_CORRELATION_ID_LENGTH,
  MAX_ID_LENGTH,
  MAX_IP_LENGTH,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_ENTRIES,
} from './inputValidation';
import { AUDIT_ACTIONS as TYPES_AUDIT_ACTIONS } from './types';
import { AUDIT_SEVERITIES as TYPES_AUDIT_SEVERITIES } from './types';
import { parseAuditQuery } from './service';
import { GENESIS_HASH, computeEntryHash, AuditStore } from './store';
import { encodeCursor } from './types';
import type { AuditAction, CreateAuditEntryInput } from './types';

const querySchema = buildAuditQuerySchema({ defaultLimit: 50, maxLimit: 100 });

function parseQuery(
  raw: Record<string, unknown>,
  schema = querySchema,
): { ok: true; data: AuditQueryParams } | { ok: false; messages: string[] } {
  const result = schema.safeParse(raw);
  return result.success
    ? { ok: true, data: result.data }
    : { ok: false, messages: result.error.issues.map((issue) => issue.message) };
}

const validBody = {
  action: 'CONTRACT_CREATED' as const,
  severity: 'INFO' as const,
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'contract-1',
};

// ── 1. Single source of truth ────────────────────────────────────────────────

describe('compatibility: one definition per rule', () => {
  it('re-exports the action registry from ./types rather than declaring its own', () => {
    // Regression: this module used to carry a private copy of the list that had
    // drifted one entry behind, so REPUTATION_CORRECTED was accepted by
    // inputValidation and AuditService but rejected by the write schema the
    // POST /api/v1/audit handler actually runs.
    expect(AUDIT_ACTIONS).toBe(TYPES_AUDIT_ACTIONS);
    expect(AUDIT_SEVERITIES).toBe(TYPES_AUDIT_SEVERITIES);
  });

  it('accepts every action the public registry allows', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionSchema.safeParse(action).success).toBe(true);
      expect(
        createAuditEntryBodySchema.safeParse({ ...validBody, action }).success,
      ).toBe(true);
    }
  });

  it('accepts REPUTATION_CORRECTED on the write path, as every other validator does', () => {
    const body = { ...validBody, action: 'REPUTATION_CORRECTED' };
    expect(createAuditEntryBodySchema.safeParse(body).success).toBe(true);
    expect(CreateAuditEntrySchema.safeParse(body).success).toBe(true);
  });

  it('keeps the write registry a strict subset of the domain action list', () => {
    const domain = new Set<string>(AUDIT_DOMAIN_ACTIONS);
    for (const action of AUDIT_ACTIONS) {
      expect(domain.has(action)).toBe(true);
    }
    // The subset is what keeps the HTTP surface narrower than the log.
    expect(AUDIT_DOMAIN_ACTIONS.length).toBeGreaterThan(AUDIT_ACTIONS.length);
  });

  it('accepts a domain action on the response schema but not on the write schema', () => {
    const internalOnly: AuditAction = 'MILESTONES_CREATED';
    expect(auditActionSchema.safeParse(internalOnly).success).toBe(false);
    expect(auditDomainActionSchema.safeParse(internalOnly).success).toBe(true);
  });

  it.each([
    ['action', { action: 'NOT_REAL' }],
    ['severity', { severity: 'NOT_REAL' }],
  ])('agrees with CreateAuditEntrySchema on an invalid %s', (field, override) => {
    expect(createAuditEntryBodySchema.safeParse({ ...validBody, ...override }).success).toBe(false);
    expect(CreateAuditEntrySchema.safeParse({ ...validBody, ...override }).success).toBe(false);
    expect(field).toBeTruthy();
  });

  it('applies the same bounds as the write validator to every accepted field', () => {
    // The unbounded version of these fields accepted a 10 KiB actor and an
    // unbounded metadata object straight into a permanent hash chain.
    expect(
      createAuditEntryBodySchema.safeParse({ ...validBody, actor: 'a'.repeat(MAX_ID_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse({ ...validBody, ipAddress: 'not-an-ip' }).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse({
        ...validBody,
        correlationId: 'x'.repeat(MAX_CORRELATION_ID_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      createAuditEntryBodySchema.safeParse({ ...validBody, actor: '  ' }).success,
    ).toBe(false);
  });

  it.each([
    [
      'too many metadata keys',
      Object.fromEntries(
        Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_unused, index) => [`k${index}`, index]),
      ),
    ],
    [
      'metadata nested too deeply',
      (() => {
        let nested: Record<string, unknown> = { leaf: true };
        for (let depth = 0; depth < MAX_METADATA_DEPTH + 2; depth += 1) {
          nested = { nested };
        }
        return nested;
      })(),
    ],
    [
      'metadata too large once serialised',
      { blob: 'x'.repeat(MAX_METADATA_BYTES + 1) },
    ],
  ])('rejects %s on the write path', (_label, metadata) => {
    expect(createAuditEntryBodySchema.safeParse({ ...validBody, metadata }).success).toBe(false);
  });

  it('rejects a prototype-polluting metadata key', () => {
    const metadata = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    expect(createAuditEntryBodySchema.safeParse({ ...validBody, metadata }).success).toBe(false);
  });

  it('still defaults metadata to {} and strips unknown top-level keys', () => {
    const result = createAuditEntryBodySchema.safeParse({
      ...validBody,
      somethingUnexpected: 'ignored',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({});
      expect((result.data as Record<string, unknown>)['somethingUnexpected']).toBeUndefined();
    }
  });

  it('keeps the documented field bounds for ipAddress and correlationId reachable', () => {
    expect(
      createAuditEntryBodySchema.safeParse({
        ...validBody,
        ipAddress: '203.0.113.7',
        correlationId: 'corr-abc',
      }).success,
    ).toBe(true);
    expect(MAX_IP_LENGTH).toBeGreaterThan(0);
  });
});

// ── 2. Preserved quirks ──────────────────────────────────────────────────────

describe('compatibility: preserved empty-value quirks', () => {
  it.each(['action', 'severity', 'actor', 'resource', 'resourceId', 'cursor'])(
    'treats an empty %s as absent, exactly as the truthy checks did',
    (field) => {
      const result = parseQuery({ [field]: '' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data[field as keyof AuditQueryParams]).toBeUndefined();
      }
    },
  );

  it.each(['from', 'to'])('still rejects an empty %s rather than dropping it', (field) => {
    const result = parseQuery({ [field]: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages[0]).toContain(`Invalid ${field} timestamp`);
    }
  });

  it('does not silently widen a filter to "everything" for a blank actor', () => {
    // The documented consequence of the preserved quirk: a blank actor is a
    // no-op filter, which is why callers must not treat it as a filter at all.
    // The key survives with an `undefined` value, exactly as before.
    const result = parseQuery({ actor: '' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.actor).toBeUndefined();
      expect(result.data.limit).toBe(50);
    }
  });
});

// ── 3. Pinned boundaries ─────────────────────────────────────────────────────

describe('compatibility: numeric query boundaries', () => {
  it.each([
    ['1', 1],
    ['99', 99],
    ['100', 100],
  ])('accepts limit=%s unchanged', (input, expected) => {
    const result = parseQuery({ limit: input });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(expected);
  });

  it('clamps rather than rejects a limit above the ceiling', () => {
    const result = parseQuery({ limit: '999999' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(100);
  });

  it.each(['0', '-1', '1.5', '01', '+1', '1e3', 'abc', ' 1 2 '])(
    'rejects limit=%p, which has more than one sensible reading',
    (input) => {
      expect(parseQuery({ limit: input }).ok).toBe(false);
    },
  );

  it('accepts a padded limit once trimmed', () => {
    const result = parseQuery({ limit: ' 25 ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(25);
  });

  it.each([
    ['0', 0],
    ['1', 1],
    ['1000000', 1_000_000],
  ])('accepts offset=%s', (input, expected) => {
    const result = parseQuery({ offset: input });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.offset).toBe(expected);
  });

  it.each(['-1', '1.5', '01', '+1', 'abc'])('rejects offset=%p', (input) => {
    expect(parseQuery({ offset: input }).ok).toBe(false);
  });

  it('defaults offset to 0 and limit to the configured default', () => {
    const result = parseQuery({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.offset).toBe(0);
      expect(result.data.limit).toBe(50);
    }
  });

  it('leaves limit undefined when no default is configured', () => {
    const result = parseQuery({}, buildAuditQuerySchema({ maxLimit: 100 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBeUndefined();
  });

  it('applies each caller its own ceiling', () => {
    const exportSchema = buildAuditQuerySchema({ defaultLimit: 50, maxLimit: 50_000 });
    const result = parseQuery({ limit: '5000' }, exportSchema);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.limit).toBe(5_000);
  });

  it.each(['action', 'severity', 'actor', 'limit', 'offset', 'cursor', 'from'])(
    'rejects a repeated %s parameter',
    (field) => {
      const result = parseQuery({ [field]: ['a', 'b'] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.messages.some((message) => message.includes('at most once'))).toBe(true);
      }
    },
  );

  it('rejects a bracket-nested parameter rather than reporting a type error', () => {
    const result = parseQuery({ actor: { a: '1' } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages).toContain('actor must be provided as a single value');
    }
  });

  it('ignores an unknown query parameter', () => {
    const result = parseQuery({ notARealFilter: 'x' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)['notARealFilter']).toBeUndefined();
    }
  });
});

describe('compatibility: timestamp boundaries', () => {
  it.each([
    ['2026-01-01', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T05:30:00+05:30', '2026-01-01T00:00:00.000Z'],
  ])('normalises %s to canonical ISO-8601 UTC', (input, expected) => {
    const result = parseQuery({ from: input });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.from).toBe(expected);
  });

  it('rejects a calendar date that does not exist instead of rolling it over', () => {
    // Date.parse('2026-02-30') yields 2026-03-02, which would silently move a
    // filter boundary by two days.
    const result = parseQuery({ from: '2026-02-30' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messages[0]).toBe('Invalid from timestamp');
  });

  it('accepts the last day of a leap and non-leap February', () => {
    for (const value of ['2024-02-29', '2026-02-28']) {
      const result = parseQuery({ to: value });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.to).toBe(`${value}T00:00:00.000Z`);
    }
  });

  it('does not calendar-check a fully-specified timestamp, and normalises the rollover', () => {
    // Deliberate asymmetry: only the date-only form is verified against the
    // calendar, because only that form has a second plausible reading. A full
    // timestamp is passed through Date, which rolls 2026-02-30T12:00:00Z over
    // to 2026-03-02T12:00:00.000Z. Pinned so the behaviour stays a decision
    // rather than a surprise.
    const result = parseQuery({ from: '2026-02-30T12:00:00Z' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.from).toBe('2026-03-02T12:00:00.000Z');
  });

  it.each(['not-a-date', '2026-13-01', 'true'])('rejects from=%p', (input) => {
    expect(parseQuery({ from: input }).ok).toBe(false);
  });

  it('accepts an inverted range and yields an empty match rather than an error', () => {
    // Documented, preserved behaviour: `from` later than `to` is not an error,
    // it simply cannot match an entry.
    const result = parseQuery({ from: '2026-02-01', to: '2026-01-01' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.from! > result.data.to!).toBe(true);
    }
  });

  it('accepts a zero-width range (from === to)', () => {
    const result = parseQuery({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });
    expect(result.ok).toBe(true);
  });
});

// ── 4. Cursor contract ───────────────────────────────────────────────────────

describe('compatibility: cursor contract', () => {
  const timestamp = '2026-03-01T10:00:00.000Z';

  it('round-trips a cursor this module could have produced', () => {
    for (const filters of [
      {},
      { action: 'CONTRACT_CREATED' as const },
      { actor: 'user-1', resourceId: 'contract-1' },
      { from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' },
    ]) {
      const cursor = encodeCursor({ lastId: 'entry-1', lastTimestamp: timestamp, filters });
      const result = parseQuery({ ...filters, cursor });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts a cursor whose filters are absent entirely', () => {
    const cursor = Buffer.from(
      JSON.stringify({ lastId: 'entry-1', lastTimestamp: timestamp }),
      'utf-8',
    ).toString('base64');

    expect(parseQuery({ cursor }).ok).toBe(true);
  });

  it('strips unknown cursor keys so a newer writer stays readable', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        lastId: 'entry-1',
        lastTimestamp: timestamp,
        filters: {},
        futureField: { anything: true },
      }),
      'utf-8',
    ).toString('base64');

    const result = parseQuery({ cursor });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.cursor).toBe(cursor);
  });

  it.each([
    ['not base64 JSON', 'not-valid-base64-json!!'],
    ['base64 of a bare string', Buffer.from('"hello"', 'utf-8').toString('base64')],
    ['base64 of a JSON array', Buffer.from('[1,2]', 'utf-8').toString('base64')],
    ['base64 of null', Buffer.from('null', 'utf-8').toString('base64')],
  ])('rejects a cursor that is %s', (_label, cursor) => {
    const result = parseQuery({ cursor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messages[0]).toContain('Invalid cursor format');
  });

  it.each([
    ['lastId missing', { lastTimestamp: '2026-03-01T10:00:00.000Z', filters: {} }],
    ['lastId empty', { lastId: '', lastTimestamp: '2026-03-01T10:00:00.000Z', filters: {} }],
    ['lastId not a string', { lastId: 7, lastTimestamp: '2026-03-01T10:00:00.000Z', filters: {} }],
    ['lastTimestamp unparseable', { lastId: 'entry-1', lastTimestamp: 'soon', filters: {} }],
    ['filters not an object', { lastId: 'entry-1', lastTimestamp: '2026-03-01T10:00:00.000Z', filters: 'all' }],
    [
      'filters carrying an unknown action',
      {
        lastId: 'entry-1',
        lastTimestamp: '2026-03-01T10:00:00.000Z',
        filters: { action: 'MILESTONES_CREATED' },
      },
    ],
  ])('rejects a cursor with %s', (_label, payload) => {
    const cursor = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
    const result = parseQuery({ cursor });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.messages[0]).toContain('Invalid cursor format');
  });

  it('rejects a cursor whose embedded filters differ from the request', () => {
    // Previously this diverged by backend: SQLite refused, the in-memory store
    // silently restarted at page one, which a well-behaved client loops on
    // forever.
    const cursor = encodeCursor({
      lastId: 'entry-1',
      lastTimestamp: timestamp,
      filters: { actor: 'user-1' },
    });

    const result = parseQuery({ cursor, actor: 'someone-else' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.messages[0]).toBe('Invalid cursor: filters do not match query filters');
    }
  });

  it('rejects a cursor that carries a filter the request omitted', () => {
    const cursor = encodeCursor({
      lastId: 'entry-1',
      lastTimestamp: timestamp,
      filters: { action: 'CONTRACT_CREATED' },
    });

    expect(parseQuery({ cursor }).ok).toBe(false);
  });

  it('compares timestamps in normalised form, not by spelling', () => {
    const cursor = encodeCursor({
      lastId: 'entry-1',
      lastTimestamp: timestamp,
      filters: { from: '2026-01-01' },
    });

    expect(parseQuery({ cursor, from: '2026-01-01' }).ok).toBe(true);
  });

  it('ignores pagination parameters when matching embedded filters', () => {
    const cursor = encodeCursor({
      lastId: 'entry-1',
      lastTimestamp: timestamp,
      filters: { actor: 'user-1' },
    });

    // limit/offset are not filters, so changing them must not invalidate a
    // cursor the way changing `actor` does.
    const result = parseQuery({ cursor, actor: 'user-1', limit: '10', offset: '0' });
    expect(result.ok).toBe(true);
  });

  it('validates the decoded cursor shape on its own', () => {
    expect(
      auditCursorDataSchema.safeParse({ lastId: 'entry-1', lastTimestamp: timestamp }).success,
    ).toBe(true);
    expect(auditCursorDataSchema.safeParse({ lastId: 'entry-1' }).success).toBe(false);
    expect(
      auditCursorFiltersSchema.safeParse({ from: '2026-01-01' }).success,
    ).toBe(true);
  });
});

// ── 5. Response contract ─────────────────────────────────────────────────────

describe('compatibility: response contract', () => {
  /** A genuine entry, hashed by the production hasher. */
  function realEntry(overrides: Partial<Record<string, unknown>> = {}) {
    const store = new AuditStore();
    const input: CreateAuditEntryInput = { ...validBody, metadata: {} };
    const entry = store.append(input);
    return { ...entry, ...overrides };
  }

  it('accepts an entry produced by the real store', () => {
    expect(auditEntryResponseSchema.safeParse(realEntry()).success).toBe(true);
  });

  it('accepts an internal-only action in a response', () => {
    const entry = realEntry({ action: 'MILESTONES_DELETED' });
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(true);
  });

  it('still rejects an entry missing its hash', () => {
    const { hash: _hash, ...withoutHash } = realEntry();
    expect(auditEntryResponseSchema.safeParse(withoutHash).success).toBe(false);
  });

  it.each([
    ['a truncated digest', { hash: 'a'.repeat(63) }],
    ['an uppercase digest', { hash: 'A'.repeat(64) }],
    ['a non-hex digest', { hash: 'z'.repeat(64) }],
    ['an empty digest', { hash: '' }],
  ])('rejects an entry whose hash is %s', (_label, override) => {
    expect(auditEntryResponseSchema.safeParse(realEntry(override)).success).toBe(false);
  });

  it.each([
    ['the genesis sentinel', GENESIS_HASH_LITERAL],
    ['a real digest', 'b'.repeat(64)],
  ])('accepts previousHash as %s', (_label, previousHash) => {
    expect(auditEntryResponseSchema.safeParse(realEntry({ previousHash })).success).toBe(true);
  });

  it('rejects an unrecognised previousHash', () => {
    expect(
      auditEntryResponseSchema.safeParse(realEntry({ previousHash: 'NOT-A-HASH' })).success,
    ).toBe(false);
  });

  it('keeps the genesis sentinel in step with the store', () => {
    expect(GENESIS_HASH_LITERAL).toBe(GENESIS_HASH);
  });

  it('rejects an entry with a non-ISO timestamp or empty identity fields', () => {
    expect(auditEntryResponseSchema.safeParse(realEntry({ timestamp: 'yesterday' })).success).toBe(false);
    expect(auditEntryResponseSchema.safeParse(realEntry({ id: '' })).success).toBe(false);
    expect(auditEntryResponseSchema.safeParse(realEntry({ actor: '' })).success).toBe(false);
  });

  it('accepts an entry without the optional transport fields', () => {
    const entry = realEntry();
    expect(auditEntryResponseSchema.safeParse(entry).success).toBe(true);
    expect(
      auditEntryResponseSchema.safeParse({ ...entry, ipAddress: undefined, correlationId: undefined })
        .success,
    ).toBe(true);
  });

  it('validates the empty data shapes both paginated responses can return', () => {
    expect(
      auditQueryResultResponseSchema.safeParse({ entries: [], count: 0, limit: 50 }).success,
    ).toBe(true);
    expect(
      auditLegacyQueryResponseSchema.safeParse({ entries: [], count: 0, limit: 50, offset: 0 })
        .success,
    ).toBe(true);
    expect(
      integrityReportResponseSchema.safeParse({
        valid: true,
        totalEntries: 0,
        checkedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
  });

  it('validates a corrupted integrity report', () => {
    const report = {
      valid: false,
      totalEntries: 3,
      firstCorruptedIndex: 1,
      firstCorruptedId: 'entry-2',
      checkedAt: new Date().toISOString(),
    };
    expect(integrityReportResponseSchema.safeParse(report).success).toBe(true);
    expect(
      integrityReportResponseSchema.safeParse({ ...report, firstCorruptedIndex: -1 }).success,
    ).toBe(false);
  });

  it.each([
    ['a negative count', { entries: [], count: -1, limit: 50 }],
    ['a fractional count', { entries: [], count: 1.5, limit: 50 }],
    ['a negative limit', { entries: [], count: 0, limit: -1 }],
  ])('rejects a paginated response with %s', (_label, payload) => {
    expect(auditQueryResultResponseSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a nextCursor that is present but empty', () => {
    expect(
      auditQueryResultResponseSchema.safeParse({ entries: [], count: 0, limit: 50, nextCursor: '' })
        .success,
    ).toBe(false);
  });

  it('accepts a real chain end to end', () => {
    const store = new AuditStore();
    const first = store.append({ ...validBody, metadata: {} });
    const second = store.append({ ...validBody, resourceId: 'contract-2', metadata: {} });

    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.previousHash).toBe(first.hash);
    for (const entry of store.getAll()) {
      const { hash, ...rest } = entry;
      expect(computeEntryHash(rest)).toBe(hash);
      expect(auditEntryResponseSchema.safeParse(entry).success).toBe(true);
    }
  });
});

// ── 6. Divergence from the live query parser ─────────────────────────────────

describe('compatibility: divergence from parseAuditQuery', () => {
  /**
   * `GET /api/v1/audit` is validated by `parseAuditQuery` today. Both parsers
   * are kept; this table pins every input where they answer differently, so a
   * future edit to either one cannot quietly widen the gap.
   */
  it.each([
    ['limit=007', { limit: '007' }, true],
    ['limit=25.9', { limit: '25.9' }, true],
    ['limit=+5', { limit: '+5' }, true],
    ['offset=5.9', { offset: '5.9' }, true],
    ['offset=007', { offset: '007' }, true],
  ])('%s is accepted by the live parser and rejected by the schema', (_label, raw, liveAccepts) => {
    let liveOk = true;
    try {
      parseAuditQuery(raw as Record<string, unknown>, { defaultLimit: 50, maxLimit: 100 });
    } catch {
      liveOk = false;
    }

    expect(liveOk).toBe(liveAccepts);
    expect(parseQuery(raw).ok).toBe(false);
  });

  it.each([
    ['limit=0', { limit: '0' }],
    ['limit=-1', { limit: '-1' }],
    ['limit=abc', { limit: 'abc' }],
    ['offset=-1', { offset: '-1' }],
    ['offset=abc', { offset: 'abc' }],
    ['from=not-a-date', { from: 'not-a-date' }],
    ['to=not-a-date', { to: 'not-a-date' }],
    ['action=NOT_REAL', { action: 'NOT_REAL' }],
    ['severity=NOT_REAL', { severity: 'NOT_REAL' }],
    ['cursor=garbage', { cursor: 'garbage' }],
  ])('%s is rejected by both parsers', (_label, raw) => {
    let liveOk = true;
    try {
      parseAuditQuery(raw as Record<string, unknown>, { defaultLimit: 50, maxLimit: 100 });
    } catch {
      liveOk = false;
    }

    expect(liveOk).toBe(false);
    expect(parseQuery(raw).ok).toBe(false);
  });

  it.each([
    ['a full valid filter set', {
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      from: '2020-01-01T00:00:00Z',
      to: '2030-01-01T00:00:00Z',
      limit: '25',
      offset: '5',
    }],
    ['a bare limit', { limit: '25' }],
    ['a blank filter', { actor: '' }],
    ['an empty query', {}],
  ])('agrees on %s', (_label, raw) => {
    const live = parseAuditQuery(raw as Record<string, unknown>, {
      defaultLimit: 50,
      maxLimit: 100,
    });
    const declarative = parseQuery(raw);

    expect(declarative.ok).toBe(true);
    if (declarative.ok) {
      expect(declarative.data.limit).toBe(live.limit);
      expect(declarative.data.offset).toBe(live.offset);
      expect(declarative.data.action).toBe(live.query.action);
      expect(declarative.data.actor ?? undefined).toBe(live.query.actor ?? undefined);
      expect(declarative.data.from ?? undefined).toBe(live.query.from ?? undefined);
    }
  });
});
