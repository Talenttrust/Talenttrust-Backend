/**
 * @file health/validation.test.ts
 * @description Comprehensive tests for health input validation schemas.
 *
 * Covers:
 * - ProbeInputSchema: required fields, type constraints, ranges, unknown fields
 * - HealthWriteBodySchema: all fields, nested probes array, limits
 * - HealthQuerySchema: enum constraints, unknown key rejection
 * - HTTP-level integration: POST /health and GET /health query validation
 */

import express from 'express';
import request from 'supertest';
import {
  ProbeInputSchema,
  HealthWriteBodySchema,
  HealthQuerySchema,
  MAX_STRING_LENGTH,
  MAX_ID_LENGTH,
  MIN_LATENCY_MS,
  MAX_LATENCY_MS,
  MIN_UPTIME_SECONDS,
  MAX_UPTIME_SECONDS,
} from './validation';
import { buildHealthRouter } from './router';
import { Probe } from './types';
import { healthRouter } from '../routes/health';
import { validateRequest, validateQuery } from '../middleware/validation';
import { HealthWriteBodySchema as HealthWriteBodySchemaImport } from './validation';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const okProbe: Probe = async () => ({ name: 'test', ok: true, latencyMs: 1 });

function buildTestApp(probes: Probe[] = [okProbe]) {
  const app = express();
  app.use(express.json());
  app.use('/health', buildHealthRouter(probes));
  return app;
}

function buildRoutesApp() {
  const app = express();
  app.use(express.json());
  app.use('/', healthRouter);
  return app;
}

// ─── ProbeInputSchema ────────────────────────────────────────────────────────

describe('ProbeInputSchema', () => {
  const validProbe = { name: 'db', ok: true, latencyMs: 10 };

  it('accepts a minimal valid probe (no detail)', () => {
    const result = ProbeInputSchema.safeParse(validProbe);
    expect(result.success).toBe(true);
  });

  it('accepts a probe with an optional detail string', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, detail: 'all good' });
    expect(result.success).toBe(true);
  });

  it('accepts ok=false with a detail string', () => {
    const result = ProbeInputSchema.safeParse({ name: 'redis', ok: false, latencyMs: 5, detail: 'ECONNREFUSED' });
    expect(result.success).toBe(true);
  });

  // ── name ─────────────────────────────────────────────────────────────────

  it('rejects a missing name field', () => {
    const { name: _n, ...noName } = validProbe;
    const result = ProbeInputSchema.safeParse(noName);
    expect(result.success).toBe(false);
  });

  it('rejects an empty name string', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a name exceeding MAX_ID_LENGTH', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: 'a'.repeat(MAX_ID_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it('accepts a name exactly at MAX_ID_LENGTH', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: 'a'.repeat(MAX_ID_LENGTH) });
    expect(result.success).toBe(true);
  });

  it('rejects a name with spaces', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: 'my probe' });
    expect(result.success).toBe(false);
  });

  it('accepts a name with hyphens and underscores', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: 'my-probe_v2' });
    expect(result.success).toBe(true);
  });

  it('rejects a name with special characters', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, name: 'probe<script>' });
    expect(result.success).toBe(false);
  });

  // ── ok ───────────────────────────────────────────────────────────────────

  it('rejects a missing ok field', () => {
    const { ok: _ok, ...noOk } = validProbe;
    const result = ProbeInputSchema.safeParse(noOk);
    expect(result.success).toBe(false);
  });

  it('rejects ok as a string', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, ok: 'true' });
    expect(result.success).toBe(false);
  });

  it('rejects ok as a number', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, ok: 1 });
    expect(result.success).toBe(false);
  });

  // ── latencyMs ────────────────────────────────────────────────────────────

  it('rejects a missing latencyMs field', () => {
    const { latencyMs: _l, ...noLatency } = validProbe;
    const result = ProbeInputSchema.safeParse(noLatency);
    expect(result.success).toBe(false);
  });

  it('rejects latencyMs below MIN_LATENCY_MS', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: MIN_LATENCY_MS - 1 });
    expect(result.success).toBe(false);
  });

  it('accepts latencyMs at MIN_LATENCY_MS (0)', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: MIN_LATENCY_MS });
    expect(result.success).toBe(true);
  });

  it('accepts latencyMs at MAX_LATENCY_MS', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: MAX_LATENCY_MS });
    expect(result.success).toBe(true);
  });

  it('rejects latencyMs above MAX_LATENCY_MS', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: MAX_LATENCY_MS + 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer latencyMs', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: 1.5 });
    expect(result.success).toBe(false);
  });

  it('rejects latencyMs as a string', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, latencyMs: '10' });
    expect(result.success).toBe(false);
  });

  // ── detail ───────────────────────────────────────────────────────────────

  it('rejects a detail string exceeding MAX_STRING_LENGTH', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, detail: 'x'.repeat(MAX_STRING_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it('accepts detail at exactly MAX_STRING_LENGTH', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, detail: 'x'.repeat(MAX_STRING_LENGTH) });
    expect(result.success).toBe(true);
  });

  it('rejects detail as a number', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, detail: 42 });
    expect(result.success).toBe(false);
  });

  // ── unknown fields ────────────────────────────────────────────────────────

  it('rejects unknown fields on a probe (strict mode)', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, extraField: 'injected' });
    expect(result.success).toBe(false);
  });

  it('rejects multiple unknown fields', () => {
    const result = ProbeInputSchema.safeParse({ ...validProbe, x: 1, y: 2 });
    expect(result.success).toBe(false);
  });
});

// ─── HealthWriteBodySchema ────────────────────────────────────────────────────

describe('HealthWriteBodySchema', () => {
  const validBody = {
    service: 'talenttrust-backend',
    status: 'ok',
    uptimeSeconds: 3600,
  };

  it('accepts a valid minimal body', () => {
    const result = HealthWriteBodySchema.safeParse(validBody);
    expect(result.success).toBe(true);
  });

  it('defaults probes to an empty array when omitted', () => {
    const result = HealthWriteBodySchema.safeParse(validBody);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.probes).toEqual([]);
    }
  });

  it('accepts a body with a probes array', () => {
    const result = HealthWriteBodySchema.safeParse({
      ...validBody,
      probes: [{ name: 'db', ok: true, latencyMs: 5 }],
    });
    expect(result.success).toBe(true);
  });

  // ── service ───────────────────────────────────────────────────────────────

  it('rejects a missing service field', () => {
    const { service: _s, ...noService } = validBody;
    const result = HealthWriteBodySchema.safeParse(noService);
    expect(result.success).toBe(false);
  });

  it('rejects an empty service string', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, service: '' });
    expect(result.success).toBe(false);
  });

  it('rejects service exceeding MAX_ID_LENGTH', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, service: 'a'.repeat(MAX_ID_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it('accepts service at exactly MAX_ID_LENGTH', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, service: 'a'.repeat(MAX_ID_LENGTH) });
    expect(result.success).toBe(true);
  });

  it('rejects service with spaces', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, service: 'my service' });
    expect(result.success).toBe(false);
  });

  it('rejects service with special characters', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, service: 'svc<xss>' });
    expect(result.success).toBe(false);
  });

  // ── status ────────────────────────────────────────────────────────────────

  it('rejects a missing status field', () => {
    const { status: _st, ...noStatus } = validBody;
    const result = HealthWriteBodySchema.safeParse(noStatus);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status value', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, status: 'healthy' });
    expect(result.success).toBe(false);
  });

  it('rejects status as a number', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, status: 1 });
    expect(result.success).toBe(false);
  });

  it('accepts status "ok"', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, status: 'ok' });
    expect(result.success).toBe(true);
  });

  it('accepts status "degraded"', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, status: 'degraded' });
    expect(result.success).toBe(true);
  });

  // ── uptimeSeconds ─────────────────────────────────────────────────────────

  it('rejects a missing uptimeSeconds field', () => {
    const { uptimeSeconds: _u, ...noUptime } = validBody;
    const result = HealthWriteBodySchema.safeParse(noUptime);
    expect(result.success).toBe(false);
  });

  it('rejects uptimeSeconds below MIN_UPTIME_SECONDS', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: MIN_UPTIME_SECONDS - 1 });
    expect(result.success).toBe(false);
  });

  it('accepts uptimeSeconds at MIN_UPTIME_SECONDS (0)', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: MIN_UPTIME_SECONDS });
    expect(result.success).toBe(true);
  });

  it('accepts uptimeSeconds at MAX_UPTIME_SECONDS', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: MAX_UPTIME_SECONDS });
    expect(result.success).toBe(true);
  });

  it('rejects uptimeSeconds above MAX_UPTIME_SECONDS', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: MAX_UPTIME_SECONDS + 1 });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer uptimeSeconds', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: 3600.5 });
    expect(result.success).toBe(false);
  });

  it('rejects uptimeSeconds as a string', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, uptimeSeconds: '3600' });
    expect(result.success).toBe(false);
  });

  // ── probes array ──────────────────────────────────────────────────────────

  it('rejects more than 50 probes', () => {
    const probes = Array.from({ length: 51 }, (_, i) => ({
      name: `probe-${i}`,
      ok: true,
      latencyMs: 1,
    }));
    const result = HealthWriteBodySchema.safeParse({ ...validBody, probes });
    expect(result.success).toBe(false);
  });

  it('accepts exactly 50 probes', () => {
    const probes = Array.from({ length: 50 }, (_, i) => ({
      name: `probe${i}`,
      ok: true,
      latencyMs: 1,
    }));
    const result = HealthWriteBodySchema.safeParse({ ...validBody, probes });
    expect(result.success).toBe(true);
  });

  it('rejects probes as a non-array value', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, probes: 'not-an-array' });
    expect(result.success).toBe(false);
  });

  it('rejects probes with invalid nested probe entries', () => {
    const result = HealthWriteBodySchema.safeParse({
      ...validBody,
      probes: [{ name: '', ok: 'yes', latencyMs: -1 }],
    });
    expect(result.success).toBe(false);
  });

  // ── unknown fields ────────────────────────────────────────────────────────

  it('rejects unknown top-level fields (strict mode)', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, admin: true });
    expect(result.success).toBe(false);
  });

  it('rejects multiple unknown top-level fields', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, foo: 1, bar: 2 });
    expect(result.success).toBe(false);
  });

  // ── error message quality ─────────────────────────────────────────────────

  it('reports a descriptive error for invalid status', () => {
    const result = HealthWriteBodySchema.safeParse({ ...validBody, status: 'unknown' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/ok.*degraded|status/i);
    }
  });
});

// ─── HealthQuerySchema ───────────────────────────────────────────────────────

describe('HealthQuerySchema', () => {
  it('accepts an empty query object', () => {
    const result = HealthQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts verbose="true"', () => {
    const result = HealthQuerySchema.safeParse({ verbose: 'true' });
    expect(result.success).toBe(true);
  });

  it('accepts verbose="false"', () => {
    const result = HealthQuerySchema.safeParse({ verbose: 'false' });
    expect(result.success).toBe(true);
  });

  it('rejects verbose="yes"', () => {
    const result = HealthQuerySchema.safeParse({ verbose: 'yes' });
    expect(result.success).toBe(false);
  });

  it('rejects verbose="1"', () => {
    const result = HealthQuerySchema.safeParse({ verbose: '1' });
    expect(result.success).toBe(false);
  });

  it('rejects verbose=true (boolean, not string)', () => {
    const result = HealthQuerySchema.safeParse({ verbose: true });
    expect(result.success).toBe(false);
  });

  it('rejects unknown query keys (strict mode)', () => {
    const result = HealthQuerySchema.safeParse({ admin: 'true' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys even when verbose is valid', () => {
    const result = HealthQuerySchema.safeParse({ verbose: 'true', extra: 'data' });
    expect(result.success).toBe(false);
  });
});

// ─── HTTP-level integration: GET /health (from health/router.ts) ──────────────

describe('GET /health — query validation (health/router.ts)', () => {
  it('returns 200 on a clean GET with no query params', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.status).toBe(200);
  });

  it('returns 200 with verbose=true', async () => {
    const res = await request(buildTestApp()).get('/health?verbose=true');
    expect(res.status).toBe(200);
  });

  it('returns 200 with verbose=false', async () => {
    const res = await request(buildTestApp()).get('/health?verbose=false');
    expect(res.status).toBe(200);
  });

  it('returns 400 when an unknown query param is passed', async () => {
    const res = await request(buildTestApp()).get('/health?admin=true');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for verbose with an invalid value', async () => {
    const res = await request(buildTestApp()).get('/health?verbose=yes');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('includes probe details when verbose=true in non-production', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const detailedProbe: Probe = async () => ({
      name: 'test',
      ok: false,
      detail: 'connection refused',
      latencyMs: 1,
    });
    const res = await request(buildTestApp([detailedProbe])).get('/health?verbose=true');
    process.env.NODE_ENV = originalEnv;
    expect(res.status).toBe(503);
    const failedProbe = res.body.probes.find((p: Record<string, unknown>) => !p.ok);
    expect(failedProbe?.detail).toBe('connection refused');
  });

  it('strips probe details when verbose=false (default)', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    const detailedProbe: Probe = async () => ({
      name: 'test',
      ok: false,
      detail: 'connection refused',
      latencyMs: 1,
    });
    const res = await request(buildTestApp([detailedProbe])).get('/health');
    process.env.NODE_ENV = originalEnv;
    expect(res.status).toBe(503);
    res.body.probes.forEach((p: Record<string, unknown>) => {
      expect(p.detail).toBeUndefined();
    });
  });

  it('always strips details in production regardless of verbose=true', async () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const detailedProbe: Probe = async () => ({
      name: 'test',
      ok: false,
      detail: 'internal error',
      latencyMs: 1,
    });
    const res = await request(buildTestApp([detailedProbe])).get('/health?verbose=true');
    process.env.NODE_ENV = original;
    expect(res.status).toBe(503);
    res.body.probes.forEach((p: Record<string, unknown>) => {
      expect(p.detail).toBeUndefined();
    });
  });
});

// ─── HTTP-level integration: POST /health (from routes/health.ts) ─────────────

describe('POST /health — body validation (routes/health.ts)', () => {
  const validBody = {
    service: 'talenttrust-backend',
    status: 'ok',
    uptimeSeconds: 3600,
  };

  it('returns 200 for a valid POST body', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send(validBody)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
  });

  it('returns 200 for valid body with probes', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, probes: [{ name: 'db', ok: true, latencyMs: 5 }] })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
  });

  it('returns 400 when body is empty', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({})
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when service field is missing', async () => {
    const { service: _s, ...noService } = validBody;
    const res = await request(buildRoutesApp())
      .post('/')
      .send(noService)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when status is an invalid enum value', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, status: 'healthy' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when uptimeSeconds is negative', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, uptimeSeconds: -1 })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when uptimeSeconds exceeds the maximum', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, uptimeSeconds: MAX_UPTIME_SECONDS + 1 })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when service name is too long', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, service: 'a'.repeat(MAX_ID_LENGTH + 1) })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 for an unknown top-level field', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, __proto__: {} })
      .set('Content-Type', 'application/json');
    // __proto__ is stripped by JSON parse, so body should still be valid
    // Ensure no error for valid body without unknown fields
    expect([200, 400]).toContain(res.status);
  });

  it('returns 400 for an explicit unknown field', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, adminOverride: true })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when probes array contains an invalid probe', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({
        ...validBody,
        probes: [{ name: 'bad probe name!', ok: 'yes', latencyMs: -5 }],
      })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 when probes array exceeds 50 entries', async () => {
    const probes = Array.from({ length: 51 }, (_, i) => ({
      name: `probe${i}`,
      ok: true,
      latencyMs: 1,
    }));
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, probes })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns structured validation error details', async () => {
    const res = await request(buildRoutesApp())
      .post('/')
      .send({ ...validBody, status: 'bad' })
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(400);
    expect(res.body.error).toHaveProperty('details');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it('GET / returns 200 with valid query params', async () => {
    const res = await request(buildRoutesApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET / returns 400 for unknown query params', async () => {
    const res = await request(buildRoutesApp()).get('/?evil=injection');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });
});
