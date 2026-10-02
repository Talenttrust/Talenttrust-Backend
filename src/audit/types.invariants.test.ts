/**
 * @file types.invariants.test.ts
 * @description Pins the audit *vocabulary* invariant owned by `./types.ts`:
 * `AUDIT_ACTIONS` and the `AuditAction` type must describe the same set, and
 * every validator in the module (`schemas`, `service`, `inputValidation`) must
 * consume that one set rather than a hand-mirrored copy.
 *
 * The failure this guards against is silent drift: before this change the
 * runtime array, the `AuditAction` union, and the copies in `schemas.ts` /
 * `service.ts` had already diverged, so an action such as `MILESTONES_DELETED`
 * (which the service itself emits) was legal in TypeScript but rejected by the
 * HTTP write/query validators.
 */

import {
  AUDIT_ACTIONS,
  AUDIT_SEVERITIES,
  isAuditAction,
  isAuditSeverity,
  type AuditAction,
  type AuditSeverity,
} from './types';
import { auditActionSchema, auditSeveritySchema } from './schemas';
import { VALID_ACTIONS } from './service';

/**
 * Compile-time completeness pin: `Record<AuditAction, true>` requires a key for
 * every member of the union (and forbids unknown keys). If a future change
 * removes an action from `AUDIT_ACTIONS` (and therefore from `AuditAction`) or
 * renames one, this object stops type-checking.
 */
const AUDIT_ACTION_TABLE: Record<AuditAction, true> = {
  CONTRACT_CREATED: true,
  CONTRACT_UPDATED: true,
  CONTRACT_CANCELLED: true,
  CONTRACT_COMPLETED: true,
  CONTRACT_DELETED: true,
  PAYMENT_INITIATED: true,
  PAYMENT_RELEASED: true,
  PAYMENT_DISPUTED: true,
  REPUTATION_UPDATED: true,
  REPUTATION_CORRECTED: true,
  USER_CREATED: true,
  USER_UPDATED: true,
  USER_DELETED: true,
  AUTH_LOGIN: true,
  AUTH_LOGOUT: true,
  AUTH_FAILED: true,
  AUTH_LOCKOUT_TRIGGERED: true,
  AUTH_LOCKOUT_RELEASED: true,
  ADMIN_ACTION: true,
  ENDPOINT_ACCESS: true,
  ENDPOINT_MUTATION: true,
  DEPLOYMENT_PROMOTED: true,
  DEPLOYMENT_ROLLED_BACK: true,
  MILESTONES_CREATED: true,
  MILESTONES_UPDATED: true,
  MILESTONES_DELETED: true,
};

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe('audit vocabulary — AUDIT_ACTIONS is the single source of truth', () => {
  it('contains no duplicate actions', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('matches the AuditAction union exactly (no extra or missing members)', () => {
    // `AuditAction` is derived from AUDIT_ACTIONS, so this asserts the derived
    // type has not been re-declared by hand anywhere in the future.
    expect(sorted(Object.keys(AUDIT_ACTION_TABLE))).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('retains the actions that the union allowed but the runtime list omitted', () => {
    // Regression: these four were legal `AuditAction`s but absent from the
    // runtime array consumed by the validators, so they were unreachable
    // through every ingest path even though the service emits them.
    expect(AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'CONTRACT_DELETED',
        'MILESTONES_CREATED',
        'MILESTONES_UPDATED',
        'MILESTONES_DELETED',
      ]),
    );
  });

  it('keeps AUDIT_SEVERITIES exhaustive for AuditSeverity', () => {
    const table: Record<AuditSeverity, true> = { INFO: true, WARNING: true, CRITICAL: true };
    expect(sorted(Object.keys(table))).toEqual(sorted(AUDIT_SEVERITIES));
  });
});

describe('isAuditAction / isAuditSeverity runtime guards', () => {
  it.each(AUDIT_ACTIONS)('accepts known action %s', (action) => {
    expect(isAuditAction(action)).toBe(true);
  });

  it.each([undefined, null, 42, {}, [], '', 'NOT_REAL', 'contract_created'])(
    'rejects non-action %p',
    (value) => {
      expect(isAuditAction(value)).toBe(false);
    },
  );

  it.each(AUDIT_SEVERITIES)('accepts known severity %s', (severity) => {
    expect(isAuditSeverity(severity)).toBe(true);
  });

  it.each([undefined, null, 0, {}, '', 'info', 'ERROR'])(
    'rejects non-severity %p',
    (value) => {
      expect(isAuditSeverity(value)).toBe(false);
    },
  );
});

describe('downstream validators consume the same vocabulary', () => {
  it('the HTTP action schema accepts every AUDIT_ACTIONS entry', () => {
    for (const action of AUDIT_ACTIONS) {
      expect(auditActionSchema.safeParse(action).success).toBe(true);
    }
  });

  it('the HTTP action schema enumerates exactly AUDIT_ACTIONS', () => {
    expect(sorted(auditActionSchema.options)).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('the HTTP severity schema enumerates exactly AUDIT_SEVERITIES', () => {
    expect(sorted(auditSeveritySchema.options)).toEqual(sorted(AUDIT_SEVERITIES));
  });

  it('the service VALID_ACTIONS set equals AUDIT_ACTIONS', () => {
    expect(sorted([...VALID_ACTIONS])).toEqual(sorted(AUDIT_ACTIONS));
  });

  it('still rejects unknown actions at every boundary', () => {
    expect(auditActionSchema.safeParse('NOT_REAL').success).toBe(false);
    expect(isAuditAction('NOT_REAL')).toBe(false);
  });
});
