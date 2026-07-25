import { z } from 'zod';
import { registry } from '../../../docs/openapi-registry';
import {
  MAX_CONTRACT_AMOUNT_STROOPS,
  MAX_CONTRACT_TERMS_LENGTH,
} from '../../../contracts/bounds';

// ─── Field-level constants ────────────────────────────────────────────────────

/** Maximum character length for contract title */
export const TITLE_MAX_LENGTH = 100;
/** Minimum character length for contract title */
export const TITLE_MIN_LENGTH = 5;

/** Maximum character length for contract description */
export const DESCRIPTION_MAX_LENGTH = 1000;
/** Minimum character length for contract description */
export const DESCRIPTION_MIN_LENGTH = 10;

/** Maximum character length for contract terms */
export const TERMS_MAX_LENGTH = 5000;

/** Maximum character length for a datetime string (ISO-8601 with timezone) */
const DATETIME_MAX_LENGTH = 64;

/** Maximum character length for milestone title */
export const MILESTONE_TITLE_MAX_LENGTH = 100;
/** Minimum character length for milestone title */
export const MILESTONE_TITLE_MIN_LENGTH = 1;

/** Maximum character length for milestone description */
export const MILESTONE_DESCRIPTION_MAX_LENGTH = 500;
/** Minimum character length for milestone description */
export const MILESTONE_DESCRIPTION_MIN_LENGTH = 1;

/** Maximum character length for contractId / route :id param */
export const CONTRACT_ID_MAX_LENGTH = 128;

/** Max allowed `limit` query param value */
export const QUERY_LIMIT_MAX = 100;

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

/**
 * Milestone sub-schema used inside createContractSchema.
 * description is optional and defaults to '' (empty string); when provided
 * it is bounded to MILESTONE_DESCRIPTION_MAX_LENGTH characters.
 * .strip() drops unknown keys silently.
 */
const createMilestoneSchema = z
  .object({
    title: z
      .string()
      .min(MILESTONE_TITLE_MIN_LENGTH, `Milestone title must be at least ${MILESTONE_TITLE_MIN_LENGTH} character`)
      .max(MILESTONE_TITLE_MAX_LENGTH, `Milestone title must not exceed ${MILESTONE_TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .max(MILESTONE_DESCRIPTION_MAX_LENGTH, `Milestone description must not exceed ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters`)
      .optional()
      .default(''),
    amount: z
      .number({ invalid_type_error: 'Milestone amount must be a number' })
      .positive('Milestone amount must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `Milestone amount must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`),
    deadline: datetimeField.optional(),
    completed: z.boolean().optional().default(false),
  })
  .strip();

/**
 * Milestone sub-schema used inside updateContractSchema.
 * description is required (not optional) to keep create/update consistent.
 * .strip() drops unknown keys silently.
 */
const updateMilestoneSchema = z
  .object({
    title: z
      .string()
      .min(MILESTONE_TITLE_MIN_LENGTH, `Milestone title must be at least ${MILESTONE_TITLE_MIN_LENGTH} character`)
      .max(MILESTONE_TITLE_MAX_LENGTH, `Milestone title must not exceed ${MILESTONE_TITLE_MAX_LENGTH} characters`),
    description: z
      .string()
      .min(MILESTONE_DESCRIPTION_MIN_LENGTH, `Milestone description must be at least ${MILESTONE_DESCRIPTION_MIN_LENGTH} character`)
      .max(MILESTONE_DESCRIPTION_MAX_LENGTH, `Milestone description must not exceed ${MILESTONE_DESCRIPTION_MAX_LENGTH} characters`),
    amount: z
      .number({ invalid_type_error: 'Milestone amount must be a number' })
      .positive('Milestone amount must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `Milestone amount must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`),
    deadline: datetimeField.optional(),
    completed: z.boolean().default(false),
  })
  .strip();

// Update contract schema with partial fields for PATCH and OCC version.
// `.strict()` on both the body and each milestone rejects unrecognized
// fields (400 validation_error) instead of silently dropping them — this is
// the write path used to initiate/resolve disputes via `status`.
// Milestone *count* is intentionally left unbounded here: it's enforced by
// `validateContractBounds` in the service layer, which returns a 422
// contract_bounds_error — an established, separately-tested contract this
// schema must not shadow with an earlier 400.
export const updateContractSchema = z.object({
  body: z.object({
    version: z.number().int().min(0),
    title: z.string().min(5).max(100).optional(),
    description: z.string().min(10).max(1000).optional(),
    freelancerId: z.string().uuid().nullable().optional(),
    clientId: z.string().uuid().optional(),
    budget: z.number().positive().max(MAX_CONTRACT_AMOUNT_STROOPS).optional(),
    deadline: z.string().datetime().nullable().optional(),
    status: z.enum(['draft', 'active', 'completed', 'cancelled', 'disputed']).optional(),
    terms: z.string().max(MAX_CONTRACT_TERMS_LENGTH).nullable().optional(),
    milestones: z.array(z.object({
      title: z.string().min(1).max(100),
      description: z.string().min(1).max(500),
      amount: z.number().positive().max(MAX_CONTRACT_AMOUNT_STROOPS),
      deadline: z.string().datetime().optional(),
      completed: z.boolean().default(false),
    }).strict()).optional(),
  }).strict(),
});

/**
 * Schema for the body of POST /api/v1/contracts.
 *
 * `.strip()` on the inner body object silently drops any fields not declared
 * here, preventing unknown fields from reaching the service layer.
 */
const createContractBodySchema = z
  .object({
    title: z
      .string({ required_error: 'title is required', invalid_type_error: 'title must be a string' })
      .min(TITLE_MIN_LENGTH, `title must be at least ${TITLE_MIN_LENGTH} characters`)
      .max(TITLE_MAX_LENGTH, `title must not exceed ${TITLE_MAX_LENGTH} characters`)
      .trim(),
    description: z
      .string({ required_error: 'description is required', invalid_type_error: 'description must be a string' })
      .min(DESCRIPTION_MIN_LENGTH, `description must be at least ${DESCRIPTION_MIN_LENGTH} characters`)
      .max(DESCRIPTION_MAX_LENGTH, `description must not exceed ${DESCRIPTION_MAX_LENGTH} characters`)
      .trim(),
    freelancerId: z.string({ invalid_type_error: 'freelancerId must be a string' }).uuid('freelancerId must be a valid UUID').optional(),
    clientId: z
      .string({ required_error: 'clientId is required', invalid_type_error: 'clientId must be a string' })
      .uuid('clientId must be a valid UUID'),
    budget: z
      .number({ required_error: 'budget is required', invalid_type_error: 'budget must be a number' })
      .positive('budget must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `budget must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`),
    deadline: datetimeField.optional(),
    status: z
      .enum(['draft', 'active', 'completed', 'cancelled', 'disputed'], {
        invalid_type_error: 'status must be one of: draft, active, completed, cancelled, disputed',
      })
      .optional(),
    terms: z
      .string({ invalid_type_error: 'terms must be a string' })
      .max(TERMS_MAX_LENGTH, `terms must not exceed ${TERMS_MAX_LENGTH} characters`)
      .optional(),
    milestones: z.array(createMilestoneSchema).optional(),
  })
  .strip();

/**
 * Full request schema validated by the `validateSchema` middleware.
 * Wraps the body schema so the middleware can assign `req.body` to
 * `validData.body` after stripping unknown fields.
 */
export const createContractSchema = z
  .object({
    body: createContractBodySchema,
  })
  .strip();

// ─── Update contract schema ───────────────────────────────────────────────────

/**
 * Schema for the body of PATCH /api/v1/contracts/:id.
 *
 * All fields are optional except `version` (OCC requirement).
 * `.strip()` silently drops undeclared keys.
 */
const updateContractBodySchema = z
  .object({
    version: z
      .number({ required_error: 'version is required', invalid_type_error: 'version must be a number' })
      .int('version must be an integer')
      .min(0, 'version must be a non-negative integer'),
    title: z
      .string({ invalid_type_error: 'title must be a string' })
      .min(TITLE_MIN_LENGTH, `title must be at least ${TITLE_MIN_LENGTH} characters`)
      .max(TITLE_MAX_LENGTH, `title must not exceed ${TITLE_MAX_LENGTH} characters`)
      .trim()
      .optional(),
    description: z
      .string({ invalid_type_error: 'description must be a string' })
      .min(DESCRIPTION_MIN_LENGTH, `description must be at least ${DESCRIPTION_MIN_LENGTH} characters`)
      .max(DESCRIPTION_MAX_LENGTH, `description must not exceed ${DESCRIPTION_MAX_LENGTH} characters`)
      .trim()
      .optional(),
    freelancerId: z
      .string({ invalid_type_error: 'freelancerId must be a string' })
      .uuid('freelancerId must be a valid UUID')
      .nullable()
      .optional(),
    clientId: z
      .string({ invalid_type_error: 'clientId must be a string' })
      .uuid('clientId must be a valid UUID')
      .optional(),
    budget: z
      .number({ invalid_type_error: 'budget must be a number' })
      .positive('budget must be a positive number')
      .max(MAX_CONTRACT_AMOUNT_STROOPS, `budget must not exceed ${MAX_CONTRACT_AMOUNT_STROOPS}`)
      .optional(),
    deadline: datetimeField.nullable().optional(),
    status: z
      .enum(['draft', 'active', 'completed', 'cancelled', 'disputed'], {
        invalid_type_error: 'status must be one of: draft, active, completed, cancelled, disputed',
      })
      .optional(),
    terms: z
      .string({ invalid_type_error: 'terms must be a string' })
      .max(TERMS_MAX_LENGTH, `terms must not exceed ${TERMS_MAX_LENGTH} characters`)
      .nullable()
      .optional(),
    milestones: z.array(updateMilestoneSchema).optional(),
  })
  .strip();

export const updateContractSchema = z
  .object({
    body: updateContractBodySchema,
  })
  .strip();

// ─── Route param schema ───────────────────────────────────────────────────────

/**
 * Schema for the `:id` route parameter on all single-contract routes.
 *
 * Rejects:
 *  - Empty strings
 *  - Strings exceeding CONTRACT_ID_MAX_LENGTH (guards against oversized inputs)
 *
 * Does NOT restrict to UUID format because some test fixtures use short IDs
 * (e.g. 'abc') and imposing UUID here would break backward compatibility.
 * The service layer returns 404 for non-existent IDs regardless of format.
 */
export const contractIdParamSchema = z
  .object({
    id: z
      .string({ required_error: 'Contract id is required', invalid_type_error: 'Contract id must be a string' })
      .min(1, 'Contract id must not be empty')
      .max(CONTRACT_ID_MAX_LENGTH, `Contract id must not exceed ${CONTRACT_ID_MAX_LENGTH} characters`),
  })
  .strip();

// ─── Query param schema ───────────────────────────────────────────────────────

/**
 * Schema for query parameters on GET /api/v1/contracts.
 *
 * All fields are optional; coercion converts string query values to the
 * correct primitive types (page/limit are always strings in Express).
 *
 * `.strip()` silently drops undeclared query keys such as `admin`, `debug`,
 * or other unexpected parameters before they reach the controller.
 */
export const contractQuerySchema = z
  .object({
    page: z.coerce
      .number({ invalid_type_error: 'page must be a number' })
      .int('page must be an integer')
      .positive('page must be a positive integer')
      .optional()
      .default(1),
    limit: z.coerce
      .number({ invalid_type_error: 'limit must be a number' })
      .int('limit must be an integer')
      .positive('limit must be a positive integer')
      .max(QUERY_LIMIT_MAX, `limit must not exceed ${QUERY_LIMIT_MAX}`)
      .optional()
      .default(10),
    status: z
      .enum(['draft', 'active', 'completed', 'cancelled', 'disputed'], {
        invalid_type_error: 'status must be one of: draft, active, completed, cancelled, disputed',
      })
      .optional(),
    clientId: z.string({ invalid_type_error: 'clientId must be a string' }).uuid('clientId must be a valid UUID').optional(),
    freelancerId: z.string({ invalid_type_error: 'freelancerId must be a string' }).uuid('freelancerId must be a valid UUID').optional(),
    cursor: z.string({ invalid_type_error: 'cursor must be a string' }).max(512, 'cursor must not exceed 512 characters').optional(),
    sortBy: z.enum(['createdAt', 'title', 'budget', 'status'], {
      invalid_type_error: 'sortBy must be one of: createdAt, title, budget, status',
    }).optional(),
    sortOrder: z.enum(['asc', 'desc'], {
      invalid_type_error: 'sortOrder must be one of: asc, desc',
    }).optional(),
  })
  .strip();

// ─── OpenAPI registry ─────────────────────────────────────────────────────────

registry.register('CreateContract', createContractSchema.shape.body);

// ─── Exported types ───────────────────────────────────────────────────────────

export type CreateContractDto = z.infer<typeof createContractBodySchema>;
export type UpdateContractDto = z.infer<typeof updateContractBodySchema>;
export type ContractQueryParams = z.infer<typeof contractQuerySchema>;
export type ContractIdParam = z.infer<typeof contractIdParamSchema>;
