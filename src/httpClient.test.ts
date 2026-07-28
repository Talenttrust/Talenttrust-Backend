import MockAdapter from 'axios-mock-adapter';
import { logger } from './logger';
import { createHttpClient } from './httpClient';

// We spy on the pino logger methods so we can assert on structured log entries
// without any real I/O.
let infoSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let debugSpy: jest.SpyInstance;

beforeEach(() => {
  infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => logger);
  errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  debugSpy = jest.spyOn(logger, 'debug').mockImplementation(() => logger);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** Returns the first object argument passed to logger.info */
function lastInfoEntry(): Record<string, unknown> {
  const call = infoSpy.mock.calls[infoSpy.mock.calls.length - 1];
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

/** Returns the first object argument passed to logger.error */
function lastErrorEntry(): Record<string, unknown> {
  const call = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

/** Returns the first object argument passed to logger.debug */
function lastDebugEntry(): Record<string, unknown> {
  const call = debugSpy.mock.calls[debugSpy.mock.calls.length - 1];
  return (call?.[0] ?? {}) as Record<string, unknown>;
}

// ── Successful request ────────────────────────────────────────────────────────

describe('createHttpClient — successful response', () => {
  it('logs dependency_name, http_status, timing_ms, request_method, request_url', async () => {
    const client = createHttpClient('Stripe-API');
    const mock = new MockAdapter(client);
    mock.onGet('https://api.stripe.com/v1/customers/123').reply(200, {});

    await client.get('https://api.stripe.com/v1/customers/123');

    const entry = lastInfoEntry();
    expect(entry.dependency_name).toBe('Stripe-API');
    expect(entry.http_status).toBe(200);
    expect(entry.request_method).toBe('GET');
    expect(typeof entry.timing_ms).toBe('number');
    expect((entry.timing_ms as number)).toBeGreaterThanOrEqual(0);
    expect(typeof entry.request_url).toBe('string');
  });

  it('normalises the URL path to a cardinality-safe pattern', async () => {
    const client = createHttpClient('Auth0');
    const mock = new MockAdapter(client);
    mock.onGet('https://auth0.example.com/api/v2/users/42').reply(200, {});

    await client.get('https://auth0.example.com/api/v2/users/42');

    const entry = lastInfoEntry();
    expect(entry.url_pattern).toBe('/api/v2/users/:id');
  });

  it('does NOT include raw numeric IDs in url_pattern', async () => {
    const client = createHttpClient('Auth0');
    const mock = new MockAdapter(client);
    mock.onGet('https://auth0.example.com/api/v2/users/99999').reply(200, {});

    await client.get('https://auth0.example.com/api/v2/users/99999');

    const entry = lastInfoEntry();
    expect(String(entry.url_pattern)).not.toMatch(/\d{3,}/);
  });
});

// ── Sensitive header redaction ────────────────────────────────────────────────

describe('createHttpClient — header redaction', () => {
  it('does NOT log the Authorization header value', async () => {
    const client = createHttpClient('Stripe-API');
    const mock = new MockAdapter(client);
    mock.onGet('https://api.stripe.com/v1/charges').reply(200, {});

    await client.get('https://api.stripe.com/v1/charges', {
      headers: { Authorization: 'Bearer sk_live_supersecret' },
    });

    // Check both debug (request) and info (response) log entries
    const debugEntry = JSON.stringify(lastDebugEntry());
    const infoEntry = JSON.stringify(lastInfoEntry());

    expect(debugEntry).not.toContain('sk_live_supersecret');
    expect(infoEntry).not.toContain('sk_live_supersecret');
    expect(debugEntry).not.toContain('Bearer');
  });

  it('does NOT log the X-API-KEY header value', async () => {
    const client = createHttpClient('SendGrid');
    const mock = new MockAdapter(client);
    mock.onPost('https://api.sendgrid.com/v3/mail/send').reply(202, {});

    await client.post(
      'https://api.sendgrid.com/v3/mail/send',
      {},
      { headers: { 'X-API-KEY': 'SG.my-private-key' } },
    );

    const debugEntry = JSON.stringify(lastDebugEntry());
    expect(debugEntry).not.toContain('SG.my-private-key');
  });

  it('does NOT log the Cookie header value', async () => {
    const client = createHttpClient('InternalService');
    const mock = new MockAdapter(client);
    mock.onGet('https://internal.example.com/profile').reply(200, {});

    await client.get('https://internal.example.com/profile', {
      headers: { cookie: 'session=abc123xyz' },
    });

    const debugEntry = JSON.stringify(lastDebugEntry());
    expect(debugEntry).not.toContain('abc123xyz');
  });

  it('preserves non-sensitive headers in the debug log', async () => {
    const client = createHttpClient('GitHub');
    const mock = new MockAdapter(client);
    mock.onGet('https://api.github.com/repos').reply(200, {});

    await client.get('https://api.github.com/repos', {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'token ghp_secret',
      },
    });

    const debugEntry = JSON.stringify(lastDebugEntry());
    expect(debugEntry).toContain('application/json');
    expect(debugEntry).not.toContain('ghp_secret');
  });
});

// ── Sensitive URL parameter redaction ────────────────────────────────────────

describe('createHttpClient — URL redaction', () => {
  it('masks ?token= in the logged request_url', async () => {
    const client = createHttpClient('Auth0');
    const mock = new MockAdapter(client);
    mock.onGet(/.*/).reply(200, {});

    await client.get('https://auth0.example.com/callback?token=secret-jwt');

    const debugEntry = JSON.stringify(lastDebugEntry());
    const infoEntry = JSON.stringify(lastInfoEntry());

    expect(debugEntry).not.toContain('secret-jwt');
    expect(infoEntry).not.toContain('secret-jwt');
  });

  it('masks ?email= in the logged request_url', async () => {
    const client = createHttpClient('UserService');
    const mock = new MockAdapter(client);
    mock.onGet(/.*/).reply(200, {});

    await client.get('https://api.example.com/lookup?email=user@example.com');

    const debugEntry = JSON.stringify(lastDebugEntry());
    expect(debugEntry).not.toContain('user@example.com');
  });
});

// ── Error / timeout handling ──────────────────────────────────────────────────

describe('createHttpClient — error handling', () => {
  it('logs http_status and timing_ms on a 4xx response', async () => {
    const client = createHttpClient('Stripe-API');
    const mock = new MockAdapter(client);
    mock.onGet('https://api.stripe.com/v1/missing').reply(404, {});

    await expect(client.get('https://api.stripe.com/v1/missing')).rejects.toThrow();

    const entry = lastErrorEntry();
    expect(entry.http_status).toBe(404);
    expect(entry.dependency_name).toBe('Stripe-API');
    expect(typeof entry.timing_ms).toBe('number');
  });

  it('logs timing_ms on a network timeout (no http_status)', async () => {
    const client = createHttpClient('SlowService');
    const mock = new MockAdapter(client);
    mock.onGet('https://slow.example.com/data').timeout();

    await expect(client.get('https://slow.example.com/data')).rejects.toThrow();

    const entry = lastErrorEntry();
    expect(entry.dependency_name).toBe('SlowService');
    expect(typeof entry.timing_ms).toBe('number');
    expect((entry.timing_ms as number)).toBeGreaterThanOrEqual(0);
    // No http_status for a network-level timeout
    expect(entry.http_status).toBeUndefined();
  });

  it('logs timing_ms on a network error (connection refused)', async () => {
    const client = createHttpClient('DownService');
    const mock = new MockAdapter(client);
    mock.onGet('https://down.example.com/api').networkError();

    await expect(client.get('https://down.example.com/api')).rejects.toThrow();

    const entry = lastErrorEntry();
    expect(typeof entry.timing_ms).toBe('number');
  });

  it('does NOT leak sensitive headers in error log entries', async () => {
    const client = createHttpClient('Stripe-API');
    const mock = new MockAdapter(client);
    mock.onPost('https://api.stripe.com/v1/charges').reply(500, {});

    await expect(
      client.post(
        'https://api.stripe.com/v1/charges',
        {},
        { headers: { Authorization: 'Bearer sk_live_topsecret' } },
      ),
    ).rejects.toThrow();

    const errorEntry = JSON.stringify(lastErrorEntry());
    expect(errorEntry).not.toContain('sk_live_topsecret');
  });
});
