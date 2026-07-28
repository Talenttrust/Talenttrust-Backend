/**
 * @file audit.flag.test.ts
 * @description Comprehensive tests for the `AUDIT_ENABLED` feature flag.
 *
 * This test suite verifies three runtime paths for every gated component:
 *
 * 1. Flag ON (default / `AUDIT_ENABLED=true`)  — audit fully active.
 * 2. Flag OFF (`AUDIT_ENABLED=false`)           — no entries written, no-op helpers.
 * 3. Flag absent (env var unset)               — should default to ON.
 *
 * Components under test
 * ─────────────────────
 * • env schema (`validateEnv`) — parses and defaults AUDIT_ENABLED correctly.
 * • `auditMiddleware`          — attaches real vs no-op helper.
 * • `createProtectedEndpointAuditMiddleware` — registers vs skips finish listener.
 *
 * Isolation strategy
 * ──────────────────
 * Each test group sets `process.env.AUDIT_ENABLED` in `beforeEach` and
 * restores the original environment in `afterEach`.  Because `validateEnv()`
 * is called at middleware invocation time (not module import time), toggling
 * `process.env.AUDIT_ENABLED` between tests is sufficient without resetting
 * the module registry.
 */

import express, { ErrorRequestHandler } from 'express';
import request from 'supertest';

// ── Shared minimum env ────────────────────────────────────────────────────────
// `validateEnv()` requires COMPLIANCE_AUDIT_SECRET to be present.
const MIN_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  COMPLIANCE_AUDIT_SECRET: 'a'.repeat(32),
};

// ── Subject imports ───────────────────────────────────────────────────────────
import { validateEnv } from '../config/env.schema';
import { auditMiddleware } from './middleware';
import { auditService } from './service';
import { createProtectedEndpointAuditMiddleware } from './protectedEndpointMiddleware';
import type { CreateAuditEntryInput } from './types';

// ── Minimal audit input helper ────────────────────────────────────────────────
function makeAuditInput(
  overrides: Partial<Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>> = {},
): Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'> {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-flag-test',
    resource: 'contract',
    resourceId: 'contract-flag-1',
    metadata: {},
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Schema — AUDIT_ENABLED parsing
// ─────────────────────────────────────────────────────────────────────────────
describe('AUDIT_ENABLED env schema', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...MIN_ENV };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('defaults to true when AUDIT_ENABLED is not set', () => {
    delete process.env.AUDIT_ENABLED;
    const config = validateEnv();
    expect(config.AUDIT_ENABLED).toBe(true);
  });

  it('is true when AUDIT_ENABLED=true', () => {
    process.env.AUDIT_ENABLED = 'true';
    const config = validateEnv();
    expect(config.AUDIT_ENABLED).toBe(true);
  });

  it('is false when AUDIT_ENABLED=false', () => {
    process.env.AUDIT_ENABLED = 'false';
    const config = validateEnv();
    expect(config.AUDIT_ENABLED).toBe(false);
  });

  it('treats any non-"false" string as true (e.g. "1")', () => {
    process.env.AUDIT_ENABLED = '1';
    const config = validateEnv();
    expect(config.AUDIT_ENABLED).toBe(true);
  });

  it('treats any non-"false" string as true (e.g. "yes")', () => {
    process.env.AUDIT_ENABLED = 'yes';
    const config = validateEnv();
    expect(config.AUDIT_ENABLED).toBe(true);
  });

  it('treats empty string as true (safe default)', () => {
    process.env.AUDIT_ENABLED = '';
    const config = validateEnv();
    // empty string → undefined after Zod optional, transform runs on undefined → true
    expect(config.AUDIT_ENABLED).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. auditMiddleware — flag ON
// ─────────────────────────────────────────────────────────────────────────────
describe('auditMiddleware — AUDIT_ENABLED=true (default)', () => {
  const savedEnv = process.env;
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env = { ...MIN_ENV, AUDIT_ENABLED: 'true' };
    logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'stub-id',
      timestamp: new Date().toISOString(),
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = savedEnv;
  });

  it('attaches a real log helper and calls next()', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/probe', (_req, res) => {
      expect(typeof res.locals.audit.log).toBe('function');
      res.status(204).send();
    });

    await request(app).get('/probe').expect(204);
  });

  it('writes an audit entry when res.locals.audit.log is called', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/contracts', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      res.status(201).json({ ok: true });
    });

    await request(app).post('/contracts').expect(201);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CONTRACT_CREATED', actor: 'user-flag-test' }),
    );
  });

  it('injects correlationId from X-Correlation-ID header', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/ping', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      res.json({ ok: true });
    });

    await request(app)
      .get('/ping')
      .set('X-Correlation-ID', 'test-corr-id')
      .expect(200);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'test-corr-id' }),
    );
  });

  it('returns the persisted entry from log()', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/echo', (_req, res) => {
      const entry = res.locals.audit.log(makeAuditInput());
      res.json({ id: entry.id });
    });

    const response = await request(app).get('/echo').expect(200);
    expect(response.body.id).toBe('stub-id');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. auditMiddleware — flag OFF
// ─────────────────────────────────────────────────────────────────────────────
describe('auditMiddleware — AUDIT_ENABLED=false', () => {
  const savedEnv = process.env;
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env = { ...MIN_ENV, AUDIT_ENABLED: 'false' };
    logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'stub-id',
      timestamp: new Date().toISOString(),
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = savedEnv;
  });

  it('still calls next() when flag is off', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/probe', (_req, res) => {
      res.status(204).send();
    });

    await request(app).get('/probe').expect(204);
  });

  it('attaches a no-op log helper — does NOT call auditService.log', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/contracts', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      res.status(201).json({ ok: true });
    });

    await request(app).post('/contracts').expect(201);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('no-op log returns a stub AuditEntry with matching fields', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/echo', (_req, res) => {
      const entry = res.locals.audit.log(makeAuditInput());
      res.json({
        action: entry.action,
        actor: entry.actor,
        resource: entry.resource,
        resourceId: entry.resourceId,
      });
    });

    const response = await request(app).get('/echo').expect(200);
    expect(response.body).toMatchObject({
      action: 'CONTRACT_CREATED',
      actor: 'user-flag-test',
      resource: 'contract',
      resourceId: 'contract-flag-1',
    });
    // Still no real write
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('no-op stub has a timestamp property', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/ts', (_req, res) => {
      const entry = res.locals.audit.log(makeAuditInput());
      res.json({ timestamp: entry.timestamp });
    });

    const response = await request(app).get('/ts').expect(200);
    expect(response.body.timestamp).toBeDefined();
  });

  it('route handlers continue to function normally (no errors)', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/normal', (_req, res) => {
      res.locals.audit.log(makeAuditInput({ action: 'AUTH_LOGIN', severity: 'INFO' }));
      res.json({ status: 'ok' });
    });

    const response = await request(app).get('/normal').expect(200);
    expect(response.body.status).toBe('ok');
  });

  it('error path still produces a response (no disruption)', async () => {
    const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
      res.status(500).json({ error: 'server error' });
    };
    const app = express();
    app.use(auditMiddleware);
    app.get('/fail', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      throw new Error('boom');
    });
    app.use(errorHandler);

    await request(app).get('/fail').expect(500);
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. auditMiddleware — flag absent (defaults to ON)
// ─────────────────────────────────────────────────────────────────────────────
describe('auditMiddleware — AUDIT_ENABLED absent (defaults to true)', () => {
  const savedEnv = process.env;
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env = { ...MIN_ENV };
    delete process.env['AUDIT_ENABLED'];
    logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'stub-default',
      timestamp: new Date().toISOString(),
      hash: 'b'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = savedEnv;
  });

  it('writes audit entries when AUDIT_ENABLED is unset', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/default', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      res.json({ ok: true });
    });

    await request(app).get('/default').expect(200);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. createProtectedEndpointAuditMiddleware — flag ON
// ─────────────────────────────────────────────────────────────────────────────
describe('createProtectedEndpointAuditMiddleware — AUDIT_ENABLED=true', () => {
  const savedEnv = process.env;
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env = { ...MIN_ENV, AUDIT_ENABLED: 'true' };
    logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'prot-stub',
      timestamp: new Date().toISOString(),
      hash: 'c'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.env = savedEnv;
  });

  it('calls next() and writes an audit entry on finish', async () => {
    const mockService = { log: jest.fn(logSpy) } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts/abc', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/api/v1/contracts/abc').expect(200);

    // finish listener fires after response
    expect(mockService.log).toHaveBeenCalledTimes(1);
    expect(mockService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ENDPOINT_ACCESS',
        resource: 'contracts',
      }),
    );
  });

  it('records AUTH_FAILED for 401 responses', async () => {
    const mockService = { log: jest.fn(logSpy) } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts', (_req, res) => {
      res.status(401).json({ error: 'unauthorized' });
    });

    await request(app).get('/api/v1/contracts').expect(401);
    expect(mockService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_FAILED', severity: 'WARNING' }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. createProtectedEndpointAuditMiddleware — flag OFF
// ─────────────────────────────────────────────────────────────────────────────
describe('createProtectedEndpointAuditMiddleware — AUDIT_ENABLED=false', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...MIN_ENV, AUDIT_ENABLED: 'false' };
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('calls next() and does NOT write any audit entry', async () => {
    const mockService = { log: jest.fn() } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts/abc', (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get('/api/v1/contracts/abc').expect(200);
    expect(mockService.log).not.toHaveBeenCalled();
  });

  it('does not write an entry for 401 responses either', async () => {
    const mockService = { log: jest.fn() } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.get('/protected', (_req, res) => {
      res.status(401).json({ error: 'unauthorized' });
    });

    await request(app).get('/protected').expect(401);
    expect(mockService.log).not.toHaveBeenCalled();
  });

  it('downstream handlers still work normally', async () => {
    const mockService = { log: jest.fn() } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.post('/api/v1/contracts', (_req, res) => {
      res.status(201).json({ created: true });
    });

    const response = await request(app)
      .post('/api/v1/contracts')
      .send({ title: 'New Contract' })
      .expect(201);

    expect(response.body.created).toBe(true);
    expect(mockService.log).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. createProtectedEndpointAuditMiddleware — flag absent (defaults to ON)
// ─────────────────────────────────────────────────────────────────────────────
describe('createProtectedEndpointAuditMiddleware — AUDIT_ENABLED absent (defaults to true)', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    process.env = { ...MIN_ENV };
    delete process.env['AUDIT_ENABLED'];
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('writes an audit entry on finish when flag is absent', async () => {
    const mockService = { log: jest.fn() } as any;
    const middleware = createProtectedEndpointAuditMiddleware(mockService);

    const app = express();
    app.use(middleware);
    app.get('/api/v1/reputation/u1', (_req, res) => {
      res.json({ score: 95 });
    });

    await request(app).get('/api/v1/reputation/u1').expect(200);
    expect(mockService.log).toHaveBeenCalledTimes(1);
    expect(mockService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ENDPOINT_ACCESS' }),
    );
  });
});
