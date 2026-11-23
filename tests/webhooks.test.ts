import http from 'http';
import { lookup } from 'dns/promises';
import request from 'supertest';
import { createApp } from '../src/app';
import { StoreEventEmitter } from '../src/events';
import { EscrowStore } from '../src/store';
import { validateWebhookUrl, verifyWebhookSignature, WebhookManager } from '../src/webhooks';

jest.mock('dns/promises', () => {
  const actual = jest.requireActual('dns/promises');
  return { ...actual, lookup: jest.fn(actual.lookup) };
});

const lookupMock = lookup as unknown as jest.Mock;

const event = (eventType: 'milestone.released' = 'milestone.released') => ({
  id: 'event-id', eventId: 'event-id', eventType, timestamp: new Date().toISOString(), data: { contractId: 1 },
});

const waitFor = async (predicate: () => boolean, timeout = 1000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for webhook delivery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe('webhook signatures and URL validation', () => {
  it('signs the raw body and rejects tampering, wrong secrets, and stale timestamps', () => {
    const body = JSON.stringify({ value: 1 });
    const timestamp = Date.now();
    const crypto = require('crypto') as typeof import('crypto');
    const signature = crypto.createHmac('sha256', 'secret').update(`${timestamp}.${body}`).digest('hex');
    const headers = { 'X-Signature': `sha256=${signature}`, 'X-Timestamp': String(timestamp) };
    expect(verifyWebhookSignature('secret', headers, body)).toBe(true);
    expect(verifyWebhookSignature('wrong', headers, body)).toBe(false);
    expect(verifyWebhookSignature('secret', headers, `${body} `)).toBe(false);
    expect(verifyWebhookSignature('secret', { ...headers, 'X-Timestamp': String(timestamp - 301_000) }, body)).toBe(false);
    expect(verifyWebhookSignature('secret', { 'X-Signature': 'bad', 'X-Timestamp': String(timestamp) }, body)).toBe(false);
  });

  it.each(['https://127.0.0.1/hook', 'https://10.0.0.1/hook', 'https://169.254.169.254/hook', 'https://[::1]/hook'])('rejects private destination %s', async (url) => {
    await expect(validateWebhookUrl(url, false)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('allows localhost HTTP only outside production', async () => {
    await expect(validateWebhookUrl('http://localhost:12345/hook', false)).resolves.toBeInstanceOf(URL);
    await expect(validateWebhookUrl('http://localhost:12345/hook', true)).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

describe('webhook delivery', () => {
  it('emits one event only after a successful mutation', () => {
    const events = new StoreEventEmitter();
    const seen: string[] = [];
    events.on((value) => seen.push(value.eventType));
    const store = new EscrowStore(events);
    expect(() => store.create({ client: 'same', freelancer: 'same', milestones: [{ amount: 1 }] })).toThrow();
    expect(seen).toEqual([]);
    const contract = store.create({ client: 'client', freelancer: 'freelancer', milestones: [{ amount: 1 }] });
    expect(seen).toEqual(['contract.created']);
    expect(() => store.deposit(contract.id, 2)).toThrow();
    expect(seen).toEqual(['contract.created']);
  });

  it('delivers a signed milestone event to a real local receiver', async () => {
    const received: { body: string; headers: http.IncomingHttpHeaders }[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { received.push({ body, headers: req.headers }); res.statusCode = 200; res.end('ok'); });
    });
    await new Promise<void>((resolve) => server.listen(0, 'localhost', resolve));
    const port = (server.address() as { port: number }).port;
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events);
    const created = await manager.create({ url: `http://localhost:${port}/hook`, events: ['milestone.released'] });
    events.emit('milestone.released', { contractId: 1 });
    await waitFor(() => received.length === 1);
    expect(received[0].headers['x-signature']).toMatch(/^sha256=/);
    expect(received[0].headers['x-timestamp']).toBeDefined();
    expect(verifyWebhookSignature(created.secret, received[0].headers as Record<string, string>, received[0].body)).toBe(true);
    expect(JSON.parse(received[0].body).eventType).toBe('milestone.released');
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('filters events and retries two failures before final success', async () => {
    const responses = [500, 500, 204];
    const client = jest.fn(async () => ({ statusCode: responses.shift() ?? 500 }));
    const sleeps = jest.fn(async () => undefined);
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, { httpClient: client, sleep: sleeps, random: () => 0.5 });
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['milestone.released'] });
    events.emit('contract.created', { contractId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client).not.toHaveBeenCalled();
    events.emit('milestone.released', { contractId: 1 });
    await waitFor(() => client.mock.calls.length === 3);
    expect(client).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveBeenCalledTimes(2);
    expect((await manager.history(created.subscription.id))[0]).toMatchObject({ status: 'success', attempts: 3 });
  });

  it('records retry exhaustion after six attempts', async () => {
    const client = jest.fn(async () => ({ statusCode: 503 }));
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, { httpClient: client, sleep: async () => undefined, random: () => 0.5 });
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['contract.created'] });
    events.emit('contract.created', {});
    await waitFor(() => client.mock.calls.length === 6);
    expect((await manager.history(created.subscription.id))[0]).toMatchObject({ status: 'failed', attempts: 6, statusCode: 503 });
  });

  it('supports wildcard subscriptions, bounded history, and secret rotation', async () => {
    const client = jest.fn(async () => ({ statusCode: 200 }));
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, { httpClient: client, sleep: async () => undefined, maxHistory: 1 });
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['*'] });
    expect(manager.get(created.subscription.id)).not.toHaveProperty('secret');
    events.emit('contract.created', {});
    events.emit('contract.cancelled', {});
    await waitFor(() => client.mock.calls.length === 2);
    expect((await manager.history(created.subscription.id))).toHaveLength(1);
    const rotated = manager.rotateSecret(created.subscription.id);
    expect(rotated.secret).not.toBe(created.secret);
    expect(manager.get(created.subscription.id)).not.toHaveProperty('secret');
  });

  it('does not block the originating mutation on a slow receiver', async () => {
    let resolveDelivery!: () => void;
    const client = jest.fn(() => new Promise<{ statusCode: number }>((resolve) => { resolveDelivery = () => resolve({ statusCode: 200 }); }));
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, { httpClient: client });
    await manager.create({ url: 'http://localhost:12345/hook', events: ['contract.created'] });
    const store = new EscrowStore(events);
    const started = Date.now();
    store.create({ client: 'client', freelancer: 'freelancer', milestones: [{ amount: 1 }] });
    expect(Date.now() - started).toBeLessThan(100);
    await waitFor(() => client.mock.calls.length === 1);
    resolveDelivery();
  });
});

describe('webhook reserved address ranges', () => {
  const rejectedIpv4 = [
    // Newly prohibited ranges, including their boundaries.
    '192.0.0.1', '192.0.0.255',
    '192.0.2.1', '192.0.2.255',
    '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '198.51.100.255',
    '203.0.113.1', '203.0.113.255',
    '224.0.0.1', '239.255.255.255',
    '240.0.0.1', '255.255.255.254', '255.255.255.255',
    // Existing private/reserved protections.
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
  ];

  it.each(rejectedIpv4)('rejects IPv4 %s', async (address) => {
    await expect(validateWebhookUrl(`https://${address}/hook`, false)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  const acceptedIpv4 = [
    '8.8.8.8', '1.1.1.1', '93.184.216.34',
    // Just outside each newly prohibited range.
    '192.0.1.1', '192.0.3.1', '198.17.255.255', '198.20.0.1', '198.51.101.1', '203.0.114.1', '223.255.255.255',
  ];

  it.each(acceptedIpv4)('keeps public IPv4 %s accepted', async (address) => {
    await expect(validateWebhookUrl(`https://${address}/hook`, false)).resolves.toBeInstanceOf(URL);
  });

  const rejectedIpv6 = [
    // Newly prohibited ranges: multicast, site-local, NAT64, plus compressed/expanded equivalents.
    '[ff00::]', '[ff02::1]', '[ffff::1]',
    '[fec0::1]', '[feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
    '[64:ff9b::1]', '[64:ff9b::192.0.2.1]', '[0064:ff9b:0000:0000:0000:0000:0000:0001]',
    // Boundary neighbours of the link-local and site-local blocks.
    '[fe80::1]', '[febf:ffff::1]',
    // IPv4-mapped and IPv4-compatible bypass attempts.
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:192.168.0.1]', '[::ffff:169.254.169.254]',
    '[0:0:0:0:0:ffff:7f00:1]', '[::ffff:7f00:1]', '[::7f00:1]',
    // Existing protections.
    '[::]', '[::1]', '[fc00::1]', '[fd12:3456::1]', '[2001:db8::1]',
  ];

  it.each(rejectedIpv6)('rejects IPv6 %s', async (address) => {
    await expect(validateWebhookUrl(`https://${address}/hook`, false)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  const acceptedIpv6 = [
    '[2606:4700:4700::1111]', '[2001:4860:4860::8888]', '[2a00:1450:4001:80f::200e]', '[::ffff:8.8.8.8]',
  ];

  it.each(acceptedIpv6)('keeps public IPv6 %s accepted', async (address) => {
    await expect(validateWebhookUrl(`https://${address}/hook`, false)).resolves.toBeInstanceOf(URL);
  });

  it('rejects hostnames whose DNS results are prohibited addresses', async () => {
    const resolved: Array<{ address: string; family: number }> = [
      { address: '224.0.0.1', family: 4 },
      { address: '198.51.100.7', family: 4 },
      { address: 'ff02::1', family: 6 },
      { address: 'fec0::1', family: 6 },
      { address: '64:ff9b::1', family: 6 },
      { address: '::ffff:10.0.0.1', family: 6 },
    ];
    for (const record of resolved) {
      lookupMock.mockResolvedValueOnce([record]);
      await expect(validateWebhookUrl('https://webhooks.example.com/hook', false)).rejects.toMatchObject({ code: 'invalid_url' });
    }
  });

  it('accepts a hostname when every DNS result is public', async () => {
    lookupMock.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    await expect(validateWebhookUrl('https://webhooks.example.com/hook', false)).resolves.toBeInstanceOf(URL);
  });

  it('fails safely for malformed IP literals', async () => {
    await expect(validateWebhookUrl('https://[not-an-ip]/hook', false)).rejects.toMatchObject({ code: 'invalid_url' });
    await expect(validateWebhookUrl('https://[::gggg]/hook', false)).rejects.toMatchObject({ code: 'invalid_url' });
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(validateWebhookUrl('https://999.999.999.999/hook', false)).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects a hostname whose DNS lookup fails', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(validateWebhookUrl('https://does-not-exist.example/hook', false)).rejects.toMatchObject({ code: 'invalid_url' });
  });
});

describe('webhook delivery history', () => {
  const build = async (statuses: Array<'success' | 'failed'>) => {
    let clock = 0;
    const responses = [...statuses];
    const client = jest.fn(async () => ({ statusCode: responses.shift() === 'failed' ? 400 : 200 }));
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, {
      httpClient: client,
      sleep: async () => undefined,
      now: () => (clock += 1000),
    });
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['*'] });
    const id = created.subscription.id;
    const eventIds = statuses.map(() => events.emit('contract.created', {}).eventId);
    await waitFor(() => {
      const history = manager.history(id, { limit: statuses.length });
      return history.length === statuses.length && history.every((delivery) => delivery.status !== 'pending');
    });
    return { manager, id, eventIds };
  };

  it('returns the newest 50 deliveries by default, newest first', async () => {
    const { manager, id, eventIds } = await build(Array.from({ length: 60 }, () => 'success' as const));
    const history = manager.history(id);
    expect(history).toHaveLength(50);
    expect(history[0].eventId).toBe(eventIds[59]);
    expect(history[49].eventId).toBe(eventIds[10]);
    const timestamps = history.map((delivery) => Date.parse(delivery.createdAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it('honours explicit limits of 1 and 100 without ever returning more than requested', async () => {
    const { manager, id, eventIds } = await build(Array.from({ length: 120 }, () => 'success' as const));
    const single = manager.history(id, { limit: 1 });
    expect(single).toHaveLength(1);
    expect(single[0].eventId).toBe(eventIds[119]);
    const hundred = manager.history(id, { limit: 100 });
    expect(hundred).toHaveLength(100);
    expect(hundred[0].eventId).toBe(eventIds[119]);
    expect(hundred[99].eventId).toBe(eventIds[20]);
  });

  it('filters by status before limiting and returns the newest matching records', async () => {
    const statuses: Array<'success' | 'failed'> = Array.from({ length: 20 }, (_, i) => (i >= 18 ? 'failed' : 'success'));
    const { manager, id, eventIds } = await build(statuses);
    const failed = manager.history(id, { status: 'failed', limit: 2 });
    expect(failed.map((delivery) => delivery.eventId)).toEqual([eventIds[19], eventIds[18]]);
    expect(failed.every((delivery) => delivery.status === 'failed')).toBe(true);
    // A naive limit-then-filter would find no successes in the newest two records.
    const successes = manager.history(id, { status: 'success', limit: 2 });
    expect(successes.map((delivery) => delivery.eventId)).toEqual([eventIds[17], eventIds[16]]);
    expect(manager.history(id, { status: 'success', limit: 100 })).toHaveLength(18);
  });

  it('filters pending deliveries while they are still in flight', async () => {
    let release!: () => void;
    const client = jest.fn(() => new Promise<{ statusCode: number }>((resolve) => { release = () => resolve({ statusCode: 200 }); }));
    const events = new StoreEventEmitter();
    const manager = new WebhookManager(events, { httpClient: client, sleep: async () => undefined });
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['*'] });
    const id = created.subscription.id;
    events.emit('contract.created', {});
    await waitFor(() => manager.history(id, { status: 'pending' }).length === 1);
    expect(manager.history(id, { status: 'success' })).toEqual([]);
    release();
    await waitFor(() => manager.history(id).every((delivery) => delivery.status === 'success'));
  });

  it('returns an empty history when there are no deliveries and 404 for unknown subscriptions', async () => {
    const manager = new WebhookManager(new StoreEventEmitter());
    const created = await manager.create({ url: 'http://localhost:12345/hook', events: ['*'] });
    expect(manager.history(created.subscription.id)).toEqual([]);
    expect(() => manager.history('missing-subscription')).toThrow();
    expect(() => manager.history('missing-subscription', { status: 'failed', limit: 1 })).toThrow();
  });
});

describe('webhook management routes', () => {
  const token = 'test-admin-token';
  const auth = { Authorization: `Bearer ${token}` };

  beforeEach(() => { process.env.WEBHOOK_ADMIN_TOKEN = token; });
  afterEach(() => { delete process.env.WEBHOOK_ADMIN_TOKEN; });

  it('requires the configured token, returns one-time secrets, and supports CRUD/rotation/history', async () => {
    const app = createApp(new EscrowStore());
    const unauth = await request(app).get('/api/v1/webhook-subscriptions');
    expect(unauth.status).toBe(401);
    expect(unauth.headers['cache-control']).toBe('no-store');
    expect(unauth.headers['pragma']).toBe('no-cache');
    const created = await request(app).post('/api/v1/webhook-subscriptions').set(auth).send({ url: 'http://localhost:12345/hook', events: ['*'] }).expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    expect(created.headers['cache-control']).toBe('no-store');
    expect(created.headers['pragma']).toBe('no-cache');
    const id = created.body.id;
    const fetched = await request(app).get(`/api/v1/webhook-subscriptions/${id}`).set(auth).expect(200);
    expect(fetched.body).not.toHaveProperty('secret');
    expect(fetched.headers['cache-control']).toBe('no-store');
    await request(app).patch(`/api/v1/webhook-subscriptions/${id}`).set(auth).send({ active: false }).expect(200);
    const rotated = await request(app).post(`/api/v1/webhook-subscriptions/${id}/rotate-secret`).set(auth).expect(200);
    expect(rotated.headers['cache-control']).toBe('no-store');
    await request(app).get(`/api/v1/webhook-subscriptions/${id}/deliveries`).set(auth).expect(200);
    await request(app).delete(`/api/v1/webhook-subscriptions/${id}`).set(auth).expect(200);
  });

  it('returns 404 when token configuration is unset and rejects malformed requests', async () => {
    delete process.env.WEBHOOK_ADMIN_TOKEN;
    await request(createApp(new EscrowStore())).get('/api/v1/webhook-subscriptions').expect(404);
    process.env.WEBHOOK_ADMIN_TOKEN = token;
    const app = createApp(new EscrowStore());
    await request(app).post('/api/v1/webhook-subscriptions').set(auth).send({ url: 'https://127.0.0.1/hook', events: ['*'] }).expect(400);
    await request(app).post('/api/v1/webhook-subscriptions').set(auth).send({ url: 'http://localhost:12345/hook', events: ['unknown.event'] }).expect(400);
  });

  it('validates delivery history limit and status query parameters', async () => {
    const app = createApp(new EscrowStore());
    const created = await request(app).post('/api/v1/webhook-subscriptions').set(auth).send({ url: 'http://localhost:12345/hook', events: ['*'] }).expect(201);
    const url = `/api/v1/webhook-subscriptions/${created.body.id}/deliveries`;
    expect((await request(app).get(url).set(auth).expect(200)).body).toEqual({ data: [] });
    await request(app).get(`${url}?limit=1`).set(auth).expect(200);
    await request(app).get(`${url}?limit=100`).set(auth).expect(200);
    for (const status of ['pending', 'success', 'failed']) {
      await request(app).get(`${url}?status=${status}`).set(auth).expect(200);
    }
    for (const invalid of ['0', '-1', '101', '1.5', 'abc', '', '1e2']) {
      const response = await request(app).get(`${url}?limit=${encodeURIComponent(invalid)}`).set(auth).expect(400);
      expect(response.body.error).toBe('invalid_limit');
    }
    const repeated = await request(app).get(`${url}?limit=1&limit=2`).set(auth).expect(400);
    expect(repeated.body.error).toBe('invalid_limit');
    for (const invalid of ['bogus', 'SUCCESS', '']) {
      const response = await request(app).get(`${url}?status=${encodeURIComponent(invalid)}`).set(auth).expect(400);
      expect(response.body.error).toBe('invalid_status');
    }
    const repeatedStatus = await request(app).get(`${url}?status=success&status=failed`).set(auth).expect(400);
    expect(repeatedStatus.body.error).toBe('invalid_status');
    await request(app).get('/api/v1/webhook-subscriptions/missing/deliveries').set(auth).expect(404);
  });

  it('serves a valid OpenAPI 3.0.3 document', async () => {
    const response = await request(createApp(new EscrowStore())).get('/openapi.json').expect(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(response.body.paths['/api/v1/webhook-subscriptions']).toBeDefined();
  });

  it('documents the delivery history limit and status query parameters', async () => {
    const response = await request(createApp(new EscrowStore())).get('/openapi.json').expect(200);
    const operation = response.body.paths['/api/v1/webhook-subscriptions/{id}/deliveries'].get;
    const limit = operation.parameters.find((parameter: { name: string }) => parameter.name === 'limit');
    expect(limit).toMatchObject({ in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } });
    const status = operation.parameters.find((parameter: { name: string }) => parameter.name === 'status');
    expect(status).toMatchObject({ in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'success', 'failed'] } });
    expect(operation.responses['400']).toBeDefined();
  });
});
