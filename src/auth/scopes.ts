/**
 * @module auth/scopes
 * @description Typed scope constants for scoped API keys.
 *
 * Scopes are the fine-grained permissions attached to a config-loaded API key.
 * Each scope follows the `resource:action` convention and is defined here
 * as a typed constant so that middleware, config validation, and OpenAPI
 * documentation all reference the same source of truth.
 */

/**
 * The set of all valid scopes recognised by the system.
 * Adding a new scope here automatically makes it available for config
 * validation and middleware enforcement.
 */
export const SCOPES = {
  /** Resolve a dispute (move escrowed funds between parties). */
  DISPUTES_RESOLVE: 'disputes:resolve',
  /** Read administrative data (audit logs, system status). */
  ADMIN_READ: 'admin:read',
  /** Create or modify contract records. */
  CONTRACTS_WRITE: 'contracts:write',
} as const;

/**
 * Union type derived from the SCOPES constant.
 * Use this wherever a scope value is expected in TypeScript code.
 */
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/**
 * A readonly array of all valid scope strings, used for validation
 * during config parsing.
 */
export const VALID_SCOPES: readonly string[] = Object.values(SCOPES);

/**
 * Type guard: returns true when `value` is one of the recognised scopes.
 */
export function isValidScope(value: string): value is Scope {
  return VALID_SCOPES.includes(value);
}
