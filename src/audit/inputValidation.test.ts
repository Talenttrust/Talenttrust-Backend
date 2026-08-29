/**
 * @file inputValidation.test.ts
 * @description Unit tests for the audit write-path validator.
 *
 * Organised by the guarantee under test:
 *  - Accepts well-formed input, applying documented defaults.
 *  - Missing / unknown / wrong-typed fields.
 *  - String length and charset bounds, at and past each boundary.
 *  - Metadata structure: type, key count, key length, depth, size, numbers.
 *  - Totality: the validator never throws, for any input.
 *  - Error contract: stable per-issue codes and addressable field paths.
 *  - Middleware behaviour: 400 envelope vs. `next()` handoff.
 */

import type { Request, Response, NextFunction } from 'express';
import {
  AUDIT_VALIDATION_CODES,
  AUDIT_VALIDATION_ERROR_CODE,
  FORBIDDEN_METADATA_KEYS,
  MAX_CORRELATION_ID_LENGTH,
  MAX_ID_LENGTH,
  MAX_IP_LENGTH,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_BYTES,
  MAX_METADATA_DEPTH,
  MAX_METADATA_ENTRIES,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_NUMBER,
  MAX_METADATA_STRING_LENGTH,
  VALIDATED_BODY_KEY,
  computeDepth,
  readValidatedBody,
  validateCreateAuditEntry,
  validateCreateAuditEntryInput,
  validateMetadata,
  type AuditValidationIssue,
} from './inputValidation';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES } from './types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A minimal valid body; spread and override to build the case under test. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { field: 'amount' },
    ...overrides,
  };
}

/** Asserts failure and returns the issues, so each test can assert specifics. */
function expectInvalid(input: unknown): AuditValidationIssue[] {
  const result = validateCreateAuditEntryInput(input);
  if (result.ok) {
    throw new Error(`expected validation to fail, but it succeeded: ${JSON.stringify(input)}`);
  }
  expect(result.code).toBe(AUDIT_VALIDATION_ERROR_CODE);
  return result.issues;
}

function codesFor(issues: AuditValidationIssue[], field: string): string[] {
  return issues.filter((issue) => issue.field === field).map((issue) => issue.code);
}

/** Builds a chain of nested objects `{a:{a:{…:{}}}}` of the requested depth. */
function nestToDepth(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = {};
  for (let i = 1; i < depth; i += 1) {
    node = { a: node };
  }
  return node;
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — accepted input', () => {
  it('accepts a minimal well-formed body', () => {
    const result = validateCreateAuditEntryInput(validBody());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: { field: 'amount' },
    });
  });

  it('accepts every valid action', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(validateCreateAuditEntryInput(validBody({ action })).ok).toBe(true);
    }
  });

  it('accepts every valid severity', () => {
    for (const severity of AUDIT_SEVERITIES) {
      expect(validateCreateAuditEntryInput(validBody({ severity })).ok).toBe(true);
    }
  });

  it('defaults metadata to an empty object when omitted', () => {
    const body = validBody();
    delete body['metadata'];

    const result = validateCreateAuditEntryInput(body);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.metadata).toEqual({});
  });

  it('accepts the optional ipAddress and correlationId fields', () => {
    const result = validateCreateAuditEntryInput(
      validBody({ ipAddress: '203.0.113.7', correlationId: 'req-42:abc_1.2' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ipAddress).toBe('203.0.113.7');
    expect(result.data.correlationId).toBe('req-42:abc_1.2');
  });

  it.each([
    ['IPv4', '192.168.0.1'],
    ['IPv6', '2001:0db8:85a3:0000:0000:8a2e:0370:7334'],
    ['IPv6 shorthand', '::1'],
  ])('accepts a valid %s address', (_label, ipAddress) => {
    expect(validateCreateAuditEntryInput(validBody({ ipAddress })).ok).toBe(true);
  });

  it('accepts nested metadata within every bound', () => {
    const result = validateCreateAuditEntryInput(
      validBody({
        metadata: {
          before: { amount: 100, currency: 'USD' },
          after: { amount: 250, currency: 'USD' },
          tags: ['escrow', 'reviewed'],
          approved: true,
          reviewer: null,
        },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('does not mutate the input object', () => {
    const body = validBody();
    const snapshot = JSON.parse(JSON.stringify(body));

    validateCreateAuditEntryInput(body);

    expect(body).toEqual(snapshot);
  });
});

// ── Body shape ────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — body shape', () => {
  it.each([
    ['null', null],
    ['an array', [{ action: 'AUTH_LOGIN' }]],
    ['a string', '{"action":"AUTH_LOGIN"}'],
    ['a number', 7],
    ['undefined', undefined],
  ])('rejects a body that is %s', (_label, input) => {
    const issues = expectInvalid(input);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('(root)');
  });

  it('rejects an empty body, reporting every missing field', () => {
    const issues = expectInvalid({});

    for (const field of ['action', 'severity', 'actor', 'resource', 'resourceId']) {
      expect(codesFor(issues, field)).toContain(AUDIT_VALIDATION_CODES.MISSING_FIELD);
    }
    // metadata is optional and must not be reported as missing.
    expect(codesFor(issues, 'metadata')).toHaveLength(0);
  });

  it.each(['action', 'severity', 'actor', 'resource', 'resourceId'])(
    'rejects a body missing %s',
    (field) => {
      const body = validBody();
      delete body[field];

      expect(codesFor(expectInvalid(body), field)).toEqual([
        AUDIT_VALIDATION_CODES.MISSING_FIELD,
      ]);
    },
  );

  it('rejects an unknown field', () => {
    const issues = expectInvalid(validBody({ hash: 'forged-hash' }));

    expect(codesFor(issues, 'hash')).toEqual([AUDIT_VALIDATION_CODES.UNKNOWN_FIELD]);
  });

  it('reports each unknown field separately', () => {
    const issues = expectInvalid(validBody({ id: 'x', timestamp: 'y', previousHash: 'z' }));

    for (const field of ['id', 'timestamp', 'previousHash']) {
      expect(codesFor(issues, field)).toEqual([AUDIT_VALIDATION_CODES.UNKNOWN_FIELD]);
    }
  });

  it('collects issues across several fields in one response', () => {
    const issues = expectInvalid({
      action: 'NOT_AN_ACTION',
      severity: 'INFO',
      actor: '',
      resource: 'contract',
      resourceId: 42,
      surprise: true,
    });

    expect(codesFor(issues, 'action')).toContain(AUDIT_VALIDATION_CODES.INVALID_ENUM);
    expect(codesFor(issues, 'actor')).toContain(AUDIT_VALIDATION_CODES.TOO_SMALL);
    expect(codesFor(issues, 'resourceId')).toContain(AUDIT_VALIDATION_CODES.INVALID_TYPE);
    expect(codesFor(issues, 'surprise')).toContain(AUDIT_VALIDATION_CODES.UNKNOWN_FIELD);
  });
});

// ── Enums ─────────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — enum fields', () => {
  it.each([
    ['unknown value', 'CONTRACT_EXPLODED'],
    ['lowercase variant', 'contract_created'],
    ['value with whitespace', ' CONTRACT_CREATED '],
    ['empty string', ''],
  ])('rejects an action that is an %s', (_label, action) => {
    expect(codesFor(expectInvalid(validBody({ action })), 'action')).toContain(
      AUDIT_VALIDATION_CODES.INVALID_ENUM,
    );
  });

  it.each([
    ['a number', 1],
    ['an object', { value: 'INFO' }],
    ['null', null],
  ])('rejects a severity that is %s', (_label, severity) => {
    expect(expectInvalid(validBody({ severity })).some((i) => i.field === 'severity')).toBe(true);
  });

  it('lists the permitted values in the message', () => {
    const issues = expectInvalid(validBody({ severity: 'FATAL' }));

    expect(issues.find((issue) => issue.field === 'severity')?.message).toContain('CRITICAL');
  });
});

// ── Identifier bounds ─────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — identifier bounds', () => {
  const identifiers = ['actor', 'resource', 'resourceId'] as const;

  it.each(identifiers)('accepts %s at exactly the maximum length', (field) => {
    expect(
      validateCreateAuditEntryInput(validBody({ [field]: 'a'.repeat(MAX_ID_LENGTH) })).ok,
    ).toBe(true);
  });

  it.each(identifiers)('rejects %s one character past the maximum length', (field) => {
    expect(
      codesFor(expectInvalid(validBody({ [field]: 'a'.repeat(MAX_ID_LENGTH + 1) })), field),
    ).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it.each(identifiers)('rejects an empty %s', (field) => {
    expect(codesFor(expectInvalid(validBody({ [field]: '' })), field)).toContain(
      AUDIT_VALIDATION_CODES.TOO_SMALL,
    );
  });

  it.each(identifiers)('rejects a whitespace-only %s', (field) => {
    expect(codesFor(expectInvalid(validBody({ [field]: '   ' })), field)).toContain(
      AUDIT_VALIDATION_CODES.BLANK,
    );
  });

  it.each(identifiers)('rejects control characters in %s', (field) => {
    expect(
      codesFor(expectInvalid(validBody({ [field]: 'user\n1' })), field),
    ).toContain(AUDIT_VALIDATION_CODES.CONTROL_CHARACTERS);
  });

  it('rejects a NUL byte, which would truncate downstream consumers', () => {
    expect(codesFor(expectInvalid(validBody({ actor: 'admin\u0000extra' })), 'actor')).toContain(
      AUDIT_VALIDATION_CODES.CONTROL_CHARACTERS,
    );
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an object', { id: 'user-1' }],
    ['an array', ['user-1']],
  ])('rejects an actor that is %s', (_label, actor) => {
    expect(codesFor(expectInvalid(validBody({ actor })), 'actor')).toEqual([
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ]);
  });

  it('reports both bounds when a value is blank and over-long', () => {
    const codes = codesFor(expectInvalid(validBody({ actor: ' '.repeat(MAX_ID_LENGTH + 1) })), 'actor');

    expect(codes).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.BLANK);
  });
});

// ── Optional fields ───────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — ipAddress', () => {
  it.each([
    ['not an address', 'localhost'],
    ['a truncated IPv4', '10.0.0'],
    ['an out-of-range octet', '999.0.0.1'],
    ['an IPv4 with a port', '10.0.0.1:8080'],
  ])('rejects an ipAddress that is %s', (_label, ipAddress) => {
    expect(codesFor(expectInvalid(validBody({ ipAddress })), 'ipAddress')).toContain(
      AUDIT_VALIDATION_CODES.INVALID_FORMAT,
    );
  });

  it('rejects an ipAddress past the length bound', () => {
    expect(
      codesFor(expectInvalid(validBody({ ipAddress: '1'.repeat(MAX_IP_LENGTH + 1) })), 'ipAddress'),
    ).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('rejects a non-string ipAddress', () => {
    expect(codesFor(expectInvalid(validBody({ ipAddress: 3232235521 })), 'ipAddress')).toEqual([
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ]);
  });
});

describe('validateCreateAuditEntryInput — correlationId', () => {
  it('accepts a correlationId at exactly the maximum length', () => {
    expect(
      validateCreateAuditEntryInput(
        validBody({ correlationId: 'c'.repeat(MAX_CORRELATION_ID_LENGTH) }),
      ).ok,
    ).toBe(true);
  });

  it('rejects a correlationId one character past the maximum length', () => {
    expect(
      codesFor(
        expectInvalid(validBody({ correlationId: 'c'.repeat(MAX_CORRELATION_ID_LENGTH + 1) })),
        'correlationId',
      ),
    ).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('rejects an empty correlationId', () => {
    expect(codesFor(expectInvalid(validBody({ correlationId: '' })), 'correlationId')).toContain(
      AUDIT_VALIDATION_CODES.TOO_SMALL,
    );
  });

  it.each([
    ['a newline (log injection)', 'req-1\nlevel=fatal'],
    ['a space', 'req 1'],
    ['a slash', 'req/1'],
  ])('rejects a correlationId containing %s', (_label, correlationId) => {
    expect(
      codesFor(expectInvalid(validBody({ correlationId })), 'correlationId'),
    ).toContain(AUDIT_VALIDATION_CODES.INVALID_FORMAT);
  });
});

// ── Metadata ──────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — metadata', () => {
  it.each([
    ['an array', []],
    ['a string', 'amount=1'],
    ['a number', 1],
    ['a boolean', true],
    ['null', null],
  ])('rejects metadata that is %s', (_label, metadata) => {
    expect(codesFor(expectInvalid(validBody({ metadata })), 'metadata')).toContain(
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    );
  });

  it('accepts metadata with exactly the maximum number of keys', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES }, (_, i) => [`k${i}`, i]),
    );

    expect(validateCreateAuditEntryInput(validBody({ metadata })).ok).toBe(true);
  });

  it('rejects metadata with one key too many', () => {
    const metadata = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_, i) => [`k${i}`, i]),
    );

    expect(codesFor(expectInvalid(validBody({ metadata })), 'metadata')).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_MANY_KEYS,
    );
  });

  it('enforces the key-count bound on nested objects too', () => {
    const nested = Object.fromEntries(
      Array.from({ length: MAX_METADATA_ENTRIES + 1 }, (_, i) => [`k${i}`, i]),
    );

    expect(codesFor(expectInvalid(validBody({ metadata: { nested } })), 'metadata.nested')).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_MANY_KEYS,
    );
  });

  it('accepts a key at exactly the maximum length', () => {
    const metadata = { ['k'.repeat(MAX_METADATA_KEY_LENGTH)]: 1 };

    expect(validateCreateAuditEntryInput(validBody({ metadata })).ok).toBe(true);
  });

  it('rejects a key one character too long', () => {
    const key = 'k'.repeat(MAX_METADATA_KEY_LENGTH + 1);
    const issues = expectInvalid(validBody({ metadata: { [key]: 1 } }));

    expect(codesFor(issues, `metadata.${key}`)).toEqual([
      AUDIT_VALIDATION_CODES.METADATA_KEY_TOO_LONG,
    ]);
  });

  it.each(FORBIDDEN_METADATA_KEYS)('rejects the reserved key %s', (key) => {
    // JSON.parse is used because an object literal would not create __proto__
    // as an own property — exactly the shape an attacker can send over HTTP.
    const metadata = JSON.parse(`{"${key}": {"polluted": true}}`);

    expect(codesFor(expectInvalid(validBody({ metadata })), `metadata.${key}`)).toEqual([
      AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY,
    ]);
  });

  it('accepts metadata nested to exactly the maximum depth', () => {
    expect(
      validateCreateAuditEntryInput(validBody({ metadata: nestToDepth(MAX_METADATA_DEPTH) })).ok,
    ).toBe(true);
  });

  it('rejects metadata nested one level too deep', () => {
    const issues = expectInvalid(validBody({ metadata: nestToDepth(MAX_METADATA_DEPTH + 1) }));

    expect(issues.map((issue) => issue.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_DEEP,
    );
  });

  it('counts arrays towards the depth bound', () => {
    let node: unknown = 'leaf';
    for (let i = 0; i < MAX_METADATA_DEPTH; i += 1) {
      node = [node];
    }

    expect(
      expectInvalid(validBody({ metadata: { deep: node } })).map((issue) => issue.code),
    ).toContain(AUDIT_VALIDATION_CODES.METADATA_TOO_DEEP);
  });

  it('rejects metadata past the serialised byte bound', () => {
    const metadata = { blob: 'x'.repeat(MAX_METADATA_STRING_LENGTH) };
    const chunks = Object.fromEntries(
      Array.from({ length: Math.ceil(MAX_METADATA_BYTES / MAX_METADATA_STRING_LENGTH) + 1 }, (_, i) => [
        `chunk${i}`,
        metadata.blob,
      ]),
    );

    expect(codesFor(expectInvalid(validBody({ metadata: chunks })), 'metadata')).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE,
    );
  });

  it('accepts a string value at exactly the maximum length', () => {
    const metadata = { note: 'n'.repeat(MAX_METADATA_STRING_LENGTH) };

    expect(validateCreateAuditEntryInput(validBody({ metadata })).ok).toBe(true);
  });

  it('rejects a string value one character too long', () => {
    const metadata = { note: 'n'.repeat(MAX_METADATA_STRING_LENGTH + 1) };

    expect(codesFor(expectInvalid(validBody({ metadata })), 'metadata.note')).toEqual([
      AUDIT_VALIDATION_CODES.TOO_BIG,
    ]);
  });

  it('accepts an array at exactly the maximum item count', () => {
    const metadata = { items: Array.from({ length: MAX_METADATA_ARRAY_ITEMS }, (_, i) => i) };

    expect(validateCreateAuditEntryInput(validBody({ metadata })).ok).toBe(true);
  });

  it('rejects an array with one item too many', () => {
    const metadata = { items: Array.from({ length: MAX_METADATA_ARRAY_ITEMS + 1 }, (_, i) => i) };

    expect(codesFor(expectInvalid(validBody({ metadata })), 'metadata.items')).toContain(
      AUDIT_VALIDATION_CODES.TOO_BIG,
    );
  });

  it('rejects a non-finite number, which JSON exposes via overflow literals', () => {
    // 1e400 has no finite double representation, so JSON.parse yields Infinity.
    const metadata = JSON.parse('{"ratio": 1e400}');
    expect(metadata.ratio).toBe(Infinity);

    expect(codesFor(expectInvalid(validBody({ metadata })), 'metadata.ratio')).toEqual([
      AUDIT_VALIDATION_CODES.NOT_FINITE,
    ]);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('rejects %s as a metadata value', (_label, value) => {
    expect(codesFor(expectInvalid(validBody({ metadata: { value } })), 'metadata.value')).toEqual([
      AUDIT_VALIDATION_CODES.NOT_FINITE,
    ]);
  });

  it('accepts a number at exactly the magnitude bound', () => {
    expect(
      validateCreateAuditEntryInput(validBody({ metadata: { n: MAX_METADATA_NUMBER } })).ok,
    ).toBe(true);
  });

  it.each([
    ['above', MAX_METADATA_NUMBER + 2],
    ['below', -(MAX_METADATA_NUMBER + 2)],
  ])('rejects a number %s the magnitude bound', (_label, n) => {
    expect(codesFor(expectInvalid(validBody({ metadata: { n } })), 'metadata.n')).toEqual([
      AUDIT_VALIDATION_CODES.TOO_BIG,
    ]);
  });

  it('rejects values with no JSON representation', () => {
    expect(codesFor(expectInvalid(validBody({ metadata: { fn: () => 1 } })), 'metadata.fn')).toEqual([
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ]);
    expect(codesFor(expectInvalid(validBody({ metadata: { big: 1n } })), 'metadata.big')).toEqual([
      AUDIT_VALIDATION_CODES.INVALID_TYPE,
    ]);
  });

  it('accepts null as a metadata value', () => {
    expect(validateCreateAuditEntryInput(validBody({ metadata: { cleared: null } })).ok).toBe(true);
  });

  it('addresses nested failures by their full path', () => {
    const issues = expectInvalid(
      validBody({ metadata: { before: { amounts: [1, Number.NaN] } } }),
    );

    expect(issues.map((issue) => issue.field)).toContain('metadata.before.amounts[1]');
  });
});

// ── Totality ──────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntryInput — never throws', () => {
  it('handles a circular metadata graph', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    const issues = expectInvalid(validBody({ metadata: cyclic }));

    expect(issues.map((issue) => issue.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
    );
  });

  it('handles a value repeated (but not circular) in two branches', () => {
    const shared = { id: 'shared' };

    expect(
      validateCreateAuditEntryInput(validBody({ metadata: { a: shared, b: shared } })).ok,
    ).toBe(true);
  });

  it.each([
    ['a symbol', Symbol('nope')],
    ['a function', () => undefined],
    ['a Map', new Map([['a', 1]])],
    ['a Date', new Date('2026-01-01T00:00:00.000Z')],
    ['a RegExp', /audit/],
  ])('handles %s as the whole body without throwing', (_label, input) => {
    expect(() => validateCreateAuditEntryInput(input)).not.toThrow();
    expect(validateCreateAuditEntryInput(input).ok).toBe(false);
  });

  it('handles metadata whose property access throws', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'boobytrap', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });

    const issues = expectInvalid(validBody({ metadata: hostile }));

    expect(issues.map((issue) => issue.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
    );
  });

  it('handles an object with a null prototype', () => {
    const body = Object.assign(Object.create(null), validBody());

    expect(() => validateCreateAuditEntryInput(body)).not.toThrow();
  });
});

// ── validateMetadata (direct) ─────────────────────────────────────────────────

describe('validateMetadata', () => {
  it('returns no issues for a valid object', () => {
    expect(validateMetadata({ a: 1, b: 'two', c: [true, null] })).toEqual([]);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['a primitive', 5],
  ])('reports a single type issue for %s', (_label, value) => {
    const issues = validateMetadata(value);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(AUDIT_VALIDATION_CODES.INVALID_TYPE);
  });

  it('reports the byte size actually measured', () => {
    // Each value stays under the per-string bound so that the total-size check
    // is what fires, not the string-length check.
    const chunk = 'x'.repeat(MAX_METADATA_STRING_LENGTH);
    const issues = validateMetadata(
      Object.fromEntries(
        Array.from({ length: Math.ceil(MAX_METADATA_BYTES / chunk.length) + 1 }, (_, i) => [
          `chunk${i}`,
          chunk,
        ]),
      ),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe(AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE);
    expect(issues[0]?.message).toMatch(/received \d+/);
  });

  it('measures size in bytes, not characters', () => {
    // A 4-byte emoji is 2 UTF-16 code units, so a cap applied to `.length`
    // would let roughly twice the intended payload through.
    const emoji = '🎯';
    const perValue = emoji.repeat(1_000); // 4,000 bytes, 2,000 code units
    const metadata = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`flags${i}`, perValue]),
    );
    expect(Buffer.byteLength(JSON.stringify(metadata), 'utf-8')).toBeGreaterThan(
      MAX_METADATA_BYTES,
    );

    expect(validateMetadata(metadata).map((issue) => issue.code)).toContain(
      AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE,
    );
  });
});

// ── computeDepth ──────────────────────────────────────────────────────────────

describe('computeDepth', () => {
  it.each([
    ['a string', 'x', 0],
    ['a number', 1, 0],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['an empty object', {}, 1],
    ['a flat object', { a: 1 }, 1],
    ['an empty array', [], 1],
    ['a nested object', { a: { b: 1 } }, 2],
    ['an object holding an array of objects', { a: [{ b: 1 }] }, 3],
  ])('reports depth %s as %s', (_label, value, expected) => {
    expect(computeDepth(value)).toBe(expected);
  });

  it('terminates on a circular graph', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(() => computeDepth(cyclic)).not.toThrow();
    // The self-reference is not counted again, so the graph measures one level.
    expect(computeDepth(cyclic)).toBe(1);
  });
});

// ── Middleware ────────────────────────────────────────────────────────────────

describe('validateCreateAuditEntry middleware', () => {
  function mockResponse(locals: Record<string, unknown> = {}): Response & {
    statusCode?: number;
    body?: unknown;
  } {
    const res = {
      locals,
      statusCode: undefined as number | undefined,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res as unknown as Response & { statusCode?: number; body?: unknown };
  }

  function run(
    body: unknown,
    locals: Record<string, unknown> = {},
  ): { res: ReturnType<typeof mockResponse>; next: jest.MockedFunction<NextFunction> } {
    const res = mockResponse(locals);
    const next = jest.fn() as jest.MockedFunction<NextFunction>;
    validateCreateAuditEntry({ body } as Request, res, next);
    return { res, next };
  }

  it('calls next and publishes the parsed body on success', () => {
    const { res, next } = run(validBody());

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
    expect(res.locals[VALIDATED_BODY_KEY]).toMatchObject({ actor: 'user-1' });
  });

  it('publishes defaults rather than the raw body', () => {
    const body = validBody();
    delete body['metadata'];

    const { res } = run(body);

    expect((res.locals[VALIDATED_BODY_KEY] as { metadata: unknown }).metadata).toEqual({});
  });

  it('responds 400 with the standard envelope and does not call next', () => {
    const { res, next } = run({ action: 'NOPE' });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: AUDIT_VALIDATION_ERROR_CODE,
        message: 'Request validation failed',
        requestId: 'unknown',
      },
    });
  });

  it('includes one addressable detail per problem', () => {
    const { res } = run({ action: 'NOPE', severity: 'INFO', actor: 'a', resource: 'r', resourceId: 'i', extra: 1 });

    const details = (res.body as { error: { details: AuditValidationIssue[] } }).error.details;
    expect(details.length).toBeGreaterThanOrEqual(2);
    for (const detail of details) {
      expect(typeof detail.field).toBe('string');
      expect(typeof detail.code).toBe('string');
      expect(typeof detail.message).toBe('string');
    }
  });

  it('echoes the request id when one is present', () => {
    const { res } = run({}, { requestId: 'req-abc' });

    expect((res.body as { error: { requestId: string } }).error.requestId).toBe('req-abc');
  });

  it('falls back to "unknown" when the request id is not a string', () => {
    const { res } = run({}, { requestId: 12345 });

    expect((res.body as { error: { requestId: string } }).error.requestId).toBe('unknown');
  });
});

describe('readValidatedBody', () => {
  it('returns the body published by the middleware', () => {
    const res = { locals: { [VALIDATED_BODY_KEY]: validBody() } } as unknown as Response;

    expect(readValidatedBody(res)).toMatchObject({ actor: 'user-1' });
  });

  it('throws when the middleware did not run, rather than logging unvalidated input', () => {
    const res = { locals: {} } as unknown as Response;

    expect(() => readValidatedBody(res)).toThrow(/middleware must run/);
  });
});
