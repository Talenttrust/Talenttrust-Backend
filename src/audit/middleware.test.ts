/**
 * @file middleware.test.ts
 * @description Unit tests for the audit Express middleware (`auditMiddleware`).
 *
 * Covered scenarios:
 * - Attaches `res.locals.audit.log` before route handlers run.
 * - Route handlers emit audit entries that include `correlationId` from
 *   `X-Correlation-ID` and `ipAddress` from the request.
 * - Audit entries are persisted once the HTTP response finishes, even when
 *   the handler throws and the error path returns a 500.
 */

import express, { ErrorRequestHandler } from 'express';
import request from 'supertest';
import { auditMiddleware } from './middleware';
import { auditService } from './service';
import type { CreateAuditEntryInput } from './types';

/** Minimal audit input used across middleware tests. */
function makeAuditInput(
  overrides: Partial<Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>> = {},
): Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'> {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-test-1',
    resource: 'contract',
    resourceId: 'contract-test-1',
    metadata: { region: 'eu' },
    ...overrides,
  };
}

describe('auditMiddleware', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    logSpy = jest.spyOn(auditService, 'log').mockImplementation((input) => ({
      id: 'audit-entry-1',
      timestamp: new Date().toISOString(),
      hash: 'a'.repeat(64),
      previousHash: 'GENESIS',
      ...input,
    }));
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('attaches res.locals.audit with a log function and calls next()', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/probe', (_req, res) => {
      expect(typeof res.locals.audit.log).toBe('function');
      res.status(204).send();
    });

    await request(app).get('/probe').expect(204);
  });

  it('emits an audit entry with correlationId after the response finishes', async () => {
    const correlationId = 'corr-finish-abc-123';
    const app = express();
    app.use(auditMiddleware);
    app.post('/contracts', (_req, res) => {
      res.locals.audit.log(makeAuditInput());
      res.status(201).json({ ok: true });
    });

    await request(app)
      .post('/contracts')
      .set('X-Correlation-ID', correlationId)
      .expect(201);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId,
        action: 'CONTRACT_CREATED',
        actor: 'user-test-1',
      }),
    );
  });

  it('injects ipAddress from the request into audit entries', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/health', (req, res) => {
      res.locals.audit.log(makeAuditInput({ action: 'ADMIN_ACTION', severity: 'CRITICAL' }));
      res.json({ ip: req.ip });
    });

    await request(app).get('/health').expect(200);

    const loggedInput = logSpy.mock.calls[0][0];
    expect(loggedInput.ipAddress).toBeDefined();
  });

  it('still produces an audit record when the handler throws before responding', async () => {
    const correlationId = 'corr-handler-error-456';
    const errorHandler: ErrorRequestHandler = (_err, _req, res, _next) => {
      res.status(500).json({ error: 'Internal server error' });
    };

    const app = express();
    app.use(auditMiddleware);
    app.get('/fail', (_req, res) => {
      res.locals.audit.log(makeAuditInput({ action: 'AUTH_FAILED', severity: 'WARNING' }));
      throw new Error('handler exploded');
    });
    app.use(errorHandler);

    await request(app)
      .get('/fail')
      .set('X-Correlation-ID', correlationId)
      .expect(500);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId,
        action: 'AUTH_FAILED',
        severity: 'WARNING',
      }),
    );
  });

  it('returns the persisted audit entry from res.locals.audit.log', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/echo', (_req, res) => {
      const entry = res.locals.audit.log(makeAuditInput());
      res.json({ id: entry.id, correlationId: entry.correlationId });
    });

    const response = await request(app)
      .get('/echo')
      .set('X-Correlation-ID', 'corr-echo-789')
      .expect(200);

    expect(response.body.id).toBe('audit-entry-1');
    expect(response.body.correlationId).toBe('corr-echo-789');
  });
});
