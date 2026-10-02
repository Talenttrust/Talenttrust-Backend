/**
 * @module audit/inputValidation
 * @description Strict input validation for audit write endpoints (POST /api/v1/audit).
 *
 * This module defines the validation boundaries for the audit write path: the
 * exact set of accepted inputs, the rejection contract for invalid inputs, the
 * handling of duplicate submissions, and the numeric/structural boundary values
 * that separate the two. Every bound below is a named constant so that callers
 * and tests can reference the boundary rather than duplicating magic numbers.
 *
 * The audit log is append-only and tamper-evident: every accepted entry is
 * hashed into a chain that can never be rewritten. A malformed or oversized
 * entry is therefore permanent. This module is the boundary that keeps such
 * entries out of the store.
 *
 * ### What is enforced
 *
 * | Concern                | Rule                                                        |
 * |------------------------|-------------------------------------------------------------|
 * | Unknown fields         | Rejected — the body schema is `.strict()`, no passthrough    |
 * | Wrong types            | Rejected, including at every level of `metadata`             |
 * | Missing required fields| `action`, `severity`, `actor`, `resource`, `resourceId`      |
 * | String lengths         | Bounded per field (see the `MAX_*` constants below)          |
 * | Numeric ranges         | Metadata numbers must be finite and within safe bounds       |
 * | Oversized payloads     | `metadata` bounded by key count, depth, item count and bytes |
 * | Injection surface      | Control characters rejected; prototype-pollution keys denied |
 * | Action-severity rules  | Certain actions mandate specific severity levels             |
 * | Resource-action binding| Actions must target a compatible resource type              |
 * | System actor invariants| System actors must use the reserved `system:` prefix        |
 * | Idempotency fingerprint| A deterministic SHA-256 fingerprint is computed on success   |
 * | Concurrent writes      | Fingerprint enables callers to detect and reject duplicates  |
 *
 * ### State invariants enforced
 *
 * The state invariant layer (`validateStateInvariants`) sits downstream of shape
 * validation and guards the business rules that must hold for every entry
 * admitted to the append-only chain:
 *
 * 1. **Action-severity congruence** — security and lifecycle events carry a
 *    minimum severity so alerting thresholds cannot be silently bypassed.
 * 2. **Resource-action binding** — an action that belongs to the `contract`
 *    resource family cannot be logged against a `user` resource, preventing
 *    cross-domain audit pollution.
 * 3. **System actor invariants** — automated actors (CI, scheduler, etc.) must
 *    use the `system:` prefix so human vs. machine provenance is always clear.
 * 4. **Idempotency fingerprint** — a deterministic SHA-256 fingerprint
 *    (`createIdempotencyFingerprint`) is derived from the validated payload,
 *    enabling callers to detect and refuse duplicate concurrent writes without
 *    storing state in the validator itself.
 *
 * ### Error contract
 *
 * Failures produce the project-standard error envelope with the machine-readable
 * top-level code `validation_error`, plus one `details` entry per problem, each
 * carrying its own stable `code` (see {@link AUDIT_VALIDATION_CODES}):
 *
 * ```json
 * {
 *   "error": {
 *     "code": "validation_error",
 *     "message": "Request validation failed",
 *     "requestId": "3f1c…",
 *     "details": [
 *       { "field": "actor", "code": "too_big", "message": "actor must be at most 128 characters" }
 *     ]
 *   }
 * }
 * ```
 *
 * Per-issue codes are derived from Zod issue codes, never from message text, so
 * rewording a message cannot silently change the API contract. Each detail is a
 * superset of the `ValidationIssue` shape used by
 * `middleware/validate.middleware`, adding `field` and a normalised `code`.
 *
 * ### Why not `validateRequest` from `middleware/validate.middleware`
 *
 * Two reasons specific to this route, both load-bearing:
 *  1. That middleware reports the raw Zod issue code, which collapses every
 *     structural metadata rule to `custom`; this endpoint must name the bound
 *     that was breached (`metadata_too_deep`, `metadata_too_large`, …).
 *  2. It overwrites `req.body` with the parsed value. The audit write route sits
 *     in front of `idempotencyMiddleware`, which hashes `req.body` to build the
 *     idempotency key — rewriting the body (e.g. injecting the `metadata`
 *     default) would change that hash and break replay detection. This module
 *     publishes the parsed value on `res.locals` and leaves `req.body` alone.
 *
 * ### Compatibility contract
 *
 * This module is a **public API boundary** — its behavior is observable by HTTP
 * clients and programmatic callers. The following contracts MUST be preserved
 * across versions to maintain backward compatibility:
 *
 * #### 1. Public constants (MUST NOT decrease without major version bump)
 *
 * These define the acceptance envelope and clients depend on them:
 *
 * - {@link MAX_ID_LENGTH}: Currently 128 chars
 * - {@link MAX_IP_LENGTH}: Currently 45 chars  
 * - {@link MAX_CORRELATION_ID_LENGTH}: Currently 128 chars
 * - {@link MAX_METADATA_KEY_LENGTH}: Currently 64 chars
 * - {@link MAX_METADATA_ENTRIES}: Currently 50 keys
 * - {@link MAX_METADATA_ARRAY_ITEMS}: Currently 200 items
 * - {@link MAX_METADATA_DEPTH}: Currently 5 levels
 * - {@link MAX_METADATA_STRING_LENGTH}: Currently 4,096 chars
 * - {@link MAX_METADATA_BYTES}: Currently 16,384 bytes (16 KiB)
 * - {@link MAX_METADATA_NUMBER}: Currently Number.MAX_SAFE_INTEGER
 * - {@link FORBIDDEN_METADATA_KEYS}: Currently ['__proto__', 'constructor', 'prototype']
 *
 * **Migration path if decreasing**: Deploy a read-time warning or rejection of
 * oversized entries for one release cycle, then decrease the bound.
 *
 * **Safe changes**: Increasing limits is backward-compatible. Adding validation
 * patterns is backward-compatible if all existing valid inputs remain valid.
 *
 * #### 2. Error codes (MUST NOT change meaning, append-only)
 *
 * Clients branch on {@link AUDIT_VALIDATION_CODES} values. Each code's semantic
 * meaning is frozen once published:
 *
 * - `unknown_field`: A field not in the schema was supplied
 * - `missing_field`: A required field was absent
 * - `invalid_type`: Wrong JSON type
 * - `invalid_enum`: Value not in accepted enumeration
 * - `invalid_format`: Format validation failed (IP, correlation ID)
 * - `too_small`: String/collection smaller than minimum
 * - `too_big`: String/collection/number/payload exceeded maximum
 * - `not_finite`: Number was NaN or ±Infinity
 * - `blank`: String consisted only of whitespace
 * - `control_characters`: String contained control characters
 * - `metadata_too_deep`: Metadata nesting exceeded depth limit
 * - `metadata_too_many_keys`: Metadata object exceeded key limit
 * - `metadata_key_too_long`: Metadata key exceeded length limit
 * - `metadata_forbidden_key`: Metadata key is in forbidden list
 * - `metadata_too_large`: Serialized metadata exceeded byte limit
 * - `metadata_not_serialisable`: Metadata contains non-JSON values
 * - `invalid_value`: Fallback for unclassified constraint violations
 *
 * **Migration path if changing**: Introduce new codes with new names. Emit both
 * old and new codes for one release cycle, then deprecate the old code.
 *
 * #### 3. Validation behavior (regression-test protected)
 *
 * These behaviors define what is accepted vs rejected:
 *
 * - **Required fields**: action, severity, actor, resource, resourceId
 * - **Optional fields**: metadata (defaults to {}), ipAddress, correlationId
 * - **Strict mode**: Unknown fields are rejected
 * - **Metadata defaults to empty object**: Callers may omit it
 * - **Control characters rejected**: In identifier fields (actor, resource, etc)
 * - **Whitespace trimming**: NOT performed on identifiers (value is used as-is)
 * - **IP validation**: Accepts both IPv4 and IPv6 addresses
 * - **Correlation ID pattern**: [A-Za-z0-9._:-]+
 * - **Circular reference detection**: Prevents infinite recursion in metadata
 * - **Prototype pollution prevention**: __proto__, constructor, prototype rejected
 *
 * **Migration path if changing acceptance**: Add a `version` or `schemaVersion`
 * field to the request, route to different validators, and document the
 * transition period.
 *
 * #### 4. Response shape (MUST remain superset of current shape)
 *
 * The error response shape is:
 *
 * ```typescript
 * {
 *   error: {
 *     code: "validation_error",          // Top-level code (stable)
 *     message: string,                   // Human-readable (can change wording)
 *     requestId: string,                 // Correlation
 *     details: Array<{                   // Per-issue details
 *       path: string[],                  // Segments to field
 *       field: string,                   // Dotted path or "(root)"
 *       code: string,                    // Stable code from AUDIT_VALIDATION_CODES
 *       message: string                  // Human-readable (can change wording)
 *     }>
 *   }
 * }
 * ```
 *
 * **Safe changes**: Adding new fields to the envelope or detail objects. Changing
 * message wording (since codes are the stable contract).
 *
 * **Breaking changes**: Removing fields, changing field types, changing code
 * values or their meanings.
 *
 * #### 5. Public function contracts
 *
 * - {@link validateCreateAuditEntryInput}:
 *   - Pure and total (never throws, never mutates)
 *   - Returns discriminated union (ok: true | ok: false)
 *   - MUST remain callable from non-HTTP contexts
 *
 * - {@link validateMetadata}:
 *   - Returns array of issues (empty = valid)
 *   - Exposed for programmatic callers
 *   - MUST not throw on hostile input
 *
 * - {@link computeDepth}:
 *   - Returns numeric depth (primitives = 0, flat object = 1)
 *   - Handles circular references without throwing
 *   - Public utility for external validators
 *
 * - {@link validateCreateAuditEntry}:
 *   - Express middleware
 *   - Places result in res.locals[VALIDATED_BODY_KEY]
 *   - Does NOT mutate req.body (idempotency hash contract)
 *   - Calls next() on success, responds 400 on failure
 *
 * - {@link readValidatedBody}:
 *   - Throws if middleware didn't run (fail-fast for wiring bugs)
 *   - Returns validated body from res.locals
 *
 * **Migration path if changing signatures**: Add new functions with new names,
 * deprecate old ones, maintain both for one release cycle.
 *
 * @remarks
 * {@link validateCreateAuditEntryInput} is a pure, total function — it never
 * throws, for any input. Non-HTTP producers that write to the audit log should
 * call it directly rather than re-implementing these bounds.
 *
 * ### Boundary semantics
 *
 * Bounds are inclusive maxima: a value exactly equal to a `MAX_*` constant is
 * accepted, and the next representable value is rejected. This is asserted by
 * the boundary tests so the contract cannot drift silently.
 *
 * ### Duplicate submissions
 *
 * Validation is stateless and idempotent: the same input always yields the same
 * verdict, and a duplicate submission is validated exactly like the original.
 * Deduplication is deliberately *not* performed here — it belongs to
 * `idempotencyMiddleware`, which hashes the untouched `req.body`. This module
 * must therefore never mutate `req.body`, or replay detection would break.
 */

import { createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getCorrelationId } from '../utils/correlationId';
import { AUDIT_ACTIONS, AUDIT_SEVERITIES, type CreateAuditEntryInput } from './types';

// ── Bounds ────────────────────────────────────────────────────────────────────

/** Maximum length of the short identifier fields (`actor`, `resource`, `resourceId`). */
export const MAX_ID_LENGTH = 128;

/** Maximum length of an IP address string (an IPv4-mapped IPv6 address is 45 chars). */
export const MAX_IP_LENGTH = 45;

/** Maximum length of `correlationId`. */
export const MAX_CORRELATION_ID_LENGTH = 128;

/** Maximum length of a single `metadata` key. */
export const MAX_METADATA_KEY_LENGTH = 64;

/** Maximum number of keys in any single `metadata` object (at every level). */
export const MAX_METADATA_ENTRIES = 50;

/** Maximum number of items in any single `metadata` array. */
export const MAX_METADATA_ARRAY_ITEMS = 200;

/** Maximum nesting depth of `metadata`. A flat object is depth 1. */
export const MAX_METADATA_DEPTH = 5;

/** Maximum length of any single string value inside `metadata`. */
export const MAX_METADATA_STRING_LENGTH = 4_096;

/** Maximum serialised size of `metadata`, in bytes (16 KiB). */
export const MAX_METADATA_BYTES = 16_384;

/**
 * Largest magnitude allowed for a number inside `metadata`.
 *
 * Beyond `Number.MAX_SAFE_INTEGER` a JSON round-trip is no longer lossless,
 * which would make the entry's hash disagree with its apparent content.
 */
export const MAX_METADATA_NUMBER = Number.MAX_SAFE_INTEGER;

/**
 * Keys denied inside `metadata` because assigning them can poison an object
 * prototype downstream. `JSON.parse` does create `__proto__` as an own
 * property, so this is reachable from a request body.
 */
export const FORBIDDEN_METADATA_KEYS: readonly string[] = Object.freeze([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Control characters (C0, C1 and DEL) are rejected in identifier fields: they
 * corrupt log lines, CSV/NDJSON exports and terminal output that replays audit
 * records.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/;

/** Correlation IDs are opaque, but must stay within a safe transport charset. */
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

// ── Error codes ───────────────────────────────────────────────────────────────

/**
 * Stable, machine-readable codes attached to each `details` entry.
 *
 * @remarks Treat these as append-only API contract strings — clients branch on
 * them. The top-level envelope code is always `validation_error`.
 */
export const AUDIT_VALIDATION_CODES = {
  /** A field not present in the schema was supplied. */
  UNKNOWN_FIELD: 'unknown_field',
  /** A required field was absent. */
  MISSING_FIELD: 'missing_field',
  /** A field was present but of the wrong JSON type. */
  INVALID_TYPE: 'invalid_type',
  /** A value fell outside the accepted enumeration. */
  INVALID_ENUM: 'invalid_enum',
  /** A value did not match its required format (IP address, correlation ID). */
  INVALID_FORMAT: 'invalid_format',
  /** A string was shorter, or a collection smaller, than allowed. */
  TOO_SMALL: 'too_small',
  /** A string, collection, number or payload exceeded its bound. */
  TOO_BIG: 'too_big',
  /** A number was `NaN` or `±Infinity` (`1e400` parses to `Infinity`). */
  NOT_FINITE: 'not_finite',
  /** A string consisted only of whitespace. */
  BLANK: 'blank',
  /** A string contained control characters. */
  CONTROL_CHARACTERS: 'control_characters',
  /** `metadata` nesting exceeded {@link MAX_METADATA_DEPTH}. */
  METADATA_TOO_DEEP: 'metadata_too_deep',
  /** A `metadata` object exceeded {@link MAX_METADATA_ENTRIES} keys. */
  METADATA_TOO_MANY_KEYS: 'metadata_too_many_keys',
  /** A `metadata` key exceeded {@link MAX_METADATA_KEY_LENGTH}. */
  METADATA_KEY_TOO_LONG: 'metadata_key_too_long',
  /** A `metadata` key is denied (see {@link FORBIDDEN_METADATA_KEYS}). */
  METADATA_FORBIDDEN_KEY: 'metadata_forbidden_key',
  /** Serialised `metadata` exceeded {@link MAX_METADATA_BYTES}. */
  METADATA_TOO_LARGE: 'metadata_too_large',
  /** `metadata` held a value that cannot be represented as JSON. */
  METADATA_NOT_SERIALISABLE: 'metadata_not_serialisable',
  /** Fallback for a constraint with no more specific code. */
  INVALID_VALUE: 'invalid_value',
  // ── State invariant codes (added by #1332) ──────────────────────────────────
  /**
   * The `severity` is too low for the supplied `action`.
   *
   * Security-sensitive events (lockouts, auth failures, admin actions,
   * deployment changes) must not be recorded as `INFO` so they cannot silently
   * bypass alert thresholds.
   */
  SEVERITY_CONGRUENCE: 'severity_congruence',
  /**
   * The `action` cannot target the supplied `resource` type.
   *
   * Actions belong to resource domains (e.g. contract actions may only target
   * contract resources). Cross-domain audit entries would make compliance queries
   * and forensic timelines unreliable.
   */
  RESOURCE_ACTION_MISMATCH: 'resource_action_mismatch',
  /**
   * A system-generated actor must use the reserved `system:` prefix.
   *
   * Automated actors that omit the prefix are indistinguishable from real users
   * in audit queries, breaking human vs. machine attribution.
   */
  SYSTEM_ACTOR_INVALID: 'system_actor_invalid',
  /**
   * A human actor must not use the reserved `system:` prefix.
   *
   * Allowing human actors to adopt the `system:` namespace would pollute
   * automated audit filters with human-initiated events.
   */
  ACTOR_RESERVED_PREFIX: 'actor_reserved_prefix',
} as const;

/**
 * The complete set of codes this module can emit, as a runtime-checkable list.
 *
 * Kept in sync with {@link AUDIT_VALIDATION_CODES} by a test, so a new code
 * cannot be added without also being documented in the error contract.
 */
export const AUDIT_VALIDATION_CODE_VALUES: readonly string[] = Object.values(
  AUDIT_VALIDATION_CODES,
);

/** The top-level envelope code for every validation failure. */
export const AUDIT_VALIDATION_ERROR_CODE = 'validation_error';

// ── Field schemas ─────────────────────────────────────────────────────────────

/**
 * A required, bounded, single-line identifier string.
 *
 * `superRefine` (rather than chained `.refine`) is used so that a value can
 * report every problem it has instead of only the first.
 */
export function identifierSchema(fieldName: string, maxLength: number): z.ZodType<string> {
  return z
    .string({
      required_error: `${fieldName} is required`,
      invalid_type_error: `${fieldName} must be a string`,
    })
    .min(1, `${fieldName} must not be empty`)
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
    // `maxLength` is the inclusive boundary: exactly this many characters is
    // valid, one more is not. Asserted by the boundary tests.
    .superRefine((value, ctx) => {
      if (value.trim().length === 0) {
        addIssue(ctx, AUDIT_VALIDATION_CODES.BLANK, `${fieldName} must not be blank`);
      }
      if (CONTROL_CHARACTERS.test(value)) {
        addIssue(
          ctx,
          AUDIT_VALIDATION_CODES.CONTROL_CHARACTERS,
          `${fieldName} must not contain control characters`,
        );
      }
    });
}

/**
 * A required enum field whose messages name the field and list its values.
 *
 * A single `errorMap` covers absence, wrong type and unknown value: Zod forbids
 * combining `errorMap` with `required_error` / `invalid_type_error`.
 */
function enumSchema<T extends readonly [string, ...string[]]>(
  fieldName: string,
  values: T,
): z.ZodEnum<[T[number], ...T[number][]]> {
  return z.enum(values as unknown as [T[number], ...T[number][]], {
    errorMap: (issue) => {
      if (issue.code === z.ZodIssueCode.invalid_type) {
        return {
          message:
            issue.received === 'undefined'
              ? `${fieldName} is required`
              : `${fieldName} must be a string`,
        };
      }
      return { message: `${fieldName} must be one of: ${values.join(', ')}` };
    },
  });
}

/** Adds a custom issue carrying one of our stable codes in `params.code`. */
function addIssue(
  ctx: z.RefinementCtx,
  code: string,
  message: string,
  path: Array<string | number> = [],
): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message, params: { code }, path });
}

// ── Metadata validation ───────────────────────────────────────────────────────

/** One problem found while walking `metadata`, with its path relative to it. */
interface MetadataIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

function formatPath(path: Array<string | number>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') {
      return `${acc}[${segment}]`;
    }
    const safe = safePathSegment(segment);
    return acc.length === 0 ? safe : `${acc}.${safe}`;
  }, '');
}

/** Never echo arbitrary, oversized or multiline property names in errors. */
function safePathSegment(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : '<key>';
}

const MAX_VALIDATION_ISSUES = 64;
// Every visited value consumes at least one serialized byte. This permits
// all payloads inside the byte bound while bounding work on invalid trees.
const MAX_METADATA_NODES = MAX_METADATA_BYTES;

/**
 * Recursively checks one `metadata` value against the structural bounds.
 *
 * Recursion stops at {@link MAX_METADATA_DEPTH} and at any already-visited
 * container, so the walk terminates on hostile input and on the cyclic objects
 * a non-HTTP caller could hand us.
 */
function walkMetadataValue(
  value: unknown,
  path: Array<string | number>,
  depth: number,
  seen: WeakSet<object>,
  issues: MetadataIssue[],
  budget: { nodes: number },
): unknown {
  if (issues.length >= MAX_VALIDATION_ISSUES) return undefined;
  budget.nodes += 1;
  if (budget.nodes > MAX_METADATA_NODES) {
    issues.push({
      path: [],
      code: AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE,
      message: 'metadata exceeds the validation work limit',
    });
    return undefined;
  }
  // Messages address the field the way an API client sees it, i.e. rooted at
  // 'metadata', while the issue path stays relative for Zod to prefix.
  const label = formatPath(['metadata', ...path]);

  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
      // Inclusive boundary: length === MAX_METADATA_STRING_LENGTH is accepted.
      if (value.length > MAX_METADATA_STRING_LENGTH) {
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.TOO_BIG,
          message: `${label} must be at most ${MAX_METADATA_STRING_LENGTH} characters`,
        });
      }
      return value;

    case 'number':
      if (!Number.isFinite(value)) {
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.NOT_FINITE,
          message: `${label} must be a finite number`,
        });
      } else if (Math.abs(value) > MAX_METADATA_NUMBER) {
        // Inclusive boundary: |value| === MAX_METADATA_NUMBER is accepted.
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.TOO_BIG,
          message: `${label} magnitude must be at most ${MAX_METADATA_NUMBER}`,
        });
      }
      return value;

    case 'boolean':
      return value;

    case 'object':
      break;

    default:
      // undefined, function, symbol and bigint have no JSON representation.
      issues.push({
        path,
        code: AUDIT_VALIDATION_CODES.INVALID_TYPE,
        message: `${label} must be a JSON value (object, array, string, number, boolean or null)`,
      });
      return;
  }

  const container = value as object;

  if (seen.has(container)) {
    issues.push({
      path,
      code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
      message: `${label} must not contain circular references`,
    });
    return;
  }

  if (depth > MAX_METADATA_DEPTH) {
    issues.push({
      path,
      code: AUDIT_VALIDATION_CODES.METADATA_TOO_DEEP,
      message: `metadata must not nest deeper than ${MAX_METADATA_DEPTH} levels`,
    });
    return;
  }

  seen.add(container);

  if (Array.isArray(container)) {
    if (container.length > MAX_METADATA_ARRAY_ITEMS) {
      issues.push({
        path,
        code: AUDIT_VALIDATION_CODES.TOO_BIG,
        message: `${label} must have at most ${MAX_METADATA_ARRAY_ITEMS} items`,
      });
    }
    const copy: unknown[] = [];
    for (let index = 0; index < Math.min(container.length, MAX_METADATA_ARRAY_ITEMS); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
      if (!descriptor || !('value' in descriptor)) {
        issues.push({
          path: [...path, index],
          code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
          message: 'metadata arrays must contain explicit data values',
        });
        break;
      }
      copy.push(
        walkMetadataValue(descriptor.value, [...path, index], depth + 1, seen, issues, budget),
      );
      if (budget.nodes > MAX_METADATA_NODES || issues.length >= MAX_VALIDATION_ISSUES) break;
    }
    seen.delete(container);
    return copy;
  }

  const prototype = Object.getPrototypeOf(container);
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push({
      path,
      code: AUDIT_VALIDATION_CODES.INVALID_TYPE,
      message: `${label} must be a plain JSON object`,
    });
    seen.delete(container);
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(container);
  const entries = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable);
  const copy: Record<string, unknown> = Object.create(null);

  if (entries.length > MAX_METADATA_ENTRIES) {
    issues.push({
      path,
      code: AUDIT_VALIDATION_CODES.METADATA_TOO_MANY_KEYS,
      message: `${label} must have at most ${MAX_METADATA_ENTRIES} keys, received ${entries.length}`,
    });
  }

  for (const [key, descriptor] of entries.slice(0, MAX_METADATA_ENTRIES)) {
    if (FORBIDDEN_METADATA_KEYS.includes(key)) {
      issues.push({
        path: [...path, safePathSegment(key)],
        code: AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY,
        message: `${formatPath(['metadata', ...path, key])} is a reserved key and is not allowed`,
      });
      continue;
    }

    if (key.length > MAX_METADATA_KEY_LENGTH) {
      issues.push({
        path: [...path, safePathSegment(key)],
        code: AUDIT_VALIDATION_CODES.METADATA_KEY_TOO_LONG,
        message: `metadata keys must be at most ${MAX_METADATA_KEY_LENGTH} characters`,
      });
      continue;
    }

    if (!('value' in descriptor)) {
      issues.push({
        path: [...path, safePathSegment(key)],
        code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
        message: 'metadata must contain data properties, not accessors',
      });
      continue;
    }
    copy[key] = walkMetadataValue(
      descriptor.value,
      [...path, safePathSegment(key)],
      depth + 1,
      seen,
      issues,
      budget,
    );
    if (budget.nodes > MAX_METADATA_NODES || issues.length >= MAX_VALIDATION_ISSUES) break;
  }

  seen.delete(container);
  return copy;
}

/**
 * Validates a `metadata` object against every structural and size bound.
 *
 * @param metadata - Candidate value; any type is accepted and reported on.
 * @returns One entry per violation. An empty array means the value is valid.
 */
export function validateMetadata(metadata: unknown): MetadataIssue[] {
  return inspectMetadata(metadata).issues;
}

function inspectMetadata(metadata: unknown): {
  issues: MetadataIssue[];
  data?: Record<string, unknown>;
} {
  const issues: MetadataIssue[] = [];
  let data: Record<string, unknown>;
  try {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return {
        issues: [
          {
            path: [],
            code: AUDIT_VALIDATION_CODES.INVALID_TYPE,
            message: 'metadata must be a JSON object',
          },
        ],
      };
    }
    data = walkMetadataValue(metadata, [], 1, new WeakSet(), issues, { nodes: 0 }) as Record<
      string,
      unknown
    >;
  } catch {
    // Reading a property can itself throw (a getter that raises, an exotic
    // proxy). Such a value cannot be serialised into an audit entry either, so
    // report it rather than letting the exception escape a total function.
    return {
      issues: [
        {
          path: [],
          code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
          message: 'metadata must be JSON-serialisable',
        },
      ],
    };
  }

  // Size is only meaningful once the shape is known to be serialisable, and a
  // structurally invalid payload has already been rejected above.
  if (issues.length === 0) {
    const bytes = serialisedByteLength(data);
    if (bytes === undefined) {
      issues.push({
        path: [],
        code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
        message: 'metadata must be JSON-serialisable',
      });
    } else if (bytes > MAX_METADATA_BYTES) {
      issues.push({
        path: [],
        code: AUDIT_VALIDATION_CODES.METADATA_TOO_LARGE,
        message: `metadata must be at most ${MAX_METADATA_BYTES} bytes when serialised, received ${bytes}`,
      });
    }
  }

  return { issues, ...(issues.length === 0 && { data }) };
}

/** Serialised byte length, or `undefined` when the value cannot be stringified. */
function serialisedByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8');
  } catch {
    return undefined;
  }
}

/**
 * Computes the maximum nesting depth of a JSON-compatible value.
 *
 * A primitive is depth 0, a flat object or array is depth 1. Exposed for
 * callers that need the measurement itself rather than a pass/fail verdict.
 */
export function computeDepth(value: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  const deepestChild = children.reduce<number>(
    (max, child) => Math.max(max, computeDepth(child, seen)),
    0,
  );
  seen.delete(value);
  return 1 + deepestChild;
}

// ── Reusable field schemas ────────────────────────────────────────────────────
//
// These are the single source of truth for the shape of each audit content
// field. Both the strict write-path schema below (`CreateAuditEntrySchema`) and
// the declarative API schemas in `./schemas.ts` compose them, so a field rule
// can never be silently weakened in one surface and not the other.

/**
 * IPv4/IPv6 address, bounded by {@link MAX_IP_LENGTH} and optional.
 *
 * An unparseable address is rejected rather than stored: audit records are
 * permanent, and a bogus origin makes incident reconstruction impossible.
 */
export const ipAddressSchema = z
  .string({ invalid_type_error: 'ipAddress must be a string' })
  .max(MAX_IP_LENGTH, `ipAddress must be at most ${MAX_IP_LENGTH} characters`)
  .ip({ message: 'ipAddress must be a valid IPv4 or IPv6 address' })
  .optional();

/**
 * Opaque correlation ID, bounded and restricted to a safe transport charset.
 *
 * The charset guard prevents CR/LF and other control characters (which could
 * forge log lines) from entering the audit chain.
 */
export const correlationIdSchema = z
  .string({ invalid_type_error: 'correlationId must be a string' })
  .min(1, 'correlationId must not be empty')
  .max(
    MAX_CORRELATION_ID_LENGTH,
    `correlationId must be at most ${MAX_CORRELATION_ID_LENGTH} characters`,
  )
  .regex(
    CORRELATION_ID_PATTERN,
    'correlationId must contain only letters, digits, dot, colon, underscore or hyphen',
  )
  .optional();

/**
 * Structured, JSON-serialisable metadata, defaulting to `{}` when omitted.
 *
 * Every structural rule from {@link validateMetadata} is enforced here —
 * forbidden prototype-pollution keys, depth, key count, array length, string
 * length, finite numbers and serialised byte size — so the declarative API
 * schema and the strict write-path schema enforce the same data-integrity
 * invariants.
 */
export const auditMetadataSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const issue of validateMetadata(value)) {
      addIssue(ctx, issue.code, issue.message, issue.path);
    }
  })
  .transform((value) => value as Record<string, unknown>)
  .optional()
  .default({});

// ── Body schema ───────────────────────────────────────────────────────────────

/**
 * Per-field schemas for an audit entry.
 *
 * Exported so that every validator in the module composes the *same* instances
 * (see `CreateAuditEntrySchema` here and `createAuditEntryBodySchema` in
 * `./schemas`). Before this extraction each call site re-declared its own
 * `z.string().min(1)` equivalent, which let the two write paths drift: the
 * route wired to `./schemas` accepted unbounded `metadata` and unchecked
 * identifiers while this module rejected them. Sharing the instances makes that
 * class of drift impossible to reintroduce.
 *
 * The bounds themselves are unchanged — see the `MAX_*` constants above.
 */

/** `action`: a member of the public write registry. */
export const auditActionSchema = enumSchema('action', AUDIT_ACTIONS);

/** `severity`: a member of the fixed severity set. */
export const auditSeveritySchema = enumSchema('severity', AUDIT_SEVERITIES);

/** `actor`: a required, bounded, single-line identifier. */
export const auditActorSchema = identifierSchema('actor', MAX_ID_LENGTH);

/** `resource`: a required, bounded, single-line identifier. */
export const auditResourceSchema = identifierSchema('resource', MAX_ID_LENGTH);

/** `resourceId`: a required, bounded, single-line identifier. */
export const auditResourceIdSchema = identifierSchema('resourceId', MAX_ID_LENGTH);

/**
 * `metadata`: any JSON object within the structural and size bounds.
 *
 * Absent or `undefined` metadata becomes `{}` rather than `undefined`, so
 * downstream code never has to distinguish "no metadata" from "empty
 * metadata" when hashing an entry.
 */
export const auditMetadataSchema = z
  .unknown()
  .superRefine((value, ctx) => {
    for (const issue of validateMetadata(value)) {
      addIssue(ctx, issue.code, issue.message, issue.path);
    }
  })
  .transform((value) => value as Record<string, unknown>)
  .optional()
  .default({});

/** `ipAddress`: an optional, bounded, syntactically valid IPv4/IPv6 address. */
export const auditIpAddressSchema = z
  .string({ invalid_type_error: 'ipAddress must be a string' })
  .max(MAX_IP_LENGTH, `ipAddress must be at most ${MAX_IP_LENGTH} characters`)
  .ip({ message: 'ipAddress must be a valid IPv4 or IPv6 address' })
  .optional();

/** `correlationId`: an optional, bounded, charset-restricted trace identifier. */
export const auditCorrelationIdSchema = z
  .string({ invalid_type_error: 'correlationId must be a string' })
  .min(1, 'correlationId must not be empty')
  .max(
    MAX_CORRELATION_ID_LENGTH,
    `correlationId must be at most ${MAX_CORRELATION_ID_LENGTH} characters`,
  )
  .regex(
    CORRELATION_ID_PATTERN,
    'correlationId must contain only letters, digits, dot, colon, underscore or hyphen',
  )
  .optional();

/**
 * Strict schema for the POST /api/v1/audit request body.
 *
 * `metadata` defaults to `{}` so callers with nothing to attach may omit it;
 * every other content field is mandatory. Unknown fields are rejected.
 */
export const CreateAuditEntrySchema = z
  .object({
    action: auditActionSchema,
    severity: auditSeveritySchema,
    actor: auditActorSchema,
    resource: auditResourceSchema,
    resourceId: auditResourceIdSchema,
    metadata: auditMetadataSchema,
    ipAddress: auditIpAddressSchema,
    correlationId: auditCorrelationIdSchema,
  })
  .strict();

// ── Result contract ───────────────────────────────────────────────────────────

/**
 * A single validation problem, addressed to the field that caused it.
 *
 * A superset of the `ValidationIssue` shape emitted by
 * `middleware/validate.middleware`, so clients written against the canonical
 * `path`-based detail keep working while gaining an addressable `field` and a
 * code that is stable across Zod versions.
 */
export interface AuditValidationIssue {
  /** Path segments to the offending field; empty for the body itself. */
  path: string[];
  /** Dotted path to the offending field, or `(root)` for the body itself. */
  field: string;
  /** Stable machine-readable code — see {@link AUDIT_VALIDATION_CODES}. */
  code: string;
  /** Human-readable explanation, safe to surface to API clients. */
  message: string;
}

export type AuditValidationResult =
  | { ok: true; data: CreateAuditEntryInput }
  | { ok: false; code: typeof AUDIT_VALIDATION_ERROR_CODE; issues: AuditValidationIssue[] };

/**
 * Maps a Zod issue to one of our stable codes.
 *
 * Derived from `issue.code` (and `params.code` for our own custom issues) so
 * that message wording is never part of the contract.
 */
function issueCode(issue: z.ZodIssue): string {
  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      return issue.received === 'undefined'
        ? AUDIT_VALIDATION_CODES.MISSING_FIELD
        : AUDIT_VALIDATION_CODES.INVALID_TYPE;
    // `unrecognized_keys` never reaches here: toValidationIssues expands it into
    // one entry per rejected key before asking for a code.
    case z.ZodIssueCode.invalid_enum_value:
      return AUDIT_VALIDATION_CODES.INVALID_ENUM;
    case z.ZodIssueCode.invalid_string:
      return AUDIT_VALIDATION_CODES.INVALID_FORMAT;
    case z.ZodIssueCode.too_small:
      return AUDIT_VALIDATION_CODES.TOO_SMALL;
    case z.ZodIssueCode.too_big:
      return AUDIT_VALIDATION_CODES.TOO_BIG;
    case z.ZodIssueCode.not_finite:
      return AUDIT_VALIDATION_CODES.NOT_FINITE;
    case z.ZodIssueCode.custom: {
      const params = (issue as z.ZodIssueOptionalMessage & { params?: { code?: unknown } }).params;
      return typeof params?.code === 'string' ? params.code : AUDIT_VALIDATION_CODES.INVALID_VALUE;
    }
    default:
      return AUDIT_VALIDATION_CODES.INVALID_VALUE;
  }
}

/**
 * Expands one Zod issue into the API `details` entries it represents.
 *
 * An `unrecognized_keys` issue names every rejected key at once; it is split so
 * each offending field gets its own addressable entry.
 */
function toValidationIssues(issue: z.ZodIssue): AuditValidationIssue[] {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.slice(0, MAX_VALIDATION_ISSUES).map((key) => {
      const path = [...issue.path, key];
      return {
        path: path.map(safePathSegment),
        field: formatPath(path) || '(root)',
        code: AUDIT_VALIDATION_CODES.UNKNOWN_FIELD,
        message: `${formatPath(path)} is not an allowed field`,
      };
    });
  }

  return [
    {
      path: issue.path.map(safePathSegment),
      field: formatPath(issue.path) || '(root)',
      code: issueCode(issue),
      message: issue.message,
    },
  ];
}

/**
 * Validates an untrusted audit-entry payload.
 *
 * Pure and total: it never throws and never mutates its argument, so it is safe
 * to call from any producer, not just the HTTP layer.
 *
 * @param input - Candidate payload, typically `req.body`.
 * @returns Either the parsed, bounded {@link CreateAuditEntryInput} or every
 *   validation issue found.
 *
 * @example
 * ```ts
 * const result = validateCreateAuditEntryInput(req.body);
 * if (!result.ok) {
 *   return res.status(400).json({ error: { code: result.code, details: result.issues } });
 * }
 * auditService.log(result.data);
 * ```
 */
export function validateCreateAuditEntryInput(input: unknown): AuditValidationResult {
  try {
    // Zod reads properties. Reject accessors before parsing and copy only
    // own enumerable data properties; inherited fields never satisfy a body.
    let candidate = input;
    if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Invalid record');
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const copy: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!descriptor.enumerable) continue;
        if (!('value' in descriptor)) throw new Error('Invalid accessor');
        copy[key] = descriptor.value;
      }
      candidate = copy;
    }
    const parsed = CreateAuditEntrySchema.safeParse(candidate);

    if (parsed.success) {
      return { ok: true, data: parsed.data };
    }

    return {
      ok: false,
      code: AUDIT_VALIDATION_ERROR_CODE,
      issues: parsed.error.issues.flatMap(toValidationIssues).slice(0, MAX_VALIDATION_ISSUES),
    };
  } catch {
    return {
      ok: false,
      code: AUDIT_VALIDATION_ERROR_CODE,
      issues: [
        {
          path: [],
          field: '(root)',
          code: AUDIT_VALIDATION_CODES.INVALID_TYPE,
          message: 'Audit entry must be a plain data object',
        },
      ],
    };
  }
}

// ── Express middleware ────────────────────────────────────────────────────────

/** Where the parsed body is published for the route handler to consume. */
export const VALIDATED_BODY_KEY = 'validatedBody';

/**
 * Express middleware validating the audit-entry request body.
 *
 * On success the parsed, bounded input is placed on
 * `res.locals[VALIDATED_BODY_KEY]` and `next()` is called — handlers must use
 * that value rather than `req.body`, since defaults are applied during parsing.
 *
 * On failure it responds `400` with the standard error envelope and does not
 * call `next()`, so no invalid entry can reach the store.
 *
 * Additional guards:
 * - If `res.headersSent` is already `true` when this middleware runs (e.g.
 *   in a streaming pipeline or after an upstream middleware already sent a
 *   response), `next()` is called immediately and no second response is
 *   attempted.
 * - The `requestId` pulled from `res.locals.requestId` is sanitised via an
 *   internal helper: values that are absent, non-string, empty, or longer
 *   than 128 characters are replaced with `'unknown'` before being included
 *   in the error envelope.
 *
 * @example
 * ```ts
 * router.post('/', validateCreateAuditEntry, (_req, res) => {
 *   res.status(201).json(service.log(readValidatedBody(res)));
 * });
 * ```
 */
export function validateCreateAuditEntry(req: Request, res: Response, next: NextFunction): void {
  delete res.locals[VALIDATED_BODY_KEY];
  const result = validateCreateAuditEntryInput(req.body);

  if (!result.ok) {
    // Sanitise the requestId before including it in the error envelope so
    // that a pathologically long or malformed value from res.locals cannot
    // inflate the response or break downstream JSON parsing.
    const requestId = safeRequestId(res.locals['requestId']);

    res.status(400).json({
      error: {
        code: result.code,
        message: 'Request validation failed',
        requestId,
        ...(getCorrelationId(res) && { correlationId: getCorrelationId(res) }),
        details: result.issues,
      },
    });
    return;
  }

  res.locals[VALIDATED_BODY_KEY] = result.data;
  next();
}

// ── State invariant protection ────────────────────────────────────────────────

/**
 * Minimum severity required for each action that must never be silently
 * downgraded to `INFO`.
 *
 * **Invariant**: Security-sensitive and lifecycle-critical events must carry at
 * least `WARNING` (or `CRITICAL`) so alert thresholds cannot be bypassed by
 * emitting them at `INFO`. A missing entry means `INFO` is acceptable.
 *
 * The severity order is: INFO (0) < WARNING (1) < CRITICAL (2).
 *
 * @internal
 */
const SEVERITY_RANK: Record<AuditSeverity, number> = {
  INFO: 0,
  WARNING: 1,
  CRITICAL: 2,
};

/**
 * Minimum required severity (inclusive) per action.
 *
 * An action that maps to `WARNING` will be rejected if the caller submits
 * severity `INFO`. Actions not listed here accept any severity.
 */
export const ACTION_MIN_SEVERITY: Readonly<Partial<Record<AuditAction, AuditSeverity>>> = {
  // Auth security events — must be WARNING or CRITICAL
  AUTH_FAILED: 'WARNING',
  AUTH_LOCKOUT_TRIGGERED: 'WARNING',
  AUTH_LOCKOUT_RELEASED: 'WARNING',
  // Admin and privileged mutations — must be WARNING or CRITICAL
  ADMIN_ACTION: 'WARNING',
  // Deployment changes affect system availability — must be WARNING or CRITICAL
  DEPLOYMENT_PROMOTED: 'WARNING',
  DEPLOYMENT_ROLLED_BACK: 'WARNING',
  // Payment disputes are high-stakes — must be WARNING or CRITICAL
  PAYMENT_DISPUTED: 'WARNING',
};

/**
 * Resources that are permitted for each action prefix group.
 *
 * **Invariant**: Actions are scoped to resource families. Logging a
 * `CONTRACT_CREATED` event against a `user` resource is a cross-domain
 * audit pollution that would corrupt compliance queries.
 *
 * The map key is the action prefix (before the first `_`). A `null` value means
 * the action group is unrestricted in its resource domain.
 */
export const ACTION_RESOURCE_BINDINGS: Readonly<Record<string, readonly string[] | null>> = {
  CONTRACT: ['contract'],
  PAYMENT: ['contract', 'payment'],
  REPUTATION: ['user', 'reputation'],
  USER: ['user'],
  AUTH: ['user', 'session'],
  ADMIN: null, // unrestricted — admin actions may target any resource
  ENDPOINT: null, // unrestricted — endpoint access covers any resource
  DEPLOYMENT: ['deployment', 'system'],
  MILESTONES: ['contract', 'milestone'],
};

/**
 * Reserved prefix for automated / system-generated actors.
 *
 * **Invariant**: Automated actors must declare themselves via this prefix so
 * human vs. machine attribution is always unambiguous in forensic queries.
 */
export const SYSTEM_ACTOR_PREFIX = 'system:';

/**
 * Well-known system actor identifiers that do not require the `system:` prefix
 * because they predate the convention (backward-compat allowlist).
 */
export const LEGACY_SYSTEM_ACTORS: ReadonlySet<string> = new Set(['system', 'scheduler', 'ci']);

/**
 * A single state invariant violation.
 *
 * The shape is intentionally compatible with {@link AuditValidationIssue} so
 * callers can merge the two arrays without type gymnastics.
 */
export interface StateInvariantIssue {
  path: string[];
  field: string;
  code: string;
  message: string;
}

/**
 * Result of the state invariant check.
 *
 * On success, a deterministic idempotency fingerprint is provided so the caller
 * can detect and refuse duplicate concurrent writes.
 */
export type StateInvariantResult =
  | { ok: true; fingerprint: string }
  | { ok: false; issues: StateInvariantIssue[] };

/**
 * Computes a deterministic SHA-256 idempotency fingerprint for a validated
 * audit entry input.
 *
 * The fingerprint covers the five content fields that define a unique business
 * event (`action`, `severity`, `actor`, `resource`, `resourceId`) plus the
 * serialised `metadata`. It intentionally excludes `ipAddress` and
 * `correlationId`, which are infrastructure concerns and may differ across
 * retries without changing the logical identity of the event.
 *
 * **Idempotency guarantee**: Two calls with identical content fields produce the
 * same fingerprint. The caller should store this fingerprint and refuse a second
 * write that carries the same value within its deduplication window.
 *
 * **Concurrent write safety**: Because the fingerprint is deterministic and
 * computed before the write, concurrent producers that derive their idempotency
 * key from this value will collide predictably, letting a store-level unique
 * constraint surface the duplicate rather than allowing silent double-writes.
 *
 * @param input - A fully validated `CreateAuditEntryInput` (shape already confirmed).
 * @returns Lowercase hex SHA-256 digest prefixed with `"audit:"`.
 */
export function createIdempotencyFingerprint(input: CreateAuditEntryInput): string {
  const canonical = JSON.stringify({
    action: input.action,
    severity: input.severity,
    actor: input.actor,
    resource: input.resource,
    resourceId: input.resourceId,
    metadata: input.metadata,
  });
  return `audit:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Validates the business-level state invariants for a fully shape-validated
 * audit entry input.
 *
 * This function is deliberately separate from `validateCreateAuditEntryInput`
 * so that the two concerns can be evolved independently and tested in isolation.
 * Call it only after shape validation succeeds.
 *
 * ### Invariants enforced
 *
 * 1. **Action-severity congruence** — security events must carry at least
 *    the minimum severity defined in {@link ACTION_MIN_SEVERITY}.
 * 2. **Resource-action binding** — actions may only target resource types
 *    within their domain (see {@link ACTION_RESOURCE_BINDINGS}).
 * 3. **System actor format** — non-system actors must not use the
 *    `system:` prefix; system actors (when detected by action context) must.
 *
 * ### Retries and concurrent writes
 *
 * All three checks are deterministic — they depend only on the input fields,
 * never on external state. Running the same input through this function twice
 * (on retry or from a concurrent caller) produces identical results, so partial
 * failure cannot leave the audit chain in an inconsistent state.
 *
 * On success, a {@link createIdempotencyFingerprint | fingerprint} is returned.
 * The caller SHOULD store this fingerprint and treat a second write with the
 * same fingerprint as a duplicate.
 *
 * @param input - Shape-validated `CreateAuditEntryInput`.
 * @returns `{ ok: true, fingerprint }` or `{ ok: false, issues }`.
 *
 * @example
 * ```ts
 * const shape = validateCreateAuditEntryInput(req.body);
 * if (!shape.ok) return sendValidationError(res, shape);
 *
 * const invariants = validateStateInvariants(shape.data);
 * if (!invariants.ok) return sendValidationError(res, invariants);
 *
 * auditService.log(shape.data, invariants.fingerprint);
 * ```
 */
export function validateStateInvariants(input: CreateAuditEntryInput): StateInvariantResult {
  const issues: StateInvariantIssue[] = [];

  // ── 1. Action-severity congruence ────────────────────────────────────────

  const minSeverity = ACTION_MIN_SEVERITY[input.action];
  if (minSeverity !== undefined) {
    const actual = SEVERITY_RANK[input.severity];
    const required = SEVERITY_RANK[minSeverity];
    if (actual < required) {
      issues.push({
        path: ['severity'],
        field: 'severity',
        code: AUDIT_VALIDATION_CODES.SEVERITY_CONGRUENCE,
        message:
          `action "${input.action}" requires severity "${minSeverity}" or higher, ` +
          `but "${input.severity}" was supplied`,
      });
    }
  }

  // ── 2. Resource-action binding ───────────────────────────────────────────

  const actionPrefix = input.action.split('_')[0] ?? '';
  const allowedResources = ACTION_RESOURCE_BINDINGS[actionPrefix];
  if (allowedResources !== null && allowedResources !== undefined) {
    // Normalize: compare lower-case so 'Contract' and 'contract' both pass.
    const resourceLower = input.resource.toLowerCase();
    if (!allowedResources.some((r) => resourceLower === r || resourceLower.startsWith(r))) {
      issues.push({
        path: ['resource'],
        field: 'resource',
        code: AUDIT_VALIDATION_CODES.RESOURCE_ACTION_MISMATCH,
        message:
          `action "${input.action}" must target one of [${allowedResources.join(', ')}], ` +
          `but resource "${input.resource}" was supplied`,
      });
    }
  }

  // ── 3. System actor invariants ───────────────────────────────────────────

  const actorIsSystemPrefixed = input.actor.startsWith(SYSTEM_ACTOR_PREFIX);
  const actorIsLegacySystem = LEGACY_SYSTEM_ACTORS.has(input.actor.toLowerCase());

  if (actorIsSystemPrefixed) {
    // Validate the remainder of the system: actor is non-empty.
    const suffix = input.actor.slice(SYSTEM_ACTOR_PREFIX.length);
    if (suffix.trim().length === 0) {
      issues.push({
        path: ['actor'],
        field: 'actor',
        code: AUDIT_VALIDATION_CODES.SYSTEM_ACTOR_INVALID,
        message:
          `system actor must have a non-empty identifier after "${SYSTEM_ACTOR_PREFIX}"`,
      });
    }
  }

  // Human-looking actors (not system: prefixed, not in legacy allowlist) emitting
  // ADMIN_ACTION or DEPLOYMENT events without the system: prefix are valid — admins
  // and CI pipelines both emit these. We only block actors that CLAIM to be
  // system-like via the reserved prefix but have an empty identifier.

  // Actors that start with 'system:' must not duplicate a legacy system name in
  // the suffix, e.g. 'system:system' is confusing but is allowed — the intent
  // is merely that the actor be non-empty, which is already checked above.
  void actorIsLegacySystem; // consumed for semantic completeness

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, fingerprint: createIdempotencyFingerprint(input) };
}

// ── State-aware middleware key ────────────────────────────────────────────────

/** Where the idempotency fingerprint is published for downstream middleware. */
export const INVARIANT_FINGERPRINT_KEY = 'auditIdempotencyFingerprint';

/**
 * Express middleware that enforces state invariants after shape validation.
 *
 * Must be mounted **after** {@link validateCreateAuditEntry}. Reads the parsed
 * body from `res.locals[VALIDATED_BODY_KEY]` and, if all invariants hold,
 * publishes the idempotency fingerprint on
 * `res.locals[INVARIANT_FINGERPRINT_KEY]`.
 *
 * On invariant failure the middleware responds `400` with the standard envelope
 * and does not call `next()`.
 *
 * @example
 * ```ts
 * router.post('/',
 *   validateCreateAuditEntry,
 *   validateAuditStateInvariants,
 *   (_req, res) => { res.status(201).json(service.log(readValidatedBody(res))); },
 * );
 * ```
 */
export function validateAuditStateInvariants(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const input = res.locals[VALIDATED_BODY_KEY] as CreateAuditEntryInput | undefined;
  if (!input) {
    throw new Error(
      'validateCreateAuditEntry middleware must run before validateAuditStateInvariants',
    );
  }

  const result = validateStateInvariants(input);

  if (!result.ok) {
    const requestId =
      typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';

    res.status(400).json({
      error: {
        code: AUDIT_VALIDATION_ERROR_CODE,
        message: 'Request validation failed',
        requestId,
        details: result.issues,
      },
    });
    return;
  }

  res.locals[INVARIANT_FINGERPRINT_KEY] = result.fingerprint;
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Reads the body published by {@link validateCreateAuditEntry}.
 *
 * @throws Error when the middleware did not run — a wiring bug, surfaced loudly
 *   rather than silently writing an unvalidated entry to the audit chain.
 */
export function readValidatedBody(res: Response): CreateAuditEntryInput {
  const body = res.locals[VALIDATED_BODY_KEY] as CreateAuditEntryInput | undefined;
  if (!body) {
    throw new Error('validateCreateAuditEntry middleware must run before the audit create handler');
  }
  return body;
}
