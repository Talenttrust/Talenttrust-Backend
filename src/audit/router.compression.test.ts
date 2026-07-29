import express from 'express';
import request from 'supertest';
import { AuditStore } from './store';
import { AuditService } from './service';
import { createAuditRouter } from './router';
import type { CreateAuditEntryInput } from './types';
import { requestIdMiddleware } from '../middleware/requestId';

describe('Audit Router - Gzip Compression', () => {
  let app: express.Application;
  let service: AuditService;
  let store: AuditStore;

  beforeEach(() => {
    store = new AuditStore();
    service = new AuditService(store as any);

    const auditRouter = createAuditRouter({
      service,
      accessMiddleware: [], // No auth for these tests to simplify
    });

    app = express();
    app.use(express.json());
    app.use(requestIdMiddleware);
    app.use('/api/v1/audit', auditRouter);
  });

  afterEach(() => {
    store._reset();
  });

  function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
    return {
      action: 'TEST_ACTION',
      severity: 'INFO',
      actor: 'test-user',
      resource: 'test-resource',
      resourceId: 'test-1',
      metadata: { note: 'test' },
      ...overrides,
    };
  }

  it('compresses responses larger than the threshold when Accept-Encoding is gzip', async () => {
    // Generate enough data to cross the 1024 byte threshold
    for (let i = 0; i < 20; i++) {
      service.log(makeInput({
        resourceId: `res-${i}`,
        metadata: {
          note: 'This is a long note to ensure the response size crosses the 1024 bytes compression threshold. '.repeat(5)
        }
      }));
    }

    const response = await request(app)
      .get('/api/v1/audit')
      .set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    // Ensure the response was actually compressed (supertest unzips automatically but headers remain)
  });

  it('does not compress responses smaller than the threshold', async () => {
    // Generate minimal data, well below 1024 bytes
    service.log(makeInput());

    const response = await request(app)
      .get('/api/v1/audit')
      .set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('does not compress when Accept-Encoding is not provided', async () => {
    // Generate enough data to cross the 1024 byte threshold
    for (let i = 0; i < 20; i++) {
      service.log(makeInput({
        resourceId: `res-${i}`,
        metadata: {
          note: 'This is a long note to ensure the response size crosses the 1024 bytes compression threshold. '.repeat(5)
        }
      }));
    }

    const response = await request(app)
      .get('/api/v1/audit')
      .set('Accept-Encoding', 'identity'); // Explicitly set identity to prevent supertest from adding gzip

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});
