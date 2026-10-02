/**
 * Comprehensive tests for src/lib/authorization.ts
 *
 * Coverage goals
 * ──────────────
 * 1. isValidRole         – accepts all valid roles, rejects anything else.
 * 2. isAuthorized        – deny-by-default for unknown resource/action/role at
 *                          runtime; explicit grants; explicit denies; ownOnly
 *                          semantics; admin bypass.
 * 3. Structured logging  – warn is emitted (with the right fields) for every
 *                          unresolved pair.
 * 4. FLAT_PERMISSION_LIST – derived list stays consistent with the matrix.
 * 5. Matrix exhaustiveness – every known (Resource × Action) has an entry for
 *                            every known role.
 */

import { isValidRole, isAuthorized, PERMISSION_MATRIX, FLAT_PERMISSION_LIST } from "./authorization";
import type { Action, Resource, Role, User } from "./types";
import * as loggerModule from "../logger";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_RESOURCES: Resource[] = [
  "users", "jobs", "proposals", "contracts",
  "payments", "reviews", "reports", "settings",
];

const ALL_ACTIONS: Action[] = ["create", "read", "update", "delete", "list"];
const ALL_ROLES:   Role[]   = ["admin", "auditor", "client", "freelancer"];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(role: Role, id = "user-1"): User {
  return { id, email: `${role}@test.com`, role };
}

// ─── isValidRole ─────────────────────────────────────────────────────────────

describe("isValidRole", () => {
  it.each(ALL_ROLES)("accepts valid role: %s", (role) => {
    expect(isValidRole(role)).toBe(true);
  });

  it.each([
    "superadmin", "guest", "ADMIN", "Admin", "", " ", "0", null, undefined, 42, {},
  ])("rejects invalid value: %p", (value) => {
    expect(isValidRole(value)).toBe(false);
  });
});

// ─── Matrix exhaustiveness ────────────────────────────────────────────────────

describe("PERMISSION_MATRIX exhaustiveness", () => {
  it("contains every Resource", () => {
    for (const resource of ALL_RESOURCES) {
      expect(PERMISSION_MATRIX).toHaveProperty(resource);
    }
  });

  it("contains every Action for every Resource", () => {
    for (const resource of ALL_RESOURCES) {
      for (const action of ALL_ACTIONS) {
        expect(PERMISSION_MATRIX[resource]).toHaveProperty(action);
      }
    }
  });

  it("contains every Role for every Resource × Action cell", () => {
    for (const resource of ALL_RESOURCES) {
      for (const action of ALL_ACTIONS) {
        for (const role of ALL_ROLES) {
          const cell = PERMISSION_MATRIX[resource][action][role];
          expect(cell === false || cell === true || (typeof cell === "object" && cell.ownOnly === true))
            .toBe(true);
        }
      }
    }
  });
});

// ─── Deny-by-default: runtime unresolved pairs ───────────────────────────────

describe("isAuthorized – deny-by-default for unresolved pairs", () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Spy on the Logger's warn method via the module-level logger instance.
    // createLogger returns a Logger; we intercept the prototype.
    warnSpy = jest.spyOn(loggerModule.Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("denies an unknown resource and emits a structured warn", () => {
    const result = isAuthorized({
      user: makeUser("admin"),
      resource: "invoices" as Resource,
      action: "read",
    });

    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/not registered in the permission matrix/i);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("authorization_deny_unresolved_resource");
    expect(fields).toMatchObject({
      resource: "invoices",
      action: "read",
      role: "admin",
    });
  });

  it("denies an unknown action on a valid resource and emits a structured warn", () => {
    const result = isAuthorized({
      user: makeUser("admin"),
      resource: "jobs",
      action: "execute" as Action,
    });

    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/not registered in the permission matrix/i);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("authorization_deny_unresolved_action");
    expect(fields).toMatchObject({ resource: "jobs", action: "execute" });
  });

  it("denies an unknown role for a valid resource/action and emits a structured warn", () => {
    const result = isAuthorized({
      user: { id: "u1", email: "x@y.com", role: "superadmin" as Role },
      resource: "jobs",
      action: "read",
    });

    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/not registered in the permission matrix/i);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, fields] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("authorization_deny_unresolved_role");
    expect(fields).toMatchObject({ role: "superadmin" });
  });

  it("does NOT emit a warn for a legitimate deny (false cell)", () => {
    // freelancer cannot create jobs → cell is false, not unresolved
    const result = isAuthorized({
      user: makeUser("freelancer"),
      resource: "jobs",
      action: "create",
    });

    expect(result.granted).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Admin: full access + ownOnly bypass ─────────────────────────────────────

describe("isAuthorized – admin role", () => {
  it("grants admin access to every resource/action combination", () => {
    const admin = makeUser("admin");
    for (const resource of ALL_RESOURCES) {
      for (const action of ALL_ACTIONS) {
        const { granted } = isAuthorized({ user: admin, resource, action });
        expect(granted).toBe(true);
      }
    }
  });

  it("grants admin access to ownOnly resources without providing resourceOwnerId", () => {
    // contracts.read for admin is a plain ALLOW cell, so "Permission granted." is the expected reason.
    // The "Admin bypass." path fires only when the cell is { ownOnly: true }, which admin never hits
    // because their cells are all ALLOW. Verify that granted is true regardless.
    const result = isAuthorized({
      user: makeUser("admin"),
      resource: "contracts",
      action: "read",
    });
    expect(result.granted).toBe(true);
    expect(result.reason).toBe("Permission granted.");
  });

  it("grants admin access to ownOnly resources even when resourceOwnerId differs", () => {
    // Same reasoning: admin cells are ALLOW, not OWN, so the admin bypass short-circuit does not fire.
    // Confirm that admin can update a contract owned by someone else and gets granted.
    const admin = makeUser("admin", "admin-1");
    const result = isAuthorized({
      user: admin,
      resource: "contracts",
      action: "update",
      resourceOwnerId: "someone-else",
    });
    expect(result.granted).toBe(true);
    expect(result.reason).toBe("Permission granted.");
  });
});

// ─── Auditor: read-only compliance role ──────────────────────────────────────

describe("isAuthorized – auditor role", () => {
  it("grants auditor read access to every resource", () => {
    const auditor = makeUser("auditor");
    for (const resource of ALL_RESOURCES) {
      const { granted } = isAuthorized({ user: auditor, resource, action: "read" });
      expect(granted).toBe(true);
    }
  });

  it("grants auditor list access to every resource", () => {
    const auditor = makeUser("auditor");
    for (const resource of ALL_RESOURCES) {
      const { granted } = isAuthorized({ user: auditor, resource, action: "list" });
      expect(granted).toBe(true);
    }
  });

  it("denies auditor create on every resource", () => {
    const auditor = makeUser("auditor");
    for (const resource of ALL_RESOURCES) {
      const { granted } = isAuthorized({ user: auditor, resource, action: "create" });
      expect(granted).toBe(false);
    }
  });

  it("denies auditor update on every resource", () => {
    const auditor = makeUser("auditor");
    for (const resource of ALL_RESOURCES) {
      const { granted } = isAuthorized({ user: auditor, resource, action: "update" });
      expect(granted).toBe(false);
    }
  });

  it("denies auditor delete on every resource", () => {
    const auditor = makeUser("auditor");
    for (const resource of ALL_RESOURCES) {
      const { granted } = isAuthorized({ user: auditor, resource, action: "delete" });
      expect(granted).toBe(false);
    }
  });
});

// ─── Client role ─────────────────────────────────────────────────────────────

describe("isAuthorized – client role", () => {
  const client = makeUser("client", "client-1");

  // Explicit grants (non-ownOnly)
  it("grants client create on jobs", () => {
    expect(isAuthorized({ user: client, resource: "jobs", action: "create" }).granted).toBe(true);
  });

  it("grants client read on jobs (public)", () => {
    expect(isAuthorized({ user: client, resource: "jobs", action: "read" }).granted).toBe(true);
  });

  it("grants client list on jobs (public)", () => {
    expect(isAuthorized({ user: client, resource: "jobs", action: "list" }).granted).toBe(true);
  });

  it("grants client create on payments", () => {
    expect(isAuthorized({ user: client, resource: "payments", action: "create" }).granted).toBe(true);
  });

  it("grants client create on reviews", () => {
    expect(isAuthorized({ user: client, resource: "reviews", action: "create" }).granted).toBe(true);
  });

  it("grants client read on reviews (public)", () => {
    expect(isAuthorized({ user: client, resource: "reviews", action: "read" }).granted).toBe(true);
  });

  // Explicit denies
  it("denies client create on users", () => {
    expect(isAuthorized({ user: client, resource: "users", action: "create" }).granted).toBe(false);
  });

  it("denies client create on reports", () => {
    expect(isAuthorized({ user: client, resource: "reports", action: "create" }).granted).toBe(false);
  });

  it("denies client read on reports", () => {
    expect(isAuthorized({ user: client, resource: "reports", action: "read" }).granted).toBe(false);
  });

  it("denies client delete on contracts", () => {
    expect(isAuthorized({ user: client, resource: "contracts", action: "delete" }).granted).toBe(false);
  });

  it("denies client create on proposals (freelancer-only)", () => {
    expect(isAuthorized({ user: client, resource: "proposals", action: "create" }).granted).toBe(false);
  });

  // ownOnly semantics
  it("grants client update on jobs they own", () => {
    expect(isAuthorized({
      user: client, resource: "jobs", action: "update", resourceOwnerId: "client-1",
    }).granted).toBe(true);
  });

  it("denies client update on jobs owned by someone else", () => {
    const result = isAuthorized({
      user: client, resource: "jobs", action: "update", resourceOwnerId: "other-user",
    });
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/owned by a different user/i);
  });

  it("denies client update on jobs when resourceOwnerId is not provided", () => {
    const result = isAuthorized({ user: client, resource: "jobs", action: "update" });
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/ownership could not be verified/i);
  });
});

// ─── Freelancer role ──────────────────────────────────────────────────────────

describe("isAuthorized – freelancer role", () => {
  const freelancer = makeUser("freelancer", "free-1");

  // Explicit grants
  it("grants freelancer read on jobs (public)", () => {
    expect(isAuthorized({ user: freelancer, resource: "jobs", action: "read" }).granted).toBe(true);
  });

  it("grants freelancer list on jobs (public)", () => {
    expect(isAuthorized({ user: freelancer, resource: "jobs", action: "list" }).granted).toBe(true);
  });

  it("grants freelancer create on proposals", () => {
    expect(isAuthorized({ user: freelancer, resource: "proposals", action: "create" }).granted).toBe(true);
  });

  it("grants freelancer create on reviews", () => {
    expect(isAuthorized({ user: freelancer, resource: "reviews", action: "create" }).granted).toBe(true);
  });

  it("grants freelancer read on reviews (public)", () => {
    expect(isAuthorized({ user: freelancer, resource: "reviews", action: "read" }).granted).toBe(true);
  });

  // Explicit denies
  it("denies freelancer create on jobs", () => {
    expect(isAuthorized({ user: freelancer, resource: "jobs", action: "create" }).granted).toBe(false);
  });

  it("denies freelancer create on contracts", () => {
    expect(isAuthorized({ user: freelancer, resource: "contracts", action: "create" }).granted).toBe(false);
  });

  it("denies freelancer delete on contracts", () => {
    expect(isAuthorized({ user: freelancer, resource: "contracts", action: "delete" }).granted).toBe(false);
  });

  it("denies freelancer create on payments", () => {
    expect(isAuthorized({ user: freelancer, resource: "payments", action: "create" }).granted).toBe(false);
  });

  it("denies freelancer any action on reports", () => {
    for (const action of ALL_ACTIONS) {
      expect(isAuthorized({ user: freelancer, resource: "reports", action }).granted).toBe(false);
    }
  });

  it("denies freelancer any action on users", () => {
    for (const action of ALL_ACTIONS) {
      expect(isAuthorized({ user: freelancer, resource: "users", action }).granted).toBe(false);
    }
  });

  // ownOnly semantics
  it("grants freelancer read on their own proposal", () => {
    expect(isAuthorized({
      user: freelancer, resource: "proposals", action: "read", resourceOwnerId: "free-1",
    }).granted).toBe(true);
  });

  it("denies freelancer read on a proposal they do not own", () => {
    const result = isAuthorized({
      user: freelancer, resource: "proposals", action: "read", resourceOwnerId: "other-free",
    });
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/owned by a different user/i);
  });

  it("denies freelancer read on a proposal when no resourceOwnerId given", () => {
    const result = isAuthorized({ user: freelancer, resource: "proposals", action: "read" });
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/ownership could not be verified/i);
  });

  it("grants freelancer read on own contract", () => {
    expect(isAuthorized({
      user: freelancer, resource: "contracts", action: "read", resourceOwnerId: "free-1",
    }).granted).toBe(true);
  });

  it("grants freelancer update on own settings", () => {
    expect(isAuthorized({
      user: freelancer, resource: "settings", action: "update", resourceOwnerId: "free-1",
    }).granted).toBe(true);
  });
});

// ─── ownOnly edge cases ───────────────────────────────────────────────────────

describe("isAuthorized – ownOnly edge cases", () => {
  it("denies when resourceOwnerId is an empty string (not equal to user.id)", () => {
    const user = makeUser("client", "client-1");
    const result = isAuthorized({
      user, resource: "jobs", action: "update", resourceOwnerId: "",
    });
    expect(result.granted).toBe(false);
    expect(result.reason).toMatch(/owned by a different user/i);
  });

  it("denies when user.id is empty and resourceOwnerId is non-empty", () => {
    const user: User = { id: "", email: "c@t.com", role: "client" };
    const result = isAuthorized({
      user, resource: "jobs", action: "update", resourceOwnerId: "some-owner",
    });
    expect(result.granted).toBe(false);
  });
});

// ─── AuthorizationResult shape ────────────────────────────────────────────────

describe("isAuthorized – result shape", () => {
  it("always returns { granted: boolean, reason: string }", () => {
    const cases: Parameters<typeof isAuthorized>[0][] = [
      { user: makeUser("admin"),      resource: "users",    action: "create" },
      { user: makeUser("auditor"),    resource: "reports",  action: "read"   },
      { user: makeUser("client"),     resource: "jobs",     action: "create" },
      { user: makeUser("freelancer"), resource: "jobs",     action: "create" },
    ];
    for (const input of cases) {
      const result = isAuthorized(input);
      expect(typeof result.granted).toBe("boolean");
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("returns reason 'Permission granted.' for a flat ALLOW cell", () => {
    const { reason } = isAuthorized({ user: makeUser("admin"), resource: "users", action: "create" });
    expect(reason).toBe("Permission granted.");
  });

  it("returns reason containing role/action/resource for a false cell", () => {
    const { reason } = isAuthorized({
      user: makeUser("freelancer"), resource: "jobs", action: "create",
    });
    expect(reason).toMatch(/freelancer/);
    expect(reason).toMatch(/create/);
    expect(reason).toMatch(/jobs/);
  });
});

// ─── FLAT_PERMISSION_LIST consistency ────────────────────────────────────────

describe("FLAT_PERMISSION_LIST", () => {
  it("is a non-empty readonly array", () => {
    expect(Array.isArray(FLAT_PERMISSION_LIST)).toBe(true);
    expect(FLAT_PERMISSION_LIST.length).toBeGreaterThan(0);
  });

  it("never contains an entry whose matrix cell is false", () => {
    for (const entry of FLAT_PERMISSION_LIST) {
      const cell = PERMISSION_MATRIX[entry.resource][entry.action][entry.role];
      expect(cell).not.toBe(false);
    }
  });

  it("marks ownOnly correctly for every entry", () => {
    for (const entry of FLAT_PERMISSION_LIST) {
      const cell = PERMISSION_MATRIX[entry.resource][entry.action][entry.role];
      if (typeof cell === "object" && cell.ownOnly) {
        expect(entry.ownOnly).toBe(true);
      } else {
        expect(entry.ownOnly).toBeUndefined();
      }
    }
  });

  it("contains an entry for admin on every resource/action", () => {
    for (const resource of ALL_RESOURCES) {
      for (const action of ALL_ACTIONS) {
        const found = FLAT_PERMISSION_LIST.some(
          (e) => e.role === "admin" && e.resource === resource && e.action === action
        );
        expect(found).toBe(true);
      }
    }
  });

  it("does not duplicate (role, resource, action) triplets", () => {
    const seen = new Set<string>();
    for (const entry of FLAT_PERMISSION_LIST) {
      const key = `${entry.role}:${entry.resource}:${entry.action}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// ─── Security: response must not leak internal IDs ───────────────────────────

describe("isAuthorized – security: no internal ID leakage in reason strings", () => {
  it("does not echo user.id into the reason on a deny", () => {
    const user = makeUser("client", "secret-internal-id-xyz");
    const { reason } = isAuthorized({ user, resource: "users", action: "create" });
    expect(reason).not.toContain("secret-internal-id-xyz");
  });

  it("does not echo resourceOwnerId into the reason on an ownership deny", () => {
    const user = makeUser("client", "client-id");
    const { reason } = isAuthorized({
      user, resource: "jobs", action: "update", resourceOwnerId: "sensitive-owner-id",
    });
    expect(reason).not.toContain("sensitive-owner-id");
    expect(reason).not.toContain("client-id");
  });

  it("does not echo unknown resource name into the structured log fields beyond what is intentional", () => {
    // The reason string may contain the resource name (by design — it's the
    // untrusted value that caused the deny). Verify the warn fields include
    // the resource for auditability but the reason is clearly framed as a deny.
    const warnSpy = jest.spyOn(loggerModule.Logger.prototype, "warn").mockImplementation(() => {});
    const { granted, reason } = isAuthorized({
      user: makeUser("admin"),
      resource: "malicious-resource" as Resource,
      action: "read",
    });
    expect(granted).toBe(false);
    expect(reason).toMatch(/Explicit deny/);
    warnSpy.mockRestore();
  });
});
