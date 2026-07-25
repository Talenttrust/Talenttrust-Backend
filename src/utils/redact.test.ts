/**
 * Unit tests for redact utility functions.
 * @module redact.test
 */

import { redactSecret, redactObject, redactPayload, redactHeaders } from './redact';

describe('redactSecret', () => {
  it('returns [REDACTED] for any value', () => {
    expect(redactSecret('my-secret')).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for null', () => {
    expect(redactSecret(null)).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for undefined', () => {
    expect(redactSecret(undefined)).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for numbers', () => {
    expect(redactSecret(12345)).toBe('[REDACTED]');
  });

  it('returns [REDACTED] for objects', () => {
    expect(redactSecret({ key: 'value' })).toBe('[REDACTED]');
  });
});

describe('redactObject', () => {
  it('redacts values for keys matching sensitive patterns (case-insensitive)', () => {
    const input = {
      secret: 'secret-value',
      SECRET: 'another-secret',
      Signature: 'sig-value',
      TOKEN: 'token-value',
      Key: 'key-value',
      PASSWORD: 'password-value',
      Authorization: 'auth-value',
      nonce: 'nonce-value',
    };

    const result = redactObject(input);

    expect(result.secret).toBe('[REDACTED]');
    expect(result.SECRET).toBe('[REDACTED]');
    expect(result.Signature).toBe('[REDACTED]');
    expect(result.TOKEN).toBe('[REDACTED]');
    expect(result.Key).toBe('[REDACTED]');
    expect(result.PASSWORD).toBe('[REDACTED]');
    expect(result.Authorization).toBe('[REDACTED]');
    expect(result.nonce).toBe('[REDACTED]');
  });

  it('preserves non-sensitive fields unchanged', () => {
    const input = {
      name: 'John Doe',
      email: 'john@example.com',
      id: 123,
      active: true,
    };

    const result = redactObject(input);

    expect(result.name).toBe('John Doe');
    expect(result.email).toBe('john@example.com');
    expect(result.id).toBe(123);
    expect(result.active).toBe(true);
  });

  it('recursively redacts nested objects', () => {
    const input = {
      user: {
        name: 'John',
        credentials: {
          password: 'secret-password',
          apiKey: 'secret-key',
        },
      },
    };

    const result = redactObject(input) as any;

    expect(result.user.name).toBe('John');
    expect(result.user.credentials.password).toBe('[REDACTED]');
    expect(result.user.credentials.apiKey).toBe('[REDACTED]');
  });

  it('handles deeply nested structures', () => {
    const input = {
      level1: {
        level2: {
          level3: {
            level4: {
              secret: 'deep-secret',
              normal: 'normal-value',
            },
          },
        },
      },
    };

    const result = redactObject(input) as any;

    expect(result.level1.level2.level3.level4.secret).toBe('[REDACTED]');
    expect(result.level1.level2.level3.level4.normal).toBe('normal-value');
  });

  it('preserves array values as-is (does not recurse into arrays)', () => {
    const input = {
      items: [
        { name: 'item1', secret: 'secret1' },
        { name: 'item2', secret: 'secret2' },
      ],
    };

    const result = redactObject(input);

    // Arrays are not recursively processed by redactObject
    expect(result.items).toEqual(input.items);
  });

  it('handles null values', () => {
    const input = {
      name: 'test',
      secret: 'secret-value',
      nullField: null,
    };

    const result = redactObject(input);

    expect(result.name).toBe('test');
    expect(result.secret).toBe('[REDACTED]');
    expect(result.nullField).toBeNull();
  });

  it('handles empty objects', () => {
    const input = {};
    const result = redactObject(input);
    expect(result).toEqual({});
  });

  it('handles objects with only sensitive keys', () => {
    const input = {
      secret: 'secret-value',
      token: 'token-value',
    };

    const result = redactObject(input);

    expect(result.secret).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
  });

  it('handles mixed case sensitive key patterns', () => {
    const input = {
      Secret: 'value1',
      sEcReT: 'value2',
      SECRET: 'value3',
      AuThOrIzAtIoN: 'value4',
    };

    const result = redactObject(input);

    expect(result.Secret).toBe('[REDACTED]');
    expect(result.sEcReT).toBe('[REDACTED]');
    expect(result.SECRET).toBe('[REDACTED]');
    expect(result['AuThOrIzAtIoN']).toBe('[REDACTED]');
  });

  it('handles keys containing sensitive patterns as substrings', () => {
    const input = {
      apiSecret: 'value1',
      secretKey: 'value2',
      authToken: 'value3',
      passwordReset: 'value4',
    };

    const result = redactObject(input);

    expect(result.apiSecret).toBe('[REDACTED]');
    expect(result.secretKey).toBe('[REDACTED]');
    expect(result.authToken).toBe('[REDACTED]');
    expect(result.passwordReset).toBe('[REDACTED]');
  });

  it('preserves number and boolean values in non-sensitive fields', () => {
    const input = {
      count: 42,
      active: false,
      ratio: 3.14,
      secret: 'secret-value',
    };

    const result = redactObject(input);

    expect(result.count).toBe(42);
    expect(result.active).toBe(false);
    expect(result.ratio).toBe(3.14);
    expect(result.secret).toBe('[REDACTED]');
  });

  it('returns a new object (does not mutate input)', () => {
    const input = {
      name: 'test',
      secret: 'secret-value',
    };

    const result = redactObject(input);

    expect(result).not.toBe(input);
    expect(input.secret).toBe('secret-value'); // Original unchanged
    expect(result.secret).toBe('[REDACTED]');
  });
});

describe('redactHeaders', () => {
  it('redacts sensitive headers case-insensitively', () => {
    const result = redactHeaders({
      Authorization: 'Bearer secret-token',
      cookie: 'session=abc123',
      'X-API-KEY': 'my-secret-key',
      'Proxy-Authorization': 'Basic dXNlcjpwYXNz',
      'x-forwarded-for': '1.2.3.4',
      'x-real-ip': '10.0.0.1',
    });

    expect(result['Authorization']).toBe('[REDACTED]');
    expect(result['cookie']).toBe('[REDACTED]');
    expect(result['X-API-KEY']).toBe('[REDACTED]');
    expect(result['Proxy-Authorization']).toBe('[REDACTED]');
    expect(result['x-forwarded-for']).toBe('[REDACTED]');
    expect(result['x-real-ip']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive headers and array values', () => {
    const result = redactHeaders({
      Accept: 'application/json',
      vary: ['Origin', 'Accept-Encoding'],
      'x-request-id': 'req-123',
    });

    expect(result).toEqual({
      Accept: 'application/json',
      vary: ['Origin', 'Accept-Encoding'],
      'x-request-id': 'req-123',
    });
  });

  it('truncates long non-sensitive string header values', () => {
    const result = redactHeaders({
      'x-long-header': 'a'.repeat(205),
    });

    expect(result['x-long-header']).toBe('a'.repeat(200) + '...');
  });

  it('does not mutate the original headers object', () => {
    const input = {
      Authorization: 'Bearer secret-token',
      Accept: 'application/json',
    };

    const result = redactHeaders(input);

    expect(result).not.toBe(input);
    expect(input.Authorization).toBe('Bearer secret-token');
  });

  it('does not over-redact benign header names containing generic fragments', () => {
    const result = redactHeaders({
      'x-public-key-hint': 'stellar-account',
      'x-session-tokenized': 'derived-value',
    });

    expect(result['x-public-key-hint']).toBe('stellar-account');
    expect(result['x-session-tokenized']).toBe('derived-value');
  });
});

describe('redactPayload', () => {
  it('handles null input', () => {
    expect(redactPayload(null)).toBeNull();
  });

  it('handles undefined input', () => {
    expect(redactPayload(undefined)).toBeUndefined();
  });

  it('handles primitive non-object values', () => {
    expect(redactPayload('string')).toBe('string');
    expect(redactPayload(123)).toBe(123);
    expect(redactPayload(true)).toBe(true);
    expect(redactPayload(false)).toBe(false);
  });

  it('delegates to redactObject for plain objects', () => {
    const input = {
      name: 'test',
      secret: 'secret-value',
    };

    const result = redactPayload(input);

    expect(result.name).toBe('test');
    expect(result.secret).toBe('[REDACTED]');
  });

  it('recursively processes arrays of objects', () => {
    const input = [
      { name: 'item1', secret: 'secret1' },
      { name: 'item2', token: 'token2' },
      { name: 'item3', password: 'password3' },
    ];

    const result = redactPayload(input);

    expect(result[0].name).toBe('item1');
    expect(result[0].secret).toBe('[REDACTED]');
    expect(result[1].name).toBe('item2');
    expect(result[1].token).toBe('[REDACTED]');
    expect(result[2].name).toBe('item3');
    expect(result[2].password).toBe('[REDACTED]');
  });

  it('handles arrays of primitive values', () => {
    const input = [1, 2, 3, 'string', true];
    const result = redactPayload(input);
    expect(result).toEqual(input);
  });

  it('handles nested arrays', () => {
    const input = [
      [{ name: 'nested', secret: 'secret' }],
      [{ token: 'token' }],
    ];

    const result = redactPayload(input);

    expect(result[0][0].name).toBe('nested');
    expect(result[0][0].secret).toBe('[REDACTED]');
    expect(result[1][0].token).toBe('[REDACTED]');
  });

  it('handles empty arrays', () => {
    const input: unknown[] = [];
    const result = redactPayload(input);
    expect(result).toEqual([]);
  });

  it('handles mixed nested structures with arrays and objects', () => {
    const input = {
      users: [
        { name: 'user1', credentials: { password: 'pass1' } },
        { name: 'user2', credentials: { apiKey: 'key2' } },
      ],
      config: {
        secret: 'config-secret',
        settings: { normal: 'value' },
      },
    };

    const result = redactPayload(input) as any;

    // redactObject preserves arrays as-is (does not recurse into them)
    // Only the top-level object's sensitive keys are redacted
    expect(result.users[0].name).toBe('user1');
    expect(result.users[0].credentials.password).toBe('pass1'); // Not redacted
    expect(result.users[1].name).toBe('user2');
    expect(result.users[1].credentials.apiKey).toBe('key2'); // Not redacted
    expect(result.config.secret).toBe('[REDACTED]');
    expect(result.config.settings.normal).toBe('value');
  });

  it('handles arrays containing null and undefined', () => {
    const input = [null, undefined, { secret: 'secret' }];
    const result = redactPayload(input);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeUndefined();
    expect(result[2].secret).toBe('[REDACTED]');
  });

  it('preserves non-sensitive fields in complex nested structures', () => {
    const input = {
      data: {
        items: [
          { id: 1, value: 'a', secret: 's1' },
          { id: 2, value: 'b', token: 't2' },
        ],
        metadata: {
          count: 2,
          version: '1.0',
        },
      },
    };

    const result = redactPayload(input) as any;

    // Arrays are preserved as-is by redactObject, so nested objects in arrays are not redacted
    expect(result.data.items[0].id).toBe(1);
    expect(result.data.items[0].value).toBe('a');
    expect(result.data.items[0].secret).toBe('s1'); // Not redacted
    expect(result.data.items[1].id).toBe(2);
    expect(result.data.items[1].value).toBe('b');
    expect(result.data.items[1].token).toBe('t2'); // Not redacted
    expect(result.data.metadata.count).toBe(2);
    expect(result.data.metadata.version).toBe('1.0');
  });

  it('does not mutate the original input object', () => {
    const input = {
      name: 'test',
      secret: 'secret-value',
    };

    redactPayload(input);

    expect(input.secret).toBe('secret-value');
  });

  it('does not mutate the original input array', () => {
    const input = [{ secret: 'secret-value' }];

    redactPayload(input);

    expect(input[0].secret).toBe('secret-value');
  });
});
