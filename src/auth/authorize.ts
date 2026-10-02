/**
 * @module authorize
 * @description Core authorization logic for TalentTrust.
 *
 * Provides `isAllowed` — a pure function that checks whether a given role
 * is permitted to perform a specific action on a resource, based on the
 * access control matrix defined in `roles.ts`.
 *
 * ## Public compatibility contract
 *
 * `isAllowed(role, resource, action)` is the stable, public entry point of
 * this module. The following guarantees are part of its contract and MUST be
 * preserved across releases (locked in by the tests in
 * `../__tests__/authorize.test.ts`):
 *
 *   1. **Total** — for every possible input, including unknown roles,
 *      unknown resources/actions, `null`/`undefined`, non-string values and
 *      inherited object keys such as `__proto__` or `constructor`, the
 *      function returns a `boolean` and never throws.
 *   2. **Deny-by-default** — a triplet that is not explicitly granted in
 *      `ACCESS_CONTROL_MATRIX` resolves to `false`. `true` is returned only
 *      for an own, exact grant in the matrix.
 *   3. **Pure / deterministic** — no module state is read or written and the
 *      result depends solely on the arguments. Repeated, retried and
 *      concurrent calls with the same arguments always return the same value.
 *   4. **Safe lookups** — the matrix is only ever read through own-property
 *      checks, so prototype members (`__proto__`, `constructor`, `toString`,
 *      …) can never be mistaken for a registered role, resource or grant.
 *
 * ## Observability
 *
 * `evaluateAuthorization` exposes the same decision together with a
 * machine-readable `reason` code and emits a structured `warn` record when a
 * denial is caused by *unexpected* input (an unregistered role/resource, an
 * unrecognized action, or malformed input). Ordinary permission denials are
 * not logged, so audit noise stays low while configuration drift is
 * diagnosable. Log records contain only the (non-sensitive) role/resource/
 * action descriptors — never tokens, identities or record contents.
 *
 * ## Security notes
 *
 *   - Unknown roles are denied by default (deny-by-default).
 *   - Unknown resources or actions are denied by default.
 *   - No runtime mutation of the matrix is permitted from this module.
 *
 * Determinism and recovery notes:
 *   - `isAllowed` is a pure function of its arguments and the immutable
 *     ACCESS_CONTROL_MATRIX. It never mutates state, never throws for well-
 *     typed inputs, and always returns a boolean. This makes failure
 *     recovery deterministic: the same inputs always produce the same
 *     decision, regardless of concurrency or retries.
 *   - Any unexpected error while evaluating the matrix is treated as a
 *     deny (fail-closed) and reported through the injectable logger so
 *     operators can diagnose failures without exposing sensitive data.
 *   - The decision is stable across retries and concurrent execution because
 *     there is no shared mutable state involved.
 */

import { Role, Resource, Action, ACCESS_CONTROL_MATRIX } from './roles';
import { createLogger } from '../logger';

const log = createLogger({ module: 'authorize' });

/**
 * Machine-readable reason attached to every authorization decision.
 *
 * - `allowed`                   – an explicit grant exists in the matrix.
 * - `role_not_registered`       – the role is not a key of the matrix.
 * - `resource_not_registered`   – the resource is not registered for *any*
 *                                 role (configuration drift/anomaly).
 * - `resource_not_permitted`    – the resource is known but not granted to
 *                                 this role (ordinary denial).
 * - `action_not_recognized`     – the action is not a known platform action.
 * - `action_not_permitted`      – the action is known but not granted to the
 *                                 role for this resource (ordinary denial).
 * - `invalid_input`             – the input was malformed (not a non-empty
 *                                 string, or the matrix cell was corrupted).
 */
export type AuthorizationReason =
  | 'allowed'
  | 'role_not_registered'
  | 'resource_not_registered'
  | 'resource_not_permitted'
  | 'action_not_recognized'
  | 'action_not_permitted'
  | 'invalid_input';

/** Result of {@link evaluateAuthorization}. */
export interface AuthorizationDecision {
  /** `true` only when the exact triplet is explicitly granted. */
  allowed: boolean;
  /** Machine-readable explanation for {@link allowed}. */
  reason: AuthorizationReason;
}

/**
 * All actions that appear anywhere in the access control matrix.
 *
 * Derived from the matrix itself so it can never drift: adding a new action
 * to `roles.ts` is automatically reflected here. Only own, enumerable
 * properties are inspected.
 */
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(
  Object.values(ACCESS_CONTROL_MATRIX).flatMap((permissions) =>
    Object.values(permissions).flatMap((actions) =>
      Array.isArray(actions) ? actions : [],
    ),
  ),
);

/**
 * Every resource registered anywhere in the matrix.
 *
 * Used to tell a genuine configuration gap (a resource no role knows about)
 * apart from an ordinary per-role denial, so only the former is logged.
 */
const KNOWN_RESOURCES: ReadonlySet<string> = new Set(
  Object.values(ACCESS_CONTROL_MATRIX).flatMap((permissions) =>
    permissions !== null && typeof permissions === 'object'
      ? Object.keys(permissions)
      : [],
  ),
);

/** Anomalies worth surfacing in logs (as opposed to ordinary denials). */
const ANOMALY_EVENT_BY_REASON: Readonly<Record<AuthorizationReason, string | null>> = {
  allowed: null,
  role_not_registered: 'authorization_deny_unresolved_role',
  resource_not_registered: 'authorization_deny_unresolved_resource',
  resource_not_permitted: null,
  action_not_recognized: 'authorization_deny_unrecognized_action',
  action_not_permitted: null,
  invalid_input: 'authorization_deny_invalid_input',
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Reduce an arbitrary caller value to a safe, bounded descriptor for logs.
 * Objects/arrays/functions are never expanded, so no caller payload can leak.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

/**
 * Pure, total evaluation of the (role, resource, action) triplet.
 *
 * This is the single source of truth for both {@link isAllowed} and
 * {@link evaluateAuthorization}; neither can drift from the other.
 */
function decide(role: unknown, resource: unknown, action: unknown): AuthorizationDecision {
  // 1. Shape validation. Non-string / empty inputs are denied, never thrown on.
  if (!isNonEmptyString(role) || !isNonEmptyString(resource) || !isNonEmptyString(action)) {
    return { allowed: false, reason: 'invalid_input' };
  }

  // 2. Role must be an *own* key of the matrix. Inherited keys such as
  //    `__proto__`, `constructor` or `toString` are not roles.
  if (!hasOwn(ACCESS_CONTROL_MATRIX, role)) {
    return { allowed: false, reason: 'role_not_registered' };
  }
  const permissions = (ACCESS_CONTROL_MATRIX as Record<string, unknown>)[role];
  if (permissions === null || typeof permissions !== 'object') {
    return { allowed: false, reason: 'invalid_input' };
  }

  // 3a. A resource that no role knows about is configuration drift → anomaly.
  if (!KNOWN_RESOURCES.has(resource)) {
    return { allowed: false, reason: 'resource_not_registered' };
  }

  // 3b. A known resource that is simply not granted to this role is an
  //     ordinary denial and is therefore not logged as an anomaly.
  if (!hasOwn(permissions, resource)) {
    return { allowed: false, reason: 'resource_not_permitted' };
  }
  const grantedActions = (permissions as Record<string, unknown>)[resource];
  if (!Array.isArray(grantedActions)) {
    return { allowed: false, reason: 'invalid_input' };
  }

  // 4. Unknown actions are distinguished from known-but-denied ones so that
  //    typo'd or injected actions surface in logs as anomalies.
  if (!KNOWN_ACTIONS.has(action)) {
    return { allowed: false, reason: 'action_not_recognized' };
  }

  // 5. Exact, explicit grant check.
  const allowed = grantedActions.includes(action);
  return { allowed, reason: allowed ? 'allowed' : 'action_not_permitted' };
}

/**
 * Check whether a role is permitted to perform an action on a resource.
 *
 * This is the public, backward-compatible API. It always returns a boolean
 * and never throws (see the module-level contract above).
 *
 * @param role     - The user's role.
 * @param resource - The target resource.
 * @param action   - The requested action.
 * @returns `true` if the action is allowed, `false` otherwise.
 */
export function isAllowed(role: Role, resource: Resource, action: Action): boolean {
  return decide(role, resource, action).allowed;
}

/**
 * Evaluate an authorization request and return an explicit decision.
 *
 * Accepts unvalidated runtime input, never throws, and emits a structured
 * `warn` record (never containing sensitive data) when the denial is caused
 * by unexpected input rather than an ordinary permission rule. Use this at
 * trust boundaries and where diagnostics are required; use {@link isAllowed}
 * where only the boolean matters.
 *
 * @param role     - The caller's role (validated or raw).
 * @param resource - The target resource (validated or raw).
 * @param action   - The requested action (validated or raw).
 * @returns An {@link AuthorizationDecision} with a machine-readable reason.
 */
export function evaluateAuthorization(
  role: unknown,
  resource: unknown,
  action: unknown,
): AuthorizationDecision {
  const decision = decide(role, resource, action);

  const event = ANOMALY_EVENT_BY_REASON[decision.reason];
  if (!decision.allowed && event !== null) {
    log.warn(event, {
      reason: decision.reason,
      role: describe(role),
      resource: describe(resource),
      action: describe(action),
    });
  }

  return decision;
}
