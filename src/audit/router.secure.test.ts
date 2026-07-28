process.env.JWT_SECRET = 'audit-router-test-secret';

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { requireAuth, requireRole } from '../middleware/authorization';
import { createRateLimiter } from '../middleware/rateLimiter';

function makeToken(role: 'admin' | 'auditor' | 'client', sub = `${role}-1`): string {
  return jwt.sign(
    { sub, email: `${role}@talenttrust.test`, role },
    process.env.JWT_SECRET as string,
    { expiresIn: '1h' },
  );
}

describe('audit export route security', () => {
  let store: AuditStore;
  let service: AuditService;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store);

    service.log({
      action: 'CONTRACT_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'contract',
      resourceId: 'contract-1',
      metadata: { region: 'eu' },
    });
  });

  function buildApp() {
    const app = express();
    app.use((_req, res, next) => {
      res.locals['requestId'] = 'req-audit-export';
      next();
    });

    const exportLimiter = createRateLimiter({
      maxRequests: 1,
      windowMs: 60_000,
      abuseThreshold: 10,
      blockWindowMs: 60_000,
      blockDurationMs: 60_000,
      maxBlockDurationMs: 60_000,
      keyFn: (req) => {
        const authReq = req as typeof req & { user?: { id?: string } };
        return `export:${authReq.user?.id ?? 'anonymous'}`;
      },
    });

    app.use('/api/v1/audit', createAuditRouter({
      service,
      exportService: new AuditExportService(service),
      accessMiddleware: [requireAuth, requireRole('admin', 'auditor')],
      exportMiddleware: [exportLimiter],
    }));

    return app;
  }

  it('rejects unauthenticated export attempts', async () => {
    await request(buildApp()).get('/api/v1/audit/export').expect(401);
  });

  it('rejects authenticated callers without export privileges', async () => {
    await request(buildApp())
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${makeToken('client')}`)
      .expect(403);
  });

  it('allows admin exports and streams an attachment response', async () => {
    const response = await request(buildApp())
      .get('/api/v1/audit/export?resource=contract')
      .set('Authorization', `Bearer ${makeToken('admin')}`)
      .expect(200);

    expect(response.headers['content-type']).toContain('application/x-ndjson');
    expect(response.headers['content-disposition']).toContain('attachment; filename=');
    expect(response.headers['x-audit-export-records']).toBe('1');
    expect(response.text).toContain('"resource":"contract"');
  });

  it('allows auditor role to export audit logs', async () => {
    await request(buildApp())
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${makeToken('auditor')}`)
      .expect(200);
  });

  it('rate limits repeated export requests per caller', async () => {
    const app = buildApp();
    const token = makeToken('admin', 'admin-rate-limited');

    await request(app)
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const response = await request(app)
      .get('/api/v1/audit/export')
      .set('Authorization', `Bearer ${token}`)
      .expect(429);

    expect(response.body.error.code).toBe('rate_limited');
  });
});
