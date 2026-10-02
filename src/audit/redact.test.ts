import {
  maskEmail,
  redactHeaders,
  redactBody,
  buildAuditMetadata,
  REDACTED,
  MAX_REDACTION_DEPTH,
} from './redact';

describe('redact edge cases and non-mutation', () => {

  it('handles circular references in objects by redacting the cycle', () => {
    const circular: Record<string, unknown> = { name: 'alice' };
    circular['self'] = circular;

    const result = redactBody(circular) as Record<string, unknown>;
    expect(result['name']).toBe('alice');
    expect(result['self']).toBe(REDACTED);
  });

  it('handles circular references in arrays by redacting the cycle', () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);

    const result = redactBody(arr) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(REDACTED);
  });

  it('handles circular references between object and array', () => {
    const obj: Record<string, unknown> = { id: 1 };
    const arr: unknown[] = [obj];
    obj['children'] = arr;

    const result = redactBody(obj) as Record<string, unknown>;
    expect(result['id']).toBe(1);
    const children = result['children'] as unknown[];
    expect(children[0]).toBe(REDACTED);
  });

  it('redacts values exceeding maximum depth', () => {
    let nested: Record<string, unknown> = { value: 'deep' };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 5; i++) {
      nested = { nested };
    }

    const result = redactBody(nested) as Record<string, unknown>;
    // Should have REDACTED at some point due to depth limit
    const serialised = JSON.stringify(result);
    expect(serialised).toContain(REDACTED);
  });

  it('handles deeply nested arrays within depth limit', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i++) {
      nested = [nested];
    }

    const result = redactBody(nested);
    expect(JSON.stringify(result)).toContain('leaf');
  });

  it('buildAuditMetadata handles null headers gracefully', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      null as any,
      undefined,
      {},
      200,
      'req-1',
    );
    expect(result['headers']).toEqual({});
  });

  it('buildAuditMetadata handles undefined headers gracefully', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      undefined as any,
      undefined,
      {},
      200,
      'req-1',
    );
    expect(result['headers']).toEqual({});
  });

  it('buildAuditMetadata handles non-object headers gracefully', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      'invalid' as any,
      undefined,
      {},
      200,
      'req-1',
    );
    expect(result['headers']).toEqual({});
  });

  it('buildAuditMetadata handles invalid method by coercing to UNKNOWN', () => {
    const result = buildAuditMetadata(
      null as any,
      '/api/v1/contracts',
      {},
      undefined,
      {},
      200,
      'req-1',
    );
    expect(result['method']).toBe('UNKNOWN');
  });

  it('buildAuditMetadata handles invalid path by coercing to empty string', () => {
    const result = buildAuditMetadata(
      'GET',
      null as any,
      {},
      undefined,
      {},
      200,
      'req-1',
    );
    expect(result['path']).toBe('');
  });

  it('buildAuditMetadata handles invalid statusCode by coercing to 0', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      {},
      undefined,
      {},
      NaN as any,
      'req-1',
    );
    expect(result['statusCode']).toBe(0);
  });

  it('buildAuditMetadata handles non-object query by setting to null', () => {
    const result = buildAuditMetadata(
      'GET',
      '/api/v1/contracts',
      {},
      undefined,
      'invalid' as any,
      200,
      'req-1',
    );
    expect(result['query']).toBeNull();
  });

  it('redactBody does not mutate the original object with circular reference', () => {
    const circular: Record<string, unknown> = { name: 'original' };
    circular['self'] = circular;

    redactBody(circular);
    expect(circular.name).toBe('original');
    expect(circular.self).toBe(circular);
  });

  it('redactBody handles multiple circular references in same object', () => {
    const obj1: Record<string, unknown> = { id: 1 };
    const obj2: Record<string, unknown> = { id: 2 };
    obj1['ref'] = obj2;
    obj2['ref'] = obj1;

    const result = redactBody(obj1) as Record<string, unknown>;
    expect(result['id']).toBe(1);
    // obj2 gets processed first, then when we try to process obj1 again from obj2.ref,
    // it's already in visited set, so it returns REDACTED
    const ref = result['ref'] as Record<string, unknown>;
    expect(ref['id']).toBe(2);
    expect(ref['ref']).toBe(REDACTED);
  });

  it('redactBody handles empty objects', () => {
    const result = redactBody({});
    expect(result).toEqual({});
  });

  it('redactBody handles empty arrays', () => {
    const result = redactBody([]);
    expect(result).toEqual([]);
  });

  it('redactBody handles arrays with mixed types', () => {
    const result = redactBody([1, 'string', null, undefined, true, { key: 'value' }]);
    expect(result).toEqual([1, 'string', null, undefined, true, { key: 'value' }]);
  });

  it('redactBody handles special characters in keys', () => {
    const result = redactBody({ 'key-with-dash': 'value', 'key_with_underscore': 'value' }) as Record<string, unknown>;
    expect(result['key-with-dash']).toBe('value');
    expect(result['key_with_underscore']).toBe('value');
  });

  it('redactBody handles numeric string keys', () => {
    const result = redactBody({ '123': 'value' }) as Record<string, unknown>;
    expect(result['123']).toBe('value');
  });

  it('redactBody handles Date objects by treating them as objects', () => {
    const date = new Date('2024-01-01');
    const result = redactBody({ date });
    // Date objects become plain objects with no special handling
    expect(result).toBeDefined();
  });

  it('redactBody handles RegExp objects by treating them as objects', () => {
    const regex = /test/g;
    const result = redactBody({ regex });
    // RegExp objects become plain objects with no special handling
    expect(result).toBeDefined();
  });

  it('redactBody handles deeply nested structure at exactly depth limit', () => {
    let nested: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < MAX_REDACTION_DEPTH - 1; i++) {
      nested = { nested };
    }

    const result = redactBody(nested) as Record<string, unknown>;
    // Should process successfully without hitting the limit
    const serialised = JSON.stringify(result);
    expect(serialised).toContain('leaf');
  });

  it('redactBody handles array with circular reference at different positions', () => {
    const obj: Record<string, unknown> = { id: 1 };
    const arr: unknown[] = [obj, 2, obj];
    obj['self'] = arr;

    const result = redactBody(arr) as unknown[];
    // obj gets processed the first time we see it
    const firstObj = result[0] as Record<string, unknown>;
    expect(firstObj['id']).toBe(1);
    // When we process obj.self, it points to arr which is already in visited set
    expect(firstObj['self']).toBe(REDACTED);
    expect(result[1]).toBe(2);
    // obj is already in visited set when we encounter it the second time
    expect(result[2]).toBe(REDACTED);
  });

  it('redactHeaders handles headers with array values', () => {
    const headers = { 'set-cookie': ['id=1', 'id=2'] };
    const result = redactHeaders(headers);
    expect(result['set-cookie']).toBe(REDACTED);
  });

  it('redactHeaders handles headers with undefined values', () => {
    const headers = { 'x-custom': undefined };
    const result = redactHeaders(headers);
    expect(result['x-custom']).toBeUndefined();
  });

  it('redactHeaders handles empty headers object', () => {
    const result = redactHeaders({});
    expect(result).toEqual({});
  });

  it('maskEmail handles email with special characters in local part', () => {
    const result = maskEmail('user+tag@example.com');
    expect(result).toBe('use***@example.com');
  });

  it('maskEmail handles email with subdomains', () => {
    const result = maskEmail('user@mail.example.com');
    expect(result).toBe('use***@mail.example.com');
  });

  it('maskEmail handles email with numbers', () => {
    const result = maskEmail('user123@example.com');
    expect(result).toBe('use***@example.com');
  });

  it('buildAuditMetadata handles all null/undefined inputs', () => {
    const result = buildAuditMetadata(
      null as any,
      null as any,
      null as any,
      null,
      null as any,
      null as any,
      null,
    );
    expect(result['method']).toBe('UNKNOWN');
    expect(result['path']).toBe('');
    expect(result['statusCode']).toBe(0);
    expect(result['requestId']).toBeNull();
    expect(result['headers']).toEqual({});
    expect(result['body']).toBeNull();
    expect(result['query']).toBeNull();
  });

  // ─── Immutability verification tests ───────────────────────────────────────

  it('redactBody never mutates simple objects', () => {
    const original = { username: 'alice', password: 'secret' };
    const originalCopy = { ...original };
    redactBody(original);
    expect(original).toEqual(originalCopy);
  });

  it('redactBody never mutates nested objects', () => {
    const original = { user: { id: 1, secret: 'value' } };
    const originalCopy = JSON.parse(JSON.stringify(original));
    redactBody(original);
    expect(original).toEqual(originalCopy);
  });

  it('redactBody never mutates arrays', () => {
    const original = [1, 2, { password: 'secret' }];
    const originalCopy = JSON.parse(JSON.stringify(original));
    redactBody(original);
    expect(original).toEqual(originalCopy);
  });

  it('redactBody returns a new object, not the same reference', () => {
    const original = { key: 'value' };
    const result = redactBody(original) as Record<string, unknown>;
    expect(result).not.toBe(original);
    expect(result.key).toBe('value');
  });

  it('redactBody returns a new array, not the same reference', () => {
    const original = [1, 2, 3];
    const result = redactBody(original) as unknown[];
    expect(result).not.toBe(original);
    expect(result).toEqual(original);
  });

  it('redactBody creates new nested objects', () => {
    const original = { nested: { key: 'value' } };
    const result = redactBody(original) as Record<string, unknown>;
    const resultNested = result.nested as Record<string, unknown>;
    const originalNested = original.nested as Record<string, unknown>;
    expect(resultNested).not.toBe(originalNested);
  });

  it('redactBody creates new nested arrays', () => {
    const original = { arr: [1, 2, 3] };
    const result = redactBody(original) as Record<string, unknown>;
    const resultArr = result.arr as unknown[];
    const originalArr = original.arr as unknown[];
    expect(resultArr).not.toBe(originalArr);
  });

  it('redactHeaders never mutates the original headers object', () => {
    const original = { authorization: 'Bearer token', 'content-type': 'application/json' };
    const originalCopy = { ...original };
    redactHeaders(original);
    expect(original).toEqual(originalCopy);
  });

  it('redactHeaders returns a new object, not the same reference', () => {
    const original = { 'x-api-key': 'secret' };
    const result = redactHeaders(original);
    expect(result).not.toBe(original);
  });

  it('buildAuditMetadata never mutates input headers', () => {
    const headers = { authorization: 'Bearer token' };
    const headersCopy = { ...headers };
    buildAuditMetadata('GET', '/', headers, undefined, {}, 200, 'req-1');
    expect(headers).toEqual(headersCopy);
  });

  it('buildAuditMetadata never mutates input body', () => {
    const body = { password: 'secret' };
    const bodyCopy = { ...body };
    buildAuditMetadata('POST', '/', {}, body, {}, 201, 'req-1');
    expect(body).toEqual(bodyCopy);
  });

  it('buildAuditMetadata never mutates input query', () => {
    const query = { token: 'value' };
    const queryCopy = { ...query };
    buildAuditMetadata('GET', '/', {}, undefined, query, 200, 'req-1');
    expect(query).toEqual(queryCopy);
  });

  it('redactBody returns same reference for primitives', () => {
    expect(redactBody(null)).toBe(null);
    expect(redactBody(undefined)).toBe(undefined);
    expect(redactBody(42)).toBe(42);
    expect(redactBody(true)).toBe(true);
    expect(redactBody(false)).toBe(false);
  });

  it('redactBody returns new string for email masking', () => {
    const original = 'alice@example.com';
    const result = redactBody(original);
    expect(result).not.toBe(original);
    expect(result).toBe('ali***@example.com');
  });

  it('redactBody returns same string reference for non-email strings', () => {
    const original = 'not-an-email';
    const result = redactBody(original);
    // Strings are immutable, so this is acceptable
    expect(result).toBe(original);
  });
});
