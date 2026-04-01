/**
 * Unit tests for the access control matrix defined in `roles.ts`.
 *
 * Validates:
 *   - Every role is present in the matrix.
 *   - Action arrays contain only valid values.
 *   - No duplicate actions per resource.
 */

import { ACCESS_CONTROL_MATRIX, VALID_ROLES, Role, Resource, Action } from '../roles';

const ALL_RESOURCES: Resource[] = ['contracts', 'users', 'reputation', 'disputes', 'health'];
const ALL_ACTIONS: Action[] = ['create', 'read', 'update', 'delete'];

describe('Access Control Matrix – structural integrity', () => {
  it('should define permissions for every valid role', () => {
    for (const role of VALID_ROLES) {
      expect(ACCESS_CONTROL_MATRIX).toHaveProperty(role);
    }
  });

  it('should only contain valid actions', () => {
    for (const role of VALID_ROLES) {
      const resources = ACCESS_CONTROL_MATRIX[role];
      for (const [, actions] of Object.entries(resources)) {
        for (const action of actions as Action[]) {
          expect(ALL_ACTIONS).toContain(action);
        }
      }
    }
  });

  it('should not have duplicate actions for any role-resource pair', () => {
    for (const role of VALID_ROLES) {
      const resources = ACCESS_CONTROL_MATRIX[role];
      for (const [resource, actions] of Object.entries(resources)) {
        const unique = new Set(actions as Action[]);
        expect(unique.size).toBe((actions as Action[]).length);
      }
    }
  });

  it('should only reference valid resources', () => {
    for (const role of VALID_ROLES) {
      const resources = Object.keys(ACCESS_CONTROL_MATRIX[role]);
      for (const res of resources) {
        expect(ALL_RESOURCES).toContain(res);
      }
    }
  });
});

describe('Access Control Matrix – role-specific permissions', () => {
  describe('admin role', () => {
    const perms = ACCESS_CONTROL_MATRIX['admin'];

    it('should have full CRUD on contracts', () => {
      expect(perms.contracts).toEqual(expect.arrayContaining(['create', 'read', 'update', 'delete']));
    });

    it('should have full CRUD on users', () => {
      expect(perms.users).toEqual(expect.arrayContaining(['create', 'read', 'update', 'delete']));
    });

    it('should have full CRUD on disputes', () => {
      expect(perms.disputes).toEqual(expect.arrayContaining(['create', 'read', 'update', 'delete']));
    });

    it('should be able to read and update reputation', () => {
      expect(perms.reputation).toEqual(expect.arrayContaining(['read', 'update']));
    });
  });

  describe('freelancer role', () => {
    const perms = ACCESS_CONTROL_MATRIX['freelancer'];

    it('should be able to create and read contracts', () => {
      expect(perms.contracts).toEqual(expect.arrayContaining(['create', 'read']));
    });

    it('should NOT be able to update or delete contracts', () => {
      expect(perms.contracts).not.toContain('update');
      expect(perms.contracts).not.toContain('delete');
    });

    it('should NOT have access to modify users', () => {
      expect(perms.users).not.toContain('create');
      expect(perms.users).not.toContain('update');
      expect(perms.users).not.toContain('delete');
    });
  });

  describe('client role', () => {
    const perms = ACCESS_CONTROL_MATRIX['client'];

    it('should be able to create, read, and update contracts', () => {
      expect(perms.contracts).toEqual(expect.arrayContaining(['create', 'read', 'update']));
    });

    it('should NOT be able to delete contracts', () => {
      expect(perms.contracts).not.toContain('delete');
    });

    it('should NOT be able to modify users', () => {
      expect(perms.users).not.toContain('create');
      expect(perms.users).not.toContain('update');
      expect(perms.users).not.toContain('delete');
    });
  });

  describe('guest role', () => {
    const perms = ACCESS_CONTROL_MATRIX['guest'];

    it('should only have read access to health', () => {
      expect(perms.health).toEqual(['read']);
    });

    it('should NOT have any contract permissions', () => {
      expect(perms.contracts).toBeUndefined();
    });

    it('should NOT have any user permissions', () => {
      expect(perms.users).toBeUndefined();
    });

    it('should NOT have any dispute permissions', () => {
      expect(perms.disputes).toBeUndefined();
    });

    it('should NOT have any reputation permissions', () => {
      expect(perms.reputation).toBeUndefined();
    });
  });
});
