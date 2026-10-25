/**
 * Tests for cron endpoint.
 */

import request from 'supertest';
import { createApp } from '../src/app';
import { InMemoryEventStore } from '../src/indexer/store';
import { EventIndexer } from '../src/indexer/indexer';

describe('Cron endpoint', () => {
  it('returns 401 without authorization header', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app).post('/api/cron/index-events');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('returns 401 with wrong secret', async () => {
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer wrong-secret');
    expect(response.status).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('returns 200 with correct secret', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    // Fake RPC: tests never reach the network.
    (indexer as any).rpc = { getEvents: async () => ({ events: [], cursor: 'cursor-0', latestLedger: 100 }) };
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('processed');
    expect(response.body).toHaveProperty('cursor');
    expect(response.body).toHaveProperty('latestLedger');
    delete process.env.CRON_SECRET;
  });

  it('returns 409 when indexer is busy', async () => {
    process.env.CRON_SECRET = 'test-secret';
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    (indexer as any).isRunning = true;
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer test-secret');
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('indexer_busy');
    delete process.env.CRON_SECRET;
  });

  it('fails closed when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const eventStore = new InMemoryEventStore();
    const indexer = new EventIndexer(eventStore);
    const app = createApp(undefined, eventStore, indexer);

    const response = await request(app)
      .post('/api/cron/index-events')
      .set('Authorization', 'Bearer any-token');
    expect(response.status).toBe(401);
  });
});
