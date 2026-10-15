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
 *
 * ## Compatibility contract (issue #1365)
 *
 * This module is the audit module's *declared* boundary, so the contract it
 * encodes is now written down explicitly rather than implied by whichever
 * copy of a rule happened to be edited last.
 *
 * ### 1. One definition per rule
 *
 * | Rule                            | Authoritative definition            |
 * |---------------------------------|------------------------------------|
 * | `action` / `severity` enums      | `./types` (`AUDIT_ACTIONS`, …)     |
 * | `actor`/`resource`/`resourceId`  | `./inputValidation` (`MAX_ID_LENGTH`) |
 * | `metadata` bounds                | `./inputValidation` (`validateMetadata`) |
 * | `ipAddress` / `correlationId`    | `./inputValidation`                |
 * | Response shapes                 | this module                        |
 *
 * This module re-exports rather than re-declares. It previously carried its
 * own `AUDIT_ACTIONS` list that had drifted one entry behind `AUDIT_ACTIONS`
 * in `./types` — `REPUTATION_CORRECTED` was accepted by
 * `inputValidation.CreateAuditEntrySchema` and by `AuditService.VALID_ACTIONS`
 * but rejected by `createAuditEntryBodySchema`, which is the schema the
 * `POST /api/v1/audit` handler actually runs. Drift in the other direction is
 * impossible now that both sides import the same array.
 *
 * `createAuditEntryBodySchema` also inherits the *bounds* the module already
 * documented but did not apply on the live write route: an unbounded `metadata`
 * object is permanently hashed into an append-only chain, so it is now held to
 * `MAX_METADATA_BYTES` / depth / key-count like every other producer.
 *
 * ### 2. Deliberately preserved quirks
 *
 * Both of the following are load-bearing for existing callers and are pinned
 * by tests in `schemas.compatibility.test.ts`:
 *
 * - **Empty query filters are dropped, not rejected.** `?actor=`, `?cursor=`,
 *   `?action=` etc. behave as if the parameter were absent. The live query path
 *   (`parseAuditQuery` in `./service`) used truthy checks and still does, so
 *   tightening this would turn working requests into 400s.
 * - **`from` / `to` are not empty-string tolerant.** They were always parsed
 *   with an explicit `undefined` check, so `?from=` has always been a 400.
 *
 * ### 3. Deliberately *not* preserved
 *
 * - An inverted range (`from` later than `to`) still yields an empty result
 *   set rather than a 400. It is deterministic and cheap, and rejecting it
 *   would break a documented caller; the comparison is lexicographic over the
 *   normalised ISO-8601 form, so `from === to` matches that exact millisecond.
 * - `limit` above `maxLimit` is clamped, never rejected.
 *
 * ### 4. Where this contract differs from `parseAuditQuery`
 *
 * `GET /api/v1/audit` is currently validated by `parseAuditQuery` in
 * `./service`, not by `buildAuditQuerySchema`; the two are kept in step for
 * every input that matters, but the schema is deliberately stricter about
 * numeric spelling (`limit=007`, `limit=25.9`, `offset=+1` are rejected here
 * and silently coerced there). Those divergences are enumerated in
 * `schemas.compatibility.test.ts` so the difference stays deliberate.
 */

import { z } from 'zod';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES, AUDIT_DOMAIN_ACTIONS } from './types';
import {
  auditActionSchema as boundedAuditActionSchema,
  auditSeveritySchema as boundedAuditSeveritySchema,
  auditActorSchema,
  auditCorrelationIdSchema,
  auditIpAddressSchema,
  auditMetadataSchema,
  auditResourceIdSchema,
  auditResourceSchema,
} from './inputValidation';

// Re-exported (not re-declared) so existing importers keep working while there
// is exactly one runtime list per concept. See the table in the module header.
export { AUDIT_ACTIONS, AUDIT_SEVERITIES, AUDIT_DOMAIN_ACTIONS };

/**
 * Accepted `action` values on the public write surface.
 * Alias of the bounded field schema in `./inputValidation`.
 */
export const auditActionSchema = boundedAuditActionSchema;

/** Accepted `severity` values. Alias of the schema in `./inputValidation`. */
export const auditSeveritySchema = boundedAuditSeveritySchema;

/**
 * Any action a stored entry may legitimately carry.
 *
 * Wider than {@link auditActionSchema} by the internal-only actions the service
 * layer emits (`CONTRACT_DELETED`, `MILESTONES_*`). Response schemas validate
 * against this list; request schemas validate against {@link auditActionSchema}.
 */
export const auditDomainActionSchema = z.enum(AUDIT_DOMAIN_ACTIONS);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/audit` request body.
 *
 * Field rules are shared verbatim with `inputValidation.CreateAuditEntrySchema`
 * (see the module header); the two differ only in how they treat keys the
 * schema does not know:
 *
 * | Unknown key | This schema        | `CreateAuditEntrySchema` |
 * |-------------|--------------------|--------------------------|
 * | top level   | stripped (ignored) | rejected (`.strict()`)   |
 *
 * Stripping is preserved because it is the behaviour the route handler has
 * always had, and because `POST /api/v1/audit` sits behind
 * `idempotencyMiddleware`: the stored entry must not depend on incidental keys
 * a client happens to send.
 *
 * `metadata` defaults to `{}` when omitted (previously an omitted metadata
 * field silently passed `undefined` through to the repository; defaulting to
 * an empty object is a strictly safer, additive change).
 */
export const createAuditEntryBodySchema = z.object({
  action: auditActionSchema,
  severity: auditSeveritySchema,
  actor: auditActorSchema,
  resource: auditResourceSchema,
  resourceId: auditResourceIdSchema,
  metadata: auditMetadataSchema,
  ipAddress: auditIpAddressSchema,
  correlationId: auditCorrelationIdSchema,
});

export type CreateAuditEntryBody = z.infer<typeof createAuditEntryBodySchema>;

/**
 * `YYYY-MM-DD` only. `Date.parse` happily rolls an out-of-range day over
 * (`2026-02-30` → `2026-03-02`), which would silently shift a filter boundary;
 * the round-trip check in {@link isoDateStringSchema} turns that into a
 * rejection while leaving every other accepted spelling untouched.
 */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A parseable timestamp, normalised to canonical ISO-8601 UTC.
 *
 * Normalisation is what makes `from`/`to` comparisons safe: both repositories
 * compare timestamps lexicographically as strings, so every value that reaches
 * them must share one representation.
 *
 * Rejects (rather than guesses at) a calendar date that does not exist.
 */
const isoDateStringSchema = (fieldName: string) =>
  z
    .string()
    .refine(
      (value) => {
        const parsed = Date.parse(value);
        if (Number.isNaN(parsed)) return false;
        if (!DATE_ONLY_PATTERN.test(value)) return true;
        // Reject a rolled-over day: the round-trip must preserve the input.
        return new Date(parsed).toISOString().slice(0, 10) === value;
      },
      { message: `Invalid ${fieldName} timestamp` },
    )
    .transform((value) => new Date(Date.parse(value)).toISOString());

/**
 * A base-10 integer in string form with no sign, padding, or decimal part.
 *
 * `1` and ` 1 ` are accepted (the trim is intentional — a value that arrives
 * trimmed is unambiguous), but `01`, `+1`, `1.5` and `1e3` are not: each of
 * those has more than one sensible reading, and silently picking one is how a
 * limit turns into an unbounded query.
 */
const canonicalIntStringSchema = (message: string, minimum: number) =>
  z
    .string()
    .refine((value) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && String(parsed) === value.trim() && parsed >= minimum;
    }, { message })
    .transform((value) => Number.parseInt(value, 10));

const positiveIntStringSchema = (message: string) =>
  canonicalIntStringSchema(message, 1);

const nonNegativeIntStringSchema = (message: string) =>
  canonicalIntStringSchema(message, 0);

/**
 * A cursor's `lastTimestamp`. Not range-checked against the calendar (it is a
 * server-written field, and a cursor minted by an older build must stay
 * readable) but it must at least parse.
 */
const cursorTimestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'Invalid cursor format: lastTimestamp must be a timestamp',
  })
  .transform((value) => new Date(Date.parse(value)).toISOString());

/**
 * The filter subset a cursor embeds.
 *
 * Parsed with the same field schemas as the request itself so both sides of the
 * drift check are normalised the same way — a cursor holding `from:
 * "2026-01-01"` must compare equal to a request sending `?from=2026-01-01`.
 */
export const auditCursorFiltersSchema = z.object({
  action: auditActionSchema.optional(),
  severity: auditSeveritySchema.optional(),
  actor: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  resourceId: z.string().min(1).optional(),
  from: isoDateStringSchema('from').optional(),
  to: isoDateStringSchema('to').optional(),
});

/**
 * Decoded pagination cursor.
 *
 * A cursor is an opaque server-issued token, but "opaque" must not mean
 * "unvalidated": `decodeCursor` only reports whether base64 decoded to JSON, so
 * a payload such as `"hello"` or `{"lastId":1}` passed the old check and then
 * failed — or worse, silently reset pagination — somewhere further in. The
 * shape is therefore asserted here, at the boundary, and the store is handed
 * something it can trust.
 *
 * Unknown keys are stripped so a cursor minted by a newer writer stays readable
 * by an older reader; unknown *values* are not, because a filter the reader
 * cannot compare would break the filter-match check in
 * {@link buildAuditQuerySchema}.
 *
 * `filters` is optional: a caller may legitimately paginate an unfiltered
 * query, and `store.queryWithCursor` writes `filters: { action: undefined, … }`
 * for exactly that case, which round-trips to an absent `action`.
 */
export const auditCursorDataSchema = z
  .object({
    lastId: z.string().min(1, 'Invalid cursor format: lastId must not be empty'),
    lastTimestamp: cursorTimestampSchema,
    filters: auditCursorFiltersSchema.default({}),
  })
  .strip();

/**
 * Rejects anything that is not a cursor this module could have produced.
 *
 * The message is the module's existing `Invalid cursor format` prefix (the
 * router and the export path both classify errors by that prefix) with the
 * specific defect appended.
 */
const cursorSchema = z.string().superRefine((value, ctx) => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf-8')) as unknown;
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid cursor format' });
    return;
  }

  const parsed = auditCursorDataSchema.safeParse(decoded);
  if (!parsed.success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Invalid cursor format: ${
        parsed.error.issues[0]?.message ?? 'unrecognised payload'
      }`,
    });
  }
});

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

/** Query parameters that may only be supplied once. */
const SINGLE_VALUED_QUERY_KEYS = [
  'action',
  'severity',
  'actor',
  'resource',
  'resourceId',
  'from',
  'to',
  'limit',
  'offset',
  'cursor',
] as const;

/**
 * Query-string schema for `GET /api/v1/audit` and `GET /api/v1/audit/export`.
 * Both routes share the same filter fields but enforce different `limit`
 * ceilings and defaults, so this is a factory rather than a single schema —
 * mirrors the previous `parseAuditQuery(req, { defaultLimit, maxLimit })`.
 *
 * ### Accepted-input contract
 *
 * | Input                                  | Result                                    |
 * |----------------------------------------|-------------------------------------------|
 * | absent                                 | omitted; `limit` → `defaultLimit`, `offset` → 0 |
 * | `?limit=abc`, `?limit=0`, `?limit=-1`  | rejected (`Invalid limit`)                |
 * | `?limit=<n > maxLimit>`                | clamped to `maxLimit`                     |
 * | `?offset=-1`                           | rejected (`Invalid offset`)               |
 * | `?from=` / `?to=`                      | rejected (`Invalid from/to timestamp`)    |
 * | `?from=2026-02-30`                     | rejected — day does not exist             |
 * | `?from=2026-01-01`                     | normalised to `2026-01-01T00:00:00.000Z`  |
 * | `?actor=` (and the other filters)      | dropped, as if absent                     |
 * | any filter repeated (`?actor=a&actor=b`) | rejected — must be single-valued       |
 * | unknown parameter                      | stripped, as if absent                    |
 * | `?cursor=<not a cursor>`               | rejected (`Invalid cursor format…`)      |
 * | `?cursor=`                             | dropped, as if absent                     |
 * | cursor whose filters differ from the request | rejected (`Invalid cursor: filters do not match query filters`) |
 * | `from` later than `to`                 | accepted; matches no entry                |
 */
export function buildAuditQuerySchema(options: { maxLimit: number; defaultLimit?: number }) {
  const baseSchema = z.object({
    action: emptyStringToUndefined(auditActionSchema),
    severity: emptyStringToUndefined(auditSeveritySchema),
    actor: emptyStringToUndefined(z.string().min(1)),
    resource: emptyStringToUndefined(z.string().min(1)),
    resourceId: emptyStringToUndefined(z.string().min(1)),
    from: isoDateStringSchema('from').optional(),
    to: isoDateStringSchema('to').optional(),
    limit: positiveIntStringSchema('Invalid limit')
      .optional()
      .transform((value) =>
        value === undefined ? options.defaultLimit : Math.min(value, options.maxLimit),
      ),
    offset: nonNegativeIntStringSchema('Invalid offset')
      .optional()
      .transform((value) => value ?? 0),
    cursor: emptyStringToUndefined(cursorSchema),
  });

  /*
   * The whole query is parsed inside one `transform` rather than
   * `object(...).superRefine(...)` on purpose.
   *
   * A refinement attached to the object never runs when a field aborts: in Zod
   * an object whose key produced an `aborted` result is itself `aborted`, and
   * `ZodEffects` short-circuits before invoking refinements. `?actor=a&actor=b`
   * is exactly that case — the array fails `z.string()` — so the named
   * "provided at most once" diagnostic would never be reachable and the client
   * would only ever see "Expected string, received array".
   *
   * Taking the raw value lets the diagnostic run first, then forwards the
   * field issues verbatim, so paths and messages are unchanged.
   */
  return z.unknown().transform((raw, ctx): AuditQueryParams => {
    if (typeof raw === 'object' && raw !== null) {
      rejectRepeatedQueryKeys(raw as Record<string, unknown>, ctx);
    }

    const parsed = baseSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
      }
      return undefined as unknown as AuditQueryParams;
    }

    rejectCursorFilterDrift(parsed.data, ctx);
    return parsed.data;
  });
}

export type AuditQueryParams = z.infer<ReturnType<typeof buildAuditQuerySchema>>;

/**
 * A cursor is only meaningful against the filters that produced it. The
 * repositories already refuse to serve a drifted cursor (SQLite throws, the
 * in-memory store restarts at page one); asserting it here means both backends
 * reject identically instead of one silently rewinding.
 */
function rejectCursorFilterDrift(value: AuditQueryParams, ctx: z.RefinementCtx): void {
  if (value.cursor === undefined) return;

  const decoded = auditCursorDataSchema.safeParse(debase64(value.cursor));
  if (!decoded.success) return;

  const requested = auditCursorFiltersSchema.safeParse(value);
  const embedded = auditCursorFiltersSchema.safeParse(decoded.data.filters);
  if (!requested.success || !embedded.success) return;

  if (!sameFilters(requested.data, embedded.data)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cursor'],
      message: 'Invalid cursor: filters do not match query filters',
    });
  }
}

/**
 * Rejects a repeated or bracket-nested query parameter with a message that
 * names the parameter.
 *
 * Express turns `?actor=a&actor=b` into an array and `?actor[a]=b` into an
 * object. Both fail the field schemas anyway, but as a confusing type error on
 * a field the client believes it supplied once; naming the cause is the
 * difference between a client that fixes its URL and one that gives up.
 */
function rejectRepeatedQueryKeys(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  for (const key of SINGLE_VALUED_QUERY_KEYS) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be provided at most once`,
      });
    } else if (raw !== null && typeof raw === 'object') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `${key} must be provided as a single value`,
      });
    }
  }
}

/** Base64-decodes a cursor. Only ever called with a value `cursorSchema` accepted. */
function debase64(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Compares the two filter sets a cursor encodes.
 *
 * A key that is absent and a key explicitly set to `undefined` are the same
 * filter — that is how the cursor is written (`{ action: query.action }` in
 * `store.ts` yields `action: undefined` for an unset filter), so comparing raw
 * values would report a mismatch for every unset filter.
 */
function sameFilters(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(auditCursorFiltersSchema.shape)) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

/**
 * Sentinel `previousHash` of the first entry in a chain.
 *
 * Duplicated as a literal rather than imported from `./store` to keep this
 * module free of side effects: importing the store would instantiate the
 * process-wide `auditStore` singleton. `schemas.compatibility.test.ts` asserts
 * this literal still equals `GENESIS_HASH`.
 */
export const GENESIS_HASH_LITERAL = 'GENESIS';

/** Lowercase hex SHA-256 digest, as produced by `computeEntryHash`. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'hash must be a lowercase hex SHA-256 digest',
});

/** An ISO-8601 UTC timestamp, as written by every repository. */
const isoTimestampSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'timestamp must be an ISO-8601 timestamp',
});

/**
 * Mirrors `AuditEntry` in `./types.ts`.
 *
 * Validates against the *domain* action list rather than the request registry:
 * an entry written by `AuditService.logMilestonesEvent` carries
 * `MILESTONES_CREATED`, which is not submittable over HTTP but is entirely
 * legitimate in a response. The hash fields are constrained to their documented
 * form so a truncated or placeholder digest cannot pass as a verified chain.
 */
export const auditEntryResponseSchema = z.object({
  id: z.string().min(1),
  timestamp: isoTimestampSchema,
  action: auditDomainActionSchema,
  severity: auditSeveritySchema,
  actor: z.string().min(1),
  resource: z.string().min(1),
  resourceId: z.string().min(1),
  metadata: z.record(z.unknown()),
  ipAddress: z.string().min(1).optional(),
  correlationId: z.string().min(1).optional(),
  hash: sha256HexSchema,
  previousHash: z.union([z.literal(GENESIS_HASH_LITERAL), sha256HexSchema], {
    errorMap: () => ({
      message: `previousHash must be '${GENESIS_HASH_LITERAL}' or a lowercase hex SHA-256 digest`,
    }),
  }),
});

/** Mirrors `AuditQueryResult` in `./types.ts` (the cursor-paginated shape). */
export const auditQueryResultResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  count: nonNegativeInt().max(Number.MAX_SAFE_INTEGER),
  limit: nonNegativeInt(),
  nextCursor: z.string().min(1).optional(),
});

/** Mirrors the legacy offset-paginated `GET /` response shape. */
export const auditLegacyQueryResponseSchema = z.object({
  entries: z.array(auditEntryResponseSchema),
  count: nonNegativeInt(),
  limit: nonNegativeInt(),
  offset: nonNegativeInt(),
});

/** Mirrors `IntegrityReport` in `./types.ts`. */
export const integrityReportResponseSchema = z.object({
  valid: z.boolean(),
  totalEntries: nonNegativeInt(),
  firstCorruptedIndex: nonNegativeInt().optional(),
  firstCorruptedId: z.string().min(1).optional(),
  checkedAt: isoTimestampSchema,
});

/** A finite, non-negative, safe-integer count as emitted by the repositories. */
function nonNegativeInt() {
  return z.number().int().nonnegative().finite();
}
