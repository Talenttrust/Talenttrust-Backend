import type { Action, Permission, Resource, Role, User } from "./types";

// ─── Role allowlist ───────────────────────────────────────────────────────────

const ALL_ROLES: ReadonlySet<string> = new Set<Role>(["admin", "client", "freelancer"]);

/**
 * Type-guard / validator for role claim values coming out of a JWT.
 * Returns true only for the three platform roles; rejects any other string.
 */
export function isValidRole(value: unknown): value is Role {
  return typeof value === "string" && ALL_ROLES.has(value);
}

// ─── Permission matrix ────────────────────────────────────────────────────────

/**
 * The authoritative permission matrix for the platform.
 *
 * Reads top-to-bottom:
 *   "An <role> may <action> <resource> [only when they own the record]."
 *
 * Design decisions:
 *  - admin has unrestricted access to every resource and action.
 *  - client can manage jobs/contracts they own, read public proposals, pay.
 *  - freelancer can propose on jobs, manage their own proposals/contracts.
 *  - Reviews are readable by all roles but writable only by their author.
 */
export const PERMISSION_MATRIX: readonly Permission[] = [
  // ── admin (full access, no ownOnly restrictions) ──────────────────────────
  ...(
    ["users", "jobs", "proposals", "contracts", "payments", "reviews", "reports", "settings"] as Resource[]
  ).flatMap((resource) =>
    (["create", "read", "update", "delete", "list"] as Action[]).map(
      (action): Permission => ({ role: "admin", resource, action })
    )
  ),

  // ── client ────────────────────────────────────────────────────────────────
  { role: "client", resource: "jobs",      action: "create"                 },
  { role: "client", resource: "jobs",      action: "read"                   },
  { role: "client", resource: "jobs",      action: "update", ownOnly: true  },
  { role: "client", resource: "jobs",      action: "delete", ownOnly: true  },
  { role: "client", resource: "jobs",      action: "list"                   },
  { role: "client", resource: "proposals", action: "read",   ownOnly: true  },
  { role: "client", resource: "proposals", action: "list",   ownOnly: true  },
  { role: "client", resource: "contracts", action: "create"                 },
  { role: "client", resource: "contracts", action: "read",   ownOnly: true  },
  { role: "client", resource: "contracts", action: "update", ownOnly: true  },
  { role: "client", resource: "contracts", action: "list",   ownOnly: true  },
  { role: "client", resource: "payments",  action: "create"                 },
  { role: "client", resource: "payments",  action: "read",   ownOnly: true  },
  { role: "client", resource: "payments",  action: "list",   ownOnly: true  },
  { role: "client", resource: "reviews",   action: "create"                 },
  { role: "client", resource: "reviews",   action: "read"                   },
  { role: "client", resource: "reviews",   action: "update", ownOnly: true  },
  { role: "client", resource: "reviews",   action: "list"                   },
  { role: "client", resource: "settings",  action: "read",   ownOnly: true  },
  { role: "client", resource: "settings",  action: "update", ownOnly: true  },

  // ── freelancer ────────────────────────────────────────────────────────────
  { role: "freelancer", resource: "jobs",      action: "read"                   },
  { role: "freelancer", resource: "jobs",      action: "list"                   },
  { role: "freelancer", resource: "proposals", action: "create"                 },
  { role: "freelancer", resource: "proposals", action: "read",   ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "update", ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "delete", ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "list",   ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "read",   ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "update", ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "list",   ownOnly: true  },
  { role: "freelancer", resource: "payments",  action: "read",   ownOnly: true  },
  { role: "freelancer", resource: "payments",  action: "list",   ownOnly: true  },
  { role: "freelancer", resource: "reviews",   action: "create"                 },
  { role: "freelancer", resource: "reviews",   action: "read"                   },
  { role: "freelancer", resource: "reviews",   action: "update", ownOnly: true  },
  { role: "freelancer", resource: "reviews",   action: "list"                   },
  { role: "freelancer", resource: "settings",  action: "read",   ownOnly: true  },
  { role: "freelancer", resource: "settings",  action: "update", ownOnly: true  },
] as const;

// ─── isAuthorized ─────────────────────────────────────────────────────────────

interface AuthorizationInput {
  user:             User;
  resource:         Resource;
  action:           Action;
  /**
   * The id of the user who owns the target record.
   * Required when the matching permission entry has `ownOnly: true`.
   * For admin the value is ignored — admins always pass.
   */
  resourceOwnerId?: string;
}

interface AuthorizationResult {
  granted: boolean;
  reason:  string;
}

/**
 * Evaluates whether `user` may perform `action` on `resource`.
 *
 * Logic:
 *  1. Find the matching permission entry (role + resource + action).
 *  2. If no entry exists → denied.
 *  3. If the entry has no `ownOnly` flag → granted.
 *  4. If `ownOnly: true` and the user is an admin → granted (admins are exempt).
 *  5. If `ownOnly: true` and `resourceOwnerId` is absent → denied
 *     (caller did not supply a resolver, treat as no-access).
 *  6. If `ownOnly: true` and `resourceOwnerId !== user.id` → denied.
 *  7. Otherwise → granted.
 */
export function isAuthorized({
  user,
  resource,
  action,
  resourceOwnerId,
}: AuthorizationInput): AuthorizationResult {
  const entry = PERMISSION_MATRIX.find(
    (p) => p.role === user.role && p.resource === resource && p.action === action
  );

  if (!entry) {
    return { granted: false, reason: `Role '${user.role}' may not '${action}' '${resource}'.` };
  }

  // No ownership restriction on this entry.
  if (!entry.ownOnly) {
    return { granted: true, reason: "Permission granted." };
  }

  // Admins are always exempt from ownership checks.
  if (user.role === "admin") {
    return { granted: true, reason: "Admin bypass." };
  }

  // Ownership check required but no owner id was resolved.
  if (resourceOwnerId === undefined) {
    return { granted: false, reason: "Ownership could not be verified." };
  }

  if (resourceOwnerId !== user.id) {
    return { granted: false, reason: "Resource is owned by a different user." };
  }

  return { granted: true, reason: "Permission granted (owner)." };
}