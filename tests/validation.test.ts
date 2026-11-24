import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { z, ZodTypeAny } from 'zod';
import { validate, ValidationDetail } from '../src/validation/middleware';
import { HttpError } from '../src/store';

function buildApp(
  schemas: { params?: ZodTypeAny; query?: ZodTypeAny; body?: ZodTypeAny },
  routePath = '/items/:id',
): express.Express {
  const app = express();
  app.use(express.json());
  app.post(routePath, validate(schemas), (req: Request, res: Response) => {
    res.status(200).json({
      params: req.params,
      query: req.query,
      body: req.body,
    });
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: err.code,
        message: err.message,
        details: err.details?.details,
      });
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

describe('validate() middleware error-code precedence', () => {
  const positiveIntParam = z.object({
    id: z.string().regex(/^\d+$/, 'must be a positive integer').transform(Number),
  });

  const limitQuery = z.object({
    limit: z.coerce.number().int().positive().optional(),
  });

  const amountBody = z.object({
    amount: z.number().positive(),
    title: z.string().trim().min(1).optional(),
  });

  describe('amount-only failures -> invalid_amount', () => {
    it('returns invalid_amount when only body.amount fails', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery, body: amountBody });

      const res = await request(app)
        .post('/items/42?limit=10')
        .send({ amount: -5, title: 'valid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_amount');
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'body.amount', message: expect.any(String) }),
      ]);
    });

    it('returns invalid_amount when only bare milestone amounts (body.milestones.<n>) fail', async () => {
      const app = buildApp({
        body: z.object({
          milestones: z.array(z.number().positive()),
        }),
      });

      const res = await request(app)
        .post('/items/1')
        .send({ milestones: [0, -10] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_amount');
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        'body.milestones.0',
        'body.milestones.1',
      ]);
    });

    it('returns invalid_amount when only nested milestone amounts (body.milestones.<n>.amount) fail', async () => {
      const app = buildApp({
        body: z.object({
          milestones: z.array(z.object({ amount: z.number().positive() })),
        }),
      });

      const res = await request(app)
        .post('/items/1')
        .send({ milestones: [{ amount: 100 }, { amount: 0 }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_amount');
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'body.milestones.1.amount', message: expect.any(String) }),
      ]);
    });
  });

  describe('id-only failures -> invalid_id', () => {
    it('returns invalid_id when only params.id fails', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery, body: amountBody });

      const res = await request(app)
        .post('/items/not-a-number?limit=5')
        .send({ amount: 100, title: 'ok' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_id');
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'params.id', message: expect.any(String) }),
      ]);
    });
  });

  describe('mixed failures -> validation_failed', () => {
    it('returns validation_failed when both params.id and body.amount fail', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery, body: amountBody });

      const res = await request(app)
        .post('/items/abc')
        .send({ amount: -1 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        'params.id',
        'body.amount',
      ]);
    });

    it('returns validation_failed when body.amount fails alongside another body field', async () => {
      const app = buildApp({ body: amountBody });

      const res = await request(app)
        .post('/items/1')
        .send({ amount: -1, title: '' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        'body.amount',
        'body.title',
      ]);
    });

    it('returns validation_failed when params.id fails alongside a query error', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery });

      const res = await request(app)
        .post('/items/abc?limit=-3')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        'params.id',
        'query.limit',
      ]);
    });

    it('returns validation_failed when a non-id param fails', async () => {
      const app = buildApp(
        { params: z.object({ slug: z.string().regex(/^[a-z]+$/) }) },
        '/items/:slug',
      );

      const res = await request(app).post('/items/123').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'params.slug', message: expect.any(String) }),
      ]);
    });

    it('aggregates details with params., query., and body. prefixes across all locations', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery, body: amountBody });

      const res = await request(app)
        .post('/items/bad?limit=0')
        .send({ amount: 0, title: '   ' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details.map((d: ValidationDetail) => d.path)).toEqual([
        'params.id',
        'query.limit',
        'body.amount',
        'body.title',
      ]);
    });
  });

  describe('query-only failures -> validation_failed', () => {
    it('returns validation_failed when only query fails', async () => {
      const app = buildApp({ params: positiveIntParam, query: limitQuery, body: amountBody });

      const res = await request(app)
        .post('/items/10?limit=abc')
        .send({ amount: 50 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(res.body.details).toEqual([
        expect.objectContaining({ path: 'query.limit', message: expect.any(String) }),
      ]);
    });

    it('returns validation_failed even if a failing query field is named amount or id', async () => {
      const app = buildApp({
        query: z.object({
          amount: z.coerce.number().positive().optional(),
          id: z.coerce.number().int().positive().optional(),
        }),
      });

      const amountRes = await request(app).post('/items/1?amount=-5').send({});
      expect(amountRes.status).toBe(400);
      expect(amountRes.body.error).toBe('validation_failed');
      expect(amountRes.body.details).toEqual([
        expect.objectContaining({ path: 'query.amount', message: expect.any(String) }),
      ]);

      const idRes = await request(app).post('/items/1?id=abc').send({});
      expect(idRes.status).toBe(400);
      expect(idRes.body.error).toBe('validation_failed');
      expect(idRes.body.details).toEqual([
        expect.objectContaining({ path: 'query.id', message: expect.any(String) }),
      ]);
    });
  });

  describe('successful parse', () => {
    it('replaces req.params, req.query, and req.body with parsed (coerced/trimmed) values', async () => {
      const app = buildApp({
        params: z.object({
          id: z.coerce.number().int().positive(),
        }),
        query: z.object({
          limit: z.coerce.number().int().positive(),
          tag: z.string().trim(),
        }),
        body: z.object({
          amount: z.coerce.number().positive(),
          title: z.string().trim(),
        }),
      });

      const res = await request(app)
        .post('/items/42?limit=25&tag=%20urgent%20')
        .send({ amount: '150', title: '  Design milestone  ' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        params: { id: 42 },
        query: { limit: 25, tag: 'urgent' },
        body: { amount: 150, title: 'Design milestone' },
      });
    });
  });
});
