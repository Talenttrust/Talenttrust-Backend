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

describe('webhook management routes', () => {
  const token = 'test-admin-token';
  const auth = { Authorization: `Bearer ${token}` };

  beforeEach(() => { process.env.WEBHOOK_ADMIN_TOKEN = token; });
  afterEach(() => { delete process.env.WEBHOOK_ADMIN_TOKEN; });

  it('requires the configured token, returns one-time secrets, and supports CRUD/rotation/history', async () => {
    const app = createApp(new EscrowStore());
    await request(app).get('/api/v1/webhook-subscriptions').expect(401);
    const created = await request(app).post('/api/v1/webhook-subscriptions').set(auth).send({ url: 'http://localhost:12345/hook', events: ['*'] }).expect(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const id = created.body.id;
    const fetched = await request(app).get(`/api/v1/webhook-subscriptions/${id}`).set(auth).expect(200);
    expect(fetched.body).not.toHaveProperty('secret');
    await request(app).patch(`/api/v1/webhook-subscriptions/${id}`).set(auth).send({ active: false }).expect(200);
    await request(app).post(`/api/v1/webhook-subscriptions/${id}/rotate-secret`).set(auth).expect(200);
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

  it('serves a valid OpenAPI 3.0.3 document', async () => {
    const response = await request(createApp(new EscrowStore())).get('/openapi.json').expect(200);
    expect(response.body.openapi).toBe('3.0.3');
    expect(response.body.paths['/api/v1/webhook-subscriptions']).toBeDefined();
  });
});
