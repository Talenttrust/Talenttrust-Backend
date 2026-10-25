import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

describe('request body errors', () => {
  const app = createApp(new EscrowStore());
  const validContract = { client: 'GA', freelancer: 'GB', milestones: [{ amount: 100 }] };

  afterEach(() => jest.restoreAllMocks());

  it('returns 413 payload_too_large for a body over the limit', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ title: 'a'.repeat(120000) }));
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('payload_too_large');
    expect(res.body.message).toContain('100kb');
  });

  it('returns 415 for a non-JSON content type on POST /contracts', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(validContract));
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it.each([
    '/api/v1/contracts/1/deposit',
    '/api/v1/contracts/1/dispute',
    '/api/v1/contracts/1/resolve',
    '/api/v1/contracts/1/reputation',
  ])('returns 415 for a non-JSON body on POST %s', async (path) => {
    const res = await request(app).post(path).set('Content-Type', 'text/plain').send('{"amount":1}');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('returns 415 for an unsupported charset', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it('returns 415 for an unsupported content-encoding', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'br')
      .send('{}');
    expect(res.status).toBe(415);
    expect(res.body.error).toBe('unsupported_media_type');
  });

  it.each([['[]'], ['"x"'], ['42']])('returns 400 invalid_body for a top-level %s body', async (raw) => {
    const res = await request(app).post('/api/v1/contracts').set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });

  it('still returns 400 invalid_json for malformed JSON', async () => {
    const res = await request(app).post('/api/v1/contracts').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('still allows a body-less POST /cancel without a content type', async () => {
    const created = await request(app).post('/api/v1/contracts').send(validContract).expect(201);
    const res = await request(app).post(`/api/v1/contracts/${created.body.id}/cancel`);
    expect(res.status).toBe(200);
  });

  it('returns 500 internal_error without leaking the message for unexpected errors', async () => {
    const store = new EscrowStore();
    jest.spyOn(store, 'create').mockImplementation(() => {
      throw new Error('db password is hunter2');
    });
    const res = await request(createApp(store)).post('/api/v1/contracts').send(validContract);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('internal_error');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('openapi documents body errors', () => {
  it.each([
    ['/api/v1/contracts'],
    ['/api/v1/contracts/{id}/deposit'],
    ['/api/v1/contracts/{id}/dispute'],
    ['/api/v1/contracts/{id}/resolve'],
    ['/api/v1/contracts/{id}/reputation'],
  ])('documents 413 and 415 on POST %s', async (path) => {
    const spec = await request(createApp(new EscrowStore())).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    const responses = spec.body.paths[path].post.responses;
    expect(responses['413']).toBeDefined();
    expect(responses['415']).toBeDefined();
  });
});

describe('primitive JSON bodies outside the body-taking routes', () => {
  const app = createApp(new EscrowStore());

  it.each([
    ['/api/v1/contracts/1/cancel'],
    ['/api/v1/contracts/1/milestones/0/release'],
    ['/api/v1/does-not-exist'],
  ])('keeps rejecting a top-level primitive with 400 invalid_json on POST %s', async (path) => {
    const res = await request(app).post(path).set('Content-Type', 'application/json').send('42');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });
});

describe('BODY_LIMIT validation', () => {
  const load = (value?: string): string => {
    const saved = process.env.BODY_LIMIT;
    if (value === undefined) delete process.env.BODY_LIMIT;
    else process.env.BODY_LIMIT = value;
    try {
      let limit = '';
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        limit = require('../src/config').config.bodyLimit;
      });
      return limit;
    } finally {
      if (saved === undefined) delete process.env.BODY_LIMIT;
      else process.env.BODY_LIMIT = saved;
    }
  };

  it('defaults to 100kb', () => {
    expect(load()).toBe('100kb');
  });

  it.each([['1mb'], ['1.5mb'], ['2048']])('accepts %s', (value) => {
    expect(load(value)).toBe(value);
  });

  it.each([['100mbs'], ['1.5'], ['abc'], ['-1']])('rejects %s at startup', (value) => {
    expect(() => load(value)).toThrow(/Invalid BODY_LIMIT/);
  });
});
