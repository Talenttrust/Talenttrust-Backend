/**
 * @file milestones.dto.test.ts
 * @description Comprehensive tests for milestones request/response validation schemas.
 *
 * These tests verify that the Zod schemas correctly validate:
 *   - Valid payloads pass validation
 *   - Invalid payloads are rejected with appropriate error messages
 *   - Edge cases (empty strings, wrong types, boundary values)
 *   - Optional vs required fields
 *   - Unknown keys are handled correctly
 */

import {
  createMilestoneSchema,
  updateMilestoneSchema,
  milestoneResponseSchema,
  milestonesListResponseSchema,
  milestoneIdParamSchema,
  milestonesQuerySchema,
  MILESTONE_TITLE_MAX_LENGTH,
  MILESTONE_TITLE_MIN_LENGTH,
  MILESTONE_DESCRIPTION_MAX_LENGTH,
  MILESTONE_DESCRIPTION_MIN_LENGTH,
} from './milestones.dto';
import { MAX_CONTRACT_AMOUNT_STROOPS } from '../../../contracts/bounds';

describe('createMilestoneSchema', () => {
  const validPayload = {
    title: 'Test Milestone',
    description: 'A test milestone description',
    amount: 1000,
    deadline: '2026-12-31T23:59:59.000Z',
    completed: false,
  };

  it('accepts a valid milestone payload with all fields', () => {
    const result = createMilestoneSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(validPayload);
    }
  });

  it('accepts a valid milestone payload with only required fields', () => {
    const minimalPayload = {
      title: 'Test Milestone',
      amount: 1000,
    };
    const result = createMilestoneSchema.safeParse(minimalPayload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe('Test Milestone');
      expect(result.data.amount).toBe(1000);
      expect(result.data.description).toBeUndefined();
      expect(result.data.deadline).toBeUndefined();
      expect(result.data.completed).toBeUndefined();
    }
  });

  it('rejects missing title field', () => {
    const payload = { ...validPayload, title: undefined };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('title');
    }
  });

  it('rejects missing amount field', () => {
    const payload = { ...validPayload, amount: undefined };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('amount');
    }
  });

  it('rejects title shorter than minimum length', () => {
    const payload = { ...validPayload, title: '' };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('at least');
    }
  });

  it('rejects title longer than maximum length', () => {
    const payload = { ...validPayload, title: 'x'.repeat(MILESTONE_TITLE_MAX_LENGTH + 1) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('not exceed');
    }
  });

  it('accepts title at minimum length', () => {
    const payload = { ...validPayload, title: 'x'.repeat(MILESTONE_TITLE_MIN_LENGTH) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts title at maximum length', () => {
    const payload = { ...validPayload, title: 'x'.repeat(MILESTONE_TITLE_MAX_LENGTH) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects description shorter than minimum length when provided', () => {
    const payload = { ...validPayload, description: '' };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('at least');
    }
  });

  it('rejects description longer than maximum length', () => {
    const payload = { ...validPayload, description: 'x'.repeat(MILESTONE_DESCRIPTION_MAX_LENGTH + 1) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('not exceed');
    }
  });

  it('accepts description at minimum length', () => {
    const payload = { ...validPayload, description: 'x'.repeat(MILESTONE_DESCRIPTION_MIN_LENGTH) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts description at maximum length', () => {
    const payload = { ...validPayload, description: 'x'.repeat(MILESTONE_DESCRIPTION_MAX_LENGTH) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects non-number amount', () => {
    const payload = { ...validPayload, amount: '1000' as unknown as number };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('must be a number');
    }
  });

  it('rejects negative amount', () => {
    const payload = { ...validPayload, amount: -100 };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('positive');
    }
  });

  it('rejects zero amount', () => {
    const payload = { ...validPayload, amount: 0 };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('positive');
    }
  });

  it('rejects amount exceeding maximum contract amount', () => {
    const payload = { ...validPayload, amount: MAX_CONTRACT_AMOUNT_STROOPS + 1 };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('not exceed');
    }
  });

  it('accepts amount at maximum contract amount', () => {
    const payload = { ...validPayload, amount: MAX_CONTRACT_AMOUNT_STROOPS };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects invalid datetime format for deadline', () => {
    const payload = { ...validPayload, deadline: 'not-a-date' };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('ISO-8601');
    }
  });

  it('rejects datetime string exceeding maximum length', () => {
    const payload = { ...validPayload, deadline: 'x'.repeat(65) };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('not exceed');
    }
  });

  it('accepts valid ISO-8601 datetime for deadline', () => {
    const payload = { ...validPayload, deadline: '2026-12-31T23:59:59.000Z' };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts boolean completed field', () => {
    const payload = { ...validPayload, completed: true };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.completed).toBe(true);
    }
  });

  it('strips unknown keys from payload', () => {
    const payload = {
      ...validPayload,
      unknownField: 'should be stripped',
      anotherUnknown: 123,
    };
    const result = createMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('unknownField');
      expect(result.data).not.toHaveProperty('anotherUnknown');
    }
  });
});

describe('updateMilestoneSchema', () => {
  const validPayload = {
    title: 'Updated Milestone',
    description: 'Updated description',
    amount: 2000,
  };

  it('accepts a valid update payload with all fields', () => {
    const result = updateMilestoneSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it('accepts an empty update payload (all fields optional)', () => {
    const result = updateMilestoneSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts update with only title', () => {
    const payload = { title: 'Updated Title' };
    const result = updateMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('accepts update with only amount', () => {
    const payload = { amount: 1500 };
    const result = updateMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys in strict mode', () => {
    const payload = { ...validPayload, unknownField: 'should fail' };
    const result = updateMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('Unrecognized key');
    }
  });

  it('applies same validation as create schema for title', () => {
    const payload = { title: '' };
    const result = updateMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('applies same validation as create schema for amount', () => {
    const payload = { amount: -100 };
    const result = updateMilestoneSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

describe('milestoneResponseSchema', () => {
  const validResponse = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    contractId: '550e8400-e29b-41d4-a716-446655440001',
    title: 'Test Milestone',
    description: 'Description',
    amount: 1000,
    deadline: '2026-12-31T23:59:59.000Z',
    completed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
  };

  it('accepts a valid milestone response', () => {
    const result = milestoneResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('accepts milestone response with null deadline', () => {
    const response = { ...validResponse, deadline: null };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('accepts milestone response with null deletedAt', () => {
    const response = { ...validResponse, deletedAt: null };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('accepts milestone response with deletedAt timestamp', () => {
    const response = { ...validResponse, deletedAt: '2026-01-15T00:00:00.000Z' };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID for id', () => {
    const response = { ...validResponse, id: 'not-a-uuid' };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  it('rejects invalid UUID for contractId', () => {
    const response = { ...validResponse, contractId: 'not-a-uuid' };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  it('rejects invalid datetime for createdAt', () => {
    const response = { ...validResponse, createdAt: 'not-a-date' };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean completed', () => {
    const response = { ...validResponse, completed: 'false' as unknown as boolean };
    const result = milestoneResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('milestonesListResponseSchema', () => {
  const validListResponse = {
    milestones: [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        contractId: '550e8400-e29b-41d4-a716-446655440001',
        title: 'Milestone 1',
        description: 'Description 1',
        amount: 1000,
        deadline: null,
        completed: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null,
      },
    ],
    total: 1,
  };

  it('accepts a valid milestones list response', () => {
    const result = milestonesListResponseSchema.safeParse(validListResponse);
    expect(result.success).toBe(true);
  });

  it('accepts empty milestones array', () => {
    const response = { milestones: [], total: 0 };
    const result = milestonesListResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('rejects non-array milestones', () => {
    const response = { milestones: 'not-an-array', total: 0 };
    const result = milestonesListResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  it('rejects negative total', () => {
    const response = { milestones: [], total: -1 };
    const result = milestonesListResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });

  it('rejects non-integer total', () => {
    const response = { milestones: [], total: 1.5 };
    const result = milestonesListResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('milestoneIdParamSchema', () => {
  it('accepts valid UUID for milestoneId', () => {
    const result = milestoneIdParamSchema.safeParse({ milestoneId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid UUID for milestoneId', () => {
    const result = milestoneIdParamSchema.safeParse({ milestoneId: 'not-a-uuid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('valid UUID');
    }
  });

  it('rejects empty string for milestoneId', () => {
    const result = milestoneIdParamSchema.safeParse({ milestoneId: '' });
    expect(result.success).toBe(false);
  });
});

describe('milestonesQuerySchema', () => {
  it('accepts empty query parameters', () => {
    const result = milestonesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeleted).toBe(false);
    }
  });

  it('transforms includeDeleted=true to boolean true', () => {
    const result = milestonesQuerySchema.safeParse({ includeDeleted: 'true' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeleted).toBe(true);
    }
  });

  it('transforms includeDeleted=false to boolean false', () => {
    const result = milestonesQuerySchema.safeParse({ includeDeleted: 'false' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeleted).toBe(false);
    }
  });

  it('defaults includeDeleted to false when not provided', () => {
    const result = milestonesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.includeDeleted).toBe(false);
    }
  });

  it('strips unknown query parameters', () => {
    const result = milestonesQuerySchema.safeParse({ includeDeleted: 'true', unknown: 'param' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('unknown');
    }
  });
});
