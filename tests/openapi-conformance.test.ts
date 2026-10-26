import SwaggerParser from '@apidevtools/swagger-parser';
import { openapi } from '../src/openapi';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import {
  assertConformance,
  conformanceProblems,
  request,
  type ConformanceResponse,
} from './helpers/openapi';
import { account, contract } from './helpers/addresses';

type ResponseDoc = {
  $ref?: string;
  content?: Record<string, { schema?: { $ref?: string } } | undefined>;
};
type OperationDoc = { responses?: Record<string, ResponseDoc | undefined> };
type PathItemDoc = Record<string, OperationDoc>;

const paths = (openapi as { paths: Record<string, PathItemDoc> }).paths;

const jsonBody = (body: unknown): ConformanceResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body,
});

const contractBody = () => ({
  id: 1,
  title: 'Landing page redesign',
  client: account('GA'),
  freelancer: account('GB'),
  token: contract('TOKEN'),
  tokenSymbol: null,
  milestones: [{ index: 0, title: 'Wireframes', amount: 100, amountUnits: '100', released: false }],
  totalAmount: 100,
  fundedAmount: 0,
  releasedAmount: 0,
  status: 'Created',
  reputationIssued: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('OpenAPI document', () => {
  it('is a structurally valid OpenAPI 3.0.3 document', async () => {
    const clone = JSON.parse(JSON.stringify(openapi));
    await expect(SwaggerParser.validate(clone)).resolves.toBeTruthy();
  });

  it('documents the service root, the docs page and the spec endpoint', () => {
    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining(['/', '/docs', '/openapi.json', '/health']),
    );
  });

  it('declares a 500 and an Error-referencing 4xx/5xx for every operation', () => {
    const components = (
      openapi as { components: { responses?: Record<string, ResponseDoc | undefined> } }
    ).components;
    const resolve = (declared: ResponseDoc | undefined): ResponseDoc | undefined => {
      if (!declared?.$ref) return declared;
      const name = /^#\/components\/responses\/([^/]+)$/.exec(declared.$ref)?.[1];
      return name ? components.responses?.[name] : undefined;
    };
    // The only documented non-envelope error responses: /health while draining and an unready readiness probe.
    const exceptions = new Set(['GET /health 503', 'GET /health/ready 503']);

    const problems: string[] = [];
    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        const responses = operation.responses ?? {};
        const label = `${method.toUpperCase()} ${path}`;
        if (!responses['500']) problems.push(`${label}: missing 500`);
        for (const [code, declared] of Object.entries(responses)) {
          if (!/^[45]\d\d$/.test(code)) continue;
          if (exceptions.has(`${label} ${code}`)) continue;
          const schema = resolve(declared)?.content?.['application/json']?.schema;
          if (schema?.$ref !== '#/components/schemas/Error') {
            problems.push(`${label} ${code}: does not reference #/components/schemas/Error`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('describes every field the store puts on EscrowContract', () => {
    const contract = (
      openapi as {
        components: {
          schemas: Record<string, {
            required?: string[];
            additionalProperties?: boolean;
            properties?: Record<string, unknown>;
          }>;
        };
      }
    ).components.schemas.EscrowContract;

    expect(contract.required).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'client',
        'freelancer',
        'token',
        'tokenSymbol',
        'milestones',
        'totalAmount',
        'fundedAmount',
        'releasedAmount',
        'status',
        'reputationIssued',
        'createdAt',
        'updatedAt',
      ]),
    );
    expect(contract.additionalProperties).toBe(false);
    expect(contract.properties?.dispute).toEqual({ $ref: '#/components/schemas/Dispute' });
  });
});

describe('conformance harness', () => {
  it('rejects a response that is missing a required property', () => {
    const { reputationIssued: _omitted, ...incomplete } = contractBody();
    const response: ConformanceResponse = { ...jsonBody(incomplete), status: 201 };

    const problems = conformanceProblems(response, 'post', '/api/v1/contracts');
    expect(problems.join('\n')).toMatch(/reputationIssued/);
    expect(() => assertConformance(response, 'post', '/api/v1/contracts')).toThrow(
      /OpenAPI conformance failure for POST \/api\/v1\/contracts → 201/,
    );
  });

  it('rejects a response carrying an undocumented property', () => {
    const response = { ...jsonBody(contractBody()), status: 201, body: { ...contractBody(), extra: true } };

    const problems = conformanceProblems(response, 'post', '/api/v1/contracts');
    expect(problems.join('\n')).toMatch(/unexpected property 'extra'/);
  });

  it('rejects an undocumented status for a documented path', () => {
    const problems = conformanceProblems(
      { ...jsonBody({ error: 'nope', message: 'nope' }), status: 418 },
      'post',
      '/api/v1/contracts',
    );
    expect(problems.join('\n')).toMatch(/418, which is not documented/);
  });

  it('rejects an undocumented path that does not answer with the documented 404', () => {
    const problems = conformanceProblems(jsonBody({ ok: true }), 'get', '/not-in-spec');
    expect(problems.join('\n')).toMatch(
      /path '\/not-in-spec' is not documented .*returned 200/,
    );
  });

  it('validates the global 404 for an undocumented path against the Error schema', () => {
    const response = (body: unknown): ConformanceResponse => ({
      ...jsonBody(body),
      status: 404,
    });
    const notFound = {
      error: 'not_found',
      message: 'No route for GET /not-in-spec',
      requestId: '8f14e45f-ea6f-4f5b-9c3d-2b1a7e0d5c6a',
      docs: '/docs',
    };

    expect(conformanceProblems(response(notFound), 'get', '/not-in-spec')).toEqual([]);
    expect(
      conformanceProblems(response({ error: 'not_found' }), 'get', '/not-in-spec').join('\n'),
    ).toMatch(/missing required property 'message'/);
  });
});

describe('live responses conform to the spec', () => {
  // Every awaited request below is validated against src/openapi.ts by the harness.
  const app = createApp(new EscrowStore());

  it('documents the system routes', async () => {
    await request(app).get('/').expect(200);
    await request(app).get('/health').expect(200);
    await request(app).get('/docs').expect(200);
    await request(app).get('/openapi.json').expect(200);
  });

  it('documents the contract lifecycle', async () => {
    const created = await request(app)
      .post('/api/v1/contracts')
      .send({ client: account('GA'), freelancer: account('GB'), milestones: [{ title: 'Design', amount: 100 }, 50] })
      .expect(201);
    const id = created.body.id as number;
    await request(app).get(`/api/v1/contracts/${id}`).expect(200);
    await request(app).get('/api/v1/contracts?limit=5').expect(200);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: account('GB'), reason: 'late' }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    await request(app).get('/api/v1/stats').expect(200);
  });

  it('documents error responses', async () => {
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).post('/api/v1/contracts').send({ client: account('GA'), freelancer: account('GA'), milestones: [1] }).expect(400);
    await request(app).get('/definitely-not-a-route').expect(404);
  });
});
