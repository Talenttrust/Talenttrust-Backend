/**
 * Focused authorization and caller-isolation coverage for the audit API.
 *
 * The current identity model has no tenant or organisation claim. Audit data
 * is deliberately restricted to the privileged admin/auditor roles, so
 * "cross-tenant" isolation is enforced at the role boundary: ordinary callers
 * cannot list, fetch, export, verify, or write audit records belonging to any
 * actor. Privileged audit roles retain the existing global compliance view.
 */

process.env.JWT_SECRET = 'audit-authz-test-secret-at-least-32-chars';

import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { requireAuth, requireRole } from '../middleware/authorization';
import { AuditExportService } from './exportService';
import { createAuditRouter } from './router';
import { AuditService } from './service';
import { AuditStore } from './store';
import type { Role } from '../lib/types';

const REQUEST_ID = 'audit-authz-request';
const FOREIGN_MARKER = 'tenant-a-confidential-marker';

function token(role: Role, subject = `${role}-user`, expiresIn = '1h'): string {
  return jwt.sign(
    { sub: subject, email: `${subject}@example.test`, role },
    process.env.JWT_SECRET as string,
    { expiresIn },
  );
}

function buildApp() {
  const store = new AuditStore();
  const service = new AuditService(store);

  const foreignEntry = service.log({
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'tenant-a-user',
    resource: 'contract',
    resourceId: 'tenant-a-contract',
    metadata: { marker: FOREIGN_MARKER },
  });

  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.requestId = REQUEST_ID;
    next();
  });
  app.use(
    '/api/v1/audit',
    createAuditRouter({
      service,
      exportService: new AuditExportService(service),
      accessMiddleware: [requireAuth, requireRole('admin', 'auditor')],
    }),
  );

  return { app, foreignEntry, store };
}

function expectAuthError(response: request.Response, status: 401 | 403): void {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({
    error: expect.objectContaining({
      code: status === 401 ? 'unauthorized' : 'forbidden',
      requestId: REQUEST_ID,
    }),
  });
  expect(JSON.stringify(response.body)).not.toContain(FOREIGN_MARKER);
}

describe('audit endpoint authorization and caller isolation', () => {
  const protectedReads = [
    ['list', '/api/v1/audit'],
    ['export', '/api/v1/audit/export'],
    ['integrity', '/api/v1/audit/integrity'],
  ] as const;

  it.each(protectedReads)(
    'rejects missing authentication on the %s endpoint with 401',
    async (_name, path) => {
      const { app } = buildApp();
      expectAuthError(await request(app).get(path), 401);
    },
  );

  it('rejects missing authentication before disclosing a known entry', async () => {
    const { app, foreignEntry } = buildApp();
    expectAuthError(await request(app).get(`/api/v1/audit/${foreignEntry.id}`), 401);
  });

  it.each([
    ['malformed', 'not-a-jwt'],
    ['bad signature', jwt.sign(
      { sub: 'attacker', email: 'attacker@example.test', role: 'admin' },
      'wrong-secret',
    )],
    ['expired', token('admin', 'expired-admin', '-1s')],
  ])('rejects a %s credential with 401', async (_case, credential) => {
    const { app } = buildApp();
    const response = await request(app)
      .get('/api/v1/audit')
      .set('Authorization', `Bearer ${credential}`);

    expectAuthError(response, 401);
  });

  it.each(['client', 'freelancer'] as const)(
    'rejects the %s role from every audit read path with 403',
    async role => {
      const { app, foreignEntry } = buildApp();
      const authorization = `Bearer ${token(role, 'tenant-b-user')}`;
      const paths = [
        '/api/v1/audit',
        `/api/v1/audit/${foreignEntry.id}`,
        '/api/v1/audit/export',
        '/api/v1/audit/integrity',
      ];

      for (const path of paths) {
        expectAuthError(
          await request(app).get(path).set('Authorization', authorization),
          403,
        );
      }
    },
  );

  it('denies a cross-owner read without revealing whether the entry exists', async () => {
    const { app, foreignEntry } = buildApp();
    const authorization = `Bearer ${token('client', 'tenant-b-user')}`;

    const known = await request(app)
      .get(`/api/v1/audit/${foreignEntry.id}`)
      .set('Authorization', authorization);
    const unknown = await request(app)
      .get('/api/v1/audit/00000000-0000-0000-0000-000000000000')
      .set('Authorization', authorization);

    expectAuthError(known, 403);
    expectAuthError(unknown, 403);
    expect(known.body).toEqual(unknown.body);
  });

  it('denies cross-owner list filters and never returns another actor data', async () => {
    const { app } = buildApp();
    const response = await request(app)
      .get('/api/v1/audit?actor=tenant-a-user')
      .set('Authorization', `Bearer ${token('client', 'tenant-b-user')}`);

    expectAuthError(response, 403);
    expect(response.body).not.toHaveProperty('entries');
  });

  it('denies an unauthorized write and leaves the audit store unchanged', async () => {
    const { app, store } = buildApp();
    const countBefore = store.count();
    const response = await request(app)
      .post('/api/v1/audit')
      .set('Idempotency-Key', 'tenant-b-write-attempt')
      .set('Authorization', `Bearer ${token('client', 'tenant-b-user')}`)
      .send({
        action: 'ADMIN_ACTION',
        severity: 'CRITICAL',
        actor: 'tenant-b-user',
        resource: 'audit-log',
        resourceId: 'cross-tenant-write',
        metadata: {},
      });

    expectAuthError(response, 403);
    expect(store.count()).toBe(countBefore);
  });

  it.each(['admin', 'auditor'] as const)(
    'preserves the privileged global compliance view for %s',
    async role => {
      const { app, foreignEntry } = buildApp();
      const authorization = `Bearer ${token(role)}`;

      const list = await request(app)
        .get('/api/v1/audit')
        .set('Authorization', authorization)
        .expect(200);
      expect(list.body.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: foreignEntry.id })]),
      );

      await request(app)
        .get(`/api/v1/audit/${foreignEntry.id}`)
        .set('Authorization', authorization)
        .expect(200);
    },
  );
});
