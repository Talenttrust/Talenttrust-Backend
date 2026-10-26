import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore, HttpError } from '../src/store';
import { ERRORS, ErrorKey } from '../src/errors';
import { account } from './helpers/addresses';

describe('Error catalog', () => {
  const app = createApp(new EscrowStore());

  it('every catalog entry has a unique code and a valid status', () => {
    const codes = new Set<string>();
    for (const [key, entry] of Object.entries(ERRORS)) {
      codes.add(key);
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThanOrEqual(599);
      expect(entry.title).toBeTruthy();
      expect(entry.detail).toBeTruthy();
    }
    expect(codes.size).toBe(Object.keys(ERRORS).length);
  });

  it('GET /api/v1/errors lists every code', async () => {
    const res = await request(app).get('/api/v1/errors');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(Object.keys(res.body).sort()).toEqual(Object.keys(ERRORS).sort());
    for (const [key, entry] of Object.entries(res.body as Record<string, unknown>)) {
      expect((entry as { status: number }).status).toBe(ERRORS[key as ErrorKey].status);
      expect((entry as { title: string }).title).toBe(ERRORS[key as ErrorKey].title);
    }
  });

  it('GET /errors/:code returns a description', async () => {
    const res = await request(app).get('/errors/over_funded').set('Accept', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('over_funded');
    expect(res.body.contractError).toEqual({ name: 'OverFunded', code: 9 });
  });

  it('GET /errors/:code returns HTML when requested', async () => {
    const res = await request(app).get('/errors/over_funded').set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Over funded');
  });

  it('GET /errors/:code returns 404 for unknown code', async () => {
    const res = await request(app).get('/errors/does_not_exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('error_code_not_found');
  });

  it('contract_not_found response is problem+json with error and message', async () => {
    const res = await request(app).get('/api/v1/contracts/999');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.error).toBe('contract_not_found');
    expect(res.body.message).toBeTruthy();
    expect(res.body.title).toBe('Contract not found');
    expect(res.body.status).toBe(404);
    expect(res.body.type).toBe('https://talenttrust-backend.vercel.app/errors/contract_not_found');
  });

  it('over_funded response includes contractError', async () => {
    const { body: created } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ amount: 100 }] });
    await request(app).post(`/api/v1/contracts/${created.id}/deposit`).send({ amount: 100 });
    const res = await request(app)
      .post(`/api/v1/contracts/${created.id}/deposit`)
      .send({ amount: 1 });
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.contractError).toEqual({ name: 'OverFunded', code: 9 });
    expect(res.body.error).toBe('over_funded');
    expect(res.body.message).toBeTruthy();
  });

  it('forbidden response uses forbidden code (unauthorized renamed)', async () => {
    const { body } = await request(app)
      .post('/api/v1/contracts')
      .send({ client: account('GC'), freelancer: account('GD'), milestones: [{ amount: 200 }] });
    await request(app).post(`/api/v1/contracts/${body.id}/deposit`).send({ amount: 200 });
    const res = await request(app)
      .post(`/api/v1/contracts/${body.id}/dispute`)
      .send({ raisedBy: account('GX') });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(res.body.message).toBeTruthy();
  });

  it('invalid_id response is problem+json', async () => {
    const res = await request(app).get('/api/v1/contracts/abc');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.error).toBe('invalid_id');
    expect(res.body.message).toBeTruthy();
  });

  it('unknown route returns problem+json not_found', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.error).toBe('not_found');
    expect(res.body.message).toBeTruthy();
  });

  it('malformed JSON returns problem+json invalid_json', async () => {
    const res = await request(app)
      .post('/api/v1/contracts')
      .send('{ not valid json')
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.error).toBe('invalid_json');
    expect(res.body.message).toBeTruthy();
  });

  it('OpenAPI declares at least one 4xx/5xx response referencing Problem for every operation', async () => {
    const spec = await request(app).get('/openapi.json');
    expect(spec.body.openapi).toBe('3.0.3');
    for (const [path, item] of Object.entries(spec.body.paths as Record<string, unknown>)) {
      for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
        const responses = (op as { responses?: Record<string, unknown> }).responses ?? {};
        const statuses = Object.keys(responses);
        const has4xxOr5xx = statuses.some((s) => s.startsWith('4') || s.startsWith('5'));
        const hasProblem = Object.values(responses).some(
          (r) => (r as { content?: Record<string, unknown> }).content?.['application/problem+json'],
        );
        expect(has4xxOr5xx && hasProblem).toBe(true);
      }
    }
  });

  it('rejects unknown catalog keys at compile time', () => {
    // @ts-expect-error - 'bogus' is not a valid ErrorKey
    const badKey: ErrorKey = 'bogus';
    void badKey;
  });
});
