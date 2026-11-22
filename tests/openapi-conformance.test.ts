import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { z } from 'zod';
import { listQueryDocs, openapi, requestSchema } from '../src/openapi';
import {
  CancelBody,
  CREATE_CONTRACT_RULES,
  CreateContractBody,
  CreateTemplateBody,
  DeleteTemplateBody,
  DepositBody,
  DisputeBody,
  IdParam,
  ListQuery,
  RateBody,
  ResolveBody,
  TEMPLATE_RULES,
  TemplateOwnerQuery,
  UpdateTemplateBody,
} from '../src/validation/schemas';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import {
  assertConformance,
  compileSpecSchema,
  conformanceProblems,
  request,
  type ConformanceResponse,
} from './helpers/openapi';

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
  client: 'GA',
  freelancer: 'GB',
  token: 'XLM',
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
  it('keeps committed docs/openapi.json byte-for-byte equal to the served spec export', () => {
    const root = resolve(__dirname, '..');
    // Generate in a fresh process, not from Jest's cached import of src/openapi.
    // Deliberately set deployment-specific variables to prove the exporter
    // produces the canonical document regardless of a developer's local env.
    const generated = execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-e',
        'process.stdout.write(require("./scripts/export-openapi").generateOpenApiJson())',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          STELLAR_NETWORK: 'mainnet',
          ESCROW_CONTRACT_ID: 'ENV_OVERRIDE_MUST_NOT_LEAK_INTO_DOCS',
          TX_CACHE_MAX: '77',
        },
      },
    );

    expect(readFileSync(resolve(root, 'docs/openapi.json'), 'utf8')).toBe(generated);
  });

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
      .send({ client: 'GA', freelancer: 'GB', milestones: [{ title: 'Design', amount: 100 }, 50] })
      .expect(201);
    const id = created.body.id as number;
    await request(app).get(`/api/v1/contracts/${id}`).expect(200);
    await request(app).get('/api/v1/contracts?limit=5').expect(200);
    await request(app).post(`/api/v1/contracts/${id}/deposit`).send({ amount: 150 }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/milestones/0/release`).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/dispute`).send({ raisedBy: 'GB', reason: 'late' }).expect(200);
    await request(app).post(`/api/v1/contracts/${id}/resolve`).send({ freelancerBps: 5000 }).expect(200);
    await request(app).get('/api/v1/stats').expect(200);
  });

  it('documents error responses', async () => {
    await request(app).get('/api/v1/contracts/999').expect(404);
    await request(app).post('/api/v1/contracts').send({ client: 'GA', freelancer: 'GA', milestones: [1] }).expect(400);
    await request(app).get('/definitely-not-a-route').expect(404);
  });
});

// ── Request schemas are derived from the zod validators (#1719) ────────────────────────────────────

type RequestOperation = {
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Record<string, unknown> }>;
  requestBody?: { content?: Record<string, { schema?: Record<string, unknown> } | undefined> };
};
const components = (openapi as unknown as { components: { schemas: Record<string, Record<string, unknown>> } }).components
  .schemas;
const operation = (method: string, path: string) =>
  (paths[path] as unknown as Record<string, RequestOperation | undefined>)[method];
const resolveSchema = (schema: Record<string, unknown> | undefined) => {
  const ref = typeof schema?.$ref === 'string' ? /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)?.[1] : undefined;
  return ref ? components[ref] : schema;
};
const documentedBody = (method: string, path: string) =>
  resolveSchema(operation(method, path)?.requestBody?.content?.['application/json']?.schema);

const milestones = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `M${i}`, amount: 10 }));

type BodyCase = {
  op: string;
  zod: z.ZodType;
  /** Accepted by the zod validator, so they must also match the documented schema. */
  valid: unknown[];
  /** Rejected by the documented schema and by zod: the schema carries the constraint. */
  invalid: unknown[];
  /** Match the documented schema but fail a `.refine` rule; the description must name the rule. */
  refinements?: Array<{ body: unknown; message: string }>;
};

const bodyCases: BodyCase[] = [
  {
    op: 'post /api/v1/contracts',
    zod: CreateContractBody,
    valid: [
      { client: 'GA', freelancer: 'GB', milestones: [100, { title: 'Design', amount: '250' }] },
      { client: 'GA', freelancer: 'GB', milestones: milestones(20), token: 'USDC', fundingDeadline: '2027-01-01T00:00:00Z' },
      { client: 'GA', freelancer: 'GB', templateId: 3, budget: 1000 },
    ],
    invalid: [
      { client: 'GA', freelancer: 'GB', milestones: milestones(21) },
      { client: 'GA', freelancer: 'GB', milestones: [] },
      { client: 'GA', freelancer: 'GB', milestones: [0] },
      { client: 'GA', freelancer: 'GB', milestones: ['0100'] },
      { client: 'GA', freelancer: 'GB', milestones: [{ title: 'x'.repeat(121), amount: 1 }] },
      { client: 'GA', freelancer: 'GB', milestones: [1], extra: true },
      { freelancer: 'GB', milestones: [1] },
      { client: 'GA', freelancer: 'GB', templateId: 0 },
      { client: 'GA', freelancer: 'GB', milestones: [1], token: 'T'.repeat(65) },
    ],
    refinements: [
      { body: { client: 'GA', freelancer: 'GA', milestones: [1] }, message: CREATE_CONTRACT_RULES.distinctParties },
      { body: { client: 'GA', freelancer: 'GB', milestones: [1], templateId: 1 }, message: CREATE_CONTRACT_RULES.notBoth },
      { body: { client: 'GA', freelancer: 'GB' }, message: CREATE_CONTRACT_RULES.oneOf },
      { body: { client: 'GA', freelancer: 'GB', milestones: [1], budget: 5 }, message: CREATE_CONTRACT_RULES.budgetOnlyWithTemplate },
    ],
  },
  {
    op: 'post /api/v1/contracts/{id}/deposit',
    zod: DepositBody,
    valid: [{ amount: 150 }, { amount: '1' + '0'.repeat(38) }],
    invalid: [{}, { amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: '1' + '0'.repeat(39) }, { amount: 1, note: 'x' }],
  },
  {
    op: 'post /api/v1/contracts/{id}/dispute',
    zod: DisputeBody,
    valid: [{}, { raisedBy: 'GB' }, { raisedBy: 'GB', reason: 'late' }],
    invalid: [{ raisedBy: '' }, { reason: 'x'.repeat(1001) }, { raisedBy: 'GB', severity: 'high' }],
  },
  {
    op: 'post /api/v1/contracts/{id}/resolve',
    zod: ResolveBody,
    valid: [{ freelancerBps: 0 }, { freelancerBps: 10000 }],
    invalid: [{}, { freelancerBps: 10001 }, { freelancerBps: -1 }, { freelancerBps: 50.5 }],
  },
  {
    op: 'post /api/v1/contracts/{id}/reputation',
    zod: RateBody,
    valid: [{ rating: 1 }, { rating: 5 }],
    invalid: [{}, { rating: 0 }, { rating: 6 }, { rating: 4.5 }, { rating: 5, comment: 'great' }],
  },
  {
    op: 'post /api/v1/contracts/{id}/cancel',
    zod: CancelBody,
    valid: [{}],
    invalid: [{ reason: 'changed my mind' }],
  },
  {
    op: 'post /api/v1/templates',
    zod: CreateTemplateBody,
    valid: [
      { owner: 'GA', name: 'Three steps', mode: 'fixed', milestones: [{ amount: 100 }, { title: 'Final', amount: '200' }] },
      { owner: 'GA', name: 'Halves', mode: 'percent', milestones: [{ percentBps: 5000 }, { percentBps: 5000 }] },
    ],
    invalid: [
      { owner: 'GA', name: 'x', mode: 'fixed' },
      { owner: 'GA', name: 'x'.repeat(81), mode: 'fixed', milestones: [{ amount: 1 }] },
      { owner: 'GA', name: 'x', mode: 'hourly', milestones: [{ amount: 1 }] },
      { owner: 'GA', name: 'x', mode: 'percent', milestones: [{ percentBps: 10001 }] },
      { owner: 'GA', name: 'x', mode: 'fixed', milestones: Array.from({ length: 21 }, () => ({ amount: 1 })) },
    ],
    refinements: [
      { body: { owner: 'GA', name: 'x', mode: 'fixed', milestones: [{ percentBps: 10000 }] }, message: TEMPLATE_RULES.matchMode },
      { body: { owner: 'GA', name: 'x', mode: 'percent', milestones: [{ percentBps: 4000 }] }, message: TEMPLATE_RULES.percentSum },
    ],
  },
  {
    op: 'put /api/v1/templates/{id}',
    zod: UpdateTemplateBody,
    valid: [{ owner: 'GA' }, { owner: 'GA', name: 'Renamed' }, { owner: 'GA', mode: 'fixed', milestones: [{ amount: 1 }] }],
    invalid: [{ name: 'Renamed' }, { owner: 'GA', name: '' }, { owner: 'GA', milestones: [] }],
    refinements: [
      { body: { owner: 'GA', milestones: [{ amount: 1 }, { percentBps: 10000 }] }, message: TEMPLATE_RULES.updateNoMix },
    ],
  },
  {
    op: 'delete /api/v1/templates/{id}',
    zod: DeleteTemplateBody,
    valid: [{ owner: 'GA' }],
    invalid: [{}, { owner: '' }, { owner: 'GA', force: true }],
  },
];

describe('request schemas match their zod validators', () => {
  describe.each(bodyCases)('$op', ({ op, zod, valid, invalid, refinements }) => {
    const [method, path] = op.split(' ');

    it('documents exactly the schema generated from the validator', () => {
      expect(documentedBody(method, path)).toEqual(requestSchema(zod));
    });

    it('accepts, in both, what the validator accepts', () => {
      const documented = compileSpecSchema(documentedBody(method, path)!);
      for (const body of valid) {
        expect(zod.safeParse(body).success).toBe(true);
        expect({ body, errors: documented(body) ? null : documented.errors }).toEqual({ body, errors: null });
      }
    });

    it('rejects, in both, what the schema constrains', () => {
      const documented = compileSpecSchema(documentedBody(method, path)!);
      for (const body of invalid) {
        expect({ body, zod: zod.safeParse(body).success }).toEqual({ body, zod: false });
        expect({ body, documented: documented(body) }).toEqual({ body, documented: false });
      }
    });

    if (refinements) {
      it('names every rule the schema cannot express in the operation description', () => {
        const documented = compileSpecSchema(documentedBody(method, path)!);
        const description = operation(method, path)?.description ?? '';
        for (const { body, message } of refinements) {
          expect({ body, documented: documented(body) }).toEqual({ body, documented: true });
          const result = zod.safeParse(body);
          expect(result.success).toBe(false);
          expect(result.error?.issues.map((i) => i.message)).toContain(message);
          expect(description).toContain(message);
        }
      });
    }
  });

  it('follows a changed zod limit without editing openapi.ts', () => {
    // Load the spec against a validator module whose limits differ: 1–10 stars, 25 milestones.
    let spec: { components: { schemas: Record<string, any> } } | undefined;
    jest.isolateModules(() => {
      jest.doMock('../src/validation/schemas', () => {
        const actual = jest.requireActual('../src/validation/schemas');
        const { z: zod } = jest.requireActual('zod');
        return {
          ...actual,
          RateBody: zod.object({ rating: zod.number().int().min(1).max(10) }).strict(),
          Milestones: zod.array(actual.MilestoneItem).min(1).max(25),
        };
      });
      spec = require('../src/openapi').openapi;
    });
    jest.dontMock('../src/validation/schemas');
    expect(spec!.components.schemas.RateRequest.properties.rating.maximum).toBe(10);
    expect(components.RateRequest).toMatchObject({ properties: { rating: { maximum: 5 } } });
    const patch = (spec as any).paths['/api/v1/contracts/{id}'].patch.requestBody.content['application/json'].schema;
    expect(patch.properties.milestones.maxItems).toBe(25);
  });

  it('documents the path id parameter from IdParam on every contract operation', () => {
    const generatedId = (requestSchema(IdParam) as { properties: { id: object } }).properties.id;
    for (const [path, item] of Object.entries(paths)) {
      if (!path.startsWith('/api/v1/contracts/{id}')) continue;
      for (const op of Object.values(item as unknown as Record<string, RequestOperation>)) {
        const id = op.parameters?.find((p) => p.in === 'path' && p.name === 'id');
        if (id) expect({ path, schema: id.schema }).toEqual({ path, schema: generatedId });
      }
    }
  });

  it('documents exactly the ListQuery keys as GET /contracts query parameters', () => {
    const params = operation('get', '/api/v1/contracts')?.parameters ?? [];
    const queryNames = params.filter((p) => p.in === 'query').map((p) => p.name);
    expect(queryNames.sort()).toEqual(Object.keys(ListQuery.shape).sort());
    expect(Object.keys(listQueryDocs).filter((k) => !(k in ListQuery.shape))).toEqual([]);
    // Every value the spec enumerates for a route-checked parameter passes the validator.
    for (const p of params) {
      for (const value of (p.schema?.enum as unknown[] | undefined) ?? []) {
        expect({ [p.name]: ListQuery.safeParse({ [p.name]: String(value) }).success }).toEqual({ [p.name]: true });
      }
    }
    expect(params.find((p) => p.name === 'party')?.schema).toMatchObject({ maxLength: 64 });
    expect(ListQuery.safeParse({ party: 'x'.repeat(65) }).success).toBe(false);
    expect(ListQuery.safeParse({ nope: '1' }).success).toBe(false);
  });

  it('documents GET /templates owner from TemplateOwnerQuery', () => {
    const params = operation('get', '/api/v1/templates')?.parameters ?? [];
    expect(params).toEqual([{ name: 'owner', in: 'query', required: true, schema: { type: 'string', minLength: 1 } }]);
    expect(TemplateOwnerQuery.safeParse({ owner: '' }).success).toBe(false);
  });
});
