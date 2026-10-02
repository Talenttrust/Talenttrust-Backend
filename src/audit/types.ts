/**
 * @module audit/types
 * @description Core type definitions for the TalentTrust immutable audit log system.
 *
 * Design principles:
 * - AuditEntry is a sealed, readonly record — no field may be mutated after creation.
 * - Each entry carries a SHA-256 hash of its own content plus the previous entry's hash,
 *   forming a tamper-evident hash chain (similar to a blockchain ledger).
 * - Sensitive payloads are stored as opaque strings; callers must sanitise PII before logging.
 *
 * State invariants owned by this module:
 * 1. AUDIT_ACTIONS is the single source of truth for valid actions. AuditAction is derived
 *    from it via type constraints, and the runtime guard {@link isAuditAction} is the
 *    only supported way to validate an untrusted value. This prevents drift between
 *    the compile-time union and the runtime allowlist.
 * 2. AuditEntries are immutable at runtime: {@link freezeAuditEntry} deep-freezes the
 *    entry and its metadata so consumers cannot mutate a persisted record.
 * 3. Cursors are opaque and self-describing; {@link decodeCursor} rejects malformed,
 *    truncated, or structurally invalid input instead of returning a partial object.
 */

/**
 * Every action that may be **submitted over the public HTTP surface**, as a
 * runtime value list.
 *
 * This is the single source of truth for the *request* contract: the
 * request-body validator (`audit/inputValidation`), the query filter validator
 * and the response schemas (`audit/schemas`) all derive their enums from this
 * array, so a new action can never be accepted by one path and rejected by
 * another.
 *
 * Invariant: `AUDIT_ACTIONS` is a subset of {@link AUDIT_DOMAIN_ACTIONS} — the
 * registry is deliberately narrower than the domain because internal-only
 * actions (see {@link AUDIT_DOMAIN_ACTIONS}) are emitted by service helpers and
 * never by an untrusted caller. `schemas.compatibility.test.ts` asserts the
 * subset relationship so the two lists cannot drift apart.
 */
export const AUDIT_ACTIONS = Object.freeze([
  'CONTRACT_CREATED',
  'CONTRACT_UPDATED',
  'CONTRACT_CANCELLED',
  'CONTRACT_COMPLETED',
  'CONTRACT_DELETED',
  'PAYMENT_INITIATED',
  'PAYMENT_RELEASED',
  'PAYMENT_DISPUED',
  'REPUTATION_UPDATED',
  'REPUTATION_CORRECTED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DELETED',
  'AUTH_LOGIN',
  'AUTH_LOGOUT',
  'AUTH_FAILED',
  'AUTH_LOCKOUT_TRIGGERED',
  'AUTH_LOCKOUT_RELEASED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS',
  'ENDPOINT_MUTATION',
  'DEPLOYMENT_PROMOTED',
  'DEPLOYMENT_ROLLED_BACK',
  'MILESTONES_CREATED',
  'MILESTONES_UPDATED',
  'MILESTONES_DELETED',
] as const);

/** Categories of sensitive state changes that must be audited. */
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Every member of the {@link AuditAction} union, as a runtime value list.
 *
 * Where {@link AUDIT_ACTIONS} describes what an untrusted caller may
 * **submit**, this list describes what the log may legitimately **contain**.
 * The difference matters in one direction only: the service layer emits
 * internal-only actions (`CONTRACT_DELETED`, `MILESTONES_*`) through
 * `AuditService.log*` helpers, so a response schema validated against
 * {@link AUDIT_ACTIONS} would reject a perfectly legitimate entry on the way
 * out. Validating responses against this list instead keeps the outbound
 * contract honest without widening the inbound one.
 *
 * `satisfies` rejects a typo that is not a member of the union, and
 * {@link AUDIT_DOMAIN_ACTIONS_ARE_EXHAUSTIVE} fails to compile when a member
 * of the union is added here — the two together make drift a build error
 * rather than a runtime surprise.
 */
export const AUDIT_DOMAIN_ACTIONS = [
  'CONTRACT_CREATED',
  'CONTRACT_UPDATED',
  'CONTRACT_CANCELLED',
  'CONTRACT_COMPLETED',
  'CONTRACT_DELETED',
  'PAYMENT_INITIATED',
  'PAYMENT_RELEASED',
  'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'REPUTATION_CORRECTED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DELETED',
  'AUTH_LOGIN',
  'AUTH_LOGOUT',
  'AUTH_FAILED',
  'AUTH_LOCKOUT_TRIGGERED',
  'AUTH_LOCKOUT_RELEASED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS',
  'ENDPOINT_MUTATION',
  'DEPLOYMENT_PROMOTED',
  'DEPLOYMENT_ROLLED_BACK',
  'MILESTONES_CREATED',
  'MILESTONES_UPDATED',
  'MILESTONES_DELETED',
] as const satisfies readonly AuditAction[];

/**
 * Compile-time exhaustiveness guard for {@link AUDIT_DOMAIN_ACTIONS}.
 *
 * Resolves to `true` only while the list covers every member of the
 * {@link AuditAction} union. Adding a member to the union without adding it to
 * the list turns this type into `never`, so assigning `true` below fails to
 * compile. Exported so the assertion is a named, reviewable part of the module
 * rather than an unused local.
 */
export type AuditDomainActionsAreExhaustive =
  Exclude<AuditAction, (typeof AUDIT_DOMAIN_ACTIONS)[number]> extends never ? true : never;

export const AUDIT_DOMAIN_ACTIONS_ARE_EXHAUSTIVE: AuditDomainActionsAreExhaustive = true;

export const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

/** Array of all valid AuditAction values for validation. */
export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'CONTRACT_CREATED',
  'CONTRACT_UPDATED',
  'CONTRACT_CANCELLED',
  'CONTRACT_COMPLETED',
  'PAYMENT_INITIATED',
  'PAYMENT_RELEASED',
  'PAYMENT_DISPUTED',
  'REPUTATION_UPDATED',
  'USER_CREATED',
  'USER_UPDATED',
  'USER_DELETED',
  'AUTH_LOGIN',
  'AUTH_LOGOUT',
  'AUTH_FAILED',
  'ADMIN_ACTION',
  'ENDPOINT_ACCESS',
  'ENDPOINT_MUTATION',
  'DEPLOYMENT_PROMOTED',
  'DEPLOYMENT_ROLLED_BACK',
] as const;

/** Severity level of the audit event. */
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/** Runtime membership check for audit severities. */
export function isAuditSeverity(value: unknown): value is AuditSeverity {
  return typeof value === 'string' && (AUDIT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Runtime lookup set for {@link AUDIT_SEVERITIES}.
 */
export const AUDIT_SEVERITY_SET: Readonly<Set<string> = new Set(AUDIT_SEVERITIES);

/**
 * Type guard for {@link AuditSeverity}.
 */
export function isAuditSeverity(value: unknown): value is AuditSeverity {
  return typeof value === 'string' && AUDIT_SEVERITY_SET.has(value);
}

/**
 * An immutable audit log entry.
 * Once created, all fields are readonly and the object is frozen.
 */
export interface AuditEntry {
  /** Unique identifier for this log entry (UUID v4). */
  readonly id: string;
  /** ISO-8601 UTC timestamp of when the event occurred. */
  readonly timestamp: string;
  /** The type of sensitive action that was performed. */
  readonly action: AuditAction;
  /** Severity classification of the event. */
  readonly severity: AuditSeverity;
  /** Actor who performed the action (user ID, service name, or 'system'). */
  readonly actor: string;
  /** Resource type affected (e.g. 'contract', 'user', 'payment'). */
  readonly resource: string;
  /** Identifier of the specific resource instance affected. */
  readonly resourceId: string;
  /**
   * Structured metadata about the change.
   * Must NOT contain raw PII — callers are responsible for sanitisation.
   */
  readonly metadata: Readonly<Record<string, unknown>;
  /** IP address of the request origin, if available. */
  readonly ipAddress?: string;
  /** Correlation ID for tracing across services. */
  readonly correlationId?: string;
  /**
   * SHA-256 hex digest of this entry's content fields concatenated with
   * the previous entry's hash, enabling tamper detection.
   */
  readonly hash: string;
  /** Hash of the immediately preceding entry, or 'GENESIS' for the first entry. */
  readonly previousHash: string;
}

/**
 * A single audit entry that has been sealed into the hash chain. The
 * `sequence` field is a monotonically increasing integer assigned by the
 * store at append time; it is the authoritative ordering key and must be
 * used (instead of `timestamp`) whenever entries are compared or paged.
 */
export interface SealedAuditEntry extends AuditEntry {
  readonly sequence: number;
}

/** Input required to create a new audit entry (hash fields are computed internally). */
export type CreateAuditEntryInput = Omit<AuditEntry, 'id' | 'timestamp' | 'hash' | 'previousHash'>;

/**
 * Outcome of a single item within a `POST /api/v1/audit/bulk ` request.
 * Exactly one of `entry` / `error` is populated, matching `success`.
 */
export interface BulkAuditItemResult {
  /** Position of this item within the submitted `entries` array. */
  index: number;
  success: boolean;
  entry?: AuditEntry;
  error?: string;
}

/** Aggregate response body for `POST /api/v1/audit/bulk `. */
export interface BulkAuditResult {
  results: BulkAuditItemResult[];
  succeeded: number;
  failed: number;
}

/** Opaque cursor for pagination. Encodes position and filters. */
export type AuditCursor = string;

/** Internal cursor structure (encoded to base64 for API). */
export interface CursorData {
  /** ID of the last entry in the previous page. */
  lastId: string;
  /** Timestamp of the last entry for ordering stability. */
  lastTimestamp: string;
  /**
   * Monotonic sequence of the last entry in the previous page. Required for
   * stable pagination under concurrent appends: two entries may share a
   * timestamp, so `lastTimestamp` alone is not a total order.
   */
  lastSequence: number;
  /** Filters applied when this cursor was generated. */
  filters: {
    action?: AuditAction;
    severity?: AuditSeverity;
    actor?: string;
    resource?: string;
    resourceId?: string;
    from?: string;
    to?: string;
  };
}

/** Maximum accepted encoded audit cursor size (8 KiB). */
export const MAX_AUDIT_CURSOR_LENGTH = 8_192;

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);
const AUDIT_SEVERITY_SET: ReadonlySet<string> = new Set(AUDIT_SEVERITIES);
const CURSOR_FILTER_KEYS = new Set([
  'action', 'severity', 'actor', 'resource', 'resourceId', 'from', 'to',
]);

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/**
 * Runtime guard for the cursor wire format. Cursors are untrusted query input;
 * validating their complete shape here prevents malformed values from reaching
 * repositories, where they could otherwise trigger silent pagination resets.
 */
function isCursorData(value: unknown): value is CursorData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !['lastId', 'lastTimestamp', 'filters'].includes(key))) return false;
  if (
    typeof data['lastId'] !== 'string' || data['lastId'].length === 0 ||
    typeof data['lastTimestamp'] !== 'string' || !isCanonicalIsoTimestamp(data['lastTimestamp']) ||
    typeof data['filters'] !== 'object' || data['filters'] === null || Array.isArray(data['filters'])
  ) {
    return false;
  }

  const filters = data['filters'] as Record<string, unknown>;
  if (Object.keys(filters).some((key) => !CURSOR_FILTER_KEYS.has(key))) return false;
  for (const [key, filter] of Object.entries(filters)) {
    if (filter === undefined) continue;
    if (key === 'action') {
      if (typeof filter !== 'string' || !AUDIT_ACTION_SET.has(filter)) return false;
    } else if (key === 'severity') {
      if (typeof filter !== 'string' || !AUDIT_SEVERITY_SET.has(filter)) return false;
    } else if (key === 'from' || key === 'to') {
      if (!isCanonicalIsoTimestamp(filter)) return false;
    } else if (typeof filter !== 'string') {
      return false;
    }
  }
  return true;
}

/** Query filters for retrieving audit log entries. */
export interface AuditQuery {
  action?: AuditAction;
  severity?: AuditSeverity;
  actor?: string;
  resource?: string;
  resourceId?: string;
  /** ISO-8601 start of time range (inclusive). */
  from?: string;
  /** ISO-8601 end of time range (inclusive). */
  to?: string;
  /** Maximum number of results to return. Undefined means "no explicit limit". */
  limit?: number;
  /** Zero-based offset for pagination (deprecated, use cursor instead). */
  offset?: number;
  /** Opaque cursor for pagination. */
  cursor?: AuditCursor;
}

/**
 * Options controlling a single export operation. `snapshotSequence` pins the
 * export to a consistent point in the chain so that entries appended while
 * the export is in flight are not silently included or dropped.
 */
export interface ExportOptions {
  /** Inclusive lower bound on entry sequence. */
  fromSequence?: number;
  /** Inclusive upper bound on entry sequence. */
  toSequence?: number;
  /** Maximum number of entries to return in this page. */
  limit?: number;
}

/** Result of a chain integrity verification. */
export interface IntegrityReport {
  valid: boolean;
  totalEntries: number;
  /** Index of the first corrupted entry, if any. */
  firstCorruptedIndex?: number;
  /** ID of the first corrupted entry, if any. */
  firstCorruptedId?: string;
  checkedAt: string;
}

/** Paginated audit query result. */
export interface AuditQueryResult {
  entries: AuditEntry[];
  count: number;
  limit: number;
  /** Opaque cursor for the next page, if more results exist. */
  nextCursor?: string;
  /**
   * Sequence of the last entry included in this page. Callers must pass this
   * back as `fromSequence` (or encode it in the cursor) to resume without
   * gaps or duplicates when new entries are appended concurrently.
   */
  lastSequence?: number;
}

/**
 * Validation boundaries for the audit cache layer.
 *
 * These constants are the single source of truth for what the cache will
 * accept as input. Every entry point (router, service, bulk handler) must
 * validate against these bounds before calling into the cache so that an
 * invalid key or oversized payload never reaches the store.
 *
 * Invariants:
 * - A cache key must be a non-empty string of at most AUDIT_CACHE_MAX_KEY_LENGTH
 *   characters and must not contain control characters.
 * - A cache value must be serialisable to at most AUDIT_CACHE_MAX_VALUE_BYTES
 *   bytes of UTF-8 JSON.
 * - A cache TTL must be a positive integer no greater than AUDIT_CACHE_MAX_TTL_MS.
 * - The cache capacity must be a positive integer no greater than
 *   AUDIT_CACHE_MAX_CAPACITY and the cache must never exceed it.
 */

/** Maximum number of entries the audit cache may hold. */
export const AUDIT_CACHE_MAX_CAPACITY = 10000;

/** Maximum length of a cache key, in characters. */
export const AUDIT_CACHE_MAX_KEY_LENGTH = 512;

/** Maximum serialised size of a cache value, in UTF-8 bytes. */
export const AUDIT_CACHE_MAX_VALUE_BYTES = 1024 * 1024;

/** Maximum cache TTL in milliseconds (24 hours). */
export const AUDIT_CACHE_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Default cache TT\ in milliseconds (5 minutes). */
export const AUDIT_CACHE_DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Minimum cache TTL in milliseconds (1 second). */
export const AUDIT_CACHE_MIN_TTL_MS = 1000;

/** Maximum number of entries accepted in a single bulk request. */
export const AUDIT_CACHE_MAX_BULK_SIZE = 500;

/**
 * Result of validating a cache key.
 * Exactly one of the fields is populated.
 */
export type CacheKeyValidation =
  | { valid: true; key: string }
  | { valid: false; reason: string };

/**
 * Result of validating a cache TTL.
 */
export type CacheTtlValidation =
  | { valid: true; ttlMs: number }
  | { valid: false; reason: string };

/**
 * Result of validating a cache value for serialisation size.
 */
export type CacheValueValidation =
  | { valid: true; bytes: number }
  | { valid: false; reason: string };

/** Control characters (U+0000-U-001F and U-007F) are never allowed in keys. */
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;

/**
 * Validate an audit cache key.
 *
 * Accepts a non-empty string of at most {@link AUDIT_CACHE_MAX_KEY_LENGTH}
 * characters that contains no control characters. Whitespace is trimmed
 * before validation so that duplicate submissions with incidental padding
 * map to the same canonical key.
 */
export function validateCacheKey(key: unknown): CacheKeyValidation {
  if (typeof key !== 'string') {
    return { valid: false, reason: 'cache key must be a string' };
  }
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'cache key must not be empty' };
  }
  if (trimmed.length > AUDIT_CACHE_MAX_KEY_LENGTH) {
    return {
      valid: false,
      reason: `cache key must be at most ${AUDIT_CACHE_MAX_KEY_LENGTH} characters`,
    };
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { valid: false, reason: 'cache key must not contain control characters' };
  }
  return { valid: true, key: trimmed };
}

/**
 * Validate a cache TTL.
 *
 * Accepts a positive integer between {@link AUDIT_CACHE_MIN_TTL_MS} and
 * {@link AUDIT_CACHE_MAX_TTL_MS} inclusive. Non-integer, non-finite, NAN and
 * infinite values are rejected. Undefined maps to the default TTL.
 */
export function validateCacheTtl(ttl: unknown): CacheTtlValidation {
  if (ttl === undefined) {
    return { valid: true, ttlMs: AUDIT_CACHE_DEFAULT_TTL_MS };
  }
  if (typeof ttl !== 'number' || !Number.isFinite(ttl) || !Number.isInteger(ttl)) {
    return { valid: false, reason: 'cache TTL must be a finite integer number of milliseconds' };
  }
  if (ttl < AUDIT_CACHE_MIN_TTL_MS) {
    return {
      valid: false,
      reason: `cache TTL must be at least ${AUDIT_CACHE_MIN_TTL_MS} ms`,
    };
  }
  if (ttl > AUDIT_CACHE_MAX_TTL_MS) {
    return {
      valid: false,
      reason: `cache TTL must be at most ${AUDIT_CACHE_MAX_TTL_MS} ms`,
    };
  }
  return { valid: true, ttlMs: ttl };
}

/**
 * Validate the serialised size of a cache value.
 *
 * The value is serialised to UTF-8 JSON and rejected if it exceeds
 * {@link AUDIT_CACHE_MAX_VALUE_BYTES}. Circular references and values that
 * cannot be serialised are rejected rather than thrown, so the caller can
 * report a deterministic error.
 */
export function validateCacheValue(value: unknown): CacheValueValidation {
  if (value === undefined) {
    return { valid: false, reason: 'cache value must not be undefined' };
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return { valid: false, reason: 'cache value is not JSON-serialisable' };
  }
  if (typeof serialised !== 'string') {
    return { valid: false, reason: 'cache value is not JSON-serialisable' };
  }
  const bytes = Buffer.byteLength(serialised, 'utf-8');
  if (bytes > AUDIT_CACHE_MAX_VALUE_BYTES) {
    return {
      valid: false,
      reason: `cache value must be at most ${AUDIT_CACHE_MAX_VALUE_BYTES} bytes`,
    };
  }
  return { valid: true, bytes };
}

/**
 * Validate the configured capacity of the audit cache.
 *
 * Accepts a positive integer no greater than
 * {@link AUDIT_CACHE_MAX_CAPACITY}. This is the boundary that prevents
 * unbounded memory growth under adverse input.
 */
export function validateCacheCapacity(capacity: unknown): CacheTtlValidation {
  if (typeof capacity !== 'number' || !Number.isFinite(capacity) || !Number.isInteger(capacity)) {
    return { valid: false, reason: 'cache capacity must be a finite integer' };
  }
  if (capacity < 1) {
    return { valid: false, reason: 'cache capacity must be at least 1' };
  }
  if (capacity > AUDIT_CACHE_MAX_CAPACITY) {
    return {
      valid: false,
      reason: `cache capacity must be at most ${AUDIT_CACHE_MAX_CAPACITY}`,
    };
  }
  return { valid: true, ttlMs: capacity };
}

/**
 * Encodes cursor data to an opaque base64 string.
 *
 * The encoded form is a UTF-8 JSON payload base64-encoded. This format is a
 * compatibility contract: cursors generated by older versions of this service
 * must remain decodable by newer versions. Do not change the encoding without
 * a tested migration path.
 */
export function encodeCursor(data: CursorData): string {
  const json = JSON.stringify(data);
  return Buffer.from(json, 'utf-8').toString('base64');
}

/**
 * Decodes an opaque base64 cursor string to cursor data.
 *
 * This function is the single validation boundary for cursors. It must:
 * - reject malformed base64 and non-JSON payloads with a deterministic error,
 * - reject payloads whose shape does not match {@link CursorData},
 * - reject payloads whose `filters` contain invalid action/severity values,
 * - never throw a raw JSON/Buffer error that could leak internal details.
 *
 * The thrown error message is stable ('Invalid cursor format') so that
 * callers and tests can rely on it as part of the compatibility contract.
 */
export function decodeCursor(cursor: string): CursorData {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new Error('Invalid cursor format');
  }

  let json: string;
  try {
    json = Buffer.from(cursor, 'base64').toString('utf-8');
  } catch {
    throw new Error('Invalid cursor format');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid cursor format');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid cursor format');
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.lastId !== 'string' || candidate.lastId.length === 0) {
    throw new Error('Invalid cursor format');
  }

  if (typeof candidate.lastTimestamp !== 'string' || candidate.lastTimestamp.length === 0) {
    throw new Error('Invalid cursor format');
  }

  const filters = candidate.filters;
  if (filters === null || typeof filters !== 'object' || Array.isArray(filters)) {
    throw new Error('Invalid cursor format');
  }

  const filterRecord = filters as Record<string, unknown>;

  if (filterRecord.action !== undefined && !isAuditAction(filterRecord.action)) {
    throw new Error('Invalid cursor format');
  }

  if (filterRecord.severity !== undefined && !isAuditSeverity(filterRecord.severity)) {
    throw new Error('Invalid cursor format');
  }

  const stringFilterKeys = ['actor', 'resource', 'resourceId', 'from', 'to'] as const;
  for (const key of stringFilterKeys) {
    const value = filterRecord[key];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error('Invalid cursor format');
    }
  }

  return {
    lastId: candidate.lastId as string,
    lastTimestamp: candidate.lastTimestamp as string,
    filters: {
      action: filterRecord.action as AuditAction | undefined,
      severity: filterRecord.severity as AuditSeverity | undefined,
      actor: filterRecord.actor as string | undefined,
      resource: filterRecord.resource as string | undefined,
      resourceId: filterRecord.resourceId as string | undefined,
      from: filterRecord.from as string | undefined,
      to: filterRecord.to as string | undefined,
    },
  };
}

/**
 * Deterministic failure recovery support for the audit export service.
 *
 * These types describe the durable export job model used by `services/exportService.ts`.
 * The invariants are:
 * - Every job has a monotonically increasing `sequence` and a `status` from a closed set.
 * - Partial completion is represented by `cursor` + `progress`, never by dropping data.
 * - Retries are idempotent: the same `retryKey` can never produce two committed jobs.
 * - Concurrent execution is serialised via compare-and-swap on `sequence`.
 */

/** Terminal and non-terminal states of an export job. */
export const EXPORT_JOB_STATUSES = [
  'pending',
  'running',
  'partial',
  'completed',
  'failed',
  'cancelled',
] as const;

export type ExportJobStatus = (typeof EXPORT_JOB_STATUSES)[number];

/** Statuses from which no further transition is allowed. */
export const TERMINAL_EXPORT_JOB_STATUSES: readonly ExportJobStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/** Record of a single attempt to execute an export job. */
export interface ExportAttempt {
  /** Monotonically increasing attempt number, starting at 1. */
  attempt: number;
  /** ISO-8601 timestamp when the attempt started. */
  startedAt: string;
  /** ISO-8601 timestamp when the attempt finished, if it did. */
  finishedAt?: string;
  /** Outcome of the attempt. */
  outcome: 'success' | 'partial' | 'failure';
  /** Sanitised, non-sensitive error code for diagnosis. */
  errorCode?: string;
}

/**
 * Durable export job record.
 *
 * Invariants:
 * - `sequence` is strictly increasing and unique per job.
 * - `progress.committed` <= `progress.total` always holds.
 * - Terminal statuses are absorbing: once set, no further transition occurs.
 * - `previousHash` chains job versions for tamper-evident recovery.
 */
export interface ExportJob {
  /** Stable job identifier (UUID v4). */
  readonly id: string;
  /** Idempotency key supplied by the caller. */
  readonly retryKey: string;
  /** Current lifecycle status. */
  readonly status: ExportJobStatus;
  /** Monotonically increasing version of this job record. */
  readonly sequence: number;
  /** Opaque resume cursor for partial completion. */
  readonly cursor: string | null;
  /** Progress counters for observability and resume. */
  readonly progress: {
    readonly committed: number;
    readonly total: number;
  };
  /** History of execution attempts. */
  readonly attempts: readonly ExportAttempt[];
  /** ISO-8601 creation timestamp. */
  readonly createdAt: string;
  /** ISO-8601 last-update timestamp. */
  readonly updatedAt: string;
  /** Hash of the previous job version, or 'GENESIS'. */
  readonly previousHash: string;
  /** Hash of this job version for tamper detection. */
  readonly hash: string;
}

/** Result of a job execution attempt. */
export interface ExportJobResult {
  job: ExportJob;
  /** True when the job reached a terminal status. */
  terminal: boolean;
  /** True when the caller may retry with the same retryKey. */
  retryable: boolean;
}
