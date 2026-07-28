/**
 * @module audit/dto/audit.dto
 * @description Typed Data Transfer Object (DTO) layer for the audit boundary.
 *
 * This module provides explicit, stable types for every request payload and
 * response shape the audit HTTP endpoints accept or emit. Mapping functions
 * translate between the DTOs and the internal domain types (`AuditEntry`,
 * `CreateAuditEntryInput`, etc.) so that transport-level concerns (HTTP body
 * shapes, query-string coercions, optional field defaults) never leak into
 * the service layer — and vice versa.
 *
 * Design principles (follow the contracts module pattern):
 * - Plain TypeScript interfaces only — no Zod, no class-validator.
 * - One mapping function per direction per type, named `to<Type>` or
 *   `from<Type>`.
 * - All fields are explicit; no `...spread` of arbitrary objects so that
 *   unknown keys cannot reach the service layer.
 * - Optional/nullable fields in the domain type surface as optional in the
 *   DTO; required fields are always present.
 */

import type {
  AuditAction,
  AuditEntry,
  AuditQuery,
  AuditQueryResult,
  AuditSeverity,
  CreateAuditEntryInput,
  IntegrityReport,
} from '../types';

// ─── Request DTOs ─────────────────────────────────────────────────────────────

/**
 * Shape of the JSON body accepted by `POST /api/v1/audit`.
 *
 * Mirrors {@link CreateAuditEntryInput} but is a plain (mutable) object, which
 * is the natural representation of an inbound HTTP request body. The mapping
 * function {@link toCreateAuditEntryInput} converts it to the strictly-typed
 * domain input.
 */
export interface CreateAuditEntryRequestDto {
  /** The type of sensitive action that was performed. */
  action: AuditAction;
  /** Severity classification of the event. */
  severity: AuditSeverity;
  /** Actor who performed the action (user ID, service name, or 'system'). */
  actor: string;
  /** Resource type affected (e.g. 'contract', 'user', 'payment'). */
  resource: string;
  /** Identifier of the specific resource instance affected. */
  resourceId: string;
  /**
   * Structured metadata about the change.
   * Must NOT contain raw PII — callers are responsible for sanitisation.
   */
  metadata: Record<string, unknown>;
  /** IP address of the request origin, if available. */
  ipAddress?: string;
  /** Correlation ID for tracing across services. */
  correlationId?: string;
}

/**
 * Shape of the validated query parameters accepted by `GET /api/v1/audit`.
 *
 * All values arrive as strings from Express; the mapping function
 * {@link toAuditQuery} performs coercions (string → number, ISO-date
 * parsing) and applies defaults.
 */
export interface AuditQueryParamsDto {
  /** Filter by event type (e.g. `CONTRACT_CREATED`). */
  action?: string;
  /** Filter by severity level (`INFO`, `WARNING`, `CRITICAL`). */
  severity?: string;
  /** Filter by actor ID. */
  actor?: string;
  /** Filter by resource type (e.g. `contract`, `user`). */
  resource?: string;
  /** Filter by resource instance ID. */
  resourceId?: string;
  /** ISO-8601 start of time range (inclusive). */
  from?: string;
  /** ISO-8601 end of time range (inclusive). */
  to?: string;
  /** Maximum number of results to return (string, coerced to number). */
  limit?: string;
  /** Zero-based pagination offset (string, coerced to number). */
  offset?: string;
  /** Opaque cursor for cursor-based pagination. */
  cursor?: string;
}

// ─── Response DTOs ────────────────────────────────────────────────────────────

/**
 * Public representation of a single audit entry returned by
 * `GET /api/v1/audit/:id` and embedded in list/cursor responses.
 *
 * Mirrors the internal {@link AuditEntry} but is a plain (non-frozen)
 * interface, which is appropriate for JSON serialisation. Fields match
 * 1-to-1 with the domain type so no data is lost or added at this boundary.
 */
export interface AuditEntryResponseDto {
  id: string;
  timestamp: string;
  action: AuditAction;
  severity: AuditSeverity;
  actor: string;
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  correlationId?: string;
  hash: string;
  previousHash: string;
}

/**
 * Paginated response shape returned by `GET /api/v1/audit`.
 *
 * Wraps an array of {@link AuditEntryResponseDto} with count and pagination
 * metadata so callers can page through results without inspecting internals.
 */
export interface AuditQueryResponseDto {
  entries: AuditEntryResponseDto[];
  count: number;
  limit: number;
  /**
   * Zero-based offset used in the current page.
   * Present only when offset-based pagination is in use.
   */
  offset?: number;
  /**
   * Opaque cursor for the next page.
   * Present only when cursor-based pagination is in use and more results exist.
   */
  nextCursor?: string;
}

/**
 * Response shape returned by `GET /api/v1/audit/integrity`.
 *
 * Maps 1-to-1 from {@link IntegrityReport} — kept as a separate DTO so the
 * public contract is independent of any future internal refactors.
 */
export interface IntegrityReportResponseDto {
  /** Whether the hash chain is intact (no tampering detected). */
  valid: boolean;
  /** Total number of entries inspected. */
  totalEntries: number;
  /**
   * Zero-based index of the first corrupted entry.
   * Absent when the chain is valid.
   */
  firstCorruptedIndex?: number;
  /**
   * ID of the first corrupted entry.
   * Absent when the chain is valid.
   */
  firstCorruptedId?: string;
  /** ISO-8601 timestamp of when the check was performed. */
  checkedAt: string;
}

// ─── Request mapping functions ────────────────────────────────────────────────

/**
 * Maps the inbound HTTP request DTO to the service-layer input type.
 *
 * Only explicitly listed fields are forwarded — unknown keys in the HTTP
 * body cannot reach the domain layer.
 *
 * @param dto - Validated request body from `POST /api/v1/audit`.
 * @returns A {@link CreateAuditEntryInput} ready for `AuditService.log()`.
 */
export function toCreateAuditEntryInput(
  dto: CreateAuditEntryRequestDto,
): CreateAuditEntryInput {
  return {
    action: dto.action,
    severity: dto.severity,
    actor: dto.actor,
    resource: dto.resource,
    resourceId: dto.resourceId,
    metadata: { ...dto.metadata },
    ...(dto.ipAddress !== undefined && { ipAddress: dto.ipAddress }),
    ...(dto.correlationId !== undefined && { correlationId: dto.correlationId }),
  };
}

/**
 * Maps query-string parameters (all strings from Express) to the typed
 * {@link AuditQuery} used by `AuditService.query()` / `queryWithCursor()`.
 *
 * Coercions performed:
 * - `limit` and `offset` are parsed as integers; invalid values fall back to
 *   `undefined` / `0` respectively so the service uses its own defaults.
 * - `from` and `to` are validated as ISO-8601; invalid values throw so the
 *   caller can return a 400 to the client.
 * - `action` and `severity` are kept as-is (validated at the router level
 *   before this function is called).
 *
 * @param dto - Raw query parameters from the Express request.
 * @param options.maxLimit - Upper bound for the parsed `limit` value.
 * @param options.defaultLimit - Default `limit` when not provided.
 * @returns A typed {@link AuditQuery}.
 * @throws {Error} When `from` or `to` is provided but not a valid ISO-8601 date.
 */
export function toAuditQuery(
  dto: AuditQueryParamsDto,
  options: { maxLimit: number; defaultLimit?: number } = { maxLimit: 100 },
): AuditQuery {
  // Parse and clamp limit
  let limit: number | undefined = options.defaultLimit;
  if (dto.limit !== undefined) {
    const parsed = Number.parseInt(dto.limit, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error('Invalid limit');
    }
    limit = Math.min(parsed, options.maxLimit);
  }

  // Parse and validate offset
  let offset = 0;
  if (dto.offset !== undefined) {
    const parsed = Number.parseInt(dto.offset, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error('Invalid offset');
    }
    offset = parsed;
  }

  // Validate ISO-8601 date strings
  let from: string | undefined;
  if (dto.from !== undefined) {
    const parsed = Date.parse(dto.from);
    if (Number.isNaN(parsed)) {
      throw new Error('Invalid from timestamp');
    }
    from = new Date(parsed).toISOString();
  }

  let to: string | undefined;
  if (dto.to !== undefined) {
    const parsed = Date.parse(dto.to);
    if (Number.isNaN(parsed)) {
      throw new Error('Invalid to timestamp');
    }
    to = new Date(parsed).toISOString();
  }

  return {
    ...(dto.action !== undefined && { action: dto.action as AuditAction }),
    ...(dto.severity !== undefined && { severity: dto.severity as AuditSeverity }),
    ...(dto.actor !== undefined && { actor: dto.actor }),
    ...(dto.resource !== undefined && { resource: dto.resource }),
    ...(dto.resourceId !== undefined && { resourceId: dto.resourceId }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
    ...(limit !== undefined && { limit }),
    offset,
    ...(dto.cursor !== undefined && { cursor: dto.cursor }),
  };
}

// ─── Response mapping functions ───────────────────────────────────────────────

/**
 * Maps an internal {@link AuditEntry} domain object to the stable public
 * {@link AuditEntryResponseDto} shape.
 *
 * Fields are listed explicitly so that any future additions to `AuditEntry`
 * do not accidentally appear in the API response until this mapping is
 * deliberately updated.
 *
 * @param entry - Domain entry from the store or service.
 * @returns A plain-object DTO safe for JSON serialisation.
 */
export function toAuditEntryResponseDto(entry: AuditEntry): AuditEntryResponseDto {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    severity: entry.severity,
    actor: entry.actor,
    resource: entry.resource,
    resourceId: entry.resourceId,
    metadata: { ...(entry.metadata as Record<string, unknown>) },
    ...(entry.ipAddress !== undefined && { ipAddress: entry.ipAddress }),
    ...(entry.correlationId !== undefined && { correlationId: entry.correlationId }),
    hash: entry.hash,
    previousHash: entry.previousHash,
  };
}

/**
 * Maps a paginated query result (offset-based) to the public list response DTO.
 *
 * @param result - Array of domain entries returned by `AuditService.query()`.
 * @param limit - The effective limit used in the query.
 * @param offset - The effective offset used in the query.
 * @returns {@link AuditQueryResponseDto} ready for `res.json()`.
 */
export function toAuditQueryResponseDto(
  result: AuditEntry[],
  limit: number,
  offset: number,
): AuditQueryResponseDto {
  return {
    entries: result.map(toAuditEntryResponseDto),
    count: result.length,
    limit,
    offset,
  };
}

/**
 * Maps a cursor-paginated {@link AuditQueryResult} to the public list response DTO.
 *
 * @param result - Paginated result returned by `AuditService.queryWithCursor()`.
 * @returns {@link AuditQueryResponseDto} ready for `res.json()`.
 */
export function toAuditQueryCursorResponseDto(
  result: AuditQueryResult,
): AuditQueryResponseDto {
  return {
    entries: result.entries.map(toAuditEntryResponseDto),
    count: result.count,
    limit: result.limit,
    ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
  };
}

/**
 * Maps an internal {@link IntegrityReport} to the public response DTO.
 *
 * @param report - Report returned by `AuditService.verifyIntegrity()`.
 * @returns {@link IntegrityReportResponseDto} ready for `res.json()`.
 */
export function toIntegrityReportResponseDto(
  report: IntegrityReport,
): IntegrityReportResponseDto {
  return {
    valid: report.valid,
    totalEntries: report.totalEntries,
    ...(report.firstCorruptedIndex !== undefined && {
      firstCorruptedIndex: report.firstCorruptedIndex,
    }),
    ...(report.firstCorruptedId !== undefined && {
      firstCorruptedId: report.firstCorruptedId,
    }),
    checkedAt: report.checkedAt,
  };
}

/**
 * Converts a public {@link AuditEntryResponseDto} back to an {@link AuditEntry}.
 *
 * Useful in tests and adapters that hydrate entries from another audit API
 * response. The round-trip is lossless for all defined fields.
 *
 * @param dto - Public DTO received from the API.
 * @returns A domain {@link AuditEntry} (not frozen — callers freeze if needed).
 */
export function fromAuditEntryResponseDto(dto: AuditEntryResponseDto): AuditEntry {
  return {
    id: dto.id,
    timestamp: dto.timestamp,
    action: dto.action,
    severity: dto.severity,
    actor: dto.actor,
    resource: dto.resource,
    resourceId: dto.resourceId,
    metadata: { ...dto.metadata },
    ...(dto.ipAddress !== undefined && { ipAddress: dto.ipAddress }),
    ...(dto.correlationId !== undefined && { correlationId: dto.correlationId }),
    hash: dto.hash,
    previousHash: dto.previousHash,
  };
}
