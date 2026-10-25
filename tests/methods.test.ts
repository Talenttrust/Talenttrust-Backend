import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

const EXPECTED_ENDPOINTS = [
  'GET  /health',
  'GET  /docs',
  'GET  /openapi.json',
  'GET  /api/v1/chain',
  'GET  /api/v1/stats',
  'GET  /api/v1/contracts',
  'POST /api/v1/contracts',
  'GET  /api/v1/contracts/:id',
  'POST /api/v1/contracts/:id/deposit',
  'POST /api/v1/contracts/:id/milestones/:index/release',
  'POST /api/v1/contracts/:id/dispute',
  'POST /api/v1/contracts/:id/resolve',
  'POST /api/v1/contracts/:id/cancel',
  'POST /api/v1/contracts/:id/reputation',
  'GET  /api/v1/reputation/:address',
];

describe('method handling', () => {
  const app = createApp(new EscrowStore());

  it('returns 405 with Allow: POST for GET on the deposit route', async () => {
    const res = await request(app).get('/api/v1/contracts/1/deposit').expect(405);
    expect(res.headers.allow).toBe('POST');
    expect(res.body).toMatchObject({
      error: 'method_not_allowed',
      message: 'Method GET is not allowed for /api/v1/contracts/1/deposit',
      allowed: ['POST'],
    });
  });

  it('returns 405 with the supported methods for PUT on a contract', async () => {
    // Contracts support GET (and HEAD), PATCH (edit) and DELETE (withdraw).
    const res = await request(app).put('/api/v1/contracts/1').expect(405);
    expect(res.headers.allow).toBe('DELETE, GET, HEAD, PATCH');
    expect(res.body.allowed).toEqual(['DELETE', 'GET', 'HEAD', 'PATCH']);
  });

  it('returns 405 for PUT on the stats route', async () => {
    const res = await request(app).put('/api/v1/stats').expect(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });

  it('answers OPTIONS on a known path with 204 and Allow', async () => {
    const res = await request(app).options('/api/v1/contracts').expect(204);
    expect(res.headers.allow).toBe('GET, HEAD, POST');
    expect(res.text).toBe('');
  });

  it('supports HEAD for every GET route', async () => {
    const res = await request(app).head('/health').expect(200);
    expect(res.text).toBeUndefined();
    await request(app).head('/api/v1/contracts').expect(200);
    await request(app).head('/api/v1/stats').expect(200);
  });

  it('keeps the 404 body for unknown paths', async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.body).toMatchObject({
      error: 'not_found',
      message: 'No route for GET /nope',
      docs: '/docs',
    });
    expect(res.headers.allow).toBeUndefined();
  });

  it('keeps listing the core endpoints on GET /', async () => {
    const res = await request(app).get('/').expect(200);
    expect(res.body.endpoints).toEqual(expect.arrayContaining(EXPECTED_ENDPOINTS));
  });
});

describe('OpenAPI method responses', () => {
  const app = createApp(new EscrowStore());

  it('documents 405 on every path operation using a shared component', async () => {
    const spec = await request(app).get('/openapi.json').expect(200);
    expect(spec.body.openapi).toBe('3.0.3');
    expect(spec.body.components.responses.MethodNotAllowed).toBeDefined();

    const methods = ['get', 'post'];
    for (const [path, item] of Object.entries<Record<string, { responses: Record<string, unknown> }>>(
      spec.body.paths,
    )) {
      for (const method of methods) {
        const operation = item[method];
        if (!operation) continue;
        expect({ path, method, responses: operation.responses }).toEqual({
          path,
          method,
          responses: expect.objectContaining({
            405: { $ref: '#/components/responses/MethodNotAllowed' },
          }),
        });
      }
    }
  });
});
