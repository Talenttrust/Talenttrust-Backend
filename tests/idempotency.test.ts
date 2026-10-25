import express from 'express';
import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { MemoryIdempotencyStore, StoredResponse, fingerprint, idempotency } from '../src/idempotency';

type App = ReturnType<typeof createApp>;
const parties = { client: 'GA', freelancer: 'GB' };
const create = (app: App, milestones: unknown[] = [100]) =>
  request(app).post('/api/v1/contracts').send({ ...parties, milestones });
const entry = (over: Partial<StoredResponse> = {}): StoredResponse => ({
  fingerprint: 'f',
  status: 200,
  body: {},
  headers: {},
  createdAt: Date.now(),
  ...over,
});

/** Blocks inside set() until released, so a request stays "in flight". */
class GatedStore extends MemoryIdempotencyStore {
  entered: Promise<void>;
  release!: () => void;
  private enter!: () => void;
  private gate: Promise<void>;
  constructor() {
    super();
    this.entered = new Promise((r) => (this.enter = r));
    this.gate = new Promise((r) => (this.release = r));
  }
  async set(key: string, value: StoredResponse) {
    this.enter();
    await this.gate;
    return super.set(key, value);
  }
}

describe('Idempotency-Key', () => {
  let store: EscrowStore;
  let app: App;
  beforeEach(() => {
    store = new EscrowStore();
    app = createApp(store);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('applies a retried deposit once and replays the response', async () => {
    const { body: c } = await create(app, [200]).expect(201);
    const url = `/api/v1/contracts/${c.id}/deposit`;
    const first = await request(app).post(url).set('Idempotency-Key', 'dep-1').send({ amount: 50 }).expect(200);
    const second = await request(app).post(url).set('Idempotency-Key', 'dep-1').send({ amount: 50 }).expect(200);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(store.get(c.id).fundedAmount).toBe(50);
  });

  it('replays a snapshot, not the live contract state', async () => {
    const { body: c } = await create(app).expect(201);
    const url = `/api/v1/contracts/${c.id}/deposit`;
    const first = await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 50 }).expect(200);
    await request(app).post(url).send({ amount: 25 }).expect(200);
    const replay = await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 50 }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.body.fundedAmount).toBe(50);
    expect(store.get(c.id).fundedAmount).toBe(75);
  });

  it('does not create a duplicate contract on retry', async () => {
    const a = await create(app).set('Idempotency-Key', 'c1').expect(201);
    const b = await create(app).set('Idempotency-Key', 'c1').expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps old behaviour without a key', async () => {
    const { body: c } = await create(app, [200]).expect(201);
    const url = `/api/v1/contracts/${c.id}/deposit`;
    await request(app).post(url).send({ amount: 50 }).expect(200);
    await request(app).post(url).send({ amount: 50 }).expect(200);
    expect(store.get(c.id).fundedAmount).toBe(100);
  });

  it('returns 422 when the key is reused with a different body', async () => {
    const { body: c } = await create(app, [200]).expect(201);
    const url = `/api/v1/contracts/${c.id}/deposit`;
    await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 50 }).expect(200);
    const r = await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 60 }).expect(422);
    expect(r.body.error).toBe('idempotency_key_reused');
    expect(store.get(c.id).fundedAmount).toBe(50);
  });

  it('scopes keys by path', async () => {
    const a = (await create(app, [100])).body;
    const b = (await create(app, [100])).body;
    await request(app).post(`/api/v1/contracts/${a.id}/deposit`).set('Idempotency-Key', 'k').send({ amount: 10 }).expect(200);
    const r = await request(app).post(`/api/v1/contracts/${b.id}/deposit`).set('Idempotency-Key', 'k').send({ amount: 10 }).expect(200);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(store.get(b.id).fundedAmount).toBe(10);
  });

  it('returns 409 + Retry-After while the first request is in flight', async () => {
    const gated = new GatedStore();
    const gatedApp = createApp(store, undefined, { idempotencyStore: gated });
    const first = create(gatedApp).set('Idempotency-Key', 'k').then((r) => r);
    await gated.entered;
    const dup = await create(gatedApp).set('Idempotency-Key', 'k');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('idempotency_request_in_progress');
    expect(dup.headers['retry-after']).toBe('1');
    gated.release();
    expect((await first).status).toBe(201);
    const after = await create(gatedApp).set('Idempotency-Key', 'k');
    expect(after.status).toBe(201);
    expect(after.headers['idempotent-replayed']).toBe('true');
    expect(store.list()).toHaveLength(1);
  });

  it('replays 4xx responses instead of re-executing', async () => {
    const { body: c } = await create(app, [100]).expect(201);
    const url = `/api/v1/contracts/${c.id}/deposit`;
    const spy = jest.spyOn(store, 'deposit');
    const first = await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 150 }).expect(409);
    expect(first.body.error).toBe('over_funded');
    const second = await request(app).post(url).set('Idempotency-Key', 'k').send({ amount: 150 }).expect(409);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not cache 5xx responses', async () => {
    const { body: c } = await create(app).expect(201);
    const url = `/api/v1/contracts/${c.id}/cancel`;
    jest.spyOn(store, 'cancel').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await request(app).post(url).set('Idempotency-Key', 'k').expect(500);
    const retry = await request(app).post(url).set('Idempotency-Key', 'k').expect(200);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    const again = await request(app).post(url).set('Idempotency-Key', 'k').expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });

  it.each(['a'.repeat(256), 'clé'])('rejects invalid key %#', async (k) => {
    const r = await create(app).set('Idempotency-Key', k);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_idempotency_key');
  });

  it('accepts a 255-char key', async () => {
    await create(app).set('Idempotency-Key', 'a'.repeat(255)).expect(201);
  });

  it('IDEMPOTENCY_REQUIRED makes the header mandatory on POST only', async () => {
    const strict = createApp(new EscrowStore(), undefined, { idempotencyRequired: true });
    const r = await create(strict);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('idempotency_key_required');
    await create(strict).set('Idempotency-Key', 'k').expect(201);
    await request(strict).get('/api/v1/contracts').expect(200);
  });

  it('treats reordered JSON keys as the same request', async () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }));
    const a = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'k')
      .send({ client: 'GA', freelancer: 'GB', milestones: [100] })
      .expect(201);
    const b = await request(app)
      .post('/api/v1/contracts')
      .set('Idempotency-Key', 'k')
      .send({ milestones: [100], freelancer: 'GB', client: 'GA' })
      .expect(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body.id).toBe(a.body.id);
  });

  it('scopes keys by authenticated principal', async () => {
    let calls = 0;
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      Object.assign(req, { user: { id: req.header('x-user') } });
      next();
    });
    a.post('/api/v1/x', idempotency(new MemoryIdempotencyStore()), (_req, res) => {
      res.status(201).json({ n: ++calls });
    });
    const post = (u: string) => request(a).post('/api/v1/x').set('x-user', u).set('Idempotency-Key', 'k');
    const alice = await post('alice');
    const bob = await post('bob');
    const alice2 = await post('alice');
    expect(bob.body.n).toBe(2);
    expect(bob.headers['idempotent-replayed']).toBeUndefined();
    expect(alice2.body).toEqual(alice.body);
    expect(alice2.headers['idempotent-replayed']).toBe('true');
  });
});

describe('MemoryIdempotencyStore', () => {
  afterEach(() => jest.useRealTimers());

  it('expires entries after the TTL (default 24h)', async () => {
    jest.useFakeTimers().setSystemTime(0);
    const s = new MemoryIdempotencyStore();
    await s.set('k', entry());
    jest.setSystemTime(24 * 60 * 60 * 1000 - 1);
    expect(await s.get('k')).toBeDefined();
    jest.setSystemTime(24 * 60 * 60 * 1000 + 1);
    expect(await s.get('k')).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it('evicts the least recently used entry at capacity', async () => {
    const s = new MemoryIdempotencyStore(60_000, 2);
    await s.set('a', entry());
    await s.set('b', entry());
    await s.get('a'); // a is now most recent
    await s.set('c', entry());
    expect(await s.get('b')).toBeUndefined();
    expect(await s.get('a')).toBeDefined();
    expect(await s.get('c')).toBeDefined();
  });

  it('stays bounded under a flood of unique keys', async () => {
    const s = new MemoryIdempotencyStore(60_000, 100);
    for (let i = 0; i < 1000; i++) await s.set(`k${i}`, entry());
    expect(s.size).toBe(100);
  });

  it('lock is exclusive until unlock', async () => {
    const s = new MemoryIdempotencyStore();
    expect(await s.lock('k')).toBe(true);
    expect(await s.lock('k')).toBe(false);
    await s.unlock('k');
    expect(await s.lock('k')).toBe(true);
  });
});

describe('OpenAPI', () => {
  it('documents Idempotency-Key, 409 and 422 on every POST', async () => {
    const spec = (await request(createApp(new EscrowStore())).get('/openapi.json').expect(200)).body;
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.components.parameters.IdempotencyKey.name).toBe('Idempotency-Key');
    const posts = Object.entries<Record<string, any>>(spec.paths).filter(([, item]) => item.post); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(posts).toHaveLength(17);
    for (const [path, item] of posts) {
      const op = item.post;
      expect(op.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
      expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['400', '409', '422']));
      for (const r of Object.values<{ $ref?: string }>(op.responses)) {
        if (r.$ref) expect(spec.components.responses[r.$ref.split('/').pop()!]).toBeDefined();
      }
      expect(path).toMatch(/^\/api\/v1\//);
    }
  });
});
