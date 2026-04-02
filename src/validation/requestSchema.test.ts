/**
 * @file requestSchema.test.ts
 * @description Unit tests for validateSegment — the core validation engine
 *   used by createRequestValidationMiddleware.
 *
 * @security
 *   - Verifies unknown fields are always rejected (no field injection)
 *   - Verifies non-finite numbers are rejected (NaN/Infinity attacks)
 *   - Verifies non-object inputs are rejected (prototype pollution guard)
 *   - Verifies pattern constraints prevent format-bypass attacks
 */

import { ObjectSchema, validateSegment } from './requestSchema';

describe('validateSegment', () => {
  const schema: ObjectSchema = {
    id:       { type: 'string',  required: true,  minLength: 3 },
    score:    { type: 'number',  required: false, min: 0, max: 100 },
    verified: { type: 'boolean', required: false },
  };

  // ── Happy paths ─────────────────────────────────────────────────────────

  it('accepts valid payload and returns validated value', () => {
    const result = validateSegment(
      { id: 'abc', score: 90, verified: true },
      schema,
      'body'
    );
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ id: 'abc', score: 90, verified: true });
  });

  it('accepts payload with only required fields present', () => {
    const result = validateSegment({ id: 'abc' }, schema, 'body');
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({ id: 'abc' });
  });

  it('accepts score at boundary values (0 and 100)', () => {
    const atMin = validateSegment({ id: 'abc', score: 0 }, schema, 'body');
    const atMax = validateSegment({ id: 'abc', score: 100 }, schema, 'body');
    expect(atMin.errors).toEqual([]);
    expect(atMax.errors).toEqual([]);
  });

  it('accepts string at exact minLength boundary', () => {
    const result = validateSegment({ id: 'abc' }, schema, 'body'); // length === 3
    expect(result.errors).toEqual([]);
  });

  // ── Unknown field rejection ──────────────────────────────────────────────

  it('rejects unknown keys', () => {
    const result = validateSegment(
      { id: 'abcd', unknown: 'not-allowed' },
      schema,
      'body'
    );
    expect(result.errors).toContain('body.unknown is not allowed');
  });

  it('rejects multiple unknown keys and reports each', () => {
    const result = validateSegment(
      { id: 'abcd', foo: 1, bar: 2 },
      schema,
      'body'
    );
    expect(result.errors).toContain('body.foo is not allowed');
    expect(result.errors).toContain('body.bar is not allowed');
  });

  // ── Required field enforcement ───────────────────────────────────────────

  it('rejects missing required field', () => {
    const result = validateSegment({}, schema, 'body');
    expect(result.errors).toContain('body.id is required');
  });

  it('treats null value as missing for required field', () => {
    const result = validateSegment({ id: null }, schema, 'body');
    expect(result.errors).toContain('body.id is required');
  });

  // ── Type validation ──────────────────────────────────────────────────────

  it('rejects wrong type — string where number expected', () => {
    const result = validateSegment({ id: 'user-1', score: 'bad' }, schema, 'body');
    expect(result.errors).toContain('body.score must be of type number');
  });

  it('rejects wrong type — number where string expected', () => {
    const result = validateSegment({ id: 42 }, schema, 'body');
    expect(result.errors).toContain('body.id must be of type string');
  });

  it('rejects wrong type — string where boolean expected', () => {
    const result = validateSegment({ id: 'abc', verified: 'true' }, schema, 'body');
    expect(result.errors).toContain('body.verified must be of type boolean');
  });

  // ── Number constraints ───────────────────────────────────────────────────

  it('rejects out-of-range number (above max)', () => {
    const result = validateSegment({ id: 'user-1', score: 101 }, schema, 'body');
    expect(result.errors).toContain('body.score must be <= 100');
  });

  it('rejects out-of-range number (below min)', () => {
    const result = validateSegment({ id: 'user-1', score: -1 }, schema, 'body');
    expect(result.errors).toContain('body.score must be >= 0');
  });

  it('rejects Infinity (non-finite number attack)', () => {
    const result = validateSegment({ id: 'user-1', score: Infinity }, schema, 'body');
    expect(result.errors).toContain('body.score must be a finite number');
  });

  it('rejects -Infinity', () => {
    const result = validateSegment({ id: 'user-1', score: -Infinity }, schema, 'body');
    expect(result.errors).toContain('body.score must be a finite number');
  });

  it('rejects NaN (non-finite number attack)', () => {
    const result = validateSegment({ id: 'user-1', score: NaN }, schema, 'body');
    expect(result.errors).toContain('body.score must be a finite number');
  });

  // ── String constraints ───────────────────────────────────────────────────

  it('rejects string below minLength', () => {
    const result = validateSegment({ id: 'ab' }, schema, 'body');
    expect(result.errors).toContain('body.id must have length >= 3');
  });

  it('rejects string above maxLength', () => {
    const maxSchema: ObjectSchema = { tag: { type: 'string', required: true, maxLength: 5 } };
    const result = validateSegment({ tag: 'toolong' }, maxSchema, 'body');
    expect(result.errors).toContain('body.tag must have length <= 5');
  });

  it('rejects string not matching pattern', () => {
    const patternedSchema: ObjectSchema = {
      id: { type: 'string', required: true, pattern: /^usr_[a-z0-9]+$/ },
    };
    const result = validateSegment({ id: 'INVALID' }, patternedSchema, 'params');
    expect(result.errors).toContain('params.id has invalid format');
  });

  it('accepts string matching pattern', () => {
    const patternedSchema: ObjectSchema = {
      id: { type: 'string', required: true, pattern: /^usr_[a-z0-9]+$/ },
    };
    const result = validateSegment({ id: 'usr_abc123' }, patternedSchema, 'params');
    expect(result.errors).toEqual([]);
  });

  // ── Enum constraints ─────────────────────────────────────────────────────

  it('rejects value not in enum', () => {
    const enumSchema: ObjectSchema = {
      status: { type: 'string', required: true, enum: ['active', 'completed', 'disputed'] },
    };
    const result = validateSegment({ status: 'pending' }, enumSchema, 'query');
    expect(result.errors).toContain('query.status must be one of: active, completed, disputed');
  });

  it('accepts value in enum', () => {
    const enumSchema: ObjectSchema = {
      status: { type: 'string', required: true, enum: ['active', 'completed', 'disputed'] },
    };
    const result = validateSegment({ status: 'active' }, enumSchema, 'query');
    expect(result.errors).toEqual([]);
  });

  it('rejects number not in numeric enum', () => {
    const enumSchema: ObjectSchema = {
      level: { type: 'number', required: true, enum: [1, 2, 3] },
    };
    const result = validateSegment({ level: 5 }, enumSchema, 'body');
    expect(result.errors).toContain('body.level must be one of: 1, 2, 3');
  });

  // ── Non-object segment rejection ─────────────────────────────────────────

  it('rejects non-object segment (string)', () => {
    const result = validateSegment('invalid', schema, 'query');
    expect(result.errors).toEqual(['query must be a JSON object']);
  });

  it('rejects non-object segment (array)', () => {
    const result = validateSegment(['a', 'b'], schema, 'body');
    expect(result.errors).toEqual(['body must be a JSON object']);
  });

  it('rejects non-object segment (null)', () => {
    const result = validateSegment(null, schema, 'params');
    expect(result.errors).toEqual(['params must be a JSON object']);
  });

  it('rejects non-object segment (number)', () => {
    const result = validateSegment(42, schema, 'body');
    expect(result.errors).toEqual(['body must be a JSON object']);
  });

  // ── Segment name propagation ─────────────────────────────────────────────

  it('uses correct segment name in error messages for params', () => {
    const result = validateSegment({}, schema, 'params');
    expect(result.errors).toContain('params.id is required');
  });

  it('uses correct segment name in error messages for query', () => {
    const result = validateSegment({ id: 'ab' }, schema, 'query');
    expect(result.errors).toContain('query.id must have length >= 3');
  });

  // ── Empty schema ─────────────────────────────────────────────────────────

  it('rejects any field when schema is empty (strict by design)', () => {
    const result = validateSegment({ anything: 'value' }, {}, 'body');
    expect(result.errors).toContain('body.anything is not allowed');
  });

  it('accepts empty input against empty schema', () => {
    const result = validateSegment({}, {}, 'body');
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({});
  });
});
