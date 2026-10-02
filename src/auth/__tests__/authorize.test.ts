/**
 * Unit tests for `isAllowed` — the core authorization function.
 *
 * Tests the full access control matrix exhaustively with both positive
 * (allowed) and negative (denied) cases for every role-resource-action
 * combination.
 *
 * Additionally covers deterministic failure recovery: fail-closed
 * behavior on malformed inputs, invariance under repeated / concurrent
 * calls, and observability through the injectable logger.
 */

import { isAllowed, evaluateAuthorization, AuthorizationReason } from '../authorize';
import { Role, Resource, Action, ACCESS_CONTROL_MATRIX, VALID_ROLES } from '../roles';
import * as loggerModule from '../../logger';

const ALL_RESOURCES: Resource[] = ['contracts', 'users', 'reputation', 'disputes', 'health', 'api-keys'];
const ALL_ACTIONS: Action[] = ['create', 'read', 'update', 'delete'];

describe('isAllowed – exhaustive positive/negative matrix', () => {
  /**
   * Generate test cases from the matrix to cover every cell.
   * For each role × resource × action, the expected result is derived
   * directly from the matrix.
   */
  for (const role of VALID_ROLES) {
    describe(`role: ${role}`, () => {
      for (const resource of ALL_RESOURCES) {
        for (const action of ALL_ACTIONS) {
          const allowed =
            ACCESS_CONTROL_MATRIX[role][resource]?.includes(action) ?? false;

          if (allowed) {
            it(`ALLOW ${action} on ${resource}`, () => {
              expect(isAllowed(role, resource, action)).toBe(true);
            });
          } else {
            it(`DENY ${action} on ${resource}`, () => {
              expect(isAllowed(role, resource, action)).toBe(false);
            });
          }
        }
      }
    });
  }
});

describe('isAllowed – edge cases (deny-by-default)', () => {
  it('should deny an unknown role', () => {
    // Cast to bypass type checks — simulates runtime bad data.
    expect(isAllowed('hacker' as Role, 'contracts', 'read')).toBe(false);
  });

  it('should deny an unknown resource for a valid role', () => {
    expect(isAllowed('admin', 'secrets' as Resource, 'read')).toBe(false);
  });

  it('should deny an unknown action for a valid role and resource', () => {
    expect(isAllowed('admin', 'contracts', 'execute' as Action)).toBe(false);
  });

  it('should deny when role is empty string', () => {
    expect(isAllowed('' as Role, 'contracts', 'read')).toBe(false);
  });

  it('should deny when resource is empty string', () => {
    expect(isAllowed('admin', '' as Resource, 'read')).toBe(false);
  });

  it('should deny when action is empty string', () => {
    expect(isAllowed('admin', 'contracts', '' as Action)).toBe(false);
  });

  it('should deny when role is null/undefined (runtime bad data)', () => {
    expect(isAllowed(null as unknown as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed(undefined as unknown as Role, 'contracts', 'read')).toBe(false);
  });

  it('should deny when resource is null/undefined (runtime bad data)', () => {
    expect(isAllowed('admin', null as unknown as Resource, 'read')).toBe(false);
    expect(isAllowed('admin', undefined as unknown as Resource, 'read')).toBe(false);
  });

  it('should deny when action is null/undefined (runtime bad data)', () => {
    expect(isAllowed('admin', 'contracts', null as unknown as Action)).toBe(false);
    expect(isAllowed('admin', 'contracts', undefined as unknown as Action)).toBe(false);
  });

  it('should deny when identifiers are non-string primitives', () => {
    expect(isAllowed(123 as unknown as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed('admin', 456 as unknown as Resource, 'read')).toBe(false);
    expect(isAllowed('admin', 'contracts', 789 as unknown as Action)).toBe(false);
  });

  it('should deny when identifiers are objects (prototype pollution attempt)', () => {
    expect(isAllowed({} as unknown as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed('admin', {} as unknown as Resource, 'read')).toBe(false);
    expect(isAllowed('admin', 'contracts', {} as unknown as Action)).toBe(false);
  });

  it('should deny prototype-chain lookups (constructor/__proto__/toString)', () => {
    expect(isAllowed('constructor' as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed('__proto__' as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed('toString' as Role, 'contracts', 'read')).toBe(false);
    expect(isAllowed('admin', 'constructor' as Resource, 'read')).toBe(false);
    expect(isAllowed('admin', 'contracts', 'constructor' as Action)).toBe(false);
  });
});

describe('isAllowed – invariants: determinism & idempotency', () => {
  it('returns the same result for repeated invocations (idempotent retries)', () => {
    const cases: Array<[Role, Resource, Action]> = [
      ['admin', 'disputes', 'delete'],
      ['freelancer', 'contracts', 'create'],
      ['guest', 'contracts', 'read'],
      ['client', 'contracts', 'update'],
    ];

    for (const [role, resource, action] of cases) {
      const first = isAllowed(role, resource, action);
      for (let i = 0; i < 50; i++) {
        expect(isAllowed(role, resource, action)).toBe(first);
      }
    }
  });

  it('produces consistent results under concurrent invocation', async () => {
    const cases: Array<[Role, Resource, Action]> = [
      ['admin', 'disputes', 'delete'],
      ['freelancer', 'disputes', 'delete'],
      ['guest', 'health', 'read'],
      ['guest', 'contracts', 'read'],
      ['client', 'users', 'read'],
    ];

    const expected = cases.map(([r, res, a]) => isAllowed(r, res, a));

    const tasks = Array.from({ length: 200 }, (_, i) => {
      const caseIdx = i % cases.length;
      const [r, res, a] = cases[caseIdx];
      return Promise.resolve().then(() => {
        expect(isAllowed(r, res, a)).toBe(expected[caseIdx]);
        return isAllowed(r, res, a);
      });
    });

    const results = await Promise.all(tasks);
    for (let i = 0; i < results.length; i++) {
      expect(results[i]).toBe(expected[i % cases.length]);
    }
  });

  it('does not mutate the underlying access control matrix', () => {
    const snapshot = JSON.stringify(ACCESS_CONTROL_MATRIX);
    for (const role of VALID_ROLES) {
      for (const resource of ALL_RESOURCES) {
        for (const action of ALL_ACTIONS) {
          isAllowed(role, resource, action);
        }
      }
    }
    expect(JSON.stringify(ACCESS_CONTROL_MATRIX)).toBe(snapshot);
  });

  it('exposes a deep-frozen matrix that rejects mutation attempts', () => {
    const adminPerms = ACCESS_CONTROL_MATRIX['admin'] as Record<string, unknown>;
    expect(Object.isFrozen(adminPerms)).toBe(true);

    const contracts = adminPerms['contracts'] as unknown[];
    expect(Object.isFrozen(contracts)).toBe(true);

    // Attempting to mutate the frozen matrix must not change the decision.
    const before = isAllowed('guest', 'contracts', 'read');
    try {
      contracts.push('read');
    } catch {
      // Strict mode throws — expected.
    }
    expect(isAllowed('guest', 'contracts', 'read')).toBe(before);
  });
});

describe('isAllowed – validation boundaries', () => {
  describe('type boundary (non-string / null / undefined)', () => {
    const cases: Array<[string, unknown]> = [
      ['null role', null],
      ['undefined role', undefined],
      ['numeric role', 123],
      ['object role', {}],
      ['array role', []],
      ['boolean role', true],
    ];

    for (const [label, value] of cases) {
      it(`denies a ${label} without throwing', () => {
        expect(() => isAllowed(value as Role, 'contracts', 'read')).not.toThrow();
        expect(isAllowed(value as Role, 'contracts', 'read')).toBe(false);
      });
    }

    it('denies a null resource without throwing', () => {
      expect(isAllowed('admin', null as unknown as Resource, 'read')).toBe(false);
    });

    it('denies an undefined resource without throwing', () => {
      expect(isAllowed('admin', undefined as unknown as Resource, 'read')).toBe(false);
    });

    it('denies a null action without throwing', () => {
      expect(isAllowed('admin', 'contracts', null as unknown as Action)).toBe(false);
    });

    it('denies an undefined action without throwing', () => {
      expect(isAllowed('admin', 'contracts', undefined as unknown as Action)).toBe(false);
    });

    it('denies an empty resource string', () => {
      expect(isAllowed('admin', '' as Resource, 'read')).toBe(false);
    });

    it('denies an empty action string', () => {
      expect(isAllowed('admin', 'contracts', '' as Action)).toBe(false);
    });
  });

  describe('membership boundary', () => {
    it('denies a role that is not in VALID_ROLES', () => {
      expect(VALID_ROLES).not.toContain('superadmin' as Role);
      expect(isAllowed('superadmin' as Role, 'contracts', 'read')).toBe(false);
    });

    it('denies a resource that is not in VALID_RESOURCES', () => {
      expect(VALID_RESOURCES).not.toContain('payments' as Resource);
      expect(isAllowed('admin', 'payments' as Resource, 'read')).toBe(false);
    });

    it('denies an action that is not in VALID_ACTIONS', () => {
      expect(VALID_ACTIONS).not.toContain('approve' as Action);
      expect(isAllowed('admin', 'contracts', 'approve' as Action)).toBe(false);
    });
  });

  describe('matrix boundary (prototype pollution defense)', () => {
    const prototypeKeys = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

    for (const key of prototypeKeys) {
      it(`denies prototype key "${key}" as role`, () => {
        expect(isAllowed(key as Role, 'contracts', 'read')).toBe(false);
      });

      it(`denies prototype key "${key}" as resource`, () => {
        expect(isAllowed('admin', key as Resource, 'read')).toBe(false);
      });

      it(`denies prototype key "${key}" as action`, () => {
        expect(isAllowed('admin', 'contracts', key as Action)).toBe(false);
      });
    }
  });

  describe('action boundary', () => {
    it('denies an action not included in the permission array', () => {
      expect(isAllowed('guest', 'contracts', 'read')).toBe(false);
    });

    it('denies an action that is a case variant of a valid action', () => {
      expect(isAllowed('admin', 'contracts', 'READ' as Action)).toBe(false);
    });

    it('denies an action with leading/trailing whitespace', () => {
      expect(isAllowed('admin', 'contracts', ' read ' as Action)).toBe(false);
    });
  });
});

describe('isAllowed – determinism and concurrency', () => {
  it('returns the same result for repeated calls with identical inputs', () => {
    const inputs: Array<[Role, Resource, Action]> = [
      ['admin', 'contracts', 'read'],
      ['guest', 'contracts', 'read'],
      ['freelancer', 'disputes', 'delete'],
    ];

    for (const [role, resource, action] of inputs) {
      const first = isAllowed(role, resource, action);
      for (let i = 0; i < 50; i++) {
        expect(isAllowed(role, resource, action)).toBe(first);
      }
    }
  });

  it('produces identical results under concurrent calls', () => {
    const calls = Array.from({ length: 50 }, () => isAllowed('admin', 'contracts', 'read'));
    expect(new Set(calls)).toEqual(new Set([true]));
  });

  it('does not mutate the access control matrix', () => {
    const before = JSON.stringify(ACCESS_CONTROL_MATRIX);
    isAllowed('admin', 'contracts', 'read');
    isAllowed('guest', 'health', 'read');
    isAllowed('hacker' as Role, 'contracts', 'read');
    expect(JSON.stringify(ACCESS_CONTROL_MATRIX)).toBe(before);
  });
});

describe('isAllowed – specific business-logic scenarios', () => {
  it('admin can delete disputes', () => {
    expect(isAllowed('admin', 'disputes', 'delete')).toBe(true);
  });

  it('freelancer cannot delete disputes', () => {
    expect(isAllowed('freelancer', 'disputes', 'delete')).toBe(false);
  });

  it('client cannot delete contracts', () => {
    expect(isAllowed('client', 'contracts', 'delete')).toBe(false);
  });

  it('guest cannot read contracts', () => {
    expect(isAllowed('guest', 'contracts', 'read')).toBe(false);
  });

  it('guest can read health', () => {
    expect(isAllowed('guest', 'health', 'read')).toBe(true);
  });

  it('freelancer can create contracts', () => {
    expect(isAllowed('freelancer', 'contracts', 'create')).toBe(true);
  });

  it('client can update contracts', () => {
    expect(isAllowed('client', 'contracts', 'update')).toBe(true);
  });

  it('freelancer cannot update contracts', () => {
    expect(isAllowed('freelancer', 'contracts', 'update')).toBe(false);
  });
});

// ─── Compatibility contract: total & never throws ────────────────────────────

describe('isAllowed – compatibility contract: total over hostile input', () => {
  const HOSTILE_KEYS = [
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'valueOf',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
  ];

  const MALFORMED: unknown[] = [
    null,
    undefined,
    0,
    42,
    true,
    false,
    {},
    [],
    () => undefined,
    Symbol('x'),
    '',
    '   ',
  ];

  it.each(HOSTILE_KEYS)('denies inherited/prototype key used as role: %s', (key) => {
    for (const resource of ALL_RESOURCES) {
      for (const action of ALL_ACTIONS) {
        expect(() => isAllowed(key as Role, resource, action)).not.toThrow();
        expect(isAllowed(key as Role, resource, action)).toBe(false);
      }
    }
  });

  it.each(HOSTILE_KEYS)('denies inherited/prototype key used as resource: %s', (key) => {
    for (const role of VALID_ROLES) {
      for (const action of ALL_ACTIONS) {
        expect(() => isAllowed(role, key as Resource, action)).not.toThrow();
        expect(isAllowed(role, key as Resource, action)).toBe(false);
      }
    }
  });

  it.each(HOSTILE_KEYS)('denies inherited/prototype key used as action: %s', (key) => {
    for (const role of VALID_ROLES) {
      for (const resource of ALL_RESOURCES) {
        expect(() => isAllowed(role, resource, key as Action)).not.toThrow();
        expect(isAllowed(role, resource, key as Action)).toBe(false);
      }
    }
  });

  it.each(MALFORMED)('returns false (never throws) for malformed role: %p', (value) => {
    expect(() => isAllowed(value as Role, 'contracts', 'read')).not.toThrow();
    expect(isAllowed(value as Role, 'contracts', 'read')).toBe(false);
  });

  it.each(MALFORMED)('returns false (never throws) for malformed resource: %p', (value) => {
    expect(() => isAllowed('admin', value as Resource, 'read')).not.toThrow();
    expect(isAllowed('admin', value as Resource, 'read')).toBe(false);
  });

  it.each(MALFORMED)('returns false (never throws) for malformed action: %p', (value) => {
    expect(() => isAllowed('admin', 'contracts', value as Action)).not.toThrow();
    expect(isAllowed('admin', 'contracts', value as Action)).toBe(false);
  });

  it('regression: (admin, "constructor", "read") used to throw a TypeError', () => {
    // Before hardening, `permissions['constructor']` returned the inherited
    // Object constructor and `.includes` was not a function → TypeError.
    expect(() => isAllowed('admin', 'constructor' as Resource, 'read')).not.toThrow();
    expect(isAllowed('admin', 'constructor' as Resource, 'read')).toBe(false);
  });
});

// ─── Explicit decision API ───────────────────────────────────────────────────

describe('evaluateAuthorization – explicit reason codes', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(loggerModule.Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns allowed for an explicit grant', () => {
    expect(evaluateAuthorization('admin', 'disputes', 'delete')).toEqual({
      allowed: true,
      reason: 'allowed',
    });
  });

  it('returns role_not_registered for an unknown role', () => {
    expect(evaluateAuthorization('hacker', 'contracts', 'read')).toEqual({
      allowed: false,
      reason: 'role_not_registered',
    });
  });

  it('returns resource_not_registered for a resource unknown to every role', () => {
    expect(evaluateAuthorization('admin', 'secrets', 'read')).toEqual({
      allowed: false,
      reason: 'resource_not_registered',
    });
  });

  it('returns resource_not_permitted when a known resource is not granted to the role', () => {
    // `contracts` is known globally, but guest has no grant for it.
    expect(evaluateAuthorization('guest', 'contracts', 'read')).toEqual({
      allowed: false,
      reason: 'resource_not_permitted',
    });
  });

  it('returns action_not_recognized for an action outside the matrix', () => {
    expect(evaluateAuthorization('admin', 'contracts', 'execute')).toEqual({
      allowed: false,
      reason: 'action_not_recognized',
    });
  });

  it('returns action_not_permitted for a recognized but ungranted action', () => {
    expect(evaluateAuthorization('freelancer', 'disputes', 'delete')).toEqual({
      allowed: false,
      reason: 'action_not_permitted',
    });
  });

  it('returns invalid_input for malformed input', () => {
    expect(evaluateAuthorization('', 'contracts', 'read')).toEqual({
      allowed: false,
      reason: 'invalid_input',
    });
    expect(evaluateAuthorization(null, 'contracts', 'read')).toEqual({
      allowed: false,
      reason: 'invalid_input',
    });
  });

  it('regression: constructor resource is resource_not_registered, not a throw', () => {
    expect(evaluateAuthorization('admin', 'constructor', 'read')).toEqual({
      allowed: false,
      reason: 'resource_not_registered',
    });
  });

  it('exposes the documented reason taxonomy', () => {
    const documented: AuthorizationReason[] = [
      'allowed',
      'role_not_registered',
      'resource_not_registered',
      'resource_not_permitted',
      'action_not_recognized',
      'action_not_permitted',
      'invalid_input',
    ];
    expect(new Set(documented).size).toBe(documented.length);
  });
});

// ─── Observability: structured anomaly logging ───────────────────────────────

describe('evaluateAuthorization – observability', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(loggerModule.Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs a structured warn for an unknown role', () => {
    evaluateAuthorization('ghost', 'contracts', 'read');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('authorization_deny_unresolved_role');
    expect(fields).toEqual({
      reason: 'role_not_registered',
      role: 'ghost',
      resource: 'contracts',
      action: 'read',
    });
  });

  it('logs a structured warn for an unknown resource', () => {
    evaluateAuthorization('admin', 'secrets', 'read');

    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('authorization_deny_unresolved_resource');
    expect(fields).toMatchObject({ reason: 'resource_not_registered', resource: 'secrets' });
  });

  it('logs a structured warn for an unrecognized action', () => {
    evaluateAuthorization('admin', 'contracts', 'execute');

    const [message] = warnSpy.mock.calls[0] as [string];
    expect(message).toBe('authorization_deny_unrecognized_action');
  });

  it('logs invalid_input and never expands a caller payload', () => {
    const payload = { token: 'super-secret-token', ssn: '123-45-6789' };
    evaluateAuthorization('admin', 'contracts', payload);

    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe('authorization_deny_invalid_input');
    expect(fields).toEqual({
      reason: 'invalid_input',
      role: 'admin',
      resource: 'contracts',
      action: 'object',
    });
    expect(JSON.stringify(fields)).not.toContain('super-secret-token');
    expect(JSON.stringify(fields)).not.toContain('123-45-6789');
  });

  it('does NOT log an ordinary action denial', () => {
    const decision = evaluateAuthorization('freelancer', 'disputes', 'delete');
    expect(decision).toEqual({ allowed: false, reason: 'action_not_permitted' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT log an ordinary resource denial', () => {
    const decision = evaluateAuthorization('guest', 'contracts', 'read');
    expect(decision).toEqual({ allowed: false, reason: 'resource_not_permitted' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT log an allowed decision', () => {
    const decision = evaluateAuthorization('guest', 'health', 'read');
    expect(decision).toEqual({ allowed: true, reason: 'allowed' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Determinism, retries and concurrency ────────────────────────────────────

describe('isAllowed – determinism, retries and concurrency', () => {
  const SAMPLE: Array<[Role, Resource, Action]> = [
    ['admin', 'contracts', 'delete'],
    ['freelancer', 'contracts', 'create'],
    ['client', 'contracts', 'update'],
    ['guest', 'health', 'read'],
    ['auditor', 'health', 'read'],
    ['guest', 'contracts', 'read'],
  ];

  it('returns the same value across repeated calls (retry-safe)', () => {
    for (const [role, resource, action] of SAMPLE) {
      const expected = isAllowed(role, resource, action);
      for (let i = 0; i < 100; i += 1) {
        expect(isAllowed(role, resource, action)).toBe(expected);
      }
    }
  });

  it('returns consistent results under interleaved async evaluation', async () => {
    const expected = SAMPLE.map(([role, resource, action]) => isAllowed(role, resource, action));

    const actual = await Promise.all(
      SAMPLE.map(([role, resource, action]) =>
        Promise.resolve().then(() => isAllowed(role, resource, action)),
      ),
    );

    expect(actual).toEqual(expected);
  });
});

// ─── Backward-compatibility: isAllowed and evaluateAuthorization agree ────────

describe('compatibility: isAllowed and evaluateAuthorization agree', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(loggerModule.Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('agree for every matrix cell', () => {
    for (const role of VALID_ROLES) {
      for (const resource of ALL_RESOURCES) {
        for (const action of ALL_ACTIONS) {
          expect(evaluateAuthorization(role, resource, action).allowed).toBe(
            isAllowed(role, resource, action),
          );
        }
      }
    }
  });

  it('agree for malformed and hostile input', () => {
    const cases: Array<[unknown, unknown, unknown]> = [
      ['hacker', 'contracts', 'read'],
      ['admin', 'secrets', 'read'],
      ['admin', 'contracts', 'execute'],
      ['admin', 'constructor', 'read'],
      ['__proto__', 'contracts', 'read'],
      ['', 'contracts', 'read'],
      [null, undefined, {}],
    ];

    for (const [role, resource, action] of cases) {
      const viaDecision = evaluateAuthorization(role, resource, action).allowed;
      const viaLegacy = isAllowed(role as Role, resource as Resource, action as Action);
      expect(viaDecision).toBe(viaLegacy);
      expect(viaLegacy).toBe(false);
    }
  });
});
