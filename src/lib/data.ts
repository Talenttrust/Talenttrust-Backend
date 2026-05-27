import { Action, Permission, Resource } from "./types";

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
  ...( ["users","jobs","proposals","contracts","payments","reviews","reports","settings"] as Resource[]).flatMap(
    (resource) =>
      (["create","read","update","delete","list"] as Action[]).map(
        (action): Permission => ({ role: "admin", resource, action })
      )
  ),
 
  // ── client ────────────────────────────────────────────────────────────────
  { role: "client", resource: "jobs",      action: "create"                  },
  { role: "client", resource: "jobs",      action: "read"                    },
  { role: "client", resource: "jobs",      action: "update",  ownOnly: true  },
  { role: "client", resource: "jobs",      action: "delete",  ownOnly: true  },
  { role: "client", resource: "jobs",      action: "list"                    },
  { role: "client", resource: "proposals", action: "read",    ownOnly: true  },
  { role: "client", resource: "proposals", action: "list",    ownOnly: true  },
  { role: "client", resource: "contracts", action: "create"                  },
  { role: "client", resource: "contracts", action: "read",    ownOnly: true  },
  { role: "client", resource: "contracts", action: "update",  ownOnly: true  },
  { role: "client", resource: "contracts", action: "list",    ownOnly: true  },
  { role: "client", resource: "payments",  action: "create"                  },
  { role: "client", resource: "payments",  action: "read",    ownOnly: true  },
  { role: "client", resource: "payments",  action: "list",    ownOnly: true  },
  { role: "client", resource: "reviews",   action: "create"                  },
  { role: "client", resource: "reviews",   action: "read"                    },
  { role: "client", resource: "reviews",   action: "update",  ownOnly: true  },
  { role: "client", resource: "reviews",   action: "list"                    },
  { role: "client", resource: "settings",  action: "read",    ownOnly: true  },
  { role: "client", resource: "settings",  action: "update",  ownOnly: true  },
 
  // ── freelancer ────────────────────────────────────────────────────────────
  { role: "freelancer", resource: "jobs",      action: "read"                    },
  { role: "freelancer", resource: "jobs",      action: "list"                    },
  { role: "freelancer", resource: "proposals", action: "create"                  },
  { role: "freelancer", resource: "proposals", action: "read",    ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "update",  ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "delete",  ownOnly: true  },
  { role: "freelancer", resource: "proposals", action: "list",    ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "read",    ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "update",  ownOnly: true  },
  { role: "freelancer", resource: "contracts", action: "list",    ownOnly: true  },
  { role: "freelancer", resource: "payments",  action: "read",    ownOnly: true  },
  { role: "freelancer", resource: "payments",  action: "list",    ownOnly: true  },
  { role: "freelancer", resource: "reviews",   action: "create"                  },
  { role: "freelancer", resource: "reviews",   action: "read"                    },
  { role: "freelancer", resource: "reviews",   action: "update",  ownOnly: true  },
  { role: "freelancer", resource: "reviews",   action: "list"                    },
  { role: "freelancer", resource: "settings",  action: "read",    ownOnly: true  },
  { role: "freelancer", resource: "settings",  action: "update",  ownOnly: true  },
] as const;