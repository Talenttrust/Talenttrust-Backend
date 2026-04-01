import type { Request } from "express";

// ─── Role ─────────────────────────────────────────────────────────────────────

export type Role = "admin" | "client" | "freelancer";

// ─── Resource & Action ───────────────────────────────────────────────────────

export type Resource =
  | "users"
  | "jobs"
  | "proposals"
  | "contracts"
  | "payments"
  | "reviews"
  | "reports"
  | "settings";

export type Action = "create" | "read" | "update" | "delete" | "list";

// ─── Permission (one row of the PERMISSION_MATRIX) ───────────────────────────

export interface Permission {
  role:     Role;
  resource: Resource;
  action:   Action;
  /** When true, the action is only allowed if the caller owns the record. */
  ownOnly?: boolean;
}

// ─── User (attached to req.user by requireAuth) ──────────────────────────────

export interface User {
  id:    string;
  email: string;
  role:  Role;
}

// ─── AuthenticatedRequest ────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  user?: User;
}