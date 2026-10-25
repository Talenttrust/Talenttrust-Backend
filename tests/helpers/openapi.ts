/**
 * OpenAPI conformance harness.
 *
 * Wraps supertest so that every response produced by the test suite is checked
 * against the published spec (`src/openapi.ts`) for its path, method, status,
 * content type and body schema. An undocumented path or status, or a body that
 * does not match the documented schema, fails the test with a readable diff.
 *
 * OpenAPI 3.0 → JSON Schema conversion applied before handing schemas to Ajv:
 *   - `nullable: true` becomes `type: [T, 'null']`
 *   - boolean `exclusiveMinimum` / `exclusiveMaximum` become numeric
 *   - `$ref: '#/components/schemas/X'` is rewritten to a standalone resource
 *     so Ajv can resolve component schemas through `addSchema`
 *   - OAS-only keywords (`example`, `xml`, `discriminator`, …) are dropped
 */

import originalRequest from 'supertest';
import type { Application } from 'express';
import Ajv, { type AnySchema, type ErrorObject, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { openapi } from '../../src/openapi';

// ── Spec model ────────────────────────────────────────────────────────────────────────────────────

type SchemaObject = Record<string, unknown>;

interface ResponseObject {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: SchemaObject } | undefined>;
}

interface OperationObject {
  responses?: Record<string, ResponseObject | undefined>;
}

interface SpecDocument {
  paths: Record<string, Record<string, OperationObject> | undefined>;
  components: {
    schemas: Record<string, SchemaObject>;
    responses?: Record<string, ResponseObject | undefined>;
  };
}

const spec = openapi as unknown as SpecDocument;

// ── OpenAPI 3.0 → JSON Schema ─────────────────────────────────────────────────────────────────────

const COMPONENTS_RESOURCE = 'https://talenttrust.local/openapi-components.json';
const OAS_ONLY_KEYWORDS = new Set([
  'example',
  'examples',
  'xml',
  'externalDocs',
  'discriminator',
  'summary',
  'deprecated',
]);

function rewriteRef(ref: string): string {
  const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref);
  return match ? `${COMPONENTS_RESOURCE}#/definitions/${match[1]}` : ref;
}

function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'nullable' || OAS_ONLY_KEYWORDS.has(key)) continue;
    if (key === '$ref') {
      target.$ref = rewriteRef(String(value));
      continue;
    }
    target[key] = toJsonSchema(value);
  }

  if (source.nullable === true && typeof target.type === 'string') {
    target.type = [target.type, 'null'];
  }
  if (target.exclusiveMinimum === true) {
    target.exclusiveMinimum = target.minimum;
    delete target.minimum;
  }
  if (target.exclusiveMaximum === true) {
    target.exclusiveMaximum = target.maximum;
    delete target.maximum;
  }
  return target;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({
  $id: COMPONENTS_RESOURCE,
  definitions: toJsonSchema(spec.components.schemas) as Record<string, SchemaObject>,
});

// ── Path / response lookup ────────────────────────────────────────────────────────────────────────

// Query strings are not part of the path template.
const pathSegments = (path: string): string[] =>
  path
    .split('?')[0]
    .split('/')
    .filter((s) => s.length > 0);

function pathMatches(template: string, actual: string): boolean {
  const expected = pathSegments(template);
  const received = pathSegments(actual);
  if (expected.length !== received.length) return false;
  return expected.every(
    (segment, i) => (segment.startsWith('{') && segment.endsWith('}')) || segment === received[i],
  );
}

const templateParams = (template: string): number =>
  pathSegments(template).filter((s) => s.startsWith('{')).length;

function findSpecPath(actual: string): string | undefined {
  return Object.keys(spec.paths)
    .filter((template) => pathMatches(template, actual))
    .sort((a, b) => templateParams(a) - templateParams(b))[0];
}

/** Follows `#/components/responses/…` so operation-level `$ref`s stay usable. */
function resolveResponse(responseDoc: ResponseObject): ResponseObject {
  if (!responseDoc.$ref) return responseDoc;
  const name = /^#\/components\/responses\/([^/]+)$/.exec(responseDoc.$ref)?.[1];
  return (name ? spec.components.responses?.[name] : undefined) ?? responseDoc;
}

const validatorCache = new Map<string, ValidateFunction | null>();

function validatorFor(key: string, schema: SchemaObject | undefined): ValidateFunction | null {
  if (!validatorCache.has(key)) {
    validatorCache.set(key, schema ? ajv.compile(toJsonSchema(schema) as AnySchema) : null);
  }
  return validatorCache.get(key) ?? null;
}

function selectContent(
  responseDoc: ResponseObject,
  contentType: string | undefined,
): { name: string; schema?: SchemaObject } | undefined {
  const content = responseDoc.content;
  if (!content) return undefined;
  const names = Object.keys(content);
  if (contentType) {
    const exact = names.find((name) => contentType.toLowerCase().startsWith(name.toLowerCase()));
    if (exact) return { name: exact, schema: content[exact]?.schema };
  }
  if (names.length === 1) return { name: names[0], schema: content[names[0]]?.schema };
  return undefined;
}

// ── Validation ────────────────────────────────────────────────────────────────────────────────────

export interface ConformanceResponse {
  status: number;
  headers?: unknown;
  body?: unknown;
  text?: string;
}

function responseContentType(response: ConformanceResponse): string | undefined {
  const headers = response.headers as Record<string, unknown> | undefined;
  const value = headers?.['content-type'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function responseBody(response: ConformanceResponse, contentType: string): unknown {
  if (contentType.toLowerCase().includes('json')) return response.body;
  return response.text;
}

function truncate(value: string, max = 400): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      const at = error.instancePath || '/';
      let detail = error.message ?? 'is invalid';
      if (error.keyword === 'required') {
        const params = error.params as { missingProperty?: string };
        detail = `missing required property '${params.missingProperty}'`;
      } else if (error.keyword === 'additionalProperties') {
        const params = error.params as { additionalProperty?: string };
        detail = `unexpected property '${params.additionalProperty}'`;
      }
      return `  - ${at}: ${detail}`;
    })
    .join('\n');
}

/**
 * Returns every way `response` deviates from the published spec for
 * `method`/`path`. An empty array means the response is conformant.
 */
export function conformanceProblems(
  response: ConformanceResponse,
  method: string,
  path: string,
): string[] {
  const verb = method.toUpperCase();
  const contentType = responseContentType(response);
  const status = String(response.status);
  const problems: string[] = [];

  const validateBody = (responseDoc: ResponseObject, context: string): void => {
    const selected = selectContent(responseDoc, contentType);
    if (!selected) {
      if (responseDoc.content && contentType) {
        problems.push(
          `${context}: content-type '${contentType}' is not documented ` +
            `(documented: ${Object.keys(responseDoc.content).join(', ') || 'none'})`,
        );
      }
      return;
    }
    if (!selected.schema) return;
    const validate = validatorFor(`${context} ${selected.name}`, selected.schema);
    const body = responseBody(response, selected.name);
    if (!validate || !validate(body)) {
      problems.push(
        `${context}: body does not match the documented schema ` +
          `(#/components/schemas is referenced through the response content)\n` +
          `${formatErrors(validate?.errors)}\n` +
          `  received: ${truncate(JSON.stringify(body))}`,
      );
    }
  };

  const specPath = findSpecPath(path);
  if (!specPath) {
    // Undocumented path: only the documented global 404 is allowed to escape.
    const notFound = spec.components.responses?.NotFound;
    if (response.status !== 404 || !notFound) {
      problems.push(
        `path '${path}' is not documented in the OpenAPI spec and returned ` +
          `${response.status} (an undocumented path may only return the documented 404)`,
      );
      return problems;
    }
    validateBody(notFound, `${verb} ${path} → 404`);
    return problems;
  }

  const operation = spec.paths[specPath]?.[method.toLowerCase()];
  if (!operation) {
    problems.push(
      `${verb} ${specPath} is not documented in the OpenAPI spec ` +
        `(documented: ${Object.keys(spec.paths[specPath] ?? {}).join(', ') || 'none'})`,
    );
    return problems;
  }

  const responses = operation.responses ?? {};
  const declared = responses[status] ?? responses.default;
  if (!declared) {
    const documented = Object.keys(responses)
      .filter((code) => code !== 'default')
      .sort()
      .join(', ');
    problems.push(
      `${verb} ${specPath} returned ${response.status}, which is not documented ` +
        `(documented: ${documented || 'none'})`,
    );
    return problems;
  }
  const responseDoc = resolveResponse(declared);

  validateBody(responseDoc, `${verb} ${specPath} → ${response.status}`);
  return problems;
}

/** Throws a readable error when `response` deviates from the published spec. */
export function assertConformance(
  response: ConformanceResponse,
  method: string,
  path: string,
): void {
  const problems = conformanceProblems(response, method, path);
  if (problems.length > 0) {
    throw new Error(
      `OpenAPI conformance failure for ${method.toUpperCase()} ${path} → ${response.status}\n` +
        problems.map((problem) => `  ${problem}`).join('\n'),
    );
  }
}

// ── supertest wrapper ─────────────────────────────────────────────────────────────────────────────

/** The supertest response shape tests consume (`.status`, `.body`, …). */
export interface ConformanceResult {
  status: number;
  body: any;
  text: string;
  headers: Record<string, any>;
}

/** A supertest request whose awaited response is validated against the spec. */
export class ConformanceTest {
  constructor(
    private readonly test: unknown,
    private readonly method: string,
    private readonly path: string,
  ) {}

  send(body: unknown): this {
    (this.test as { send: (value: unknown) => unknown }).send(body);
    return this;
  }

  set(field: string, value: string): this {
    (this.test as { set: (f: string, v: string) => unknown }).set(field, value);
    return this;
  }

  query(params: Record<string, unknown>): this {
    (this.test as { query: (value: unknown) => unknown }).query(params);
    return this;
  }

  expect(...args: unknown[]): this {
    (this.test as { expect: (...values: unknown[]) => unknown }).expect(...args);
    return this;
  }

  private run(): Promise<ConformanceResult> {
    return Promise.resolve()
      .then(() => (this.test as PromiseLike<ConformanceResponse>).then())
      .then((response) => {
        assertConformance(response, this.method, this.path);
        return response as unknown as ConformanceResult;
      });
  }

  then(
    onfulfilled?: ((value: ConformanceResult) => unknown) | null,
    onrejected?: ((reason: unknown) => unknown) | null,
  ): Promise<ConformanceResult> {
    return this.run().then(onfulfilled ?? undefined, onrejected ?? undefined) as Promise<
      ConformanceResult
    >;
  }

  catch(onrejected?: ((reason: unknown) => unknown) | null): Promise<unknown> {
    return this.run().catch(onrejected ?? undefined);
  }
}

export interface ConformanceClient {
  get(path: string): ConformanceTest;
  post(path: string): ConformanceTest;
  put(path: string): ConformanceTest;
  patch(path: string): ConformanceTest;
  delete(path: string): ConformanceTest;
  head(path: string): ConformanceTest;
}

/** Drop-in replacement for supertest's `request(app)` with conformance checking. */
export function request(app: Application): ConformanceClient {
  const agent = originalRequest(app) as unknown as Record<string, (path: string) => unknown>;
  const verb =
    (name: string) =>
    (path: string): ConformanceTest =>
      new ConformanceTest(agent[name](path), name, path);
  return {
    get: verb('get'),
    post: verb('post'),
    put: verb('put'),
    patch: verb('patch'),
    delete: verb('delete'),
    head: verb('head'),
  };
}
