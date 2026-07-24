/**
 * @fileoverview Comprehensive unit tests for the redaction utility module.
 *
 * These tests assert that:
 *   - Sensitive keys (tokens, auth headers, secrets, passwords, cookies,
 *     nonces, signatures) are always replaced with the `[REDACTED]` marker.
 *   - Nested objects are recursively redacted.
 *   - Non-sensitive fields pass through unchanged.
 *   - HTTP header redaction is case-insensitive and truncates long values.
 *   - Payload redaction handles arrays, primitives, null, and undefined.
 *   - No real secret values leak into assertion messages or snapshots.
 *
 * @module redact.test
 * @see {@link redact.ts}
 */

import { redactSecret, redactObject, redactPayload, redactHeaders } from './redact';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The exact redaction marker produced by the module.
 * Tests MUST never assert on a real secret value — always assert on `[REDACTED]`.
 */
const REDACTED_MARKER = '[REDACTED]';

// ─── redactSecret ────────────────────────────────────────────────────────────

describe('redactSecret', () => {
  it('returns [REDACTED] for a plain string', () => {
    expect(redactSecret('my-secret')).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for null', () => {
    expect(redactSecret(null)).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for undefined', () => {
    expect(redactSecret(undefined)).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for numbers', () => {
    expect(redactSecret(12345)).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for objects', () => {
    expect(redactSecret({ key: 'value' })).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for booleans', () => {
    expect(redactSecret(true)).toBe(REDACTED_MARKER);
    expect(redactSecret(false)).toBe(REDACTED_MARKER);
  });

  it('returns [REDACTED] for arrays', () => {
    expect(redactSecret(['a', 'b'])).toBe(REDACTED_MARKER);
  });

  it('returns a stable string (same reference)', () => {
    const a = redactSecret('x');
    const b = redactSecret('y');
    expect(a).toBe(b);
    expect(a).toBe(REDACTED_MARKER);
  });

  it('never exposes the input value in the return', () => {
    const result = redactSecret('super-secret-api-key-12345');
    expect(result).not.toContain('super-secret');
    expect(result).not.toContain('api-key');
    expect(result).toBe(REDACTED_MARKER);
  });
});

// ─── redactObject ────────────────────────────────────────────────────────────

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

    expect(result.secret).toBe(REDACTED_MARKER);
    expect(result.SECRET).toBe(REDACTED_MARKER);
    expect(result.Signature).toBe(REDACTED_MARKER);
    expect(result.TOKEN).toBe(REDACTED_MARKER);
    expect(result.Key).toBe(REDACTED_MARKER);
    expect(result.PASSWORD).toBe(REDACTED_MARKER);
    expect(result.Authorization).toBe(REDACTED_MARKER);
    expect(result.nonce).toBe(REDACTED_MARKER);
  });

  it('redacts keys containing sensitive substrings', () => {
    const input = {
      apiSecret: 'value1',
      secretKey: 'value2',
      authToken: 'value3',
      passwordReset: 'value4',
    };

    const result = redactObject(input);

    expect(result.apiSecret).toBe(REDACTED_MARKER);
    expect(result.secretKey).toBe(REDACTED_MARKER);
    expect(result.authToken).toBe(REDACTED_MARKER);
    expect(result.passwordReset).toBe(REDACTED_MARKER);
  });

  it('redacts cookie-related keys', () => {
    const input = {
      sessionCookie: 'abc123',
      cookieData: 'xyz789',
    };

    const result = redactObject(input);

    expect(result.sessionCookie).toBe(REDACTED_MARKER);
    expect(result.cookieData).toBe(REDACTED_MARKER);
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
    expect(result.user.credentials.password).toBe(REDACTED_MARKER);
    expect(result.user.credentials.apiKey).toBe(REDACTED_MARKER);
  });

  it('handles deeply nested structures (4+ levels)', () => {
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

    expect(result.level1.level2.level3.level4.secret).toBe(REDACTED_MARKER);
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

    // Arrays are not recursively processed by redactObject — they pass through
    // as-is. This is a deliberate design choice documented in the source.
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
    expect(result.secret).toBe(REDACTED_MARKER);
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

    expect(result.secret).toBe(REDACTED_MARKER);
    expect(result.token).toBe(REDACTED_MARKER);
  });

  it('handles mixed-case sensitive key patterns', () => {
    const input = {
      Secret: 'value1',
      sEcReT: 'value2',
      SECRET: 'value3',
      AuThOrIzAtIoN: 'value4',
    };

    const result = redactObject(input);

    expect(result.Secret).toBe(REDACTED_MARKER);
    expect(result.sEcReT).toBe(REDACTED_MARKER);
    expect(result.SECRET).toBe(REDACTED_MARKER);
    expect(result['AuThOrIzAtIoN']).toBe(REDACTED_MARKER);
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
    expect(result.secret).toBe(REDACTED_MARKER);
  });

  it('returns a new object (does not mutate input)', () => {
    const input = {
      name: 'test',
      secret: 'secret-value',
    };

    const result = redactObject(input);

    expect(result).not.toBe(input);
    expect(input.secret).toBe('secret-value'); // Original unchanged
    expect(result.secret).toBe(REDACTED_MARKER);
  });

  // ─── Security assertions ───────────────────────────────────────────────

  it('never leaks a real secret value into the redacted output', () => {
    const input = {
      apiKey: 'sk-live-abc123xyz789',
      hmacSignature: 'sha256=fake-signature-hex',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      refreshToken: 'refresh-token-uuid-44556677',
      cookie: 'session_id=abcd1234; Path=/; HttpOnly',
    };

    const result = redactObject(input);

    // Verify none of the real secret values appear anywhere in the output
    const outputStr = JSON.stringify(result);
    expect(outputStr).not.toContain('sk-live-abc123xyz789');
    expect(outputStr).not.toContain('sha256=fake-signature-hex');
    expect(outputStr).not.toContain('Bearer eyJ');
    expect(outputStr).not.toContain('refresh-token-uuid-44556677');
    expect(outputStr).not.toContain('session_id=abcd1234');

    // All sensitive keys should be [REDACTED]
    expect(result.apiKey).toBe(REDACTED_MARKER);
    expect(result.hmacSignature).toBe(REDACTED_MARKER);
    expect(result.authorization).toBe(REDACTED_MARKER);
    expect(result.refreshToken).toBe(REDACTED_MARKER);
    expect(result.cookie).toBe(REDACTED_MARKER);
  });

  it('handles all sensitive key patterns from the regex', () => {
    /**
     * The SENSITIVE_KEY_PATTERN matches (case-insensitive):
     *   secret | signature | token | key | password | authorization | nonce | cookie
     *
     * We assert each pattern individually to confirm the regex covers all
     * documented sensitive key types.
     */
    const patterns: Array<{ key: string; value: string }> = [
      { key: 'mySecret', value: 's1' },
      { key: 'xSignature', value: 's2' },
      { key: 'accessToken', value: 's3' },
      { key: 'someKey', value: 's4' },
      { key: 'userPassword', value: 's5' },
      { key: 'proxyAuthorization', value: 's6' },
      { key: 'requestNonce', value: 's7' },
      { key: 'sessionCookie', value: 's8' },
    ];

    const input: Record<string, string> = {};
    patterns.forEach((p) => (input[p.key] = p.value));

    const result = redactObject(input);

    patterns.forEach((p) => {
      expect(result[p.key]).toBe(REDACTED_MARKER);
    });
  });
});

// ─── redactHeaders ───────────────────────────────────────────────────────────

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

    expect(result['Authorization']).toBe(REDACTED_MARKER);
    expect(result['cookie']).toBe(REDACTED_MARKER);
    expect(result['X-API-KEY']).toBe(REDACTED_MARKER);
    expect(result['Proxy-Authorization']).toBe(REDACTED_MARKER);
    expect(result['x-forwarded-for']).toBe(REDACTED_MARKER);
    expect(result['x-real-ip']).toBe(REDACTED_MARKER);
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
    const longValue = 'a'.repeat(205);
    const result = redactHeaders({
      'x-long-header': longValue,
    });

    expect(result['x-long-header']).toBe('a'.repeat(200) + '...');
  });

  it('does not truncate values exactly at the default max length', () => {
    const result = redactHeaders({
      'x-exact-length': 'a'.repeat(200),
    });

    // Exactly 200 chars should NOT be truncated
    expect(result['x-exact-length']).toBe('a'.repeat(200));
  });

  it('accepts a custom max value length', () => {
    const result = redactHeaders(
      { 'x-header': 'a'.repeat(15) },
      10,
    );

    expect(result['x-header']).toBe('a'.repeat(10) + '...');
  });

  it('returns an empty object when headers is undefined', () => {
    expect(redactHeaders(undefined)).toEqual({});
  });

  it('returns an empty object when headers is null', () => {
    expect(redactHeaders(null as any)).toEqual({});
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

  it('handles the set-cookie header', () => {
    const result = redactHeaders({
      'set-cookie': 'sessionId=abc123; Path=/; HttpOnly',
    });

    expect(result['set-cookie']).toBe(REDACTED_MARKER);
  });

  it('handles the x-api-secret header', () => {
    const result = redactHeaders({
      'x-api-secret': 'my-api-secret-value',
    });

    expect(result['x-api-secret']).toBe(REDACTED_MARKER);
  });

  it('handles the x-auth-token header', () => {
    const result = redactHeaders({
      'x-auth-token': 'auth-token-value',
    });

    expect(result['x-auth-token']).toBe(REDACTED_MARKER);
  });

  it('handles the x-access-token header', () => {
    const result = redactHeaders({
      'x-access-token': 'access-token-value',
    });

    expect(result['x-access-token']).toBe(REDACTED_MARKER);
  });

  // ─── Security assertions ───────────────────────────────────────────────

  it('never leaks real header values in the redacted output', () => {
    const input = {
      Authorization: 'Bearer super-secret-jwt-token-xyz',
      cookie: 'session=real-session-value-12345',
      'x-api-key': 'sk-1234567890abcdef',
    };

    const result = redactHeaders(input);
    const outputStr = JSON.stringify(result);

    expect(outputStr).not.toContain('super-secret-jwt-token-xyz');
    expect(outputStr).not.toContain('real-session-value-12345');
    expect(outputStr).not.toContain('sk-1234567890abcdef');

    expect(result['Authorization']).toBe(REDACTED_MARKER);
    expect(result['cookie']).toBe(REDACTED_MARKER);
    expect(result['x-api-key']).toBe(REDACTED_MARKER);
  });
});

// ─── redactPayload ───────────────────────────────────────────────────────────

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
    expect(result.secret).toBe(REDACTED_MARKER);
  });

  it('recursively processes arrays of objects', () => {
    const input = [
      { name: 'item1', secret: 'secret1' },
      { name: 'item2', token: 'token2' },
      { name: 'item3', password: 'password3' },
    ];

    const result = redactPayload(input);

    expect(result[0].name).toBe('item1');
    expect(result[0].secret).toBe(REDACTED_MARKER);
    expect(result[1].name).toBe('item2');
    expect(result[1].token).toBe(REDACTED_MARKER);
    expect(result[2].name).toBe('item3');
    expect(result[2].password).toBe(REDACTED_MARKER);
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
    expect(result[0][0].secret).toBe(REDACTED_MARKER);
    expect(result[1][0].token).toBe(REDACTED_MARKER);
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
    expect(result.users[0].credentials.password).toBe('pass1'); // Not redacted (inside array)
    expect(result.users[1].name).toBe('user2');
    expect(result.users[1].credentials.apiKey).toBe('key2'); // Not redacted (inside array)
    expect(result.config.secret).toBe(REDACTED_MARKER);
    expect(result.config.settings.normal).toBe('value');
  });

  it('handles arrays containing null and undefined', () => {
    const input = [null, undefined, { secret: 'secret' }];
    const result = redactPayload(input);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeUndefined();
    expect(result[2].secret).toBe(REDACTED_MARKER);
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

    // Arrays are preserved as-is by redactObject, so nested objects in arrays
    // are not redacted. Only top-level object keys are processed.
    expect(result.data.items[0].id).toBe(1);
    expect(result.data.items[0].value).toBe('a');
    expect(result.data.items[0].secret).toBe('s1'); // Not redacted (inside array)
    expect(result.data.items[1].id).toBe(2);
    expect(result.data.items[1].value).toBe('b');
    expect(result.data.items[1].token).toBe('t2'); // Not redacted (inside array)
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

  // ─── Security assertions ───────────────────────────────────────────────

  it('never leaks real webhook payload secrets in the output', () => {
    const input = {
      event: 'contract.created',
      data: {
        contractAddress: 'GABC...XYZ',
        signingKey: 'sk-live-webhook-secret-key',
        hmacSignature: 'sha256=abcdef1234567890',
      },
      timestamp: '2026-07-24T12:00:00Z',
    };

    const result = redactPayload(input) as any;

    const outputStr = JSON.stringify(result);
    expect(outputStr).not.toContain('sk-live-webhook-secret-key');
    expect(outputStr).not.toContain('abcdef1234567890');

    // Top-level object keys in the data nesting are redacted
    expect(result.data.signingKey).toBe(REDACTED_MARKER);
    expect(result.data.hmacSignature).toBe(REDACTED_MARKER);
  });
});
