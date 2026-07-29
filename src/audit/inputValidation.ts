/**
 * @module audit/inputValidation
 * @description Strict input validation for audit write endpoints (POST /api/v1/audit).
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
 * @remarks
 * {@link validateCreateAuditEntryInput} is a pure, total function — it never
 * throws, for any input. Non-HTTP producers that write to the audit log should
 * call it directly rather than re-implementing these bounds.
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  AUDIT_SEVERITIES,
  type CreateAuditEntryInput,
} from './types';

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
export const FORBIDDEN_METADATA_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

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
} as const;

/** The top-level envelope code for every validation failure. */
export const AUDIT_VALIDATION_ERROR_CODE = 'validation_error';

// ── Field schemas ─────────────────────────────────────────────────────────────

/**
 * A required, bounded, single-line identifier string.
 *
 * `superRefine` (rather than chained `.refine`) is used so that a value can
 * report every problem it has instead of only the first.
 */
function identifierSchema(fieldName: string, maxLength: number): z.ZodType<string> {
  return z
    .string({
      required_error: `${fieldName} is required`,
      invalid_type_error: `${fieldName} must be a string`,
    })
    .min(1, `${fieldName} must not be empty`)
    .max(maxLength, `${fieldName} must be at most ${maxLength} characters`)
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
    return acc.length === 0 ? segment : `${acc}.${segment}`;
  }, '');
}

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
): void {
  // Messages address the field the way an API client sees it, i.e. rooted at
  // 'metadata', while the issue path stays relative for Zod to prefix.
  const label = formatPath(['metadata', ...path]);

  if (value === null) {
    return;
  }

  switch (typeof value) {
    case 'string':
      if (value.length > MAX_METADATA_STRING_LENGTH) {
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.TOO_BIG,
          message: `${label} must be at most ${MAX_METADATA_STRING_LENGTH} characters`,
        });
      }
      return;

    case 'number':
      if (!Number.isFinite(value)) {
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.NOT_FINITE,
          message: `${label} must be a finite number`,
        });
      } else if (Math.abs(value) > MAX_METADATA_NUMBER) {
        issues.push({
          path,
          code: AUDIT_VALIDATION_CODES.TOO_BIG,
          message: `${label} magnitude must be at most ${MAX_METADATA_NUMBER}`,
        });
      }
      return;

    case 'boolean':
      return;

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
    container
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .forEach((item, index) =>
        walkMetadataValue(item, [...path, index], depth + 1, seen, issues),
      );
    seen.delete(container);
    return;
  }

  const entries = Object.entries(container as Record<string, unknown>);

  if (entries.length > MAX_METADATA_ENTRIES) {
    issues.push({
      path,
      code: AUDIT_VALIDATION_CODES.METADATA_TOO_MANY_KEYS,
      message: `${label} must have at most ${MAX_METADATA_ENTRIES} keys, received ${entries.length}`,
    });
  }

  for (const [key, child] of entries) {
    if (FORBIDDEN_METADATA_KEYS.includes(key)) {
      issues.push({
        path: [...path, key],
        code: AUDIT_VALIDATION_CODES.METADATA_FORBIDDEN_KEY,
        message: `${formatPath(['metadata', ...path, key])} is a reserved key and is not allowed`,
      });
      continue;
    }

    if (key.length > MAX_METADATA_KEY_LENGTH) {
      issues.push({
        path: [...path, key],
        code: AUDIT_VALIDATION_CODES.METADATA_KEY_TOO_LONG,
        message: `metadata keys must be at most ${MAX_METADATA_KEY_LENGTH} characters`,
      });
      continue;
    }

    walkMetadataValue(child, [...path, key], depth + 1, seen, issues);
  }

  seen.delete(container);
}

/**
 * Validates a `metadata` object against every structural and size bound.
 *
 * @param metadata - Candidate value; any type is accepted and reported on.
 * @returns One entry per violation. An empty array means the value is valid.
 */
export function validateMetadata(metadata: unknown): MetadataIssue[] {
  const issues: MetadataIssue[] = [];

  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return [
      {
        path: [],
        code: AUDIT_VALIDATION_CODES.INVALID_TYPE,
        message: 'metadata must be a JSON object',
      },
    ];
  }

  try {
    walkMetadataValue(metadata, [], 1, new WeakSet(), issues);
  } catch {
    // Reading a property can itself throw (a getter that raises, an exotic
    // proxy). Such a value cannot be serialised into an audit entry either, so
    // report it rather than letting the exception escape a total function.
    return [
      {
        path: [],
        code: AUDIT_VALIDATION_CODES.METADATA_NOT_SERIALISABLE,
        message: 'metadata must be JSON-serialisable',
      },
    ];
  }

  // Size is only meaningful once the shape is known to be serialisable, and a
  // structurally invalid payload has already been rejected above.
  if (issues.length === 0) {
    const bytes = serialisedByteLength(metadata);
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

  return issues;
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

// ── Body schema ───────────────────────────────────────────────────────────────

/**
 * Strict schema for the POST /api/v1/audit request body.
 *
 * `metadata` defaults to `{}` so callers with nothing to attach may omit it;
 * every other content field is mandatory. Unknown fields are rejected.
 */
export const CreateAuditEntrySchema = z
  .object({
    action: enumSchema('action', AUDIT_ACTIONS),
    severity: enumSchema('severity', AUDIT_SEVERITIES),
    actor: identifierSchema('actor', MAX_ID_LENGTH),
    resource: identifierSchema('resource', MAX_ID_LENGTH),
    resourceId: identifierSchema('resourceId', MAX_ID_LENGTH),
    metadata: z
      .unknown()
      .superRefine((value, ctx) => {
        for (const issue of validateMetadata(value)) {
          addIssue(ctx, issue.code, issue.message, issue.path);
        }
      })
      .transform((value) => value as Record<string, unknown>)
      .optional()
      .default({}),
    ipAddress: z
      .string({ invalid_type_error: 'ipAddress must be a string' })
      .max(MAX_IP_LENGTH, `ipAddress must be at most ${MAX_IP_LENGTH} characters`)
      .ip({ message: 'ipAddress must be a valid IPv4 or IPv6 address' })
      .optional(),
    correlationId: z
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
      .optional(),
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
      return typeof params?.code === 'string'
        ? params.code
        : AUDIT_VALIDATION_CODES.INVALID_VALUE;
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
    return issue.keys.map((key) => {
      const path = [...issue.path, key];
      return {
        path: path.map(String),
        field: formatPath(path) || '(root)',
        code: AUDIT_VALIDATION_CODES.UNKNOWN_FIELD,
        message: `${formatPath(path)} is not an allowed field`,
      };
    });
  }

  return [
    {
      path: issue.path.map(String),
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
  const parsed = CreateAuditEntrySchema.safeParse(input);

  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  return {
    ok: false,
    code: AUDIT_VALIDATION_ERROR_CODE,
    issues: parsed.error.issues.flatMap(toValidationIssues),
  };
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
 * @example
 * ```ts
 * router.post('/', validateCreateAuditEntry, (_req, res) => {
 *   res.status(201).json(service.log(readValidatedBody(res)));
 * });
 * ```
 */
export function validateCreateAuditEntry(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const result = validateCreateAuditEntryInput(req.body);
  const issues = result.ok ? [] : result.issues;

  const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
  if (!idempotencyKey || (typeof idempotencyKey === 'string' && idempotencyKey.trim() === '')) {
    console.error('MISSING KEY, HEADERS:', req.headers);
    issues.push({
      path: ['Idempotency-Key'],
      field: 'Idempotency-Key',
      code: AUDIT_VALIDATION_CODES.MISSING_FIELD,
      message: 'Idempotency-Key header is required',
    });
  }

  if (issues.length > 0) {
    const requestId =
      typeof res.locals['requestId'] === 'string' ? res.locals['requestId'] : 'unknown';

    res.status(400).json({
      error: {
        code: AUDIT_VALIDATION_ERROR_CODE,
        message: 'Request validation failed',
        requestId,
        details: issues,
      },
    });
    return;
  }

  res.locals[VALIDATED_BODY_KEY] = result.ok ? result.data : undefined;
  next();
}

/**
 * Reads the body published by {@link validateCreateAuditEntry}.
 *
 * @throws Error when the middleware did not run — a wiring bug, surfaced loudly
 *   rather than silently writing an unvalidated entry to the audit chain.
 */
export function readValidatedBody(res: Response): CreateAuditEntryInput {
  const body = res.locals[VALIDATED_BODY_KEY] as CreateAuditEntryInput | undefined;
  if (!body) {
    throw new Error(
      'validateCreateAuditEntry middleware must run before the audit create handler',
    );
  }
  return body;
}
