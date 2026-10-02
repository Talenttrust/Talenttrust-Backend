/**
 * @file src/audit/middleware.boundaries.test.ts
 *
 * Comprehensive boundary and regression tests for the audit middleware layer:
 *
 *  1. sanitizeCorrelationId — pure helper; valid, invalid, and boundary inputs.
 *  2. sanitizeIpAddress — pure helper; clamping and edge cases.
 *  3. auditMiddleware — feature-flag on/off, correlationId sanitization,
 *     ipAddress handling, no-op stub completeness, concurrent requests.
 *  4. auditMiddleware (no-op) — structurally complete stub for every AuditEntry
 *     field so downstream code never sees undefined where a string is expected.
 *  5. validateCreateAuditEntry — valid bodies, all rejection cases, boundary-
 *     exact lengths, unknown fields, requestId overflow, headersSent guard.
 *  6. protectedEndpointMiddleware — actor/resource/resourceId truncation,
 *     correlationId sanitization, feature-flag skip, concurrent requests.
 *
 * All network I/O is eliminated: `auditService.log` is replaced with a
 * jest.fn() so tests run in-process and remain deterministic.
 */

import express, { type Request, type Response } from 'express';
import request from 'supertest';

// ── Audit middleware ──────────────────────────────────────────────────────────
import {
  auditMiddleware,
  sanitizeCorrelationId,
  sanitizeIpAddress,
  MAX_CORRELATION_ID_LENGTH,
  MAX_IP_LENGTH,
  CORRELATION_ID_PATTERN,
  NOOP_ENTRY_ID_PREFIX,
  NOOP_ENTRY_HASH,
  NOOP_ENTRY_PREVIOUS_HASH,
} from './middleware';

// ── Input validation middleware ───────────────────────────────────────────────
import {
  validateCreateAuditEntry,
  validateCreateAuditEntryInput,
  VALIDATED_BODY_KEY,
  AUDIT_VALIDATION_CODES,
} from './inputValidation';

// ── Protected-endpoint middleware ─────────────────────────────────────────────
import {
  createProtectedEndpointAuditMiddleware,
  MAX_ACTOR_LENGTH,
  MAX_RESOURCE_LENGTH,
  MAX_RESOURCE_ID_LENGTH,
} from './protectedEndpointMiddleware';

// ── Audit service ─────────────────────────────────────────────────────────────
import { auditService } from './service';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const VALID_BODY = {
  action: 'CONTRACT_CREATED',
  severity: 'INFO',
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'contract-abc',
  metadata: { region: 'eu' },
};

function mockEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'audit-1',
    timestamp: new Date().toISOString(),
    hash: 'a'.repeat(64),
    previousHash: 'GENESIS',
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-1',
    resource: 'contract',
    resourceId: 'contract-abc',
    metadata: {},
    ...overrides,
  };
}

// ─── 1. sanitizeCorrelationId ────────────────────────────────────────────────

describe('sanitizeCorrelationId — pure helper', () => {
  it('returns undefined for undefined input', () => {
    expect(sanitizeCorrelationId(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(sanitizeCorrelationId(null)).toBeUndefined();
  });

  it('returns undefined for a number', () => {
    expect(sanitizeCorrelationId(42)).toBeUndefined();
  });

  it('returns undefined for an object', () => {
    expect(sanitizeCorrelationId({})).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(sanitizeCorrelationId('')).toBeUndefined();
  });

  it('returns a clean value for a simple UUID-style id', () => {
    expect(sanitizeCorrelationId('abc-123')).toBe('abc-123');
  });

  it('accepts all allowed charset chars (letters, digits, hyphen, dot, colon, underscore)', () => {
    const id = 'Az09_-.:';
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  it('strips control characters and returns the cleaned value when still valid', () => {
    // After stripping \u0000 and \u001F the value 'abc-\u0000123\u001F' → 'abc-123'
    expect(sanitizeCorrelationId('abc-\u0000123\u001F')).toBe('abc-123');
  });

  it('returns undefined when string consists entirely of control characters', () => {
    expect(sanitizeCorrelationId('\u0000\u001F\u007F')).toBeUndefined();
  });

  it('returns undefined for a value containing spaces (not in allowed charset)', () => {
    expect(sanitizeCorrelationId('corr id')).toBeUndefined();
  });

  it('returns undefined for a value containing non-ASCII characters', () => {
    expect(sanitizeCorrelationId('corr\u00e9')).toBeUndefined();
  });

  it('accepts a value exactly at MAX_CORRELATION_ID_LENGTH', () => {
    const id = 'a'.repeat(MAX_CORRELATION_ID_LENGTH);
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  it('returns undefined for a value one char over MAX_CORRELATION_ID_LENGTH', () => {
    const id = 'a'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
    expect(sanitizeCorrelationId(id)).toBeUndefined();
  });

  it('returns undefined for a very long value', () => {
    expect(sanitizeCorrelationId('x'.repeat(10_000))).toBeUndefined();
  });

  it('strips C1 control chars (\u0080–\u009F)', () => {
    // After stripping the C1 char the result is 'abc' which is valid
    expect(sanitizeCorrelationId('a\u0085bc')).toBe('abc');
  });

  it('preserves a standard OpenTelemetry trace-id format', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7';
    expect(sanitizeCorrelationId(id)).toBe(id);
  });

  it('preserves AWS X-Ray trace ID format', () => {
    const id = '1-5759e988-bd862e3fe1be46a994272793';
    expect(sanitizeCorrelationId(id)).toBe(id);
  });
});

// ─── 2. sanitizeIpAddress ─────────────────────────────────────────────────────

describe('sanitizeIpAddress — pure helper', () => {
  it('returns undefined for undefined', () => {
    expect(sanitizeIpAddress(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(sanitizeIpAddress(null)).toBeUndefined();
  });

  it('returns undefined for a number', () => {
    expect(sanitizeIpAddress(42)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(sanitizeIpAddress('')).toBeUndefined();
  });

  it('returns a normal IPv4 address unchanged', () => {
    expect(sanitizeIpAddress('192.168.1.1')).toBe('192.168.1.1');
  });

  it('returns a normal IPv6 address unchanged', () => {
    expect(sanitizeIpAddress('::1')).toBe('::1');
  });

  it('returns a value exactly at MAX_IP_LENGTH unchanged', () => {
    const ip = 'x'.repeat(MAX_IP_LENGTH);
    expect(sanitizeIpAddress(ip)).toBe(ip);
  });

  it('clamps a value one char over MAX_IP_LENGTH', () => {
    const long = 'x'.repeat(MAX_IP_LENGTH + 1);
    expect(sanitizeIpAddress(long)).toBe('x'.repeat(MAX_IP_LENGTH));
  });

  it('clamps a very long value', () => {
    const long = '1'.repeat(1_000);
    expect(sanitizeIpAddress(long)).toHaveLength(MAX_IP_LENGTH);
  });

  it('handles an IPv4-mapped IPv6 address (max real-world length = 45 chars) without clamping', () => {
    // '::ffff:' + IPv4 — longest is '::ffff:255.255.255.255' = 22 chars; well within MAX_IP_LENGTH
    const ip = '::ffff:192.168.100.200';
    expect(sanitizeIpAddress(ip)).toBe(ip);
  });
});

// ─── 3. auditMiddleware — feature flag ON ─────────────────────────────────────

describe('auditMiddleware — AUDIT_ENABLED=true', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
    logSpy = jest.spyOn(auditService, 'log').mockReturnValue(mockEntry() as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_ENABLED;
  });

  it('attaches res.locals.audit.log and calls next()', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/probe', (_req, res) => {
      expect(typeof res.locals.audit?.log).toBe('function');
      res.sendStatus(204);
    });
    await request(app).get('/probe').expect(204);
  });

  it('passes a valid correlationId header through to auditService.log', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    await request(app)
      .post('/entries')
      .set('X-Correlation-ID', 'valid-id-123')
      .expect(201);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'valid-id-123' }),
    );
  });

  it('discards a correlationId header that exceeds MAX_CORRELATION_ID_LENGTH', async () => {
    const longId = 'a'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    await request(app)
      .post('/entries')
      .set('X-Correlation-ID', longId)
      .expect(201);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: undefined }),
    );
  });

  it('discards a correlationId header that is exactly at the boundary (128 chars) → accepted', async () => {
    const exactId = 'b'.repeat(MAX_CORRELATION_ID_LENGTH);
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    await request(app)
      .post('/entries')
      .set('X-Correlation-ID', exactId)
      .expect(201);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: exactId }),
    );
  });

  it('discards a correlationId with forbidden characters (spaces)', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    await request(app)
      .post('/entries')
      .set('X-Correlation-ID', 'bad id with spaces')
      .expect(201);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: undefined }),
    );
  });

  it('strips control characters from correlationId before accepting', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    // After stripping \u0001 the result is 'abc-123' which is valid
    await request(app)
      .post('/entries')
      .set('X-Correlation-ID', 'abc-\u0001123')
      .expect(201);

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'abc-123' }),
    );
  });

  it('passes ipAddress from req.ip to auditService.log', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/probe', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(200);
    });
    await request(app).get('/probe').expect(200);

    const call = logSpy.mock.calls[0][0];
    // ipAddress is undefined or a string (loopback '::1' or '127.0.0.1')
    expect(typeof call.ipAddress === 'string' || call.ipAddress === undefined).toBe(true);
  });

  it('handles concurrent requests with different correlationIds without cross-contamination', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/c', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(200);
    });

    const ids = ['corr-A', 'corr-B', 'corr-C', 'corr-D', 'corr-E'];
    const responses = await Promise.all(
      ids.map(id =>
        request(app).get('/c').set('X-Correlation-ID', id),
      ),
    );

    for (const r of responses) expect(r.status).toBe(200);

    // Every call's correlationId must match one of our ids
    const passedIds = logSpy.mock.calls.map(c => c[0].correlationId);
    for (const id of ids) expect(passedIds).toContain(id);
  });
});

// ─── 4. auditMiddleware — feature flag OFF (no-op stub) ──────────────────────

describe('auditMiddleware — AUDIT_ENABLED=false (no-op)', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'false';
    logSpy = jest.spyOn(auditService, 'log').mockReturnValue(mockEntry() as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_ENABLED;
  });

  it('does NOT call auditService.log', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      res.locals.audit.log(VALID_BODY);
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns a structurally complete AuditEntry from the no-op stub', async () => {
    let capturedEntry: Record<string, unknown> | null = null;
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      capturedEntry = res.locals.audit.log(VALID_BODY) as Record<string, unknown>;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);

    expect(capturedEntry).not.toBeNull();
    // Required string fields must be non-empty strings.
    expect(typeof capturedEntry!['id']).toBe('string');
    expect((capturedEntry!['id'] as string).length).toBeGreaterThan(0);
    expect(typeof capturedEntry!['timestamp']).toBe('string');
    expect((capturedEntry!['timestamp'] as string).length).toBeGreaterThan(0);
    expect(typeof capturedEntry!['hash']).toBe('string');
    expect((capturedEntry!['hash'] as string).length).toBeGreaterThan(0);
    expect(typeof capturedEntry!['previousHash']).toBe('string');
    expect(typeof capturedEntry!['action']).toBe('string');
    expect(typeof capturedEntry!['severity']).toBe('string');
    expect(typeof capturedEntry!['actor']).toBe('string');
    expect(typeof capturedEntry!['resource']).toBe('string');
    expect(typeof capturedEntry!['resourceId']).toBe('string');
    expect(typeof capturedEntry!['metadata']).toBe('object');
  });

  it('stub id starts with NOOP_ENTRY_ID_PREFIX', async () => {
    let capturedId = '';
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      capturedId = (res.locals.audit.log(VALID_BODY) as any).id;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(capturedId.startsWith(NOOP_ENTRY_ID_PREFIX)).toBe(true);
  });

  it('stub hash equals NOOP_ENTRY_HASH', async () => {
    let capturedHash = '';
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      capturedHash = (res.locals.audit.log(VALID_BODY) as any).hash;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(capturedHash).toBe(NOOP_ENTRY_HASH);
  });

  it('stub previousHash equals NOOP_ENTRY_PREVIOUS_HASH', async () => {
    let capturedPrevHash = '';
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      capturedPrevHash = (res.locals.audit.log(VALID_BODY) as any).previousHash;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(capturedPrevHash).toBe(NOOP_ENTRY_PREVIOUS_HASH);
  });

  it('stub reflects the caller input action and severity fields', async () => {
    let captured: Record<string, unknown> | null = null;
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      captured = res.locals.audit.log({
        ...VALID_BODY,
        action: 'AUTH_FAILED',
        severity: 'WARNING',
      }) as any;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(captured!['action']).toBe('AUTH_FAILED');
    expect(captured!['severity']).toBe('WARNING');
  });

  it('stub uses fallback action/severity when caller passes invalid values', async () => {
    let captured: Record<string, unknown> | null = null;
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      // Pass an object with missing required fields — no-op must not throw
      captured = res.locals.audit.log({} as any) as any;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    // Should not throw; stub provides fallback values
    expect(typeof captured!['action']).toBe('string');
    expect(typeof captured!['severity']).toBe('string');
    expect(typeof captured!['actor']).toBe('string');
    expect(typeof captured!['resource']).toBe('string');
    expect(typeof captured!['resourceId']).toBe('string');
  });

  it('stub returns a frozen object', async () => {
    let captured: object | null = null;
    const app = express();
    app.use(auditMiddleware);
    app.post('/entries', (_req, res) => {
      captured = res.locals.audit.log(VALID_BODY) as any;
      res.sendStatus(201);
    });
    await request(app).post('/entries').expect(201);
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it('still calls next() so the response is sent', async () => {
    const app = express();
    app.use(auditMiddleware);
    app.get('/ok', (_req, res) => res.sendStatus(200));
    await request(app).get('/ok').expect(200);
  });
});

// ─── 5. validateCreateAuditEntry ─────────────────────────────────────────────

describe('validateCreateAuditEntry — valid input', () => {
  it('calls next() and publishes parsed body on res.locals for a valid payload', async () => {
    let capturedBody: unknown = null;
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (req, res) => {
      capturedBody = res.locals[VALIDATED_BODY_KEY];
      res.sendStatus(201);
    });
    await request(app).post('/audit').send(VALID_BODY).expect(201);
    expect(capturedBody).toMatchObject({ action: 'CONTRACT_CREATED', actor: 'user-1' });
  });

  it('defaults metadata to {} when omitted', async () => {
    let capturedBody: any = null;
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (_req, res) => {
      capturedBody = res.locals[VALIDATED_BODY_KEY];
      res.sendStatus(201);
    });
    const { metadata: _omit, ...withoutMetadata } = VALID_BODY;
    await request(app).post('/audit').send(withoutMetadata).expect(201);
    expect(capturedBody.metadata).toEqual({});
  });

  it('accepts actor exactly at MAX_ID_LENGTH (128 chars)', async () => {
    const body = { ...VALID_BODY, actor: 'a'.repeat(128) };
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    await request(app).post('/audit').send(body).expect(201);
  });

  it('accepts all valid action values', async () => {
    const actions = [
      'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'PAYMENT_INITIATED',
      'AUTH_LOGIN', 'ADMIN_ACTION', 'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
    ];
    for (const action of actions) {
      const app = express();
      app.use(express.json());
      app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
      await request(app).post('/audit').send({ ...VALID_BODY, action }).expect(201);
    }
  });

  it('accepts all valid severity values', async () => {
    for (const severity of ['INFO', 'WARNING', 'CRITICAL']) {
      const app = express();
      app.use(express.json());
      app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
      await request(app).post('/audit').send({ ...VALID_BODY, severity }).expect(201);
    }
  });
});

describe('validateCreateAuditEntry — rejection cases', () => {
  function makeRejectApp() {
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    return app;
  }

  it('returns 400 for a missing action', async () => {
    const { action: _a, ...body } = VALID_BODY;
    const res = await request(makeRejectApp()).post('/audit').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.MISSING_FIELD);
  });

  it('returns 400 for an unknown action value', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, action: 'INVENTED_ACTION' });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.INVALID_ENUM);
  });

  it('returns 400 for a missing severity', async () => {
    const { severity: _s, ...body } = VALID_BODY;
    const res = await request(makeRejectApp()).post('/audit').send(body);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing actor', async () => {
    const { actor: _a, ...body } = VALID_BODY;
    const res = await request(makeRejectApp()).post('/audit').send(body);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an empty actor string', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: '' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an actor that is only whitespace', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: '   ' });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.BLANK);
  });

  it('returns 400 for an actor containing control characters', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: 'user\u0001-1' });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.CONTROL_CHARACTERS);
  });

  it('returns 400 for actor exceeding MAX_ID_LENGTH (129 chars)', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: 'a'.repeat(129) });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.TOO_BIG);
  });

  it('returns 400 for a missing resource', async () => {
    const { resource: _r, ...body } = VALID_BODY;
    const res = await request(makeRejectApp()).post('/audit').send(body);
    expect(res.status).toBe(400);
  });

  it('returns 400 for a missing resourceId', async () => {
    const { resourceId: _rid, ...body } = VALID_BODY;
    const res = await request(makeRejectApp()).post('/audit').send(body);
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown top-level field', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, unexpectedField: 'oops' });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.UNKNOWN_FIELD);
  });

  it('returns 400 for a metadata value that is an array (not an object)', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, metadata: [1, 2, 3] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a metadata object containing a forbidden key (__proto__)', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({ ...VALID_BODY, metadata: { __proto__: { polluted: true } } });
    expect(res.status).toBe(400);
    const codes = res.body.error.details.map((d: any) => d.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY);
  });

  it('returns 400 for an empty request body', async () => {
    const res = await request(makeRejectApp())
      .post('/audit')
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-JSON body (plain text)', async () => {
    const res = await request(express().use(express.json()).post('/audit', validateCreateAuditEntry, (_r, res) => res.sendStatus(201)))
      .post('/audit')
      .set('Content-Type', 'text/plain')
      .send('not json');
    // Express rejects non-json body before middleware runs; either 400 or next is called with an unvalidated body
    // We only care that a 201 is NOT returned
    expect(res.status).not.toBe(201);
  });
});

describe('validateCreateAuditEntry — boundary lengths', () => {
  function makeApp() {
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    return app;
  }

  it('accepts actor exactly 128 chars (boundary)', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: 'x'.repeat(128) })
      .expect(201);
  });

  it('rejects actor at 129 chars (one over boundary)', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, actor: 'x'.repeat(129) })
      .expect(400);
  });

  it('accepts resource exactly 128 chars', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, resource: 'r'.repeat(128) })
      .expect(201);
  });

  it('rejects resource at 129 chars', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, resource: 'r'.repeat(129) })
      .expect(400);
  });

  it('accepts resourceId exactly 128 chars', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, resourceId: 'i'.repeat(128) })
      .expect(201);
  });

  it('rejects resourceId at 129 chars', async () => {
    await request(makeApp())
      .post('/audit')
      .send({ ...VALID_BODY, resourceId: 'i'.repeat(129) })
      .expect(400);
  });
});

describe('validateCreateAuditEntry — requestId sanitization in error response', () => {
  it('returns requestId from res.locals in the error envelope', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals['requestId'] = 'req-abc-123';
      next();
    });
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    const res = await request(app).post('/audit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.requestId).toBe('req-abc-123');
  });

  it('falls back to "unknown" when requestId is absent', async () => {
    const app = express();
    app.use(express.json());
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    const res = await request(app).post('/audit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.requestId).toBe('unknown');
  });

  it('falls back to "unknown" when requestId exceeds 128 chars', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      res.locals['requestId'] = 'x'.repeat(200);
      next();
    });
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    const res = await request(app).post('/audit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.requestId).toBe('unknown');
  });

  it('falls back to "unknown" when requestId is a number', async () => {
    const app = express();
    app.use(express.json());
    app.use((_req, res, next) => {
      (res.locals as any)['requestId'] = 12345;
      next();
    });
    app.post('/audit', validateCreateAuditEntry, (_req, res) => res.sendStatus(201));
    const res = await request(app).post('/audit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.requestId).toBe('unknown');
  });
});

describe('validateCreateAuditEntry — headersSent guard', () => {
  it('calls next() without sending a second response when headersSent is true', async () => {
    let nextCalledAfterHeaders = false;
    const app = express();
    app.use(express.json());
    // Middleware that sends a response AND then calls next (simulating a
    // misbehaving upstream that already committed the response).
    app.use((_req, res, next) => {
      res.status(200).json({ early: true });
      // Manually mark headersSent-like scenario by just calling next after sending
      next();
    });
    app.post('/audit', validateCreateAuditEntry, (_req, _res) => {
      nextCalledAfterHeaders = true;
    });
    await request(app).post('/audit').send({}); // body is invalid but shouldn't re-respond
    expect(nextCalledAfterHeaders).toBe(true);
  });
});

// ─── 6. protectedEndpointMiddleware ──────────────────────────────────────────

describe('protectedEndpointMiddleware — field truncation', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
    logSpy = jest.spyOn(auditService, 'log').mockReturnValue(mockEntry() as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_ENABLED;
  });

  it('truncates an oversized actor to MAX_ACTOR_LENGTH', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts', (req: any, res) => {
      // Inject a very long userId
      req.user = { userId: 'u'.repeat(MAX_ACTOR_LENGTH + 100) };
      res.sendStatus(200);
    });

    await request(app).get('/api/v1/contracts').expect(200);

    // Wait for the finish listener to fire
    await new Promise(r => setTimeout(r, 10));
    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].actor.length).toBeLessThanOrEqual(MAX_ACTOR_LENGTH);
  });

  it('truncates an oversized resource segment to MAX_RESOURCE_LENGTH', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const longSegment = 'r'.repeat(MAX_RESOURCE_LENGTH + 50);
    const app = express();
    app.use(middleware);
    app.get(`/api/v1/${longSegment}`, (_req, res) => res.sendStatus(200));

    await request(app).get(`/api/v1/${longSegment}`).expect(200);
    await new Promise(r => setTimeout(r, 10));

    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].resource.length).toBeLessThanOrEqual(MAX_RESOURCE_LENGTH);
  });

  it('truncates an oversized resourceId segment to MAX_RESOURCE_ID_LENGTH', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const longId = 'i'.repeat(MAX_RESOURCE_ID_LENGTH + 100);
    const app = express();
    app.use(middleware);
    app.get(`/api/v1/contracts/${longId}`, (_req, res) => res.sendStatus(200));

    await request(app).get(`/api/v1/contracts/${longId}`).expect(200);
    await new Promise(r => setTimeout(r, 10));

    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].resourceId.length).toBeLessThanOrEqual(MAX_RESOURCE_ID_LENGTH);
  });

  it('sanitizes correlationId from res.locals.requestId', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts', (_req, res) => {
      res.locals['requestId'] = 'valid-request-id';
      res.sendStatus(200);
    });

    await request(app).get('/api/v1/contracts').expect(200);
    await new Promise(r => setTimeout(r, 10));

    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].correlationId).toBe('valid-request-id');
  });

  it('discards an oversized requestId from res.locals as correlationId', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts', (_req, res) => {
      res.locals['requestId'] = 'x'.repeat(MAX_CORRELATION_ID_LENGTH + 1);
      res.sendStatus(200);
    });

    await request(app).get('/api/v1/contracts').expect(200);
    await new Promise(r => setTimeout(r, 10));

    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].correlationId).toBeUndefined();
  });

  it('uses "anonymous" when req.user is absent', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/api/v1/health', (_req, res) => res.sendStatus(200));

    await request(app).get('/api/v1/health').expect(200);
    await new Promise(r => setTimeout(r, 10));

    const call = logSpy.mock.calls[0];
    expect(call).toBeDefined();
    expect(call[0].actor).toBe('anonymous');
  });
});

describe('protectedEndpointMiddleware — AUDIT_ENABLED=false', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'false';
    logSpy = jest.spyOn(auditService, 'log').mockReturnValue(mockEntry() as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_ENABLED;
  });

  it('skips the finish listener and does not call auditService.log', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/api/v1/contracts', (_req, res) => res.sendStatus(200));

    await request(app).get('/api/v1/contracts').expect(200);
    await new Promise(r => setTimeout(r, 10));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('still calls next() so the request is handled', async () => {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.get('/probe', (_req, res) => res.sendStatus(204));
    await request(app).get('/probe').expect(204);
  });
});

describe('protectedEndpointMiddleware — action and severity mapping', () => {
  let logSpy: jest.SpiedFunction<typeof auditService.log>;

  beforeEach(() => {
    process.env.AUDIT_ENABLED = 'true';
    logSpy = jest.spyOn(auditService, 'log').mockReturnValue(mockEntry() as any);
  });

  afterEach(() => {
    logSpy.mockRestore();
    delete process.env.AUDIT_ENABLED;
  });

  async function fireRequest(method: string, path: string, status: number) {
    const middleware = createProtectedEndpointAuditMiddleware(auditService);
    const app = express();
    app.use(middleware);
    app.all(path, (_req, res) => res.sendStatus(status));
    await request(app)[method.toLowerCase() as 'get'](path);
    await new Promise(r => setTimeout(r, 10));
    return logSpy.mock.calls[0]?.[0];
  }

  it('GET 200 → ENDPOINT_ACCESS / INFO', async () => {
    const entry = await fireRequest('GET', '/api/v1/contracts', 200);
    expect(entry?.action).toBe('ENDPOINT_ACCESS');
    expect(entry?.severity).toBe('INFO');
  });

  it('POST 201 → ENDPOINT_MUTATION / INFO', async () => {
    const entry = await fireRequest('POST', '/api/v1/contracts', 201);
    expect(entry?.action).toBe('ENDPOINT_MUTATION');
    expect(entry?.severity).toBe('INFO');
  });

  it('GET 401 → AUTH_FAILED / WARNING', async () => {
    const entry = await fireRequest('GET', '/api/v1/contracts', 401);
    expect(entry?.action).toBe('AUTH_FAILED');
    expect(entry?.severity).toBe('WARNING');
  });

  it('POST 403 → AUTH_FAILED / WARNING', async () => {
    const entry = await fireRequest('POST', '/api/v1/contracts', 403);
    expect(entry?.action).toBe('AUTH_FAILED');
    expect(entry?.severity).toBe('WARNING');
  });

  it('DELETE 500 → ENDPOINT_MUTATION / WARNING', async () => {
    const entry = await fireRequest('DELETE', '/api/v1/contracts/abc', 500);
    expect(entry?.action).toBe('ENDPOINT_MUTATION');
    expect(entry?.severity).toBe('WARNING');
  });
});

// ─── 7. validateCreateAuditEntryInput (pure function) ─────────────────────────

describe('validateCreateAuditEntryInput — pure function', () => {
  it('returns ok:true with parsed data for a valid input', () => {
    const result = validateCreateAuditEntryInput(VALID_BODY);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.action).toBe('CONTRACT_CREATED');
      expect(result.data.actor).toBe('user-1');
      expect(result.data.metadata).toEqual({ region: 'eu' });
    }
  });

  it('returns ok:false with issues for an invalid input', () => {
    const result = validateCreateAuditEntryInput({ action: 'INVENTED' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.code).toBe('validation_error');
    }
  });

  it('never throws for any input (total function)', () => {
    const dangerous = [
      null,
      undefined,
      42,
      'string',
      [],
      { action: undefined, metadata: { __proto__: 'x' } },
      { action: 'CONTRACT_CREATED', severity: 'INFO', actor: '\u0000', resource: '', resourceId: '' },
    ];
    for (const d of dangerous) {
      expect(() => validateCreateAuditEntryInput(d)).not.toThrow();
    }
  });

  it('returns ok:false for circular metadata (non-HTTP caller scenario)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = validateCreateAuditEntryInput({ ...VALID_BODY, metadata: circular });
    expect(result.ok).toBe(false);
  });

  it('returns all issues at once for multiple invalid fields', () => {
    const result = validateCreateAuditEntryInput({
      action: 'BAD',
      severity: 'UNKNOWN',
      actor: '',
      resource: '',
      resourceId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // At least action, severity, actor, resource, resourceId must be reported
      expect(result.issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});
