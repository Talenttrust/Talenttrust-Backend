/**
 * @module roles
 * @description Defines the role-based access control (RBAC) model for TalentTrust.
 *
 * Roles:
 *   - admin:      Full platform access — manages users, contracts, disputes.
 *   - freelancer: Can create/view own contracts, submit work, view own reputation.
 *   - client:     Can create/view own contracts, approve/reject deliverables.
 *   - guest:      Read-only access to public endpoints (health, public listings).
 *
 * Resources:
 *   contracts, users, reputation, disputes, health, api-keys
 *
 * Actions:
 *   create, read, update, delete
 */

export type Role = 'admin' | 'auditor' | 'freelancer' | 'client' | 'guest';

export type Resource = 'contracts' | 'users' | 'reputation' | 'disputes' | 'health' | 'api-keys';

export type Action = 'create' | 'read' | 'update' | 'delete';

/**
 * Access control matrix.
 * Maps each role to the set of allowed actions per resource.
 */
export const ACCESS_CONTROL_MATRIX: Record<Role, Partial<Record<Resource, Action[]>>> = {
  admin: {
    contracts: ['create', 'read', 'update', 'delete'],
    users: ['create', 'read', 'update', 'delete'],
    reputation: ['read', 'update'],
    disputes: ['create', 'read', 'update', 'delete'],
    health: ['read'],
    'api-keys': ['create', 'read', 'update', 'delete'],
  },
  auditor: {
    health: ['read'],
  },
  freelancer: {
    contracts: ['create', 'read'],
    users: ['read'],
    reputation: ['read', 'update'], // Can rate clients after contract completion
    disputes: ['create', 'read'],
    health: ['read'],
    'api-keys': ['create', 'read', 'update', 'delete'],
  },
  client: {
    contracts: ['create', 'read', 'update'],
    users: ['read'],
    reputation: ['read', 'update'], // Can rate freelancers after contract completion
    disputes: ['create', 'read'],
    health: ['read'],
    'api-keys': ['create', 'read', 'update', 'delete'],
  },
  guest: {
    health: ['read'],
  },
};

/** All valid roles in the system. */
export const VALID_ROLES: readonly Role[] = ['admin', 'auditor', 'freelancer', 'client', 'guest'] as const;
