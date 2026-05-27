/**
 * @module authorize
 * @description Core authorization logic for TalentTrust.
 *
 * Provides `isAllowed` — a pure function that checks whether a given role
 * is permitted to perform a specific action on a resource, based on the
 * access control matrix defined in `roles.ts`.
 *
 * Security notes:
 *   - Unknown roles are denied by default (deny-by-default).
 *   - Unknown resources or actions are denied by default.
 *   - No runtime mutation of the matrix is permitted from this module.
 */

import { Role, Resource, Action, ACCESS_CONTROL_MATRIX } from './roles';

/**
 * Check whether a role is permitted to perform an action on a resource.
 *
 * @param role     - The user's role.
 * @param resource - The target resource.
 * @param action   - The requested action.
 * @returns `true` if the action is allowed, `false` otherwise.
 */
export function isAllowed(role: Role, resource: Resource, action: Action): boolean {
  const permissions = ACCESS_CONTROL_MATRIX[role];
  if (!permissions) {
    return false;
  }
  const actions = permissions[resource];
  if (!actions) {
    return false;
  }
  return actions.includes(action);
}
