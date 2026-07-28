/**
 * @module audit/schemas
 * @description Declarative zod schemas for the audit module's request and
 * response payloads. These replace the hand-rolled parsing/validation that
 * used to live directly in `router.ts` (see PR for issue #939) so that:
 *   - every field's constraints are defined in one declarative place
 *   - invalid payloads are rejected with structured, machine-readable
 *     details (same shape as `ValidationErrorResponse` in
 *     `src/middleware/validate.middleware.ts`) instead of a bare string
 *   - the response shapes are documented and can be asserted against in
 *     tests, catching drift between the service layer and the API contract
 */

import { z } from 'zod';
import { decodeCursor } from './types';

/** Mirrors the `AuditAction` union in `./types.ts`. Keep these in sync. */
export const AUDIT_ACTIONS = [
  'CONTRACT_CREATED', 'CONTRACT_UPDATED', 'CONTRACT_CANCELLED', 'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED', 'PAYMENT_RELEASED', 'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DELETED',
  'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED',
  'AUTH_LOCKOUT_TRIGGERED', 'AUTH_LOCKOUT_RELEASED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS', 'ENDPOINT_MUTATION',
  'DEPLOYMENT_PROMOTED', 'DEPLOYMENT_ROLLED_BACK',
] as const;

/** Mirrors the `AuditSeverity` union in `./types.ts`. */
export const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export const auditSeveritySchema = z.enum(AUDIT_SEVERITIES);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/audit` request body.
 * `metadata` defaults to `{}` when omitted (previously an omitted metadata
 * field silently passed `undefined` through to the repository; defaulting
 * to an empty object is a strictly safer, additive change).
 */
export const createAuditEntryBodySchema = z.object({
  action: auditActionSchema,
  severity: auditSeveritySchema,
  actor: z.string().min(1, 'actor must not be empty'),
  resource: z.string().min(1, 'resource must not be empty'),
  resourceId: z.string().min(1, 'resourceId must not be empty'),
  metadata: z.record(z.unknown()).optional().default({}),
  ipAddress: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
});

export type CreateAuditEntryBody = z.infer<typeof createAuditEntryBodySchema>;

const isoDateStringSchema = (fieldName: string) =>
  z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), { message: `Invalid ${fieldName} timestamp` })
    .transform((value) => new Date(Date.parse(value)).toISOString());

const positiveIntStringSchema = (message: string) =>
  z
    .string()
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && String(parsed) === value.trim() && parsed >= 1;
    }, { message })
    .transform((value) => Number.parseInt(value, 10));

const nonNegativeIntStringSchema = (message: string) =>
  z
    .string()
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && String(parsed) === value.trim() && parsed >= 0;
    }, { message })
    .transform((value) => Number.parseInt(value, 10));

const cursorSchema = z.string().refine(
  (value) => {
    try {
      decodeCursor(value);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Invalid cursor format' },
);

/**
 * The old ad hoc parser used truthy checks (`if (action && ...)`) for
 * action/severity/actor/resource/resourceId/cursor, so `?cursor=` (an empty
 * string) was silently treated as "not provided" for those fields — but NOT
 * for limit/offset/from/to, which used explicit `=== undefined` checks and
 * so rejected an empty string as invalid input. Preserving that exact split
 * (rather than "helpfully" making every field consistent) keeps this
 * refactor behaviour-neutral for existing callers relying on the old quirk.
 */
const emptyStringToUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/**
 * Query-string schema for `GET /api/v1/audit` and `GET /api/v1/audit/export`.
 * Both routes share the same filter fields but enforce different `limit`
 * ceilings and defaults, so this is a factory rather than a single schema —
 * mirrors the previous `parseAuditQuery(req, { defaultLimit, maxLimit })`.
 */
export function buildAuditQuerySchema(options: { maxLimit: number; defaultLimit?: number }) {
  return z.object({
    action: emptyStringToUndefined(auditActionSchema),
    severity: emptyStringToUndefined(auditSeveritySchema),
    actor: emptyStringToUndefined(z.string().min(1)),
    resource: emptyStringToUndefined(z.string().min(1)),
    resourceId: emptyStringToUndefined(z.string().min(1)),
    from: isoDateStringSchema('from').optional(),
    to: isoDateStringSchema('to').optional(),
    limit: positiveIntStringSchema('Invalid limit')
      .optional()
      .transform((value) => (value === undefined ? options.defaultLimit : Math.min(value, options.maxLimit))),
    offset: nonNegativeIntStringSchema('Invalid offset')
      .optional()
      .transform((value) => value ?? 0),
    cursor: emptyStringToUndefined(cursorSchema),
  });
}

export type AuditQueryParams = z.infer<ReturnType<typeof buildAuditQuerySchema>>;

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/** Mirrors `AuditEntry` in `./types.ts`. */
export const auditEntryResponseSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  action: auditActionSchema,
  severity: auditSeveritySchema,
  actor: z.string(),
  resource: z.string(),
  resourceId: z.string(),
  metadata: z.record(z.unknown()),
  ipAddress: z.string().optional(),
  correlationId: z.string().optional(),
  hash: z.string(),
  previousHash: z.string(),
});

/** Mirrors `AuditQueryResult` in `./types.ts` (the cursor-paginated shape). */
export const auditQueryResultResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  count: z.number(),
  limit: z.number(),
  nextCursor: z.string().optional(),
});

/** Mirrors the legacy offset-paginated `GET /` response shape. */
export const auditLegacyQueryResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  count: z.number(),
  limit: z.number(),
  offset: z.number(),
});

/** Mirrors `IntegrityReport` in `./types.ts`. */
export const integrityReportResponseSchema = z.object({
  valid: z.boolean(),
  totalEntries: z.number(),
  firstCorruptedIndex: z.number().optional(),
  firstCorruptedId: z.string().optional(),
  checkedAt: z.string(),
});
