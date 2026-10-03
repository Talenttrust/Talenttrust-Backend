/**
 * @module audit/middleware
 * @description Express middleware for automatic audit logging of HTTP requests.
 *
 * Attaches a per-request audit helper to `res.locals.audit` so route handlers
 * can emit structured audit events without importing the service directly.
 *
 * When `AUDIT_ENABLED=false` the middleware attaches a no-op helper so that
 * callers compiled against `res.locals.audit.log(...)` continue to work
 * without error — they simply produce no stored entry.
 *
 * Security notes:
 * - IP addresses are extracted from X-Forwarded-For only when the app is
 *   behind a trusted proxy. Set `app.set('trust proxy', true)` accordingly.
 * - Correlation IDs from X-Correlation-ID headers are sanitised before use:
 *   control characters are stripped, the value is clamped to
 *   {@link MAX_CORRELATION_ID_LENGTH} characters, and any value that does not
 *   match the safe charset ({@link CORRELATION_ID_PATTERN}) is discarded so
 *   that attacker-controlled header values cannot pollute the audit store or
 *   downstream log aggregators.
 * - IP addresses are clamped to {@link MAX_IP_LENGTH} characters to prevent
 *   oversized values from reaching the store when the app is behind a proxy
 *   that forwards an unexpectedly long `X-Forwarded-For` chain.
 *
 * Validation invariants (enforced at this boundary):
 *
 * | Field         | Rule                                                           |
 * |---------------|----------------------------------------------------------------|
 * | correlationId | Optional; max {@link MAX_CORRELATION_ID_LENGTH} chars;         |
 * |               | must match {@link CORRELATION_ID_PATTERN}; control chars       |
 * |               | stripped before pattern check; discarded on violation.         |
 * | ipAddress     | Optional; clamped to {@link MAX_IP_LENGTH} chars (IPv6-mapped  |
 * |               | IPv4 addresses are at most 45 chars); undefined when absent.   |
 * | no-op stub    | Returns a structurally complete {@link AuditEntry} so callers  |
 * |               | that destructure `entry.id`, `entry.hash`, etc. do not crash.  |
 */

import type { Request, Response, NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { auditService } from './service';
import type { AuditEntry, CreateAuditEntryInput, AuditAction, AuditSeverity } from './types';
import { validateEnv } from '../config/env.schema';
import { z } from 'zod';
import { AUDIT_ACTIONS } from './types';
import { CreateAuditEntrySchema } from './inputValidation';
import { redactBody } from './redact';
import { sanitizeCorrelationId } from '../utils/correlationId';
import { AppError } from '../errors/appError';

type RequestAuditInput = Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>;

// The HTTP write schema predates these actions in the public AuditAction type.
// Preserve every typed helper action without broadening the HTTP endpoint.
const requestAuditSchema = CreateAuditEntrySchema
  .omit({ ipAddress: true, correlationId: true })
  .extend({ action: z.enum([
    ...AUDIT_ACTIONS, 'CONTRACT_DELETED',
    'MILESTONES_CREATED', 'MILESTONES_UPDATED', 'MILESTONES_DELETED',
  ]) })
  .strip();

function freezeMetadata(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeMetadata);
    Object.freeze(value);
  }
}

/** Prepare a detached JSON snapshot before any append can change store state. */
function prepareInput(input: RequestAuditInput): RequestAuditInput {
  try {
    const parsed = requestAuditSchema.parse(input);
    // Validation bounds depth/size and rejects cycles and non-JSON values.
    // Revalidate the serialized snapshot as getters/toJSON can alter the value.
    const snapshot: unknown = JSON.parse(JSON.stringify(parsed.metadata));
    const metadata = CreateAuditEntrySchema.shape.metadata.parse(
      redactBody(CreateAuditEntrySchema.shape.metadata.parse(snapshot)),
    );
    freezeMetadata(metadata);
    return { ...parsed, metadata };
  } catch {
    // Never expose raw values, property names or exceptions from custom getters.
    throw new AppError(400, 'validation_error', 'Invalid audit event');
  }
}

import { auditCache } from './auditCache';

// ── Validation constants ──────────────────────────────────────────────────────

/**
 * Maximum length of a `correlationId` value accepted from the
 * `X-Correlation-ID` HTTP header.
 *
 * Any value longer than this is discarded (treated as absent) rather than
 * truncated, because a truncated ID is worse for tracing than no ID at all:
 * it silently misidentifies the request in downstream log queries.
 */
export const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Maximum length of an IP address string passed to the audit store.
 *
 * An IPv4-mapped IPv6 address (`::ffff:192.168.0.1`) is 19 chars; the
 * longest canonical IPv6 address with an IPv4 suffix is 45 chars.  Values
 * beyond this are clamped rather than discarded so the entry is still
 * traceable even if the full address is not persisted.
 */
export const MAX_IP_LENGTH = 45;

/**
 * Allowed charset for correlation ID values coming from HTTP headers.
 *
 * Restricts to ASCII letters, digits, hyphen, underscore, dot and colon —
 * the characters used by common tracing standards (W3C trace-id, UUID,
 * OpenTelemetry, AWS X-Ray).  Values outside this set are discarded so that
 * attacker-controlled header injection cannot reach log aggregators.
 */
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Control characters (C0, C1 and DEL). Stripped from header values before
 * the charset check so that log-injection attempts embedded in C0 sequences
 * are neutralised even if the pattern would otherwise have accepted the value.
 */
const CONTROL_CHARACTERS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

// ── Internal sanitisers ───────────────────────────────────────────────────────

/**
 * Sanitise a raw `X-Correlation-ID` header value.
 *
 * Steps:
 *  1. If the value is absent or not a string, return `undefined`.
 *  2. Strip ASCII control characters (log-injection defence).
 *  3. If the cleaned value is empty or exceeds {@link MAX_CORRELATION_ID_LENGTH},
 *     return `undefined` — a corrupted or oversized ID is not useful for tracing.
 *  4. If the cleaned value does not match {@link CORRELATION_ID_PATTERN},
 *     return `undefined` — unknown chars could break downstream consumers.
 *  5. Otherwise return the cleaned value.
 *
 * @param raw - The raw header value, e.g. `req.headers['x-correlation-id']`.
 * @returns A sanitised correlation ID string, or `undefined` when the value
 *   is absent, malformed, or oversized.
 */
export function sanitizeCorrelationId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  // Step 2: strip control characters.
  const cleaned = raw.replace(CONTROL_CHARACTERS_RE, '');

  // Step 3: length checks.
  if (cleaned.length === 0 || cleaned.length > MAX_CORRELATION_ID_LENGTH) {
    return undefined;
  }

  // Step 4: charset check.
  if (!CORRELATION_ID_PATTERN.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

/**
 * Sanitise an IP address value coming from `req.ip` or
 * `req.socket.remoteAddress`.
 *
 * Clamps the value to {@link MAX_IP_LENGTH} characters.  Values that are
 * already within bounds are returned as-is.  `undefined` / non-string values
 * are normalised to `undefined`.
 *
 * @param raw - Candidate IP address string.
 * @returns A bounded IP address string, or `undefined` when absent.
 */
export function sanitizeIpAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw.length <= MAX_IP_LENGTH ? raw : raw.slice(0, MAX_IP_LENGTH);
}

// ── Helper types ──────────────────────────────────────────────────────────────

/** Helper attached to res.locals for route-level audit logging. */
export interface RequestAuditHelper {
  /**
   * Emits an audit event scoped to the current HTTP request.
   *
   * The middleware automatically injects `ipAddress` (from `req.ip` or the
   * raw socket) and `correlationId` (from the `X-Correlation-ID` header) so
   * callers do not need to supply those fields manually.
   *
   * Both values are sanitised before being passed to the service:
   * - `correlationId` is stripped of control characters, length-checked, and
   *   charset-validated; a value that fails any of these checks is discarded.
   * - `ipAddress` is clamped to {@link MAX_IP_LENGTH} characters.
   *
   * When `AUDIT_ENABLED=false` this is a **no-op**: it returns a structurally
   * complete stub `AuditEntry` with deterministic placeholder values and does
   * **not** write anything to the underlying store.  The stub is fully typed
   * so callers that destructure `entry.id`, `entry.hash`, `entry.timestamp`,
   * etc. continue to function without special-casing the disabled state.
   *
   * @param input - Audit event details, excluding `ipAddress` and
   *   `correlationId` (injected from the request context).
   * @returns The persisted {@link AuditEntry}, or a complete stub entry when
   *   the feature flag is off.
   */
  log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      audit: RequestAuditHelper;
    }
  }
}

// ── No-op stub ────────────────────────────────────────────────────────────────

/**
 * Sentinel values used by the no-op stub when `AUDIT_ENABLED=false`.
 *
 * These are intentionally recognisable so that monitoring tooling can
 * differentiate a genuinely persisted entry (UUID id, SHA-256 hash) from a
 * stub (constant prefix).  The fields are still structurally valid so
 * callers that read `entry.id` or `entry.hash` do not receive empty strings,
 * which could trigger downstream null-checks.
 */
export const NOOP_ENTRY_ID_PREFIX = 'noop-';
export const NOOP_ENTRY_HASH = '0'.repeat(64);
export const NOOP_ENTRY_PREVIOUS_HASH = 'GENESIS';

/**
 * Build the no-op stub `AuditEntry` returned by the disabled audit helper.
 *
 * The entry is structurally complete: every required field is populated
 * with a valid typed value so code that destructures or serialises the result
 * does not encounter `undefined` where a string is expected.
 *
 * @param input - The caller's log input, used to fill the content fields.
 * @returns A frozen, structurally complete `AuditEntry` stub.
 */
function buildNoopEntry(
  input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>,
): AuditEntry {
  const prepared = prepareInput(input);
  const action: AuditAction = prepared.action;
  const severity: AuditSeverity = prepared.severity;
  const actor = prepared.actor;
  const resource = prepared.resource;
  const resourceId = prepared.resourceId;
  const id = `${NOOP_ENTRY_ID_PREFIX}${createHash('sha256')
    .update(JSON.stringify(prepared))
    .digest('hex')
    .slice(0, 24)}`;

  return Object.freeze({
    id,
    timestamp: '1970-01-01T00:00:00.000Z',
    hash: NOOP_ENTRY_HASH,
    previousHash: NOOP_ENTRY_PREVIOUS_HASH,
    action,
    severity,
    actor,
    resource,
    resourceId,
    metadata: prepared.metadata,
  });
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Attaches `res.locals.audit` to every request.
 * Mount this before your route handlers.
 *
 * When `AUDIT_ENABLED=false` (runtime env), the attached helper is a no-op:
 * it returns a structurally complete stub `AuditEntry` without writing
 * anything to the store.  The stub has a non-empty `id` (prefixed with
 * `"noop-"`) and a zero-filled `hash` so callers that inspect the returned
 * entry do not encounter empty strings.
 *
 * Sanitisation applied unconditionally (even when the flag is on):
 * - `X-Correlation-ID` header: control chars stripped, length checked
 *   (max {@link MAX_CORRELATION_ID_LENGTH}), charset validated
 *   ({@link CORRELATION_ID_PATTERN}); discarded on any violation.
 * - `req.ip` / `req.socket.remoteAddress`: clamped to {@link MAX_IP_LENGTH}.
 *
 * @example
 * ```ts
 * app.use(auditMiddleware);
 * app.post('/api/v1/contracts', (req, res) => {
 *   res.locals.audit.log({ action: 'CONTRACT_CREATED', ... });
 *   res.json({ ... });
 * });
 * ```
 */
export function auditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const env = validateEnv();

  if (!env.AUDIT_ENABLED) {
    // Feature flag off — attach a no-op helper so route code compiles and
    // runs without branching on the flag themselves.
    res.locals.audit = {
      log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry {
        return buildNoopEntry(input);
      },
    } satisfies RequestAuditHelper;
    next();
    return;
  }

  // Sanitise request-scoped context fields once per request, before the helper
  // is attached to res.locals, so every audit entry emitted by the same
  // request gets the same validated values.
  const ipAddress = sanitizeIpAddress(req.ip ?? req.socket?.remoteAddress);
  const correlationId = sanitizeCorrelationId(req.headers['x-correlation-id']);

  // Cache the normalised request context once so every log() call from this
  // request uses the same validated ipAddress/correlationId pair, even if
  // the underlying req object is mutated later in the request lifecycle.
  const requestContext = Object.freeze({ ipAddress, correlationId });

  // Capture the request-scoped context in closure so the helper cannot be
  // affected by later mutation of `req` headers or by concurrent requests.
  // Each call to `log()` delegates to the service exactly once, preserving
  // the service's hash-chain / serialisation invariants.
  res.locals.audit = {
    log(input: Omit<CreateAuditEntryInput, 'ipAddress' | 'correlationId'>): AuditEntry {
      // Validate and detach caller-owned fields before the synchronous append.
      // A storage failure remains visible to Express so a route cannot report
      // success after losing a required audit record.
      const prepared = prepareInput(input);
      return auditService.log({ ...prepared, ...requestContext });
    },
  } satisfies RequestAuditHelper;

  // Ensure the audit cache is bounded for this request lifecycle. This is
  // idempotent and safe to call concurrently; it only evicts expired or
  // over-capacity entries and never throws.
  if (typeof auditCache.prune === 'function') {
    auditCache.prune();
  }

  next();
}
