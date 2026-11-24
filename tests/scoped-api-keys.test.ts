import request from 'supertest';
import * as crypto from 'crypto';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { parseApiKeysConfig, parseExpiresAt, sha256Hex, type ParsedApiKeys } from '../src/auth/apiKeysConfig';
import { extractApiKeyFromHeaders, matchApiKey } from '../src/auth/scopedApiKeyMiddleware';
import { expiresAtFromDays, parseNewApiKeyArgs } from '../scripts/new-api-key';
import { SCOPES, isValidScope } from '../src/auth/scopes';

function sha256(plaintext: string): string {
  return `sha256:${crypto.createHash('sha256').update(plaintext).digest('hex')}`;
}

const SECRET = 'tt__testsecret';

function makeApiKeys(opts: { id?: string; scopes?: string[]; hash?: string } = {}): ParsedApiKeys {
  return parseApiKeysConfig(
    JSON.stringify([{ id: opts.id ?? 'test-key-1', hash: opts.hash ?? sha256(SECRET), scopes: opts.scopes ?? ['disputes:resolve'] }]),
  );
}

/** App with one disputed, funded contract (id 1). */
function disputedApp(apiKeys: ParsedApiKeys) {
  const store = new EscrowStore();
  const c = store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 200 }] });
  store.deposit(c.id, 200);
  store.openDispute(c.id, 'GA', 'late');
  return { store, id: c.id, app: createApp({ store, apiKeys }) };
}

describe('parseApiKeysConfig', () => {
  it('returns empty store for undefined/empty input', () => {
    expect(parseApiKeysConfig(undefined).keys).toHaveLength(0);
    expect(parseApiKeysConfig('').keys).toHaveLength(0);
    expect(parseApiKeysConfig('  ').keys).toHaveLength(0);
  });

  it('parses a valid single key', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'sha256:' + 'a'.repeat(64), scopes: ['disputes:resolve'] },
    ]);
    const result = parseApiKeysConfig(raw);
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].id).toBe('ops-1');
    expect(result.keys[0].scopes).toEqual(['disputes:resolve']);
    expect(result.byDigest.size).toBe(1);
  });

  it('parses multiple keys', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'sha256:' + 'a'.repeat(64), scopes: ['disputes:resolve'] },
      { id: 'ops-2', hash: 'sha256:' + 'b'.repeat(64), scopes: ['admin:read'] },
    ]);
    const result = parseApiKeysConfig(raw);
    expect(result.keys).toHaveLength(2);
    expect(result.byDigest.size).toBe(2);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseApiKeysConfig('{bad')).toThrow(/invalid JSON/i);
  });

  it('throws when not an array', () => {
    expect(() => parseApiKeysConfig('{}')).toThrow(/expected a JSON array/i);
  });

  it('throws on unknown scope', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'sha256:' + 'a'.repeat(64), scopes: ['unknown:scope'] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/unknown scope/i);
  });

  it('throws on duplicate id', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'sha256:' + 'a'.repeat(64), scopes: ['disputes:resolve'] },
      { id: 'ops-1', hash: 'sha256:' + 'b'.repeat(64), scopes: ['admin:read'] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/duplicate key id/i);
  });

  it('throws on missing id', () => {
    const raw = JSON.stringify([
      { hash: 'sha256:' + 'a'.repeat(64), scopes: ['disputes:resolve'] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/missing a non-empty "id"/i);
  });

  it('throws on missing hash', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', scopes: ['disputes:resolve'] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/missing a non-empty "hash"/i);
  });

  it('throws on invalid hash format', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'plain-text', scopes: ['disputes:resolve'] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/invalid hash format/i);
  });

  it('throws on empty scopes array', () => {
    const raw = JSON.stringify([
      { id: 'ops-1', hash: 'sha256:' + 'a'.repeat(64), scopes: [] },
    ]);
    expect(() => parseApiKeysConfig(raw)).toThrow(/non-empty "scopes"/i);
  });

  it('throws on non-object entry', () => {
    expect(() => parseApiKeysConfig(JSON.stringify(['string'])))
      .toThrow(/must be a JSON object/i);
  });
});

// ── Scopes tests ──────────────────────────────────────────────────────────

describe('scopes', () => {
  it('defines all expected scopes', () => {
    expect(SCOPES.DISPUTES_RESOLVE).toBe('disputes:resolve');
    expect(SCOPES.ADMIN_READ).toBe('admin:read');
    expect(SCOPES.CONTRACTS_WRITE).toBe('contracts:write');
  });

  it('isValidScope returns true for valid scopes', () => {
    expect(isValidScope('disputes:resolve')).toBe(true);
    expect(isValidScope('admin:read')).toBe(true);
    expect(isValidScope('contracts:write')).toBe(true);
  });

  it('isValidScope returns false for unknown scopes', () => {
    expect(isValidScope('unknown:scope')).toBe(false);
    expect(isValidScope('')).toBe(false);
  });
});

// ── Header extraction tests ────────────────────────────────────────────────

describe('extractApiKeyFromHeaders', () => {
  it('reads from X-API-Key header', () => {
    expect(extractApiKeyFromHeaders({ 'x-api-key': 'tt__abc123' })).toBe('tt__abc123');
  });

  it('reads from Authorization: ApiKey <key>', () => {
    expect(extractApiKeyFromHeaders({ authorization: 'ApiKey tt__abc123' })).toBe('tt__abc123');
  });

  it('reads from Authorization with lowercase apikey', () => {
    expect(extractApiKeyFromHeaders({ authorization: 'apikey tt__abc123' })).toBe('tt__abc123');
  });

  it('returns null for missing headers', () => {
    expect(extractApiKeyFromHeaders({})).toBeNull();
  });

  it('returns null for Authorization: Bearer (not ApiKey)', () => {
    expect(extractApiKeyFromHeaders({ authorization: 'Bearer token123' })).toBeNull();
  });

  it('returns null for empty X-API-Key', () => {
    expect(extractApiKeyFromHeaders({ 'x-api-key': '' })).toBeNull();
  });
});

// ── Middleware tests ───────────────────────────────────────────────────────

describe('POST /contracts/:id/resolve — scoped API key', () => {
  it('returns 401 when no API key is provided', async () => {
    const { app, id } = disputedApp(makeApiKeys());
    const res = await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 for an unknown key', async () => {
    const { app, id } = disputedApp(makeApiKeys());
    await request(app).post(`/api/v1/contracts/${id}/resolve`).set('X-API-Key', 'tt__wrong').send({ freelancerBps: 5000 }).expect(401);
  });

  it('returns 403 insufficient_scope for a key without disputes:resolve', async () => {
    const { app, id } = disputedApp(makeApiKeys({ scopes: ['admin:read'] }));
    const res = await request(app).post(`/api/v1/contracts/${id}/resolve`).set('X-API-Key', SECRET).send({ freelancerBps: 5000 }).expect(403);
    expect(res.body.error).toBe('insufficient_scope');
    expect(res.body.required).toBe('disputes:resolve');
  });

  it('resolves with a valid key and records the key id as resolver', async () => {
    const { app, id, store } = disputedApp(makeApiKeys());
    const res = await request(app)
      .post(`/api/v1/contracts/${id}/resolve`)
      .set('Authorization', `ApiKey ${SECRET}`)
      .send({ freelancerBps: 5000 })
      .expect(200);
    expect(res.body.status).toBe('Resolved');
    expect(res.body.dispute.resolvedBy).toBe('test-key-1');
    expect(store.get(id).releasedAmount).toBe(100);
  });

  it('returns 409 when the contract is not disputed', async () => {
    const store = new EscrowStore();
    const c = store.create({ client: 'GA', freelancer: 'GB', milestones: [{ amount: 200 }] });
    const app = createApp({ store, apiKeys: makeApiKeys() });
    await request(app).post(`/api/v1/contracts/${c.id}/resolve`).set('X-API-Key', SECRET).send({ freelancerBps: 5000 }).expect(409);
  });

  it('never echoes the plaintext key', async () => {
    const { app, id } = disputedApp(makeApiKeys());
    const bad = await request(app).post(`/api/v1/contracts/${id}/resolve`).set('X-API-Key', 'tt__leaky-secret').send({ freelancerBps: 1 });
    expect(JSON.stringify(bad.body)).not.toContain('tt__leaky-secret');
    const ok = await request(app).post(`/api/v1/contracts/${id}/resolve`).set('X-API-Key', SECRET).send({ freelancerBps: 1 });
    expect(JSON.stringify(ok.body)).not.toContain(SECRET);
  });

  it('fails closed in production when no API keys are configured', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { app, id } = disputedApp(parseApiKeysConfig(undefined));
      await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(401);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('GET /api/v1/auth/whoami', () => {
  it('returns the key id and scopes', async () => {
    const app = createApp({ store: new EscrowStore(), apiKeys: makeApiKeys({ scopes: ['disputes:resolve', 'admin:read'] }) });
    const res = await request(app).get('/api/v1/auth/whoami').set('X-API-Key', SECRET).expect(200);
    expect(res.body).toEqual({ keyId: 'test-key-1', scopes: ['disputes:resolve', 'admin:read'], expiresAt: null });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('returns 401 without or with an invalid key', async () => {
    const app = createApp({ store: new EscrowStore(), apiKeys: makeApiKeys() });
    await request(app).get('/api/v1/auth/whoami').expect(401);
    await request(app).get('/api/v1/auth/whoami').set('X-API-Key', 'nope').expect(401);
  });
});

describe('sha256Hex', () => {
  it('produces a 64-char hex digest', () => {
    const digest = sha256Hex('test');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic', () => {
    expect(sha256Hex('test')).toBe(sha256Hex('test'));
  });

  it('differs for different inputs', () => {
    expect(sha256Hex('test')).not.toBe(sha256Hex('test2'));
  });
});

// ── Key expiry (#1695) ────────────────────────────────────────────────────
describe('API key expiry', () => {
  const NOW = Date.parse('2027-01-15T12:00:00.000Z');
  const clock = () => NOW;
  const keysWith = (expiresAt: unknown, id = 'contractor-1') =>
    JSON.stringify([{ id, hash: sha256(SECRET), scopes: ['disputes:resolve', 'admin:read'], expiresAt }]);

  describe('parseApiKeysConfig expiresAt', () => {
    it('accepts an ISO date-time and normalises it to UTC', () => {
      const parsed = parseApiKeysConfig(keysWith('2027-02-01T10:00:00+01:00'));
      expect(parsed.keys[0].expiresAt).toBe('2027-02-01T09:00:00.000Z');
    });

    it('accepts a bare ISO date as UTC midnight', () => {
      expect(parseApiKeysConfig(keysWith('2027-02-01')).keys[0].expiresAt).toBe('2027-02-01T00:00:00.000Z');
    });

    it('treats a missing or null expiresAt as never expiring', () => {
      expect(parseApiKeysConfig(keysWith(undefined)).keys[0].expiresAt).toBeUndefined();
      expect(parseApiKeysConfig(keysWith(null)).keys[0].expiresAt).toBeUndefined();
    });

    it.each([
      ['not-a-date'],
      ['2027-02-30'],
      ['2027-13-01T00:00:00Z'],
      ['2027-02-01T10:00:00'], // no timezone: ambiguous across servers
      ['2027-02-01T25:00:00Z'],
      ['01/02/2027'],
      [''],
      [1798761600000],
      [true],
    ])('fails startup on invalid expiresAt %p, naming the key id', (bad) => {
      expect(() => parseApiKeysConfig(keysWith(bad, 'contractor-7'))).toThrow(
        /API_KEYS: entry "contractor-7" has an invalid "expiresAt"/,
      );
    });

    it('parseExpiresAt returns the instant for valid values and null otherwise', () => {
      expect(parseExpiresAt('2027-01-15T12:00:00Z')).toBe(NOW);
      expect(parseExpiresAt('2027-01-15T12:00:00.000Z')).toBe(NOW);
      expect(parseExpiresAt('2024-02-29')).toBe(Date.parse('2024-02-29T00:00:00Z'));
      expect(parseExpiresAt('2027-02-29')).toBeNull();
      expect(parseExpiresAt(undefined)).toBeNull();
    });
  });

  describe('matchApiKey with an injected clock', () => {
    it('returns valid before expiresAt and carries the expiry', () => {
      const keys = parseApiKeysConfig(keysWith('2027-01-15T12:00:00.001Z'));
      expect(matchApiKey(keys, SECRET, clock)).toEqual({
        status: 'valid',
        key: { id: 'contractor-1', scopes: ['disputes:resolve', 'admin:read'], expiresAt: '2027-01-15T12:00:00.001Z' },
      });
    });

    it('treats a key as expired from expiresAt on (boundary inclusive)', () => {
      const keys = parseApiKeysConfig(keysWith('2027-01-15T12:00:00.000Z'));
      expect(matchApiKey(keys, SECRET, clock)).toEqual({
        status: 'expired',
        id: 'contractor-1',
        expiresAt: '2027-01-15T12:00:00.000Z',
      });
    });

    it('returns null for an unknown key regardless of expiry', () => {
      const keys = parseApiKeysConfig(keysWith('2020-01-01'));
      expect(matchApiKey(keys, 'tt__other', clock)).toBeNull();
    });

    it('leaves non-expiring keys unchanged', () => {
      const keys = makeApiKeys({ scopes: ['admin:read'] });
      expect(matchApiKey(keys, SECRET, () => Number.MAX_SAFE_INTEGER)).toEqual({
        status: 'valid',
        key: { id: 'test-key-1', scopes: ['admin:read'] },
      });
    });
  });

  describe('HTTP', () => {
    const appWith = (expiresAt: unknown) =>
      createApp({ store: new EscrowStore(), apiKeys: parseApiKeysConfig(keysWith(expiresAt)), apiKeyClock: clock });

    it('rejects an expired key on whoami with 401 "API key expired"', async () => {
      const res = await request(appWith('2027-01-15T11:59:59Z')).get('/api/v1/auth/whoami').set('X-API-Key', SECRET).expect(401);
      expect(JSON.stringify(res.body)).toContain('API key expired');
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it('rejects an expired key on dispute resolution with 401 and leaves the dispute open', async () => {
      const { store, id } = disputedApp(makeApiKeys());
      const app = createApp({ store, apiKeys: parseApiKeysConfig(keysWith('2027-01-01')), apiKeyClock: clock });
      const res = await request(app)
        .post(`/api/v1/contracts/${id}/resolve`)
        .set('Authorization', `ApiKey ${SECRET}`)
        .send({ freelancerBps: 5000 })
        .expect(401);
      expect(JSON.stringify(res.body)).toContain('API key expired');
      expect(store.get(id).status).toBe('Disputed');
      expect(store.get(id).dispute?.resolvedBy).toBeUndefined();
    });

    it('whoami reports expiresAt for a key that has not expired yet', async () => {
      const res = await request(appWith('2027-02-01T00:00:00Z')).get('/api/v1/auth/whoami').set('X-API-Key', SECRET).expect(200);
      expect(res.body).toEqual({
        keyId: 'contractor-1',
        scopes: ['disputes:resolve', 'admin:read'],
        expiresAt: '2027-02-01T00:00:00.000Z',
      });
    });

    it('an unknown key is still "Invalid API key", not "expired"', async () => {
      const res = await request(appWith('2020-01-01')).get('/api/v1/auth/whoami').set('X-API-Key', 'tt__nope').expect(401);
      expect(JSON.stringify(res.body)).toContain('Invalid API key');
    });
  });

  describe('scripts/new-api-key --expires-in-days', () => {
    it('parses the flag in both forms and keeps id and scopes', () => {
      expect(parseNewApiKeyArgs(['--expires-in-days', '30', 'ops-1', 'admin:read'])).toEqual({
        id: 'ops-1',
        scopes: ['admin:read'],
        expiresInDays: 30,
      });
      expect(parseNewApiKeyArgs(['ops-1', 'admin:read', '--expires-in-days=7'])).toEqual({
        id: 'ops-1',
        scopes: ['admin:read'],
        expiresInDays: 7,
      });
    });

    it('omits expiry when the flag is absent', () => {
      expect(parseNewApiKeyArgs(['ops-1', 'disputes:resolve']).expiresInDays).toBeUndefined();
    });

    it.each([['0'], ['-3'], ['1.5'], ['abc'], [undefined]])('rejects --expires-in-days %p', (v) => {
      const argv = v === undefined ? ['ops-1', 'admin:read', '--expires-in-days'] : ['--expires-in-days', v, 'ops-1', 'admin:read'];
      expect(() => parseNewApiKeyArgs(argv)).toThrow(/positive whole number/);
    });

    it('requires an id and at least one scope', () => {
      expect(() => parseNewApiKeyArgs(['--expires-in-days', '3', 'ops-1'])).toThrow(/Usage/);
    });

    it('computes expiresAt n days ahead, and it round-trips through parseApiKeysConfig', () => {
      const expiresAt = expiresAtFromDays(30, NOW);
      expect(expiresAt).toBe('2027-02-14T12:00:00.000Z');
      expect(parseApiKeysConfig(keysWith(expiresAt)).keys[0].expiresAt).toBe(expiresAt);
    });
  });
});

describe('admin:read scope on the dispute queue', () => {
  afterEach(() => { delete process.env.ADMIN_READ_TOKEN; });

  it('lets an admin:read key list disputes and read a dispute', async () => {
    const { app, id } = disputedApp(makeApiKeys({ scopes: [SCOPES.ADMIN_READ] }));
    const list = await request(app).get('/api/v1/disputes').set('X-API-Key', SECRET).expect(200);
    expect(list.body.data).toHaveLength(1);
    const detail = await request(app).get(`/api/v1/disputes/${id}`).set('Authorization', `ApiKey ${SECRET}`).expect(200);
    expect(detail.body.contractId).toBe(id);
  });

  it('returns 403 insufficient_scope for a key without admin:read', async () => {
    const { app } = disputedApp(makeApiKeys({ scopes: [SCOPES.DISPUTES_RESOLVE] }));
    const res = await request(app).get('/api/v1/disputes').set('X-API-Key', SECRET).expect(403);
    expect(res.body).toMatchObject({ error: 'insufficient_scope', required: 'admin:read' });
  });

  it('rejects an expired admin:read key with 401', async () => {
    const apiKeys = parseApiKeysConfig(
      JSON.stringify([{ id: 'old', hash: sha256(SECRET), scopes: [SCOPES.ADMIN_READ], expiresAt: '2020-01-01T00:00:00Z' }]),
    );
    const { app } = disputedApp(apiKeys);
    const res = await request(app).get('/api/v1/disputes').set('X-API-Key', SECRET).expect(401);
    expect(res.body.message).toBe('API key expired');
  });

  it('does not let an admin:read key resolve disputes', async () => {
    const { app, id } = disputedApp(makeApiKeys({ scopes: [SCOPES.ADMIN_READ] }));
    const res = await request(app).post(`/api/v1/contracts/${id}/resolve`).set('X-API-Key', SECRET).send({ freelancerShare: 100 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('insufficient_scope');
  });
});
