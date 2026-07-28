/**
 * @file milestones.dto.ts
 * @description Declarative Zod schemas for standalone milestone request/response payloads.
 *
 * These schemas provide consistent validation for milestone operations at the API boundary,
 * replacing ad hoc validation in controllers. All milestone-related HTTP requests are validated
 * against these schemas before reaching the service layer.
 *
 * Schemas cover:
 *   - Create milestone request
 *   - Update milestone request (if/when update endpoint is added)
 *   - Milestone response serialization
 *   - Route parameter validation (milestoneId)
 *   - Query parameter validation (includeDeleted flag)
 */

import { z } from 'zod';
import { registry } from '../../../docs/openapi-registry';
import {
  MAX_CONTRACT_AMOUNT_STROOPS,
} from '../../../contracts/bounds';

// ─── Field-level constants ────────────────────────────────────────────────────

/** Maximum character length for milestone title */
export const MILESTONE_TITLE_MAX_LENGTH = 100;
/** Minimum character length for milestone title */
export const MILESTONE_TITLE_MIN_LENGTH = 1;

/** Maximum character length for milestone description */
export const MILESTONE_DESCRIPTION_MAX_LENGTH = 500;
/** Minimum character length for milestone description */
export const MILESTONE_DESCRIPTION_MIN_LENGTH = 1;

/** Maximum character length for a datetime string (ISO-8601 with timezone) */
const DATETIME_MAX_LENGTH = 64;

// ─── Reusable sub-schemas ─────────────────────────────────────────────────────

/**
 * Datetime string: must be a valid ISO-8601 datetime and not absurdly long.
 * Zod's z.string().datetime() validates the format; max(DATETIME_MAX_LENGTH)
 * prevents pathologically large strings reaching the parser.
 */
const datetimeField = z
  .string()
  .max(DATETIME_MAX_LENGTH, `Datetime string must not exceed ${DATETIME_MAX_LENGTH} characters`)
  .datetime({ message: 'Must be a valid ISO-8601 datetime string' });

// ─── Request schemas ───────────────────────────────────────────────────────────

/**
 * Schema for creating a standalone milestone via POST /:id/milestones.
 *
 * Required fields:
 *   - title: string, 1-100 characters
 *   - amount: positive number, max MAX_CONTRACT_AMOUNT_STROOPS
 *
 * Optional fields:
 *   - description: string, 1-500 characters (defaults to empty string in service)
 *   - deadline: ISO-8601 datetime string
 *   - completed: boolean (defaults to false)
 *
 * Unknown keys are stripped silently (.strip()).
 */
export const createMilestoneSchema = z
  .object({
    title: z
      .string()
      .min(MILESTONE_TITLE_MIN_LENGTH, `Milestone title must be at least ${MILESTONE_TITLE_MIN_LENGTH} character`)
      .max(MILESTONE_TITLE_MAX_LENGTH, `Milestone title must not exceed ${MILESTONE_TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .min(MILESTONE_DESCRIPTION_MIN_LENGTH, `Milestone description must be at least ${MILESTONE_DESCRIPTION_MIN_LENGTH} character`)
      .max(MILESTONE_DESCRIPTION_MAX_LENGTH, `Milestone description must not exceed ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters`)
      .optional(),
    amount: z
      .number({ invalid_type_error: 'Milestone amount must be a number' })
      .positive('Milestone amount must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `Milestone amount must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`),
    deadline: datetimeField.optional(),
    completed: z.boolean().optional(),
  })
  .strip();

/**
 * Schema for updating a standalone milestone (reserved for future PATCH endpoint).
 *
 * All fields are optional. When provided, they must pass validation.
 * .strict() rejects unknown keys rather than silently dropping them.
 */
export const updateMilestoneSchema = z
  .object({
    title: z
      .string()
      .min(MILESTONE_TITLE_MIN_LENGTH, `Milestone title must be at least ${MILESTONE_TITLE_MIN_LENGTH} character`)
      .max(MILESTONE_TITLE_MAX_LENGTH, `Milestone title must not exceed ${MILESTONE_TITLE_MAX_LENGTH} characters`)
      .optional(),
    description: z
      .string()
      .min(MILESTONE_DESCRIPTION_MIN_LENGTH, `Milestone description must be at least ${MILESTONE_DESCRIPTION_MIN_LENGTH} character`)
      .max(MILESTONE_DESCRIPTION_MAX_LENGTH, `Milestone description must not exceed ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters`)
      .optional(),
    amount: z
      .number({ invalid_type_error: 'Milestone amount must be a number' })
      .positive('Milestone amount must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `Milestone amount must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`)
      .optional(),
    deadline: datetimeField.optional(),
    completed: z.boolean().optional(),
  })
  .strict();

// ─── Response schemas ─────────────────────────────────────────────────────────

/**
 * Schema for milestone response serialization.
 * Matches the shape returned by serializeMilestone() in the controller.
 */
export const milestoneResponseSchema = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  amount: z.number(),
  deadline: z.string().datetime().nullable(),
  completed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});

/**
 * Schema for list milestones response.
 */
export const milestonesListResponseSchema = z.object({
  milestones: z.array(milestoneResponseSchema),
  total: z.number().int().nonnegative(),
});

// ─── Parameter schemas ────────────────────────────────────────────────────────

/**
 * Schema for milestoneId route parameter.
 * Must be a valid UUID.
 */
export const milestoneIdParamSchema = z.object({
  milestoneId: z.string().uuid('Milestone ID must be a valid UUID'),
});

// ─── Query parameter schemas ───────────────────────────────────────────────────

/**
 * Schema for milestones list query parameters.
 */
export const milestonesQuerySchema = z.object({
  includeDeleted: z
    .string()
    .transform((val) => val === 'true')
    .optional()
    .default('false'),
}).strip();

// ─── Type exports ─────────────────────────────────────────────────────────────

export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
export type MilestoneResponse = z.infer<typeof milestoneResponseSchema>;
export type MilestonesListResponse = z.infer<typeof milestonesListResponseSchema>;
export type MilestoneIdParams = z.infer<typeof milestoneIdParamSchema>;
export type MilestonesQuery = z.infer<typeof milestonesQuerySchema>;
