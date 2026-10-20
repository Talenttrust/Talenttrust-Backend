import request from 'supertest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { openapi } from '../../src/openapi';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

function toJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  const out: any = { ...schema };
  if (schema.type && schema.nullable) {
    const t = schema.type;
    out.type = Array.isArray(t) ? Array.from(new Set([...t, 'null'])) : [t, 'null'];
    delete out.nullable;
  }
  if (out.properties) {
    const props: any = {};
    for (const k of Object.keys(out.properties)) {
      props[k] = toJsonSchema(out.properties[k]);
    }
    out.properties = props;
  }
  if (out.items) out.items = toJsonSchema(out.items);
  if (out.additionalProperties && typeof out.additionalProperties === 'object') {
    out.additionalProperties = toJsonSchema(out.additionalProperties);
  }
  if (out.oneOf) out.oneOf = out.oneOf.map(toJsonSchema);
  if (out.anyOf) out.anyOf = out.anyOf.map(toJsonSchema);
  if (out.allOf) out.allOf = out.allOf.map(toJsonSchema);
  if (out.$ref) {
    // Keep $ref as is; ajv will resolve if added
  }
  return out;
}

const components = (openapi as any).components || {};
if (components.schemas) {
  for (const [name, schema] of Object.entries(components.schemas)) {
    ajv.addSchema(toJsonSchema(schema), `#/components/schemas/${name}`);
  }
}

function compile(schema: any) {
  try {
    return ajv.compile(toJsonSchema(schema));
  } catch (e) {
    return ajv.compile(schema);
  }
}

function matchPath(pattern: string, actual: string): boolean {
  if (pattern === actual) return true;
  const p = pattern.split('/').filter(Boolean);
  const a = actual.split('/').filter(Boolean);
  if (p.length !== a.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith('{') && p[i].endsWith('}')) continue;
    if (p[i] !== a[i]) return false;
  }
  return true;
}

const paths = (openapi as any).paths || {};

function getOp(path: string, method: Method) {
  for (const [pattern, obj] of Object.entries(paths)) {
    if (matchPath(pattern, path) && (obj as any)[method]) return (obj as any)[method];
  }
  return null;
}

function getResponseSchema(op: any, status: number) {
  const resp = op?.responses?.[String(status)] || op?.responses?.[status];
  if (!resp?.content?.['application/json']?.schema) return null;
  return resp.content['application/json'].schema;
}

const validators = new Map<string, (data: any) => boolean>();

function validateResponse(path: string, method: Method, status: number, body: any) {
  // Normalize paths like /docs/ if needed
  let checkPath = path;
  if (checkPath.endsWith('/') && checkPath.length > 1 && !checkPath.match(/\/\{[^}]+\}$/)) {
    checkPath = checkPath.slice(0, -1);
  }
  const op = getOp(checkPath, method) || getOp(path, method);
  // Allow undocumented routes (like /nope) - just don't validate against OpenAPI
  if (!op) return;
  const schema = getResponseSchema(op, status);
  if (!schema) return; // Don't fail if status not documented
  const key = `${method}:${checkPath}:${status}`;
  let v = validators.get(key);
  if (!v) {
    v = compile(schema);
    validators.set(key, v);
  }
  const valid = v(body);
  if (!valid) {
    const errors = (v as any).errors || [];
    throw new Error(`OpenAPI response schema mismatch for ${method.toUpperCase()} ${path} -> ${status}\n${JSON.stringify(errors, null, 2)}\nBody: ${JSON.stringify(body)}`);
  }
}

export function withOpenApiValidation(app: any) {
  const agent: any = request(app);
  const methods: Method[] = ['get', 'post', 'put', 'patch', 'delete'];
  const orig: any = {};
  for (const m of methods) {
    orig[m] = agent[m].bind(agent);
    (agent as any)[m] = function (url: string, ...args: any[]) {
      const test = orig[m](url, ...args);
      const origEnd = test.end.bind(test);
      test.end = function (fn?: any) {
        return origEnd((err: any, res: any) => {
          try {
            if (res) {
              const ct = res.headers?.['content-type'] || res.headers?.['Content-Type'] || '';
              if (ct.includes('application/json')) {
                validateResponse(res.req?.path || res.request?.path || url, m, res.statusCode || res.status, res.body);
              }
            }
          } catch (e: any) {
            if (fn) return fn(e);
            throw e;
          }
          if (fn) return fn(err, res);
        });
      };
      // Also override then for promises
      const origThen = test.then;
      if (origThen) {
        test.then = function (onFulfilled?: any, onRejected?: any) {
          return origThen.call(
            this,
            (res: any) => {
              try {
                if (res) {
                  const ct = res.headers?.['content-type'] || res.headers?.['Content-Type'] || '';
                  if (ct.includes('application/json')) {
                    validateResponse(res.req?.path || res.request?.path || url, m, res.statusCode || res.status, res.body);
                  }
                }
              } catch (e: any) {
                if (onRejected) return onRejected(e);
                throw e;
              }
              if (onFulfilled) return onFulfilled(res);
              return res;
            },
            onRejected,
          );
        };
      }
      return test;
    };
  }
  return agent;
}

export { validateResponse };
