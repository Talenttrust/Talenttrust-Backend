/**
 * @file milestones.constants.ts
 * @description Centralised string constants for the milestones subsystem.
 *
 * All error codes, error names, audit action names, environment-variable keys,
 * and user-facing message templates used across the milestones service,
 * controller, DTO, and audit modules live here.  Referencing these constants
 * instead of inline literals ensures:
 *
 *  - A single source of truth that is easy to grep and audit.
 *  - Typo-proof refactors: the compiler catches every reference when a
 *    constant is renamed.
 *  - Stable API contract strings – tests can import the same constant rather
 *    than duplicating the raw string.
 *
 * ## Grouping
 *
 * Constants are grouped by concern:
 *
 *  1. `MILESTONE_ERROR_CODES`      – machine-readable error code strings.
 *  2. `MILESTONE_ERROR_NAMES`      – Error subclass `.name` properties.
 *  3. `MILESTONE_AUDIT_ACTIONS`    – AuditAction values emitted by the audit helper.
 *  4. `MILESTONE_ENV_KEYS`         – process.env key names consumed by the service.
 *  5. `MILESTONE_MESSAGES`         – parameterised user-facing message factories.
 *  6. `MILESTONE_CONTROLLER_MSGS`  – response message snippets emitted by the controller.
 *  7. `MILESTONE_VALIDATION_MSGS`  – Zod validation error message strings from the DTO.
 */

// ─── 1. Error codes ──────────────────────────────────────────────────────────

/**
 * Machine-readable error codes used in MilestoneNotFoundError and
 * MilestoneConflictError.  Clients may switch on these values; do not rename
 * or remove existing entries without a breaking-change notice.
 */
export const MILESTONE_ERROR_CODES = {
  NOT_FOUND: 'milestone_not_found',
  CONFLICT: 'milestone_conflict',
} as const;

// ─── 2. Error names ──────────────────────────────────────────────────────────

/**
 * The `.name` property set on each custom Error subclass.  These appear in
 * stack traces and structured log records.
 */
export const MILESTONE_ERROR_NAMES = {
  NOT_FOUND: 'MilestoneNotFoundError',
  CONFLICT: 'MilestoneConflictError',
} as const;

// ─── 3. Audit action names ───────────────────────────────────────────────────

/**
 * AuditAction strings emitted by `determineMilestonesAction`.
 * Must stay in sync with the `AuditAction` union in `src/audit/types.ts`.
 */
export const MILESTONE_AUDIT_ACTIONS = {
  CREATED: 'MILESTONES_CREATED',
  UPDATED: 'MILESTONES_UPDATED',
  DELETED: 'MILESTONES_DELETED',
} as const;

// ─── 4. Environment variable keys ───────────────────────────────────────────

/**
 * Names of environment variables read by the milestones subsystem.
 */
export const MILESTONE_ENV_KEYS = {
  SOFT_DELETE_RETENTION_DAYS: 'MILESTONES_SOFT_DELETE_RETENTION_DAYS',
} as const;

// ─── 5. Message factories ────────────────────────────────────────────────────

/**
 * Parameterised message factories for runtime error messages.
 * Using functions (rather than template literals inlined at the call-site)
 * keeps the shape of every message in one place and makes them independently
 * testable.
 */
export const MILESTONE_MESSAGES = {
  notFound: (milestoneId: string, contractId: string): string =>
    `Milestone ${milestoneId} not found for contract ${contractId}`,

  alreadySoftDeleted: (milestoneId: string): string =>
    `Milestone ${milestoneId} is already soft-deleted`,

  notSoftDeleted: (milestoneId: string): string =>
    `Milestone ${milestoneId} is not soft-deleted`,

  retentionWindowExpired: (milestoneId: string, retentionDays: number): string =>
    `Milestone ${milestoneId} retention window of ${retentionDays} days has expired`,

  totalExceedsBudget: (total: number, budget: number): string =>
    `Total milestone amount exceeds maximum contract amount ` +
    `(milestones total ${total} exceeds budget of ${budget})`,
} as const;

// ─── 6. Controller response messages ────────────────────────────────────────

/**
 * Short status messages returned in the `message` field of soft-delete and
 * restore responses.
 */
export const MILESTONE_CONTROLLER_MSGS = {
  softDeleted: (milestoneId: string): string => `Milestone ${milestoneId} soft-deleted`,
  restored: (milestoneId: string): string => `Milestone ${milestoneId} restored`,
} as const;

// ─── 7. DTO / Zod validation messages ───────────────────────────────────────

/**
 * Zod error message strings referenced inside `milestones.dto.ts` schema
 * definitions.  Centralising them here means integration tests and DTO tests
 * can import the exact expected string rather than embedding it twice.
 */
export const MILESTONE_VALIDATION_MSGS = {
  // title
  titleMin: (min: number): string =>
    `Milestone title must be at least ${min} character`,
  titleMax: (max: number): string =>
    `Milestone title must not exceed ${max} characters`,

  // description
  descriptionMin: (min: number): string =>
    `Milestone description must be at least ${min} character`,
  descriptionMax: (max: number): string =>
    `Milestone description must not exceed ${max} characters`,

  // amount
  amountType: 'Milestone amount must be a number',
  amountPositive: 'Milestone amount must be a positive number',
  amountMax: (max: number): string => `Milestone amount must not exceed ${max}`,

  // deadline
  datetimeMax: (max: number): string =>
    `Datetime string must not exceed ${max} characters`,
  datetimeFormat: 'Must be a valid ISO-8601 datetime string',

  // milestoneId param
  milestoneIdUuid: 'Milestone ID must be a valid UUID',
} as const;
