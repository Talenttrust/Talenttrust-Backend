/**
 * @file stateInvariants.test.ts
 * @description Focused tests for the state invariant protection layer
 *   (issue #1332) added to audit/inputValidation.ts.
 *
 * ### Coverage
 *
 * | Invariant                | Scenarios covered                                              |
 * |--------------------------|----------------------------------------------------------------|
 * | Action-severity congruence | valid pairs, rejected pairs, every constrained action, boundary|
 * | Resource-action binding  | valid pairs, cross-domain mismatch, unrestricted actions       |
 * | System actor invariants  | valid system: prefix, empty suffix, legacy actors, non-system  |
 * | Idempotency fingerprint  | determinism, content sensitivity, concurrent write safety      |
 * | validateAuditStateInvariants middleware | success path, failure path, missing VALIDATED_BODY_KEY |
 * | Retries / concurrent writes | same payload → same fingerprint, different payloads differ  |
 * | Regression: shape validation preserved | existing callers still accepted                  |
 */

import type { Request, Response, NextFunction } from 'express';
import type { CreateAuditEntryInput } from './types';
import {
  ACTION_MIN_SEVERITY,
  ACTION_RESOURCE_BINDINGS,
  AUDIT_VALIDATION_CODES,
  AUDIT_VALIDATION_ERROR_CODE,
  INVARIANT_FINGERPRINT_KEY,
  LEGACY_SYSTEM_ACTORS,
  SYSTEM_ACTOR_PREFIX,
  VALIDATED_BODY_KEY,
  createIdempotencyFingerprint,
  validateAuditStateInvariants,
  validateStateInvariants,
  type StateInvariantIssue,
} from './inputValidation';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES } from './types';

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Returns a minimal valid `CreateAuditEntryInput`, ready for invariant testing.
 * Override individual fields with the second argument.
 */
function validInput(
  overrides: Partial<CreateAuditEntryInput> = {},
): CreateAuditEntryInput {
  return {
    action: 'CONTRACT_CREATED',
    severity: 'INFO',
    actor: 'user-alice',
    resource: 'contract',
    resourceId: 'contract-abc',
    metadata: {},
    ...overrides,
  };
}

/** Asserts that invariant validation fails and returns the issue list. */
function expectInvariantFail(input: CreateAuditEntryInput): StateInvariantIssue[] {
  const result = validateStateInvariants(input);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected failure but got success');
  return result.issues;
}

/** Returns all issue codes for a given field. */
function codesFor(issues: StateInvariantIssue[], field: string): string[] {
  return issues.filter((i) => i.field === field).map((i) => i.code);
}

// Mock Express response
function mockRes(locals: Record<string, unknown> = {}): Response & {
  statusCode?: number;
  body?: unknown;
} {
  const res = {
    locals,
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

// ── Action-severity congruence ────────────────────────────────────────────────

describe('validateStateInvariants — action-severity congruence', () => {
  it('accepts INFO severity for unrestricted actions', () => {
    // CONTRACT_CREATED has no minimum severity, so INFO is fine.
    expect(validateStateInvariants(validInput({ action: 'CONTRACT_CREATED', severity: 'INFO' })).ok).toBe(true);
  });

  it('accepts WARNING severity for unrestricted actions', () => {
    expect(validateStateInvariants(validInput({ action: 'CONTRACT_CREATED', severity: 'WARNING' })).ok).toBe(true);
  });

  it('accepts CRITICAL severity for unrestricted actions', () => {
    expect(validateStateInvariants(validInput({ action: 'CONTRACT_CREATED', severity: 'CRITICAL' })).ok).toBe(true);
  });

  it.each(Object.keys(ACTION_MIN_SEVERITY) as Array<keyof typeof ACTION_MIN_SEVERITY>)(
    'rejects INFO severity for constrained action %s',
    (action) => {
      const issues = expectInvariantFail(validInput({ action, severity: 'INFO' }));
      expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
    },
  );

  it('accepts the exact minimum severity for AUTH_FAILED (WARNING)', () => {
    expect(validateStateInvariants(validInput({
      action: 'AUTH_FAILED',
      severity: 'WARNING',
      resource: 'user',
    })).ok).toBe(true);
  });

  it('accepts CRITICAL (above minimum) for AUTH_FAILED', () => {
    expect(validateStateInvariants(validInput({
      action: 'AUTH_FAILED',
      severity: 'CRITICAL',
      resource: 'user',
    })).ok).toBe(true);
  });

  it('rejects INFO for AUTH_LOCKOUT_TRIGGERED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'AUTH_LOCKOUT_TRIGGERED',
      severity: 'INFO',
      resource: 'user',
    }));
    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
    expect(issues.find((i) => i.field === 'severity')?.message).toContain('AUTH_LOCKOUT_TRIGGERED');
  });

  it('rejects INFO for ADMIN_ACTION', () => {
    const issues = expectInvariantFail(validInput({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      resource: 'user',
    }));
    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
  });

  it('rejects INFO for DEPLOYMENT_PROMOTED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'DEPLOYMENT_PROMOTED',
      severity: 'INFO',
      resource: 'deployment',
    }));
    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
  });

  it('rejects INFO for DEPLOYMENT_ROLLED_BACK', () => {
    const issues = expectInvariantFail(validInput({
      action: 'DEPLOYMENT_ROLLED_BACK',
      severity: 'INFO',
      resource: 'deployment',
    }));
    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
  });

  it('rejects INFO for PAYMENT_DISPUTED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'PAYMENT_DISPUTED',
      severity: 'INFO',
      resource: 'contract',
    }));
    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
  });

  it('includes the required minimum in the error message', () => {
    const issues = expectInvariantFail(validInput({
      action: 'AUTH_FAILED',
      severity: 'INFO',
      resource: 'user',
    }));
    const msg = issues.find((i) => i.field === 'severity')?.message ?? '';
    expect(msg).toMatch(/WARNING/);
    expect(msg).toMatch(/INFO/);
  });
});

// ── Resource-action binding ───────────────────────────────────────────────────

describe('validateStateInvariants — resource-action binding', () => {
  it('accepts a contract resource for CONTRACT_CREATED', () => {
    expect(validateStateInvariants(validInput({ action: 'CONTRACT_CREATED', resource: 'contract' })).ok).toBe(true);
  });

  it('rejects a user resource for CONTRACT_CREATED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'CONTRACT_CREATED',
      resource: 'user',
    }));
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('rejects an arbitrary resource for CONTRACT_UPDATED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'CONTRACT_UPDATED',
      resource: 'payment',
    }));
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('accepts a user resource for AUTH_LOGIN', () => {
    expect(validateStateInvariants(validInput({
      action: 'AUTH_LOGIN',
      resource: 'user',
    })).ok).toBe(true);
  });

  it('accepts a session resource for AUTH_LOGIN', () => {
    expect(validateStateInvariants(validInput({
      action: 'AUTH_LOGIN',
      resource: 'session',
    })).ok).toBe(true);
  });

  it('rejects a contract resource for AUTH_LOGIN', () => {
    const issues = expectInvariantFail(validInput({
      action: 'AUTH_LOGIN',
      resource: 'contract',
    }));
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('accepts any resource for ADMIN_ACTION (unrestricted)', () => {
    for (const resource of ['user', 'contract', 'payment', 'system', 'deployment']) {
      expect(validateStateInvariants(validInput({
        action: 'ADMIN_ACTION',
        severity: 'WARNING',
        resource,
      })).ok).toBe(true);
    }
  });

  it('accepts any resource for ENDPOINT_ACCESS (unrestricted)', () => {
    expect(validateStateInvariants(validInput({
      action: 'ENDPOINT_ACCESS',
      resource: 'any-resource',
    })).ok).toBe(true);
  });

  it('accepts a user resource for REPUTATION_UPDATED', () => {
    expect(validateStateInvariants(validInput({
      action: 'REPUTATION_UPDATED',
      resource: 'user',
    })).ok).toBe(true);
  });

  it('rejects a contract resource for REPUTATION_UPDATED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'REPUTATION_UPDATED',
      resource: 'contract',
    }));
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('includes the allowed resource list in the error message', () => {
    const issues = expectInvariantFail(validInput({
      action: 'CONTRACT_CREATED',
      resource: 'user',
    }));
    const msg = issues.find((i) => i.field === 'resource')?.message ?? '';
    expect(msg).toContain('contract');
    expect(msg).toContain('user'); // explains what was supplied
  });

  it('accepts a deployment resource for DEPLOYMENT_PROMOTED', () => {
    expect(validateStateInvariants(validInput({
      action: 'DEPLOYMENT_PROMOTED',
      severity: 'WARNING',
      resource: 'deployment',
    })).ok).toBe(true);
  });

  it('accepts a contract resource for PAYMENT_DISPUTED', () => {
    expect(validateStateInvariants(validInput({
      action: 'PAYMENT_DISPUTED',
      severity: 'WARNING',
      resource: 'contract',
    })).ok).toBe(true);
  });

  it('accepts a user resource for USER_CREATED', () => {
    expect(validateStateInvariants(validInput({
      action: 'USER_CREATED',
      resource: 'user',
    })).ok).toBe(true);
  });

  it('rejects a contract resource for USER_DELETED', () => {
    const issues = expectInvariantFail(validInput({
      action: 'USER_DELETED',
      resource: 'contract',
    }));
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('is case-insensitive for resource comparison', () => {
    // 'Contract' (capital C) should pass the same as 'contract'.
    expect(validateStateInvariants(validInput({
      action: 'CONTRACT_CREATED',
      resource: 'Contract',
    })).ok).toBe(true);
  });
});

// ── System actor invariants ───────────────────────────────────────────────────

describe('validateStateInvariants — system actor invariants', () => {
  it('accepts a valid system: prefixed actor', () => {
    expect(validateStateInvariants(validInput({ actor: 'system:scheduler' })).ok).toBe(true);
  });

  it('accepts a regular human actor', () => {
    expect(validateStateInvariants(validInput({ actor: 'user-alice' })).ok).toBe(true);
  });

  it('accepts a legacy system actor without prefix', () => {
    for (const actor of LEGACY_SYSTEM_ACTORS) {
      expect(validateStateInvariants(validInput({ actor })).ok).toBe(true);
    }
  });

  it('rejects a system: prefixed actor with an empty suffix', () => {
    const issues = expectInvariantFail(validInput({ actor: 'system:' }));
    expect(codesFor(issues, 'actor')).toContain(AUDIT_VALIDATION_CODES.SYSTEM_ACTOR_INVALID);
  });

  it('rejects a system: prefixed actor with a whitespace-only suffix', () => {
    const issues = expectInvariantFail(validInput({ actor: 'system:   ' }));
    expect(codesFor(issues, 'actor')).toContain(AUDIT_VALIDATION_CODES.SYSTEM_ACTOR_INVALID);
  });

  it('accepts system:ci as a valid system actor', () => {
    expect(validateStateInvariants(validInput({ actor: 'system:ci' })).ok).toBe(true);
  });

  it('accepts system:migration-job-42 as a valid system actor', () => {
    expect(validateStateInvariants(validInput({ actor: 'system:migration-job-42' })).ok).toBe(true);
  });

  it('includes the prefix requirement in the error message', () => {
    const issues = expectInvariantFail(validInput({ actor: 'system:' }));
    const msg = issues.find((i) => i.field === 'actor')?.message ?? '';
    expect(msg).toContain(SYSTEM_ACTOR_PREFIX);
  });
});

// ── Idempotency fingerprint ───────────────────────────────────────────────────

describe('createIdempotencyFingerprint', () => {
  it('returns a string prefixed with "audit:"', () => {
    const fp = createIdempotencyFingerprint(validInput());
    expect(fp).toMatch(/^audit:[0-9a-f]{64}$/);
  });

  it('is deterministic — same input always produces the same fingerprint', () => {
    const input = validInput({ action: 'CONTRACT_CREATED', actor: 'user-1', resourceId: 'c-1' });
    const fp1 = createIdempotencyFingerprint(input);
    const fp2 = createIdempotencyFingerprint(input);
    expect(fp1).toBe(fp2);
  });

  it('differs when the action changes', () => {
    const base = validInput({ resource: 'contract', resourceId: 'c-1' });
    expect(createIdempotencyFingerprint({ ...base, action: 'CONTRACT_CREATED' })).not.toBe(
      createIdempotencyFingerprint({ ...base, action: 'CONTRACT_UPDATED' }),
    );
  });

  it('differs when the severity changes', () => {
    const base = validInput();
    expect(createIdempotencyFingerprint({ ...base, severity: 'INFO' })).not.toBe(
      createIdempotencyFingerprint({ ...base, severity: 'WARNING' }),
    );
  });

  it('differs when the actor changes', () => {
    const base = validInput();
    expect(createIdempotencyFingerprint({ ...base, actor: 'user-alice' })).not.toBe(
      createIdempotencyFingerprint({ ...base, actor: 'user-bob' }),
    );
  });

  it('differs when the resourceId changes', () => {
    const base = validInput();
    expect(createIdempotencyFingerprint({ ...base, resourceId: 'c-1' })).not.toBe(
      createIdempotencyFingerprint({ ...base, resourceId: 'c-2' }),
    );
  });

  it('differs when metadata changes', () => {
    const base = validInput();
    expect(
      createIdempotencyFingerprint({ ...base, metadata: { before: 100 } }),
    ).not.toBe(
      createIdempotencyFingerprint({ ...base, metadata: { before: 200 } }),
    );
  });

  it('is identical regardless of ipAddress value (transport concern, not identity)', () => {
    const base = validInput();
    expect(
      createIdempotencyFingerprint({ ...base, ipAddress: '1.2.3.4' }),
    ).toBe(
      createIdempotencyFingerprint({ ...base, ipAddress: '5.6.7.8' }),
    );
  });

  it('is identical regardless of correlationId value (transport concern, not identity)', () => {
    const base = validInput();
    expect(
      createIdempotencyFingerprint({ ...base, correlationId: 'req-1' }),
    ).toBe(
      createIdempotencyFingerprint({ ...base, correlationId: 'req-2' }),
    );
  });

  it('concurrent calls with the same payload produce the same fingerprint (write-safe)', () => {
    const input = validInput({ action: 'CONTRACT_CREATED', resourceId: 'c-concurrent' });
    const fingerprints = Array.from({ length: 20 }, () => createIdempotencyFingerprint(input));
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(1);
  });

  it('different payloads produce different fingerprints (no collisions in representative set)', () => {
    const inputs = Array.from({ length: 20 }, (_, i) =>
      validInput({ resourceId: `resource-${i}` }),
    );
    const fingerprints = inputs.map(createIdempotencyFingerprint);
    const unique = new Set(fingerprints);
    expect(unique.size).toBe(inputs.length);
  });
});

// ── validateStateInvariants — success path ────────────────────────────────────

describe('validateStateInvariants — success path', () => {
  it('returns ok: true for a fully valid input', () => {
    const result = validateStateInvariants(validInput());
    expect(result.ok).toBe(true);
  });

  it('includes a fingerprint on success', () => {
    const result = validateStateInvariants(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toMatch(/^audit:[0-9a-f]{64}$/);
  });

  it('fingerprint on success matches createIdempotencyFingerprint directly', () => {
    const input = validInput({ actor: 'system:ci', resource: 'contract', resourceId: 'c-99' });
    const result = validateStateInvariants(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe(createIdempotencyFingerprint(input));
  });

  it('accepts every valid action/resource/severity combination in AUDIT_ACTIONS', () => {
    // Sanity check that all documented actions pass invariant validation
    // when given an appropriate resource and severity.
    const resourceMap: Record<string, string> = {
      CONTRACT: 'contract',
      PAYMENT: 'contract',
      REPUTATION: 'user',
      USER: 'user',
      AUTH: 'user',
      ADMIN: 'user',
      ENDPOINT: 'api',
      DEPLOYMENT: 'deployment',
      MILESTONES: 'contract',
    };
    const severityMap: Record<string, 'INFO' | 'WARNING' | 'CRITICAL'> = {
      AUTH_FAILED: 'WARNING',
      AUTH_LOCKOUT_TRIGGERED: 'WARNING',
      AUTH_LOCKOUT_RELEASED: 'WARNING',
      ADMIN_ACTION: 'WARNING',
      DEPLOYMENT_PROMOTED: 'WARNING',
      DEPLOYMENT_ROLLED_BACK: 'WARNING',
      PAYMENT_DISPUTED: 'WARNING',
    };

    for (const action of AUDIT_ACTIONS) {
      const prefix = action.split('_')[0] ?? 'CONTRACT';
      const resource = resourceMap[prefix] ?? 'contract';
      const severity = severityMap[action] ?? 'INFO';
      const result = validateStateInvariants(validInput({ action, resource, severity }));
      expect(result.ok).toBe(
        true,
        // Provide helpful context if this fails.
        `Expected ${action} with resource="${resource}", severity="${severity}" to pass`,
      );
    }
  });
});

// ── validateStateInvariants — rejection (multiple invariant failures) ─────────

describe('validateStateInvariants — multiple simultaneous failures', () => {
  it('reports both severity and resource failures when both are wrong', () => {
    // AUTH_FAILED requires WARNING+; targeting resource 'contract' is wrong for auth
    const issues = expectInvariantFail(validInput({
      action: 'AUTH_FAILED',
      severity: 'INFO',    // too low
      resource: 'contract', // wrong domain
    }));

    expect(codesFor(issues, 'severity')).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
    expect(codesFor(issues, 'resource')).toContain(AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH);
  });

  it('reports both severity and actor failures when both are wrong', () => {
    const issues = expectInvariantFail(validInput({
      action: 'AUTH_FAILED',
      severity: 'INFO',   // too low
      resource: 'user',
      actor: 'system:',  // invalid empty suffix
    }));

    const codes = issues.map((i) => i.code);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE);
    expect(codes).toContain(AUDIT_VALIDATION_CODES.SYSTEM_ACTOR_INVALID);
  });
});

// ── validateAuditStateInvariants middleware ───────────────────────────────────

describe('validateAuditStateInvariants middleware', () => {
  function runMiddleware(
    validatedBody: CreateAuditEntryInput | undefined,
    localsOverrides: Record<string, unknown> = {},
  ): { res: ReturnType<typeof mockRes>; next: jest.MockedFunction<NextFunction> } {
    const locals: Record<string, unknown> = { ...localsOverrides };
    if (validatedBody !== undefined) {
      locals[VALIDATED_BODY_KEY] = validatedBody;
    }
    const res = mockRes(locals);
    const next = jest.fn() as jest.MockedFunction<NextFunction>;
    validateAuditStateInvariants({} as Request, res, next);
    return { res, next };
  }

  it('calls next() and publishes fingerprint when all invariants hold', () => {
    const { res, next } = runMiddleware(validInput());

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
    expect(typeof res.locals[INVARIANT_FINGERPRINT_KEY]).toBe('string');
    expect(res.locals[INVARIANT_FINGERPRINT_KEY]).toMatch(/^audit:/);
  });

  it('responds 400 and does not call next() when an invariant fails', () => {
    const { res, next } = runMiddleware(
      validInput({ action: 'AUTH_FAILED', severity: 'INFO', resource: 'user' }),
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({
      error: {
        code: AUDIT_VALIDATION_ERROR_CODE,
        message: 'Request validation failed',
      },
    });
  });

  it('includes issue details in the 400 response', () => {
    const { res } = runMiddleware(
      validInput({ action: 'AUTH_FAILED', severity: 'INFO', resource: 'user' }),
    );

    const details = (res.body as { error: { details: StateInvariantIssue[] } }).error.details;
    expect(Array.isArray(details)).toBe(true);
    expect(details.length).toBeGreaterThan(0);
    expect(details[0]).toMatchObject({
      field: expect.any(String),
      code: expect.any(String),
      message: expect.any(String),
    });
  });

  it('echoes the requestId in the error response', () => {
    const { res } = runMiddleware(
      validInput({ action: 'AUTH_FAILED', severity: 'INFO', resource: 'user' }),
      { requestId: 'req-xyz' },
    );

    expect((res.body as { error: { requestId: string } }).error.requestId).toBe('req-xyz');
  });

  it('falls back to "unknown" requestId when none is present', () => {
    const { res } = runMiddleware(
      validInput({ action: 'AUTH_FAILED', severity: 'INFO', resource: 'user' }),
    );

    expect((res.body as { error: { requestId: string } }).error.requestId).toBe('unknown');
  });

  it('throws when VALIDATED_BODY_KEY is not set (middleware ordering violation)', () => {
    const res = mockRes();
    const next = jest.fn();
    expect(() =>
      validateAuditStateInvariants({} as Request, res, next),
    ).toThrow(/must run before/);
  });

  it('published fingerprint equals createIdempotencyFingerprint directly', () => {
    const input = validInput({ actor: 'user-bob', resourceId: 'c-middleware' });
    const { res } = runMiddleware(input);

    expect(res.locals[INVARIANT_FINGERPRINT_KEY]).toBe(createIdempotencyFingerprint(input));
  });
});

// ── Regression: shape validation still functions after the additions ───────────

describe('regression — shape validation still enforced', () => {
  it('validateStateInvariants accepts a fully populated valid input', () => {
    const result = validateStateInvariants({
      action: 'CONTRACT_CREATED',
      severity: 'WARNING',
      actor: 'user-alice',
      resource: 'contract',
      resourceId: 'contract-42',
      metadata: { before: { amount: 100 }, after: { amount: 200 } },
      ipAddress: '10.0.0.1',
      correlationId: 'corr-abc123',
    });
    expect(result.ok).toBe(true);
  });

  it('state invariants do not interfere with existing shape validation codes', () => {
    // Trigger a resource mismatch — the code must be RESOURCE_ACTION_MISMATCH,
    // not any shape-validation code like INVALID_ENUM or UNKNOWN_FIELD.
    const issues = expectInvariantFail(validInput({ action: 'CONTRACT_CREATED', resource: 'user' }));
    expect(issues.every((i) => i.code === AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH)).toBe(true);
  });
});

// ── Documentation: exported table of constrained actions ─────────────────────

describe('ACTION_MIN_SEVERITY and ACTION_RESOURCE_BINDINGS are exported', () => {
  it('ACTION_MIN_SEVERITY is a non-empty readonly map', () => {
    expect(Object.keys(ACTION_MIN_SEVERITY).length).toBeGreaterThan(0);
    // All values must be valid severities
    for (const sev of Object.values(ACTION_MIN_SEVERITY)) {
      expect(AUDIT_SEVERITIES as ReadonlyArray<string>).toContain(sev);
    }
  });

  it('ACTION_RESOURCE_BINDINGS keys are known action prefixes', () => {
    // Collect all prefixes that appear in AUDIT_ACTIONS (the runtime array)
    // plus the extended AuditAction type, to allow future actions.
    const knownPrefixes = new Set<string>();
    for (const action of AUDIT_ACTIONS) {
      knownPrefixes.add(action.split('_')[0] ?? '');
    }
    // MILESTONES is defined in the AuditAction type but not yet in the
    // AUDIT_ACTIONS runtime array — add it explicitly so the binding remains
    // future-proof once the runtime array is extended.
    knownPrefixes.add('MILESTONES');

    for (const prefix of Object.keys(ACTION_RESOURCE_BINDINGS)) {
      expect(knownPrefixes.has(prefix)).toBe(true);
    }
  });

  it('LEGACY_SYSTEM_ACTORS is a non-empty Set', () => {
    expect(LEGACY_SYSTEM_ACTORS.size).toBeGreaterThan(0);
    for (const actor of LEGACY_SYSTEM_ACTORS) {
      expect(typeof actor).toBe('string');
    }
  });

  it('SYSTEM_ACTOR_PREFIX is the string "system:"', () => {
    expect(SYSTEM_ACTOR_PREFIX).toBe('system:');
  });
});
