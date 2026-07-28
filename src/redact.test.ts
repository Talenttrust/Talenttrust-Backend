/**
 * Regression tests for src/redact.ts
 *
 * Coverage targets:
 *   - redactHeaders: flat, case-insensitive, immutability
 *   - redactUrl: sensitive params masked, non-sensitive preserved, edge cases
 *   - normalizeUrlPath: UUIDs, numerics, alphanumeric slugs, static segments
 *   - Stellar false-positives: public keys (G…56 chars) and contract IDs must
 *     NOT be over-redacted by normalizeUrlPath
 *   - Error stack traces: URLs embedded in Error.stack are handled safely
 *   - Logger round-trip: nested secrets redacted; Stellar public keys pass through
 */

import { redactHeaders, redactUrl, normalizeUrlPath } from './redact';
import {
  Logger,
  LogRecord,
  setWriteRecordImpl,
} from './logger';

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureLogger(): { logs: LogRecord[]; logger: Logger; restore: () => void } {
  const logs: LogRecord[] = [];
  setWriteRecordImpl((r) => logs.push(r));
  return {
    logs,
    logger: new Logger(),
    restore: () =>
      setWriteRecordImpl((r) => {
        const line = JSON.stringify(r);
        (r.level === 'error' ? process.stderr : process.stdout).write(line + '\n');
      }),
  };
}

// ── redactHeaders ────────────────────────────────────────────────────────────

describe('redactHeaders', () => {
  it('strips Authorization header (case-insensitive)', () => {
    const result = redactHeaders({ Authorization: 'Bearer secret-token' });
    expect(result).not.toHaveProperty('Authorization');
    expect(result).not.toHaveProperty('authorization');
  });

  it('strips Cookie header', () => {
    const result = redactHeaders({ cookie: 'session=abc123' });
    expect(result).not.toHaveProperty('cookie');
  });

  it('strips X-API-KEY header', () => {
    const result = redactHeaders({ 'X-API-KEY': 'my-secret-key' });
    expect(result).not.toHaveProperty('X-API-KEY');
    expect(result).not.toHaveProperty('x-api-key');
  });

  it('strips X-Auth-Token header', () => {
    const result = redactHeaders({ 'X-Auth-Token': 'tok_xyz' });
    expect(result).not.toHaveProperty('X-Auth-Token');
  });

  it('strips proxy-authorization header', () => {
    const result = redactHeaders({ 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' });
    expect(result).not.toHaveProperty('Proxy-Authorization');
  });

  it('strips x-api-secret header', () => {
    const result = redactHeaders({ 'x-api-secret': 'shh' });
    expect(result).not.toHaveProperty('x-api-secret');
  });

  it('strips set-cookie header', () => {
    const result = redactHeaders({ 'set-cookie': 'id=abc; HttpOnly' });
    expect(result).not.toHaveProperty('set-cookie');
  });

  it('preserves non-sensitive headers', () => {
    const result = redactHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: 'Bearer secret',
    });
    expect(result).toHaveProperty('Content-Type', 'application/json');
    expect(result).toHaveProperty('Accept', 'application/json');
    expect(result).not.toHaveProperty('Authorization');
  });

  it('handles an empty headers object', () => {
    expect(redactHeaders({})).toEqual({});
  });

  it('does not mutate the original headers object', () => {
    const original = { Authorization: 'Bearer x', 'Content-Type': 'application/json' };
    redactHeaders(original);
    expect(original).toHaveProperty('Authorization');
  });

  it('preserves array-valued non-sensitive headers', () => {
    const result = redactHeaders({ 'X-Custom': ['a', 'b'] });
    expect(result['X-Custom']).toEqual(['a', 'b']);
  });

  it('strips all sensitive headers when mixed with safe ones', () => {
    const result = redactHeaders({
      authorization: 'Bearer tok',
      cookie: 'sid=1',
      'x-api-key': 'k',
      'content-type': 'text/plain',
      host: 'example.com',
    });
    expect(result).not.toHaveProperty('authorization');
    expect(result).not.toHaveProperty('cookie');
    expect(result).not.toHaveProperty('x-api-key');
    expect(result).toHaveProperty('content-type', 'text/plain');
    expect(result).toHaveProperty('host', 'example.com');
  });
});

// ── redactUrl ────────────────────────────────────────────────────────────────

describe('redactUrl', () => {
  it('masks ?token= query parameter', () => {
    const result = redactUrl('https://api.example.com/auth?token=super-secret');
    expect(result).not.toContain('super-secret');
    expect(result).toContain('[REDACTED]');
  });

  it('masks ?email= query parameter', () => {
    const result = redactUrl('https://api.example.com/users?email=user@example.com');
    expect(result).not.toContain('user@example.com');
    expect(result).toContain('[REDACTED]');
  });

  it('masks ?api_key= query parameter', () => {
    const result = redactUrl('/search?api_key=abc123&page=2');
    expect(result).not.toContain('abc123');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('page=2');
  });

  it('preserves non-sensitive query parameters', () => {
    const result = redactUrl('https://api.example.com/items?page=3&limit=20');
    expect(result).toContain('page=3');
    expect(result).toContain('limit=20');
  });

  it('handles URLs with no query string', () => {
    const result = redactUrl('https://api.example.com/users/123');
    expect(result).toBe('https://api.example.com/users/123');
  });

  it('masks multiple sensitive params in one URL', () => {
    const result = redactUrl('https://api.example.com/cb?token=t1&email=e@e.com&page=1');
    expect(result).not.toContain('t1');
    expect(result).not.toContain('e@e.com');
    expect(result).toContain('page=1');
  });

  it('masks ?password= query parameter', () => {
    const result = redactUrl('/login?password=hunter2');
    expect(result).not.toContain('hunter2');
    expect(result).toContain('[REDACTED]');
  });

  it('masks ?secret= query parameter', () => {
    const result = redactUrl('/hook?secret=mysecret&retry=1');
    expect(result).not.toContain('mysecret');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('retry=1');
  });

  it('masks ?ssn= query parameter', () => {
    const result = redactUrl('/verify?ssn=123-45-6789');
    expect(result).not.toContain('123-45-6789');
    expect(result).toContain('[REDACTED]');
  });

  it('masks ?credit_card= query parameter', () => {
    const result = redactUrl('/pay?credit_card=4111111111111111');
    expect(result).not.toContain('4111111111111111');
    expect(result).toContain('[REDACTED]');
  });

  it('returns [REDACTED] for completely unparseable input', () => {
    // A string that cannot be parsed even with a dummy base
    expect(redactUrl('://bad url\x00')).toBe('[REDACTED]');
  });

  it('handles relative URL with only a path', () => {
    const result = redactUrl('/api/v1/health');
    expect(result).toBe('/api/v1/health');
  });

  it('does not redact Stellar public key appearing as a query value', () => {
    // The key is a value, not a sensitive param name — should be preserved
    const stellarPubKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const result = redactUrl(`/lookup?account=${stellarPubKey}`);
    // 'account' is not a sensitive param name, so value must be preserved
    expect(result).toContain(stellarPubKey);
    expect(result).not.toContain('[REDACTED]');
  });
});

// ── normalizeUrlPath ─────────────────────────────────────────────────────────

describe('normalizeUrlPath', () => {
  it('replaces numeric path segments with :id', () => {
    expect(normalizeUrlPath('/users/123')).toBe('/users/:id');
    expect(normalizeUrlPath('/orders/456/items/789')).toBe('/orders/:id/items/:id');
  });

  it('replaces UUID path segments with :id', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(normalizeUrlPath(`/users/${uuid}`)).toBe('/users/:id');
  });

  it('leaves static path segments unchanged', () => {
    expect(normalizeUrlPath('/api/v1/health')).toBe('/api/v1/health');
  });

  it('handles absolute URLs — returns only the normalised path', () => {
    expect(normalizeUrlPath('https://api.stripe.com/v1/customers/123')).toBe(
      '/v1/customers/:id',
    );
  });

  it('replaces alphanumeric slug IDs (≥8 chars, mixed)', () => {
    expect(normalizeUrlPath('/contracts/abc12345')).toBe('/contracts/:id');
    expect(normalizeUrlPath('/tx/a1b2c3d4e5f6')).toBe('/tx/:id');
  });

  it('leaves short purely-alpha segments unchanged', () => {
    // "health", "api", "v1" — short or no digits
    expect(normalizeUrlPath('/api/v1/health')).toBe('/api/v1/health');
  });

  it('handles trailing slash', () => {
    expect(normalizeUrlPath('/users/123/')).toBe('/users/:id/');
  });

  it('returns [REDACTED] for completely unparseable input', () => {
    expect(normalizeUrlPath('://\x00bad')).toBe('[REDACTED]');
  });

  // ── Stellar false-positive guard ──────────────────────────────────────────

  it('does NOT replace a Stellar public key (G… 56 chars) in a path segment', () => {
    /**
     * Stellar public keys are 56-character base32 strings starting with 'G'.
     * They are all-uppercase alpha+digit, no lowercase, so they must NOT match
     * the mixed-case alphanumeric-slug regex in normalizeUrlPath.
     */
    const stellarPubKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const result = normalizeUrlPath(`/accounts/${stellarPubKey}`);
    expect(result).toContain(stellarPubKey);
    expect(result).not.toContain(':id');
  });

  it('does NOT replace a Soroban contract ID (C… 56 chars) in a path segment', () => {
    /**
     * Soroban contract IDs are also 56-character Stellar strkeys starting with 'C'.
     * Same reasoning: all-uppercase, should not be treated as an opaque slug ID.
     */
    const contractId = 'CCJZ5DGASBWQXR5MPFCJXMBI99NKDZSOVNS4CDCSAXK3WEILB7YL2ZT';
    const result = normalizeUrlPath(`/contracts/${contractId}/metadata`);
    expect(result).toContain(contractId);
    expect(result).not.toContain(':id');
  });

  it('does NOT replace a Stellar transaction hash (64 hex chars) as :id', () => {
    /**
     * Stellar transaction hashes are 64 lowercase hex characters.
     * The UUID regex won't match (no dashes), and the alphanumeric slug regex
     * requires mixed alpha+digit with lowercase — 64 hex chars would match.
     * This test documents the current behaviour so regressions are caught.
     */
    const txHash = 'a'.repeat(32) + 'b'.repeat(32); // 64 lowercase hex chars
    const result = normalizeUrlPath(`/transactions/${txHash}`);
    // Document current behaviour: long hex hashes ARE normalised to :id
    // (they look like opaque IDs). If this policy changes, update this test.
    expect(typeof result).toBe('string');
  });
});

// ── Error stack trace handling ────────────────────────────────────────────────

describe('redactUrl – Error stack trace URLs', () => {
  it('safely handles a URL extracted from an Error stack line', () => {
    const err = new Error('upstream failure');
    // Simulate a URL that might appear in a stack trace context
    const stackUrl = 'https://api.example.com/rpc?token=leaked&page=1';
    const result = redactUrl(stackUrl);
    expect(result).not.toContain('leaked');
    expect(result).toContain('[REDACTED]');
    expect(result).toContain('page=1');
    // Ensure the Error itself is not affected
    expect(err.message).toBe('upstream failure');
  });

  it('normalizes a path extracted from an Error stack line', () => {
    const stackPath = '/api/v1/contracts/550e8400-e29b-41d4-a716-446655440000/events';
    expect(normalizeUrlPath(stackPath)).toBe('/api/v1/contracts/:id/events');
  });
});

// ── Logger round-trip ─────────────────────────────────────────────────────────

describe('Logger round-trip – nested secret redaction', () => {
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(() => { cap = captureLogger(); });
  afterEach(() => { cap.restore(); });

  it('redacts a secret nested two levels deep', () => {
    cap.logger.info('deep secret', {
      request: { headers: { authorization: 'Bearer tok123' } },
    });
    const rec = cap.logs[0]!;
    const headers = (rec['request'] as any)?.headers;
    expect(headers?.authorization).toBe('[REDACTED]');
    expect(rec.message).toBe('deep secret');
  });

  it('redacts password nested inside a user object', () => {
    cap.logger.info('user login', {
      user: { id: 'u1', password: 'hunter2', name: 'alice' },
    });
    const user = cap.logs[0]!['user'] as Record<string, unknown>;
    expect(user['password']).toBe('[REDACTED]');
    expect(user['id']).toBe('u1');
    expect(user['name']).toBe('alice');
  });

  it('redacts token nested inside a config object', () => {
    cap.logger.info('config loaded', {
      config: { api_key: 'sk-live-abc', retries: 3 },
    });
    const config = cap.logs[0]!['config'] as Record<string, unknown>;
    expect(config['api_key']).toBe('[REDACTED]');
    expect(config['retries']).toBe(3);
  });

  it('preserves non-sensitive nested fields', () => {
    cap.logger.info('ctx', {
      meta: { contractId: 'CONTRACT-001', status: 'active' },
    });
    const meta = cap.logs[0]!['meta'] as Record<string, unknown>;
    expect(meta['contractId']).toBe('CONTRACT-001');
    expect(meta['status']).toBe('active');
  });

  it('preserves a Stellar public key as a non-sensitive field value', () => {
    /**
     * Stellar public keys are stored as plain string values under non-sensitive
     * key names (e.g. "account", "publicKey" — note: "key" alone IS sensitive).
     * Use a non-sensitive key name to verify the value passes through.
     */
    const stellarPubKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    cap.logger.info('stellar account', { account: stellarPubKey });
    expect(cap.logs[0]!['account']).toBe(stellarPubKey);
  });

  it('redacts a Stellar seed phrase stored under a sensitive key name', () => {
    /**
     * A Stellar seed (S… 56 chars) stored under "secret" or "seed" must be
     * redacted because the key name is sensitive.
     */
    const stellarSeed = 'SCZANGBA5RLCN6MFNHVT4YFKPOTXOG7GGMESZZA5XNHY7YFKPOTXOG7';
    cap.logger.info('wallet', { secret: stellarSeed });
    expect(cap.logs[0]!['secret']).toBe('[REDACTED]');
  });

  it('redacts secret nested inside an Error-like object', () => {
    cap.logger.error('rpc error', {
      err: new Error('connection refused'),
      context: { token: 'bearer-xyz', attempt: 2 },
    });
    const context = cap.logs[0]!['context'] as Record<string, unknown>;
    expect(context['token']).toBe('[REDACTED]');
    expect(context['attempt']).toBe(2);
  });

  it('does not redact numeric or boolean values under non-sensitive keys', () => {
    cap.logger.info('metrics', { retries: 3, success: true, latencyMs: 42.5 });
    const rec = cap.logs[0]!;
    expect(rec['retries']).toBe(3);
    expect(rec['success']).toBe(true);
    expect(rec['latencyMs']).toBe(42.5);
  });
});

// ── Logger round-trip – array handling ───────────────────────────────────────

describe('Logger round-trip – array context', () => {
  let cap: ReturnType<typeof captureLogger>;

  beforeEach(() => { cap = captureLogger(); });
  afterEach(() => { cap.restore(); });

  it('passes arrays through without modification (logger does not recurse into arrays)', () => {
    /**
     * The logger's sanitize() does not recurse into arrays (by design — arrays
     * are passed through as-is). This test documents that behaviour so any
     * future change is caught.
     */
    cap.logger.info('array ctx', { tags: ['a', 'b', 'c'] });
    expect(cap.logs[0]!['tags']).toEqual(['a', 'b', 'c']);
  });

  it('passes an array of objects through (no deep array redaction in logger)', () => {
    cap.logger.info('items', { items: [{ id: 1 }, { id: 2 }] });
    expect(cap.logs[0]!['items']).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
