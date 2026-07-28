/**
 * @file service.test.ts
 * @description Focused unit tests for the `AuditService`-level contract.
 *
 * Scope (issue #424 — see also `sqliteRepository.test.ts`):
 * 1. `AuditService` routes every `log()` call to its configured repository
 *    with **action**, **actor**, `ipAddress`, and `correlationId` preserved,
 *    and the caller's metadata passed through unchanged.
 * 2. The redaction contract via `src/audit/redact.ts` is documented and
 *    observable at the service boundary: the service itself does NOT mutate
 *    metadata — callers that want sensitive fields redacted MUST
 *    pre-process them via `redactBody()`. This is verified by both
 *    positive (redacted input survives verbatim) and **canary-string**
 *    assertions (the canary value cannot leak into the persisted record)
 *    plus a "teeth" assertion (without redaction, the canary WOULD leak —
 *    proving the negative assertion is meaningful).
 * 3. A repository write failure surfaces from `AuditService.log()` — the
 *    exception is re-thrown so callers (typically `auditMiddleware` or
 *    `protectedEndpointAuditMiddleware`) can detect and handle it
 *    instead of silently dropping the entry.
 * 4. Each convenience wrapper (`logContractEvent`, `logPaymentEvent`,
 *    `logAuthEvent`, `logUserEvent`) sets the correct `resource`,
 *    `resourceId`, and per-action `severity` rule.
 *
 * These tests use a pure in-memory mock `AuditLogRepository` so they are
 * **DB-isolated** (no SQLite, no shared singleton) and **deterministic**.
 * The SQLite backend behaviour is covered separately in
 * `src/audit/sqliteRepository.test.ts`.
 *
 * Note: there is intentionally a divergence between the `makeInput` here
 * (which includes `ipAddress` and `correlationId` so routing can be
 * asserted) and the one in `sqliteRepository.test.ts` (which omits them —
 * SQLite persistence is tested with the smallest input needed). Future
 * tests reusing these fixtures should preserve the convention to keep the
 * assertions meaningful.
 */

import { AuditService, auditService } from './service';
import { redactBody, REDACTED } from './redact';
import type { AuditLogRepository } from './repository';
import type { AuditExportService, AuditExportResult } from './exportService';
import type {
  AuditAction,
  AuditEntry,
  AuditQuery,
  CreateAuditEntryInput,
  IntegrityReport,
  AuditQueryResult,
} from './types';

// ─── Test fixtures ──────────────────────────────────────────────────────────

/** Frozen timestamp used by the mock repository so that assertion stability
 *  does not depend on the wall clock.
 */
const FROZEN_TIMESTAMP = '2026-01-15T10:00:00.000Z';

/**
 * Mock repository that records every appended input and supports a one-shot
 * `failNextAppend` trigger for write-failure tests. It mirrors the production
 * `AuditLogRepository` contract closely enough for service-level assertions
 * without coupling to any concrete backend.
 */
type MockRepository = AuditLogRepository & {
  appendedInputs: CreateAuditEntryInput[];
  failNextAppend: Error | null;
};

function makeMockRepository(): MockRepository {
  const repo: MockRepository = {
    appendedInputs: [],
    failNextAppend: null,
    append(input: CreateAuditEntryInput): AuditEntry {
      if (repo.failNextAppend) {
        const err = repo.failNextAppend;
        // One-shot failure — clearing it matches the real semantics in
        // better-sqlite3 where each call gets a fresh transaction.
        repo.failNextAppend = null;
        throw err;
      }
      repo.appendedInputs.push(input);
      const index = repo.appendedInputs.length;
      const entry: AuditEntry = Object.freeze({
        id: `mock-id-${index}`,
        timestamp: FROZEN_TIMESTAMP,
        action: input.action,
        severity: input.severity,
        actor: input.actor,
        resource: input.resource,
        resourceId: input.resourceId,
        metadata: Object.freeze({ ...input.metadata }),
        ipAddress: input.ipAddress,
        correlationId: input.correlationId,
        previousHash: 'GENESIS',
        hash: `mock-hash-${index}`,
      });
      return entry;
    },
    getById(_id: string): AuditEntry | undefined {
      return undefined;
    },
    query(_query?: AuditQuery): AuditEntry[] {
      return [];
    },
    *stream(_query?: AuditQuery) {
      // Empty generator — read-side delegation is asserted via jest.spyOn
      // elsewhere; the iterator mechanics themselves are not the focus.
    },
    count(): number {
      return repo.appendedInputs.length;
    },
    verifyIntegrity(): IntegrityReport {
      return {
        valid: true,
        totalEntries: repo.appendedInputs.length,
        checkedAt: FROZEN_TIMESTAMP,
      };
    },
    queryWithCursor(query: AuditQuery = {}): AuditQueryResult {
      const entries = repo.query(query);
      return {
        entries,
        count: entries.length,
        limit: query.limit ?? 50,
      };
    },
  };
  return repo;
}

/** Minimal valid input — spread+override to drop optional fields cleanly. */
function makeInput(overrides: Partial<CreateAuditEntryInput> = {}): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-abc',
    resource: 'contract',
    resourceId: 'contract-1',
    metadata: { clientId: 'client-1' },
    ipAddress: '127.0.0.1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

// ─── 1. Routing contract ────────────────────────────────────────────────────

describe('AuditService — repository routing contract', () => {
  let repo: MockRepository;
  let service: AuditService;

  beforeEach(() => {
    repo = makeMockRepository();
    service = new AuditService(repo);
  });

  it('forwards a single log() call to repository.append() exactly once', () => {
    service.log(makeInput());
    expect(repo.appendedInputs).toHaveLength(1);
  });

  it('returns the entry that the repository returned', () => {
    const returned = service.log(makeInput());
    expect(returned.id).toBe('mock-id-1');
    expect(returned.hash).toBe('mock-hash-1');
  });

  // Keep in sync with `AuditAction` in types.ts. If a new variant is added,
  // append it here so this assertion pins the routing layer's accept-set.
  it('preserves the action field without coercion across every AuditAction', () => {
    const actions: AuditAction[] = [
      'CONTRACT_CREATED',
      'CONTRACT_UPDATED',
      'CONTRACT_CANCELLED',
      'CONTRACT_COMPLETED',
      'PAYMENT_INITIATED',
      'PAYMENT_RELEASED',
      'PAYMENT_DISPUTED',
      'REPUTATION_UPDATED',
      'USER_CREATED',
      'USER_UPDATED',
      'USER_DELETED',
      'AUTH_LOGIN',
      'AUTH_LOGOUT',
      'AUTH_FAILED',
      'ADMIN_ACTION',
      'ENDPOINT_ACCESS',
      'ENDPOINT_MUTATION',
      'DEPLOYMENT_PROMOTED',
      'DEPLOYMENT_ROLLED_BACK',
    ];
    actions.forEach((action) => service.log(makeInput({ action })));
    expect(repo.appendedInputs.map((i) => i.action)).toEqual(actions);
  });

  it('preserves the actor field (does not default to "anonymous")', () => {
    service.log(makeInput({ actor: 'user-xyz' }));
    expect(repo.appendedInputs[0].actor).toBe('user-xyz');
  });

  it('propagates correlationId into the repository call', () => {
    service.log(makeInput({ correlationId: 'trace-abc-123' }));
    expect(repo.appendedInputs[0].correlationId).toBe('trace-abc-123');
  });

  it('persists ipAddress on every entry', () => {
    service.log(makeInput({ ipAddress: '203.0.113.42' }));
    expect(repo.appendedInputs[0].ipAddress).toBe('203.0.113.42');
  });

  it('passes caller-supplied metadata through as the SAME REFERENCE (no clone/re-wrap)', () => {
    const metadata = { clientId: 'c-1', note: 'plain text' };
    service.log(makeInput({ metadata }));
    // Reference identity — the service must NOT clone or re-wrap the
    // metadata before forwarding. `.toBe` checks identity, not equality.
    expect(repo.appendedInputs[0].metadata).toBe(metadata);
  });
});

// ─── 2. Redaction contract ──────────────────────────────────────────────────

/**
 * Critical: `AuditService.log()` does NOT mutate caller-supplied metadata.
 * Callers that need sensitive fields redacted MUST pre-process them via
 * `redactBody()` from `src/audit/redact.ts`. The tests below pin that
 * contract on both sides.
 */
describe('AuditService — redaction contract', () => {
  const CANARY = 'CANARY-PASSWORD-VALUE-DO-NOT-LEAK-XYZ';

  let repo: MockRepository;
  let service: AuditService;

  beforeEach(() => {
    repo = makeMockRepository();
    service = new AuditService(repo);
  });

  it('does NOT redact caller-supplied metadata — sensitive keys remain unless pre-redacted', () => {
    const unredacted = { username: 'alice', password: 'hunter2' };
    service.log(makeInput({ metadata: unredacted }));
    expect(repo.appendedInputs[0].metadata).toEqual(unredacted);
  });

  it('round-trips redacted metadata produced by redactBody()', () => {
    const sensitive = {
      username: 'alice@example.com',
      password: 'hunter2',
      token: 'eyJ.abc.xyz',
      nested: { apiKey: 'k-123' },
    };
    const redacted = redactBody(sensitive) as Record<string, unknown>;
    service.log(makeInput({ metadata: redacted }));

    const stored = repo.appendedInputs[0].metadata;
    expect(stored.username).toBe('ali***@example.com');
    expect(stored.password).toBe(REDACTED);
    expect(stored.token).toBe(REDACTED);
    const nested = stored.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe(REDACTED);
  });

  it('does NOT mutate non-sensitive metadata when redactBody is applied', () => {
    const payload = { clientId: 'c-1', amount: 1000, currency: 'XLM' };
    const redacted = redactBody(payload) as Record<string, unknown>;
    service.log(makeInput({ metadata: redacted }));
    expect(repo.appendedInputs[0].metadata).toEqual(redacted);
  });

  it('SECURITY: a sensitive canary value cannot leak into the persisted record when the caller pre-processes via redactBody()', () => {
    const sensitive = {
      username: 'safe-name',
      password: CANARY,
      apiKey: `${CANARY}-k`,
      note: 'plaintext',
    };
    const redacted = redactBody(sensitive) as Record<string, unknown>;
    service.log(makeInput({ metadata: redacted }));

    const serialised = JSON.stringify(repo.appendedInputs[0].metadata);
    expect(serialised).not.toContain(CANARY);
    expect(repo.appendedInputs[0].metadata.password).toBe(REDACTED);
    expect((repo.appendedInputs[0].metadata as Record<string, unknown>)['apiKey']).toBe(REDACTED);
  });

  it('SECURITY (deep): redaction prevents canary leakage from nested arrays and objects', () => {
    // Place canary values inside sensitive-keyed contexts NESTED at
    // different depths so a redaction bug that only walks a single object
    // depth or skips arrays would be caught here. NOTE: canaries must
    // live under sensitive keys (`apiKey`, `token`, `credential`) because
    // `redactBody` only masks strings via `maskEmail` (which is email
    // pattern-specific) and otherwise leaves non-email strings under
    // non-sensitive keys verbatim — plain canary strings in plain arrays
    // would not actually be redacted.
    const sensitive = {
      profile: { apiKey: `${CANARY}-profile` },
      history: [
        { token: `${CANARY}-t1` },
        { token: `${CANARY}-t2`, nested: { credential: `${CANARY}-c` } },
      ],
    };
    const redacted = redactBody(sensitive) as Record<string, unknown>;
    service.log(makeInput({ metadata: redacted }));

    const serialised = JSON.stringify(repo.appendedInputs[0].metadata);
    expect(serialised).not.toContain(CANARY);

    // Positive counter-assertion: redaction must REPLACE the sensitive
    // keys with `[REDACTED]`, not short-circuit to `{}` or pass the
    // payload through verbatim. This keeps the negative assertion
    // meaningful even if `redactBody` is ever refactored.
    expect(repo.appendedInputs[0].metadata).toMatchObject({
      profile: { apiKey: REDACTED },
      history: [
        { token: REDACTED },
        { token: REDACTED, nested: { credential: REDACTED } },
      ],
    });
  });

  it('SECURITY (teeth): without redaction, the same canary value WOULD leak into the persisted record', () => {
    const sensitive = { username: 'safe-name', password: CANARY };
    service.log(makeInput({ metadata: sensitive }));

    const serialised = JSON.stringify(repo.appendedInputs[0].metadata);
    // This test ensures the prior SECURITY assertion is meaningful — a
    // bug in redactBody or silent mutation by the service would be caught
    // by the contrast between the two tests.
    expect(serialised).toContain(CANARY);
  });
});

// ─── 3. Repository write-failure surfacing ──────────────────────────────────

/**
 * Security: a quiet swallow of a write failure would let an audit gap go
 * undetected. The service MUST surface the failure so that callers in the
 * request path (e.g. `protectedEndpointAuditMiddleware`) can react.
 */
describe('AuditService — repository write failures surface', () => {
  let repo: MockRepository;
  let service: AuditService;

  beforeEach(() => {
    repo = makeMockRepository();
    service = new AuditService(repo);
  });

  it('re-throws when repository.append() throws', () => {
    repo.failNextAppend = new Error('disk-full');
    expect(() => service.log(makeInput())).toThrow('disk-full');
  });

  it('a failed append does not corrupt subsequent calls', () => {
    repo.failNextAppend = new Error('transient');
    expect(() => service.log(makeInput())).toThrow('transient');
    service.log(makeInput({ actor: 'user-after-failure' }));
    expect(repo.appendedInputs).toHaveLength(1);
    expect(repo.appendedInputs[0].actor).toBe('user-after-failure');
  });

  it('does not retain the failed input in the recorded input list', () => {
    repo.failNextAppend = new Error('boom');
    try {
      service.log(makeInput({ actor: 'do-not-retain' }));
    } catch {
      // Expected throw — swallow so we can assert.
    }
    expect(repo.appendedInputs).toHaveLength(0);
  });

  it('convenience wrappers also propagate repository write failures', () => {
    const failingRepo = makeMockRepository();
    failingRepo.failNextAppend = new Error('store-down');
    const failingService = new AuditService(failingRepo);
    expect(() =>
      failingService.logContractEvent('CONTRACT_CREATED', 'u', 'c-1'),
    ).toThrow('store-down');
  });

  it('a write failure does not crash a request-style catch handler', () => {
    // Simulate the request path: the caller wraps the audit call in
    // try/catch and continues serving the response.
    repo.failNextAppend = new Error('kernel-panic');
    let requestContinued = false;
    let caughtError: unknown = null;
    try {
      service.log(makeInput());
    } catch (err) {
      caughtError = err;
    } finally {
      requestContinued = true;
    }
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toBe('kernel-panic');
    expect(requestContinued).toBe(true);
  });
});

// ─── 4. Convenience wrappers ────────────────────────────────────────────────

describe('AuditService — convenience wrappers', () => {
  let repo: MockRepository;
  let service: AuditService;

  beforeEach(() => {
    repo = makeMockRepository();
    service = new AuditService(repo);
  });

  it('logContractEvent sets resource="contract", resourceId, severity="INFO"', () => {
    service.logContractEvent('CONTRACT_UPDATED', 'u-1', 'c-9', { fields: ['status'] });
    expect(repo.appendedInputs[0]).toMatchObject({
      action: 'CONTRACT_UPDATED',
      severity: 'INFO',
      actor: 'u-1',
      resource: 'contract',
      resourceId: 'c-9',
    });
  });

  it('logPaymentEvent sets severity="CRITICAL" and resource="payment"', () => {
    service.logPaymentEvent('PAYMENT_RELEASED', 'u-2', 'p-7', { amount: 250 });
    expect(repo.appendedInputs[0]).toMatchObject({
      action: 'PAYMENT_RELEASED',
      severity: 'CRITICAL',
      actor: 'u-2',
      resource: 'payment',
      resourceId: 'p-7',
    });
  });

  it('logAuthEvent raises severity="WARNING" for AUTH_FAILED with full routing', () => {
    service.logAuthEvent('AUTH_FAILED', 'u-3', { reason: 'bad-pw' }, { ipAddress: '10.0.0.1' });
    expect(repo.appendedInputs[0]).toMatchObject({
      severity: 'WARNING',
      action: 'AUTH_FAILED',
      actor: 'u-3',
      resource: 'auth',
      resourceId: 'u-3',
      ipAddress: '10.0.0.1',
    });
  });

  it('logAuthEvent: AUTH_LOGIN / AUTH_LOGOUT set severity="INFO", resource="auth", resourceId=actor', () => {
    service.logAuthEvent('AUTH_LOGIN', 'u-3');
    service.logAuthEvent('AUTH_LOGOUT', 'u-3');
    expect(
      repo.appendedInputs.map((i) => ({
        severity: i.severity,
        action: i.action,
        resource: i.resource,
        resourceId: i.resourceId,
      })),
    ).toEqual([
      { severity: 'INFO', action: 'AUTH_LOGIN', resource: 'auth', resourceId: 'u-3' },
      { severity: 'INFO', action: 'AUTH_LOGOUT', resource: 'auth', resourceId: 'u-3' },
    ]);
  });

  it('logUserEvent: USER_CREATED/UPDATED use "INFO"; USER_DELETED uses "WARNING"', () => {
    service.logUserEvent('USER_CREATED', 'admin-1', 'user-2');
    service.logUserEvent('USER_UPDATED', 'admin-1', 'user-2');
    service.logUserEvent('USER_DELETED', 'admin-1', 'user-2');
    expect(repo.appendedInputs.map((i) => i.severity)).toEqual(['INFO', 'INFO', 'WARNING']);
    // Resource label is "user" and targetUserId maps to resourceId —
    // not the actor.
    expect(repo.appendedInputs[0].resource).toBe('user');
    expect(repo.appendedInputs[0].resourceId).toBe('user-2');
  });

  it('convenience wrappers propagate context (ipAddress, correlationId)', () => {
    service.logContractEvent(
      'CONTRACT_CREATED',
      'u',
      'c',
      {},
      { ipAddress: '127.0.0.1', correlationId: 'trace-42' },
    );
    expect(repo.appendedInputs[0]).toMatchObject({
      ipAddress: '127.0.0.1',
      correlationId: 'trace-42',
    });
  });

  it('logDisputeEvent: DISPUTE_CREATED uses INFO severity, resource="dispute"', () => {
    service.logDisputeEvent('DISPUTE_CREATED', 'user-1', 'dispute-1', { reason: 'Test' });
    expect(repo.appendedInputs[0]).toMatchObject({
      action: 'DISPUTE_CREATED',
      severity: 'INFO',
      actor: 'user-1',
      resource: 'dispute',
      resourceId: 'dispute-1',
      metadata: { reason: 'Test' },
    });
  });

  it('logDisputeEvent: DISPUTE_UPDATED uses WARNING severity', () => {
    service.logDisputeEvent('DISPUTE_UPDATED', 'admin-1', 'dispute-2', {});
    expect(repo.appendedInputs[0].severity).toBe('WARNING');
  });

  it('logDisputeEvent: DISPUTE_DELETED uses INFO severity', () => {
    service.logDisputeEvent('DISPUTE_DELETED', 'admin-1', 'dispute-3', {});
    expect(repo.appendedInputs[0].severity).toBe('INFO');
  });

  it('logDisputeEvent propagates context (ipAddress, correlationId)', () => {
    service.logDisputeEvent(
      'DISPUTE_CREATED',
      'user-1',
      'dispute-1',
      {},
      { ipAddress: '10.0.0.1', correlationId: 'trace-dispute' },
    );
    expect(repo.appendedInputs[0]).toMatchObject({
      ipAddress: '10.0.0.1',
      correlationId: 'trace-dispute',
    });
  });
});

// ─── 5. Read-side delegation ────────────────────────────────────────────────

describe('AuditService — read-side delegation to repository', () => {
  it('query() forwards the filter object verbatim', () => {
    const repo = makeMockRepository();
    const spy = jest.spyOn(repo, 'query');
    new AuditService(repo).query({ action: 'CONTRACT_CREATED', limit: 10 });
    expect(spy).toHaveBeenCalledWith({ action: 'CONTRACT_CREATED', limit: 10 });
  });

  it('getById() forwards the id verbatim', () => {
    const repo = makeMockRepository();
    const spy = jest.spyOn(repo, 'getById');
    new AuditService(repo).getById('id-1');
    expect(spy).toHaveBeenCalledWith('id-1');
  });

  it('count() and verifyIntegrity() delegate to the repository', () => {
    const repo = makeMockRepository();
    const countSpy = jest.spyOn(repo, 'count');
    const verifySpy = jest.spyOn(repo, 'verifyIntegrity');
    const service = new AuditService(repo);
    service.count();
    service.verifyIntegrity();
    expect(countSpy).toHaveBeenCalled();
    expect(verifySpy).toHaveBeenCalled();
  });

  it('stream() returns the exact iterator from the repository (not a re-wrap)', () => {
    const repo = makeMockRepository();
    const sentinel = (function* () {
      yield Object.freeze({} as AuditEntry);
    })();
    // mockReturnValue (not Once) so any number of subsequent calls still
    // bind to the sentinel, surfacing future refactors that try to
    // re-iterate inside the same test.
    jest.spyOn(repo, 'stream').mockReturnValue(sentinel);
    const service = new AuditService(repo);
    expect(service.stream()).toBe(sentinel);
  });
});

// ─── 6. Singleton sanity ────────────────────────────────────────────────────

describe('auditService singleton', () => {
  it('is a functional AuditService instance with the documented surface area', () => {
    expect(auditService).toBeInstanceOf(AuditService);
    // Behavioural sanity — these methods must exist on the singleton.
    expect(typeof auditService.log).toBe('function');
    expect(typeof auditService.query).toBe('function');
    expect(typeof auditService.getById).toBe('function');
    expect(typeof auditService.stream).toBe('function');
    expect(typeof auditService.count).toBe('function');
    expect(typeof auditService.verifyIntegrity).toBe('function');
    expect(typeof auditService.createEntry).toBe('function');
    expect(typeof auditService.validateAndParseQuery).toBe('function');
    expect(typeof auditService.queryLogs).toBe('function');
    expect(typeof auditService.exportAuditLogs).toBe('function');
    expect(typeof auditService.checkIntegrity).toBe('function');
    expect(typeof auditService.getEntry).toBe('function');
  });
});

// ─── 7. Extracted Business Logic Methods ────────────────────────────────────

describe('AuditService — extracted business logic & query parsing', () => {
  describe('createEntry', () => {
    it('throws error when required fields are missing', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      const invalidInputs: Partial<CreateAuditEntryInput>[] = [
        { severity: 'INFO', actor: 'user1', resource: 'contract', resourceId: 'c1' },
        { action: 'CONTRACT_CREATED', actor: 'user1', resource: 'contract', resourceId: 'c1' },
        { action: 'CONTRACT_CREATED', severity: 'INFO', resource: 'contract', resourceId: 'c1' },
        { action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user1', resourceId: 'c1' },
        { action: 'CONTRACT_CREATED', severity: 'INFO', actor: 'user1', resource: 'contract' },
      ];

      for (const input of invalidInputs) {
        expect(() => service.createEntry(input as CreateAuditEntryInput)).toThrow(
          'Missing required fields: action, severity, actor, resource, resourceId',
        );
      }
    });

    it('persists and returns entry when all required fields are present', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      const input: CreateAuditEntryInput = {
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'user1',
        resource: 'contract',
        resourceId: 'c1',
        metadata: {},
      };

      const entry = service.createEntry(input);
      expect(entry.action).toBe('CONTRACT_CREATED');
      expect(repo.appendedInputs).toHaveLength(1);
    });
  });

  describe('validateAndParseQuery', () => {
    const service = new AuditService(makeMockRepository());

    it('validates action field', () => {
      expect(() =>
        service.validateAndParseQuery({ action: 'INVALID_ACTION' }, { maxLimit: 100 }),
      ).toThrow('Invalid action: INVALID_ACTION');

      const parsed = service.validateAndParseQuery({ action: 'CONTRACT_CREATED' }, { maxLimit: 100 });
      expect(parsed.query.action).toBe('CONTRACT_CREATED');
    });

    it('validates severity field', () => {
      expect(() =>
        service.validateAndParseQuery({ severity: 'SUPER_CRITICAL' }, { maxLimit: 100 }),
      ).toThrow('Invalid severity: SUPER_CRITICAL');

      const parsed = service.validateAndParseQuery({ severity: 'CRITICAL' }, { maxLimit: 100 });
      expect(parsed.query.severity).toBe('CRITICAL');
    });

    it('parses limit and clamps to maxLimit', () => {
      expect(() =>
        service.validateAndParseQuery({ limit: '0' }, { maxLimit: 100 }),
      ).toThrow('Invalid limit');

      expect(() =>
        service.validateAndParseQuery({ limit: '-5' }, { maxLimit: 100 }),
      ).toThrow('Invalid limit');

      expect(() =>
        service.validateAndParseQuery({ limit: 'abc' }, { maxLimit: 100 }),
      ).toThrow('Invalid limit');

      const parsedClamped = service.validateAndParseQuery({ limit: '200' }, { maxLimit: 100 });
      expect(parsedClamped.limit).toBe(100);

      const parsedDefault = service.validateAndParseQuery({}, { defaultLimit: 50, maxLimit: 100 });
      expect(parsedDefault.limit).toBe(50);
    });

    it('parses offset', () => {
      expect(() =>
        service.validateAndParseQuery({ offset: '-1' }, { maxLimit: 100 }),
      ).toThrow('Invalid offset');

      expect(() =>
        service.validateAndParseQuery({ offset: 'xyz' }, { maxLimit: 100 }),
      ).toThrow('Invalid offset');

      const parsed = service.validateAndParseQuery({ offset: '25' }, { maxLimit: 100 });
      expect(parsed.offset).toBe(25);
    });

    it('parses optional ISO date timestamps', () => {
      expect(() =>
        service.validateAndParseQuery({ from: 'invalid-date' }, { maxLimit: 100 }),
      ).toThrow('Invalid from timestamp');

      expect(() =>
        service.validateAndParseQuery({ to: 'invalid-date' }, { maxLimit: 100 }),
      ).toThrow('Invalid to timestamp');

      const parsed = service.validateAndParseQuery(
        { from: '2026-01-01T00:00:00Z', to: '2026-01-31T23:59:59Z' },
        { maxLimit: 100 },
      );
      expect(parsed.query.from).toBe('2026-01-01T00:00:00.000Z');
      expect(parsed.query.to).toBe('2026-01-31T23:59:59.000Z');
    });

    it('validates cursor format', () => {
      expect(() =>
        service.validateAndParseQuery({ cursor: 'not-a-valid-cursor' }, { maxLimit: 100 }),
      ).toThrow('Invalid cursor format');
    });
  });

  describe('queryLogs', () => {
    it('returns offset-based result when cursor is not provided', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      const mockEntry = service.log({
        action: 'CONTRACT_CREATED',
        severity: 'INFO',
        actor: 'user1',
        resource: 'contract',
        resourceId: 'c1',
        metadata: {},
      });

      jest.spyOn(repo, 'query').mockReturnValue([mockEntry]);

      const result = service.queryLogs({ limit: '10', offset: '0' });
      expect(result).toMatchObject({
        count: 1,
        limit: 10,
        offset: 0,
      });
      expect(result.entries).toHaveLength(1);
    });

    it('returns cursor-based result when cursor is provided', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      jest.spyOn(repo, 'queryWithCursor').mockReturnValue({
        entries: [],
        count: 0,
        limit: 10,
        nextCursor: undefined,
      });

      const validCursor = Buffer.from(JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', id: '123' })).toString('base64url');
      const result = service.queryLogs({ cursor: validCursor });

      expect(result).toHaveProperty('nextCursor');
      expect(result.limit).toBe(10);
    });
  });

  describe('exportAuditLogs', () => {
    it('orchestrates NDJSON export and logs compliance ADMIN_ACTION entry', async () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      const mockReadStream = {} as any;
      const mockExportResult: AuditExportResult = {
        filePath: '/tmp/export.ndjson',
        fileName: 'export.ndjson',
        bytesWritten: 1234,
        recordCount: 5,
        openReadStream: jest.fn().mockReturnValue(mockReadStream),
        cleanup: jest.fn().mockResolvedValue(undefined),
      };

      const mockExportService: AuditExportService = {
        createNdjsonExport: jest.fn().mockResolvedValue(mockExportResult),
      } as any;

      const result = await service.exportAuditLogs(
        { action: 'CONTRACT_CREATED', limit: '100' },
        { actor: 'admin-user', ipAddress: '192.168.1.1', correlationId: 'req-123' },
        mockExportService,
      );

      expect(result).toBe(mockExportResult);
      expect(mockExportService.createNdjsonExport).toHaveBeenCalledWith({
        action: 'CONTRACT_CREATED',
        limit: 100,
      });

      expect(repo.appendedInputs).toHaveLength(1);
      const auditLog = repo.appendedInputs[0];
      expect(auditLog.action).toBe('ADMIN_ACTION');
      expect(auditLog.severity).toBe('CRITICAL');
      expect(auditLog.actor).toBe('admin-user');
      expect(auditLog.resource).toBe('audit-log');
      expect(auditLog.resourceId).toBe('export');
      expect(auditLog.ipAddress).toBe('192.168.1.1');
      expect(auditLog.correlationId).toBe('req-123');
      expect(auditLog.metadata).toMatchObject({
        operation: 'export',
        format: 'ndjson',
        recordCount: 5,
        bytesWritten: 1234,
      });
    });
  });

  describe('checkIntegrity and getEntry', () => {
    it('checkIntegrity maps valid:true to 200 and valid:false to 409', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);

      const reportValid: IntegrityReport = { valid: true, totalEntries: 10, checkedAt: '2026-01-15T10:00:00.000Z' };
      const reportInvalid: IntegrityReport = { valid: false, totalEntries: 10, firstCorruptedIndex: 2, firstCorruptedId: 'id-2', checkedAt: '2026-01-15T10:00:00.000Z' };

      jest.spyOn(repo, 'verifyIntegrity').mockReturnValue(reportValid);
      expect(service.checkIntegrity()).toEqual({
        report: reportValid,
        status: 200,
      });

      jest.spyOn(repo, 'verifyIntegrity').mockReturnValue(reportInvalid);
      expect(service.checkIntegrity()).toEqual({
        report: reportInvalid,
        status: 409,
      });
    });

    it('getEntry delegates to getById', () => {
      const repo = makeMockRepository();
      const service = new AuditService(repo);
      const spy = jest.spyOn(repo, 'getById').mockReturnValue(undefined);

      expect(service.getEntry('id-999')).toBeUndefined();
      expect(spy).toHaveBeenCalledWith('id-999');
    });
  });
});

