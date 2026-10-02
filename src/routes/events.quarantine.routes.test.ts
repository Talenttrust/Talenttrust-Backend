/**
 * @file events.quarantine.routes.test.ts
 * @description Integration tests for schema-version quarantine (#1206):
 * events with unknown contract schema versions are retained (redacted) at
 * the boundary, never projected; malformed versions are rejected; mixed
 * versions in one page are isolated per-item; replay is authenticated and
 * reprocesses once support ships.
 */

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createEventsRouter } from './events.routes';
import { EventAuditService, InMemoryEventAuditRepository } from '../repository/eventAuditRepository';
import { EventQuarantineStorage, clearEventQuarantineInstance } from '../events/eventQuarantine';

process.env.JWT_SECRET = 'talenttrust-test-secret';
const SECRET = process.env.JWT_SECRET;

function adminToken(): string {
  return jwt.sign({ sub: 'admin-1', email: 'admin-1@test.com', role: 'admin' }, SECRET, { expiresIn: '1h' });
}

function clientToken(): string {
  return jwt.sign({ sub: 'client-1', email: 'client-1@test.com', role: 'client' }, SECRET, { expiresIn: '1h' });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: 'm-1', amount: 100 },
    network: 'soroban',
    ledger: 120,
    ...overrides,
  };
}

describe('POST /api/v1/events — schema-version boundary', () => {
  it('processes events with a known schema version normally', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    const res = await request(app).post('/api/v1/events').send(event({ schemaVersion: 1 }));
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('accepted');
  });

  it('processes legacy events without a version (treated as version 1)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    const res = await request(app).post('/api/v1/events').send(event());
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('accepted');
  });

  it('quarantines an event with an unknown schema version (retained, not projected)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    const res = await request(app).post('/api/v1/events').send(event({ schemaVersion: 2, eventId: 'e-unknown' }));
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('quarantined');
    expect(res.body.data.quarantineId).toEqual(expect.any(String));

    // Not projected: contract history is empty.
    const history = await request(app).get('/api/v1/contracts/contract-1/history');
    expect(history.body.data).toHaveLength(0);
  });

  it('rejects a malformed schema version with 400', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    for (const bad of [0, -1, 1.5, '2']) {
      const res = await request(app).post('/api/v1/events').send(event({ schemaVersion: bad, eventId: 'e-bad' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('invalid_event_payload');
    }
  });
});

describe('POST /api/v1/events/batch — mixed versions in one page', () => {
  it('isolates per-item outcomes: known processed, unknown quarantined, malformed rejected', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    const res = await request(app).post('/api/v1/events/batch').send({
      events: [
        event({ schemaVersion: 1, eventId: 'known-1', sequence: 1 }),
        event({ schemaVersion: 2, eventId: 'unknown-1', sequence: 2 }),
        { ...event({ sequence: 3, eventId: 'malformed-1' }), schemaVersion: 0 },
      ],
    });

    expect(res.status).toBe(200);
    const byEvent: Record<string, string> = Object.fromEntries(
      res.body.data.results.map((r: { index: number; status: string }) => [r.index, r.status]),
    );
    expect(byEvent[0]).toBe('accepted');
    expect(byEvent[1]).toBe('quarantined');
    expect(byEvent[2]).toBe('rejected');
  });

  it('rejects an empty or oversized batch', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { knownSchemaVersions: [1] },
    ));

    const empty = await request(app).post('/api/v1/events/batch').send({ events: [] });
    expect(empty.status).toBe(400);

    const huge = await request(app).post('/api/v1/events/batch').send({
      events: Array.from({ length: 101 }, (_, i) => event({ sequence: i + 1, eventId: `e-${i}` })),
    });
    expect(huge.status).toBe(400);
    expect(huge.body.error.code).toBe('event_batch_too_large');
  });
});

describe('Admin quarantine inspection & replay', () => {
  let quarantine: EventQuarantineStorage;

  beforeEach(() => {
    clearEventQuarantineInstance();
    quarantine = new EventQuarantineStorage(':memory:');
  });

  afterEach(() => {
    quarantine.close();
    clearEventQuarantineInstance();
  });

  function makeApp(known: readonly number[] = [1]) {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', createEventsRouter(
      new EventAuditService(new InMemoryEventAuditRepository()),
      { quarantineStorage: quarantine, knownSchemaVersions: known },
    ));
    return app;
  }

  it('requires admin auth to inspect the quarantine', async () => {
    const app = makeApp();
    const noAuth = await request(app).get('/api/v1/events/quarantine');
    expect(noAuth.status).toBe(401);

    const forbidden = await request(app)
      .get('/api/v1/events/quarantine')
      .set('Authorization', `Bearer ${clientToken()}`);
    expect(forbidden.status).toBe(403);
  });

  it('lists quarantined events with a schemaVersion filter', async () => {
    const app = makeApp();
    const first = await request(app).post('/api/v1/events').send(event({ schemaVersion: 2, eventId: 'q-1' }));
    await request(app).post('/api/v1/events').send(event({ schemaVersion: 3, eventId: 'q-2' }));

    const res = await request(app)
      .get('/api/v1/events/quarantine')
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(2);
    expect(first.body.data.quarantineId).toEqual(expect.any(String));
  });

  it('replays a quarantined event once its version becomes known', async () => {
    // Stage: version 2 is unknown; the event is quarantined.
    const app = makeApp([1]);
    const quarantined = await request(app).post('/api/v1/events').send(event({ schemaVersion: 2, eventId: 'q-upgrade' }));
    expect(quarantined.body.data.status).toBe('quarantined');
    const quarantineId = quarantined.body.data.quarantineId;

    // Simulate the contract upgrade: version 2 is now supported.
    const upgradedApp = makeApp([1, 2]);
    const replay = await request(upgradedApp)
      .post('/api/v1/events/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ quarantineId, reason: 'v2 support shipped' });
    expect(replay.status).toBe(202);
    expect(replay.body.data.status).toBe('accepted');

    // The event is now projected.
    const history = await request(upgradedApp).get('/api/v1/contracts/contract-1/history');
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0].eventId).toBe('q-upgrade');
  });

  it('re-quarantines a replay when the version is still unknown', async () => {
    const app = makeApp([1]);
    const quarantined = await request(app).post('/api/v1/events').send(event({ schemaVersion: 2, eventId: 'q-still' }));
    const quarantineId = quarantined.body.data.quarantineId;

    const replay = await request(app)
      .post('/api/v1/events/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ quarantineId, reason: 'retry before support' });
    expect(replay.status).toBe(202);
    expect(replay.body.data.status).toBe('re-quarantined');
    expect(replay.body.data.quarantineId).not.toBe(quarantineId);
  });

  it('rejects replay without a valid quarantineId and reason', async () => {
    const app = makeApp();
    const missing = await request(app)
      .post('/api/v1/events/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ quarantineId: 'nope', reason: 'x' });
    expect(missing.status).toBe(400);

    const notFound = await request(app)
      .post('/api/v1/events/quarantine/replay')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ quarantineId: 'missing-id', reason: 'valid reason here' });
    expect(notFound.status).toBe(404);
  });
});
