import { redactHeaders, redactUrl, normalizeUrlPath } from './redact';

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
    // Non-sensitive param preserved
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
});
