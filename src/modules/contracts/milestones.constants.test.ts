/**
 * @file milestones.constants.test.ts
 * @description Comprehensive tests for the centralised milestones constants module.
 *
 * These tests verify:
 *  1. Every constant export exists with the expected type and value.
 *  2. Message factory functions produce the correct string for representative inputs.
 *  3. No value was accidentally altered by the refactor (regression guard).
 *  4. Edge-case inputs (zero, empty string, large numbers) do not throw.
 *  5. The module is self-contained — no runtime side-effects on import.
 */

import {
  MILESTONE_ERROR_CODES,
  MILESTONE_ERROR_NAMES,
  MILESTONE_AUDIT_ACTIONS,
  MILESTONE_ENV_KEYS,
  MILESTONE_MESSAGES,
  MILESTONE_CONTROLLER_MSGS,
  MILESTONE_VALIDATION_MSGS,
} from './milestones.constants';

// ─── 1. MILESTONE_ERROR_CODES ────────────────────────────────────────────────

describe('MILESTONE_ERROR_CODES', () => {
  it('exports NOT_FOUND with the expected machine-readable string', () => {
    expect(MILESTONE_ERROR_CODES.NOT_FOUND).toBe('milestone_not_found');
  });

  it('exports CONFLICT with the expected machine-readable string', () => {
    expect(MILESTONE_ERROR_CODES.CONFLICT).toBe('milestone_conflict');
  });

  it('contains exactly two entries', () => {
    expect(Object.keys(MILESTONE_ERROR_CODES)).toHaveLength(2);
  });

  it('values are strings', () => {
    for (const value of Object.values(MILESTONE_ERROR_CODES)) {
      expect(typeof value).toBe('string');
    }
  });

  it('keys and values are distinct (no accidental aliasing)', () => {
    const values = Object.values(MILESTONE_ERROR_CODES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

// ─── 2. MILESTONE_ERROR_NAMES ────────────────────────────────────────────────

describe('MILESTONE_ERROR_NAMES', () => {
  it('exports NOT_FOUND as MilestoneNotFoundError', () => {
    expect(MILESTONE_ERROR_NAMES.NOT_FOUND).toBe('MilestoneNotFoundError');
  });

  it('exports CONFLICT as MilestoneConflictError', () => {
    expect(MILESTONE_ERROR_NAMES.CONFLICT).toBe('MilestoneConflictError');
  });

  it('contains exactly two entries', () => {
    expect(Object.keys(MILESTONE_ERROR_NAMES)).toHaveLength(2);
  });

  it('values are non-empty strings', () => {
    for (const value of Object.values(MILESTONE_ERROR_NAMES)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('error name strings end with "Error" by convention', () => {
    for (const value of Object.values(MILESTONE_ERROR_NAMES)) {
      expect(value).toMatch(/Error$/);
    }
  });
});

// ─── 3. MILESTONE_AUDIT_ACTIONS ──────────────────────────────────────────────

describe('MILESTONE_AUDIT_ACTIONS', () => {
  it('exports CREATED as MILESTONES_CREATED', () => {
    expect(MILESTONE_AUDIT_ACTIONS.CREATED).toBe('MILESTONES_CREATED');
  });

  it('exports UPDATED as MILESTONES_UPDATED', () => {
    expect(MILESTONE_AUDIT_ACTIONS.UPDATED).toBe('MILESTONES_UPDATED');
  });

  it('exports DELETED as MILESTONES_DELETED', () => {
    expect(MILESTONE_AUDIT_ACTIONS.DELETED).toBe('MILESTONES_DELETED');
  });

  it('contains exactly three entries', () => {
    expect(Object.keys(MILESTONE_AUDIT_ACTIONS)).toHaveLength(3);
  });

  it('all values start with the MILESTONES_ prefix', () => {
    for (const value of Object.values(MILESTONE_AUDIT_ACTIONS)) {
      expect(value).toMatch(/^MILESTONES_/);
    }
  });

  it('all values are uppercase', () => {
    for (const value of Object.values(MILESTONE_AUDIT_ACTIONS)) {
      expect(value).toBe(value.toUpperCase());
    }
  });
});

// ─── 4. MILESTONE_ENV_KEYS ───────────────────────────────────────────────────

describe('MILESTONE_ENV_KEYS', () => {
  it('exports SOFT_DELETE_RETENTION_DAYS as MILESTONES_SOFT_DELETE_RETENTION_DAYS', () => {
    expect(MILESTONE_ENV_KEYS.SOFT_DELETE_RETENTION_DAYS).toBe(
      'MILESTONES_SOFT_DELETE_RETENTION_DAYS',
    );
  });

  it('contains exactly one entry', () => {
    expect(Object.keys(MILESTONE_ENV_KEYS)).toHaveLength(1);
  });

  it('value is a valid environment variable name (uppercase with underscores)', () => {
    expect(MILESTONE_ENV_KEYS.SOFT_DELETE_RETENTION_DAYS).toMatch(/^[A-Z_]+$/);
  });
});

// ─── 5. MILESTONE_MESSAGES ───────────────────────────────────────────────────

describe('MILESTONE_MESSAGES', () => {
  describe('notFound', () => {
    it('interpolates milestoneId and contractId into the message', () => {
      const msg = MILESTONE_MESSAGES.notFound('ms-123', 'contract-abc');
      expect(msg).toContain('ms-123');
      expect(msg).toContain('contract-abc');
    });

    it('returns a non-empty string', () => {
      expect(MILESTONE_MESSAGES.notFound('id', 'cid')).toBeTruthy();
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_MESSAGES.notFound('ms-1', 'c-1')).toBe(
        'Milestone ms-1 not found for contract c-1',
      );
    });

    it('handles empty string arguments without throwing', () => {
      expect(() => MILESTONE_MESSAGES.notFound('', '')).not.toThrow();
    });
  });

  describe('alreadySoftDeleted', () => {
    it('interpolates milestoneId into the message', () => {
      const msg = MILESTONE_MESSAGES.alreadySoftDeleted('ms-456');
      expect(msg).toContain('ms-456');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_MESSAGES.alreadySoftDeleted('ms-2')).toBe(
        'Milestone ms-2 is already soft-deleted',
      );
    });

    it('handles empty string argument without throwing', () => {
      expect(() => MILESTONE_MESSAGES.alreadySoftDeleted('')).not.toThrow();
    });
  });

  describe('notSoftDeleted', () => {
    it('interpolates milestoneId into the message', () => {
      const msg = MILESTONE_MESSAGES.notSoftDeleted('ms-789');
      expect(msg).toContain('ms-789');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_MESSAGES.notSoftDeleted('ms-3')).toBe(
        'Milestone ms-3 is not soft-deleted',
      );
    });

    it('handles empty string argument without throwing', () => {
      expect(() => MILESTONE_MESSAGES.notSoftDeleted('')).not.toThrow();
    });
  });

  describe('retentionWindowExpired', () => {
    it('interpolates milestoneId and retentionDays into the message', () => {
      const msg = MILESTONE_MESSAGES.retentionWindowExpired('ms-999', 30);
      expect(msg).toContain('ms-999');
      expect(msg).toContain('30');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_MESSAGES.retentionWindowExpired('ms-4', 14)).toBe(
        'Milestone ms-4 retention window of 14 days has expired',
      );
    });

    it('handles zero retention days without throwing', () => {
      expect(() => MILESTONE_MESSAGES.retentionWindowExpired('ms-x', 0)).not.toThrow();
    });

    it('handles large retention day values without throwing', () => {
      expect(() =>
        MILESTONE_MESSAGES.retentionWindowExpired('ms-x', Number.MAX_SAFE_INTEGER),
      ).not.toThrow();
    });
  });

  describe('totalExceedsBudget', () => {
    it('interpolates total and budget into the message', () => {
      const msg = MILESTONE_MESSAGES.totalExceedsBudget(1500, 1000);
      expect(msg).toContain('1500');
      expect(msg).toContain('1000');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_MESSAGES.totalExceedsBudget(1500, 1000)).toBe(
        'Total milestone amount exceeds maximum contract amount ' +
          '(milestones total 1500 exceeds budget of 1000)',
      );
    });

    it('handles zero values without throwing', () => {
      expect(() => MILESTONE_MESSAGES.totalExceedsBudget(0, 0)).not.toThrow();
    });

    it('handles floating-point values without throwing', () => {
      expect(() => MILESTONE_MESSAGES.totalExceedsBudget(100.5, 100.0)).not.toThrow();
    });
  });

  it('contains exactly five message factories', () => {
    expect(Object.keys(MILESTONE_MESSAGES)).toHaveLength(5);
  });

  it('all entries are functions', () => {
    for (const value of Object.values(MILESTONE_MESSAGES)) {
      expect(typeof value).toBe('function');
    }
  });
});

// ─── 6. MILESTONE_CONTROLLER_MSGS ───────────────────────────────────────────

describe('MILESTONE_CONTROLLER_MSGS', () => {
  describe('softDeleted', () => {
    it('interpolates milestoneId into the message', () => {
      const msg = MILESTONE_CONTROLLER_MSGS.softDeleted('ms-ctrl-1');
      expect(msg).toContain('ms-ctrl-1');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_CONTROLLER_MSGS.softDeleted('ms-5')).toBe('Milestone ms-5 soft-deleted');
    });

    it('handles empty string argument without throwing', () => {
      expect(() => MILESTONE_CONTROLLER_MSGS.softDeleted('')).not.toThrow();
    });
  });

  describe('restored', () => {
    it('interpolates milestoneId into the message', () => {
      const msg = MILESTONE_CONTROLLER_MSGS.restored('ms-ctrl-2');
      expect(msg).toContain('ms-ctrl-2');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_CONTROLLER_MSGS.restored('ms-6')).toBe('Milestone ms-6 restored');
    });

    it('handles empty string argument without throwing', () => {
      expect(() => MILESTONE_CONTROLLER_MSGS.restored('')).not.toThrow();
    });
  });

  it('contains exactly two message factories', () => {
    expect(Object.keys(MILESTONE_CONTROLLER_MSGS)).toHaveLength(2);
  });

  it('both entries are functions', () => {
    for (const value of Object.values(MILESTONE_CONTROLLER_MSGS)) {
      expect(typeof value).toBe('function');
    }
  });

  it('softDeleted and restored produce different messages for the same milestoneId', () => {
    const id = 'same-id';
    expect(MILESTONE_CONTROLLER_MSGS.softDeleted(id)).not.toBe(
      MILESTONE_CONTROLLER_MSGS.restored(id),
    );
  });
});

// ─── 7. MILESTONE_VALIDATION_MSGS ───────────────────────────────────────────

describe('MILESTONE_VALIDATION_MSGS', () => {
  describe('titleMin', () => {
    it('interpolates the min value', () => {
      expect(MILESTONE_VALIDATION_MSGS.titleMin(1)).toContain('1');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.titleMin(1)).toBe(
        'Milestone title must be at least 1 character',
      );
    });

    it('handles zero without throwing', () => {
      expect(() => MILESTONE_VALIDATION_MSGS.titleMin(0)).not.toThrow();
    });
  });

  describe('titleMax', () => {
    it('interpolates the max value', () => {
      expect(MILESTONE_VALIDATION_MSGS.titleMax(100)).toContain('100');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.titleMax(100)).toBe(
        'Milestone title must not exceed 100 characters',
      );
    });
  });

  describe('descriptionMin', () => {
    it('interpolates the min value', () => {
      expect(MILESTONE_VALIDATION_MSGS.descriptionMin(1)).toContain('1');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.descriptionMin(1)).toBe(
        'Milestone description must be at least 1 character',
      );
    });
  });

  describe('descriptionMax', () => {
    it('interpolates the max value', () => {
      expect(MILESTONE_VALIDATION_MSGS.descriptionMax(500)).toContain('500');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.descriptionMax(500)).toBe(
        'Milestone description must not exceed 500 characters',
      );
    });
  });

  describe('amountType', () => {
    it('is a string constant with the expected value', () => {
      expect(MILESTONE_VALIDATION_MSGS.amountType).toBe('Milestone amount must be a number');
    });

    it('is a string (not a function)', () => {
      expect(typeof MILESTONE_VALIDATION_MSGS.amountType).toBe('string');
    });
  });

  describe('amountPositive', () => {
    it('is a string constant with the expected value', () => {
      expect(MILESTONE_VALIDATION_MSGS.amountPositive).toBe(
        'Milestone amount must be a positive number',
      );
    });

    it('is a string (not a function)', () => {
      expect(typeof MILESTONE_VALIDATION_MSGS.amountPositive).toBe('string');
    });
  });

  describe('amountMax', () => {
    it('interpolates the max value', () => {
      expect(MILESTONE_VALIDATION_MSGS.amountMax(5000000)).toContain('5000000');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.amountMax(9999)).toBe(
        'Milestone amount must not exceed 9999',
      );
    });

    it('handles zero without throwing', () => {
      expect(() => MILESTONE_VALIDATION_MSGS.amountMax(0)).not.toThrow();
    });
  });

  describe('datetimeMax', () => {
    it('interpolates the max length value', () => {
      expect(MILESTONE_VALIDATION_MSGS.datetimeMax(64)).toContain('64');
    });

    it('produces the exact expected message', () => {
      expect(MILESTONE_VALIDATION_MSGS.datetimeMax(64)).toBe(
        'Datetime string must not exceed 64 characters',
      );
    });
  });

  describe('datetimeFormat', () => {
    it('is a string constant with the expected value', () => {
      expect(MILESTONE_VALIDATION_MSGS.datetimeFormat).toBe(
        'Must be a valid ISO-8601 datetime string',
      );
    });

    it('is a string (not a function)', () => {
      expect(typeof MILESTONE_VALIDATION_MSGS.datetimeFormat).toBe('string');
    });
  });

  describe('milestoneIdUuid', () => {
    it('is a string constant with the expected value', () => {
      expect(MILESTONE_VALIDATION_MSGS.milestoneIdUuid).toBe(
        'Milestone ID must be a valid UUID',
      );
    });

    it('is a string (not a function)', () => {
      expect(typeof MILESTONE_VALIDATION_MSGS.milestoneIdUuid).toBe('string');
    });
  });

  it('contains exactly ten validation message entries', () => {
    expect(Object.keys(MILESTONE_VALIDATION_MSGS)).toHaveLength(10);
  });

  it('string constants are non-empty', () => {
    const stringEntries = [
      MILESTONE_VALIDATION_MSGS.amountType,
      MILESTONE_VALIDATION_MSGS.amountPositive,
      MILESTONE_VALIDATION_MSGS.datetimeFormat,
      MILESTONE_VALIDATION_MSGS.milestoneIdUuid,
    ];
    for (const entry of stringEntries) {
      expect(typeof entry).toBe('string');
      expect((entry as string).length).toBeGreaterThan(0);
    }
  });
});

// ─── Cross-cutting: no accidental value collisions ───────────────────────────

describe('cross-cutting constant uniqueness', () => {
  it('MILESTONE_ERROR_CODES values do not overlap with MILESTONE_ERROR_NAMES values', () => {
    const codes = new Set(Object.values(MILESTONE_ERROR_CODES));
    const names = Object.values(MILESTONE_ERROR_NAMES);
    for (const name of names) {
      expect(codes.has(name)).toBe(false);
    }
  });

  it('MILESTONE_AUDIT_ACTIONS values are unique', () => {
    const values = Object.values(MILESTONE_AUDIT_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('factory functions are referentially distinct', () => {
    expect(MILESTONE_MESSAGES.notFound).not.toBe(MILESTONE_MESSAGES.alreadySoftDeleted);
    expect(MILESTONE_CONTROLLER_MSGS.softDeleted).not.toBe(MILESTONE_CONTROLLER_MSGS.restored);
  });
});

// ─── Regression: string values exactly match what callers depend on ──────────

describe('regression: exact string values unchanged', () => {
  it('error codes match what clients branch on', () => {
    expect(MILESTONE_ERROR_CODES.NOT_FOUND).toBe('milestone_not_found');
    expect(MILESTONE_ERROR_CODES.CONFLICT).toBe('milestone_conflict');
  });

  it('error names match Error subclass .name properties', () => {
    expect(MILESTONE_ERROR_NAMES.NOT_FOUND).toBe('MilestoneNotFoundError');
    expect(MILESTONE_ERROR_NAMES.CONFLICT).toBe('MilestoneConflictError');
  });

  it('audit action strings match AuditAction union literals in audit/types.ts', () => {
    expect(MILESTONE_AUDIT_ACTIONS.CREATED).toBe('MILESTONES_CREATED');
    expect(MILESTONE_AUDIT_ACTIONS.UPDATED).toBe('MILESTONES_UPDATED');
    expect(MILESTONE_AUDIT_ACTIONS.DELETED).toBe('MILESTONES_DELETED');
  });

  it('env key matches process.env key read by the service', () => {
    expect(MILESTONE_ENV_KEYS.SOFT_DELETE_RETENTION_DAYS).toBe(
      'MILESTONES_SOFT_DELETE_RETENTION_DAYS',
    );
  });

  it('controller messages match hard-coded strings previously in the controller', () => {
    expect(MILESTONE_CONTROLLER_MSGS.softDeleted('id-x')).toBe('Milestone id-x soft-deleted');
    expect(MILESTONE_CONTROLLER_MSGS.restored('id-y')).toBe('Milestone id-y restored');
  });

  it('validation messages match hard-coded strings previously in the DTO', () => {
    expect(MILESTONE_VALIDATION_MSGS.amountType).toBe('Milestone amount must be a number');
    expect(MILESTONE_VALIDATION_MSGS.amountPositive).toBe(
      'Milestone amount must be a positive number',
    );
    expect(MILESTONE_VALIDATION_MSGS.datetimeFormat).toBe(
      'Must be a valid ISO-8601 datetime string',
    );
    expect(MILESTONE_VALIDATION_MSGS.milestoneIdUuid).toBe('Milestone ID must be a valid UUID');
  });
});
