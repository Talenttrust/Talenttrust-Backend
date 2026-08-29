import type { Action, Permission, Resource, Role, User } from "./types";
import { createLogger } from "../logger";

// ─── Internal logger ─────────────────────────────────────────────────────────

const log = createLogger({ module: "authorization" });

// ─── Role allowlist ───────────────────────────────────────────────────────────

const ALL_ROLES: ReadonlySet<string> = new Set<Role>(["admin", "auditor", "client", "freelancer"]);

/**
 * Type-guard / validator for role claim values coming out of a JWT.
 * Returns true only for the known platform roles; rejects any other string.
 */
export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && ALL_ROLES.has(value);
}

// ─── Matrix cell types ────────────────────────────────────────────────────────

/**
 * Per-cell value in the permission matrix.
 *
 * - `false`           → always denied
 * - `true`            → always granted
 * - `{ ownOnly: true }` → granted only when the caller owns the record
 */
type CellValue = false | true | { ownOnly: true };

/**
 * The full matrix type.
 *
 * Using `Record<Resource, Record<Action, Record<Role, CellValue>>>` forces
 * TypeScript to flag a compile-time error whenever a new `Resource` or
 * `Action` value is added to `types.ts` without a corresponding entry here.
 */
type RoleCells = Record<Role, CellValue>;
type PermissionMatrix = {
  [R in Resource]: R extends "health"
    ? { read: RoleCells }
    : Record<Action, RoleCells>;
};

// Convenience aliases
const DENY = false as const;
const ALLOW = true as const;
const OWN = { ownOnly: true } as const;

// ─── Permission matrix ────────────────────────────────────────────────────────
/**
 * The authoritative, exhaustive permission matrix for the platform.
 *
 * Every (Resource × Action × Role) triplet has an explicit value. A missing
 * triplet is a TypeScript compile error, ensuring that adding a new
 * Resource or Action to `types.ts` immediately surfaces here.
 *
 * Design decisions
 * ─────────────────
 * - admin has unrestricted access to every resource and action.
 * - auditor has read/list access to all resources (read-only compliance role).
 * - client can manage jobs/contracts they own, read public proposals, pay.
 * - freelancer can propose on jobs, manage their own proposals/contracts.
 * - Reviews are readable by all roles but writable only by their author.
 * - users resource (user management) is admin-only.
 * - reports resource is admin/auditor only.
 * - settings are self-service (read/update own record only).
 */
export const PERMISSION_MATRIX: PermissionMatrix = {
  // ── users ──────────────────────────────────────────────────────────────────
  users: {
    create: { admin: ALLOW,  auditor: DENY,  client: DENY, freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: DENY, freelancer: DENY },
    update: { admin: ALLOW,  auditor: DENY,  client: DENY, freelancer: DENY },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY, freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: DENY, freelancer: DENY },
  },

  // ── jobs ───────────────────────────────────────────────────────────────────
  jobs: {
    create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,    freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,    freelancer: ALLOW },
    update: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: DENY },
    delete: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,    freelancer: ALLOW },
  },

  // ── proposals ──────────────────────────────────────────────────────────────
  proposals: {
    create: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: ALLOW },
    read:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
    update: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: OWN },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: OWN },
    list:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
  },

  // ── contracts ──────────────────────────────────────────────────────────────
  contracts: {
    create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,    freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
    update: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: OWN },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
  },

  // ── payments ───────────────────────────────────────────────────────────────
  payments: {
    create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,    freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
    update: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
  },

  // ── reviews ────────────────────────────────────────────────────────────────
  reviews: {
    create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,    freelancer: ALLOW },
    read:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,    freelancer: ALLOW },
    update: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: OWN },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: ALLOW,    freelancer: ALLOW },
  },

  // ── reports ────────────────────────────────────────────────────────────────
  reports: {
    create: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: DENY,     freelancer: DENY },
    update: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: DENY,     freelancer: DENY },
  },

  // ── settings ───────────────────────────────────────────────────────────────
  settings: {
    create: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    read:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
    update: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: OWN },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: DENY,     freelancer: DENY },
  },

  // ── disputes ───────────────────────────────────────────────────────────────
  disputes: {
    create: { admin: ALLOW,  auditor: DENY,  client: ALLOW,    freelancer: ALLOW },
    read:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
    update: { admin: ALLOW,  auditor: DENY,  client: OWN,      freelancer: DENY },
    delete: { admin: ALLOW,  auditor: DENY,  client: DENY,     freelancer: DENY },
    list:   { admin: ALLOW,  auditor: ALLOW, client: OWN,      freelancer: OWN },
  },

  health: {
    read: { admin: ALLOW, auditor: ALLOW, client: ALLOW, freelancer: ALLOW },
  },
} satisfies PermissionMatrix;

// ─── isAuthorized ─────────────────────────────────────────────────────────────

interface AuthorizationInput {
  user: User;
  resource: Resource;
  action: Action;
  /**
   * The id of the user who owns the target record.
   * Required when the matching cell has `ownOnly: true`.
   * For admin the value is ignored — admins always pass.
   */
  resourceOwnerId?: string;
}

interface AuthorizationResult {
  granted: boolean;
  reason: string;
}

/**
 * Evaluates whether `user` may perform `action` on `resource`.
 *
 * Logic
 * ──────
 * 1. Look up the cell in the exhaustive PERMISSION_MATRIX.
 *    - If the runtime (resource, action, role) triplet falls outside the
 *      matrix (e.g., due to unsanitised input), a structured `warn` is
 *      emitted and the request is explicitly denied. This is the
 *      deny-by-default safety net.
 * 2. `false` cell → denied.
 * 3. `true` cell → granted.
 * 4. `{ ownOnly: true }` cell:
 *    a. Admin is always exempt from ownership checks → granted.
 *    b. No `resourceOwnerId` supplied → denied.
 *    c. `resourceOwnerId !== user.id` → denied.
 *    d. Otherwise → granted (owner confirmed).
 */
export function isAuthorized({
  user,
  resource,
  action,
  resourceOwnerId,
}: AuthorizationInput): AuthorizationResult {
  // ── Runtime deny-by-default safety net ───────────────────────────────────
  // The matrix is exhaustive at compile-time, but callers may pass values that
  // have been cast from unvalidated input (e.g., from a request parameter).
  const resourceEntry = (PERMISSION_MATRIX as Record<string, unknown>)[resource];
  if (resourceEntry === undefined) {
    log.warn("authorization_deny_unresolved_resource", {
      reason: "resource not found in permission matrix",
      resource,
      action,
      userId: user.id,
      role: user.role,
    });
    return {
      granted: false,
      reason: `Explicit deny: resource '${resource}' is not registered in the permission matrix.`,
    };
  }

  const actionEntry = (resourceEntry as Record<string, unknown>)[action];
  if (actionEntry === undefined) {
    log.warn("authorization_deny_unresolved_action", {
      reason: "action not found in permission matrix",
      resource,
      action,
      userId: user.id,
      role: user.role,
    });
    return {
      granted: false,
      reason: `Explicit deny: action '${action}' on resource '${resource}' is not registered in the permission matrix.`,
    };
  }

  const cell = (actionEntry as Record<string, CellValue>)[user.role];
  if (cell === undefined) {
    log.warn("authorization_deny_unresolved_role", {
      reason: "role not found in permission matrix cell",
      resource,
      action,
      userId: user.id,
      role: user.role,
    });
    return {
      granted: false,
      reason: `Explicit deny: role '${user.role}' is not registered in the permission matrix.`,
    };
  }

  // ── Matrix cell evaluation ────────────────────────────────────────────────
  if (cell === false) {
    return {
      granted: false,
      reason: `Role '${user.role}' may not '${action}' '${resource}'.`,
    };
  }

  if (cell === true) {
    return { granted: true, reason: "Permission granted." };
  }

  // ── ownOnly branch ────────────────────────────────────────────────────────
  // Admins are always exempt from ownership checks.
  if (user.role === "admin") {
    return { granted: true, reason: "Admin bypass." };
  }

  if (resourceOwnerId === undefined) {
    return { granted: false, reason: "Ownership could not be verified." };
  }

  if (resourceOwnerId !== user.id) {
    return { granted: false, reason: "Resource is owned by a different user." };
  }

  return { granted: true, reason: "Permission granted (owner)." };
}

// ─── Legacy flat-array export ─────────────────────────────────────────────────
//
// Consumers that previously imported `PERMISSION_MATRIX` as a flat `Permission[]`
// can still do so via this derived export. It is generated from the exhaustive
// matrix so it stays in sync automatically.

export const FLAT_PERMISSION_LIST: readonly Permission[] = (
  Object.entries(PERMISSION_MATRIX) as [Resource, Record<Action, Record<Role, CellValue>>][]
).flatMap(([resource, actions]) =>
  (Object.entries(actions) as [Action, Record<Role, CellValue>][]).flatMap(
    ([action, roles]) =>
      (Object.entries(roles) as [Role, CellValue][])
        .filter(([, cell]) => cell !== false)
        .map(([role, cell]): Permission => ({
          role,
          resource,
          action,
          ...(typeof cell === "object" && cell.ownOnly ? { ownOnly: true } : {}),
        }))
  )
);
