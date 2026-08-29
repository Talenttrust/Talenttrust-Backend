/**
 * @module modules/milestones/dto/milestone.dto
 * @description Typed Data Transfer Object (DTO) layer for the milestones boundary.
 *
 * Provides explicit, stable types for every request payload and response shape
 * the milestones HTTP endpoints accept or emit. Mapping functions translate
 * between the DTOs and the internal domain types (`MilestoneRecord`,
 * `CreateMilestoneInput`) so that transport-level concerns (HTTP body shapes,
 * serialisation of Date objects to ISO strings, optional field handling) never
 * leak into the service layer — and vice versa.
 *
 * Design principles (mirrors audit.dto.ts and contracts-boundary.dto.ts):
 * - Plain TypeScript interfaces only — no Zod, no class-validator.
 * - One mapping function per direction per type, named `to<Type>` / `from<Type>`.
 * - All fields are listed explicitly; no `...spread` of arbitrary objects so
 *   that unknown keys cannot reach the service layer.
 * - Optional/nullable fields in the domain type surface as optional in the DTO;
 *   required fields are always present.
 * - Date objects are serialised to ISO-8601 strings in the response DTOs so the
 *   controller never needs to call `.toISOString()` directly.
 */

import type {
  MilestoneRecord,
  CreateMilestoneInput,
} from '../../../services/milestones.service';

// ─── Request DTOs ──────────────────────────────────────────────────────────────

/**
 * Shape of the JSON body accepted by `POST /api/v1/contracts/:id/milestones`.
 *
 * Mirrors {@link CreateMilestoneInput} but is a plain (mutable) object, the
 * natural representation of an inbound HTTP request body. The mapping function
 * {@link toCreateMilestoneInput} converts it to the service-layer input type.
 */
export interface CreateMilestoneRequestDto {
  /** Human-readable milestone title. Required; must be a non-empty string. */
  title: string;
  /** Optional free-text description. Defaults to '' when absent. */
  description?: string;
  /** Milestone amount in stroops. Required; must be a positive number. */
  amount: number;
  /** Optional ISO-8601 deadline string. */
  deadline?: string;
  /** Whether the milestone is already completed. Defaults to false. */
  completed?: boolean;
}

/**
 * Shape of query parameters accepted by
 * `GET /api/v1/contracts/:id/milestones`.
 *
 * All values arrive as strings from Express; the mapping function
 * {@link toListMilestonesOptions} coerces them to the correct types.
 */
export interface ListMilestonesQueryDto {
  /**
   * When `'true'`, soft-deleted milestones are included in the result.
   * Any other value (including absent) → false.
   */
  includeDeleted?: string;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

/**
 * Public representation of a single milestone returned by any milestones
 * endpoint (`POST`, `GET`, `DELETE`, restore).
 *
 * Mirrors {@link MilestoneRecord} but with `Date` objects serialised to
 * ISO-8601 strings and `deletedAt` normalised to `string | null` (never
 * `undefined`), matching the documented API contract.
 */
export interface MilestoneResponseDto {
  /** UUID of the milestone. */
  id: string;
  /** UUID of the parent contract. */
  contractId: string;
  /** Human-readable milestone title. */
  title: string;
  /** Free-text description (empty string when not supplied). */
  description: string;
  /** Milestone amount in stroops. */
  amount: number;
  /** Optional ISO-8601 deadline string. */
  deadline?: string;
  /** Whether the milestone has been marked as completed. */
  completed: boolean;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 last-update timestamp. */
  updatedAt: string;
  /**
   * ISO-8601 soft-deletion timestamp, or `null` when the milestone is active.
   * Never `undefined` — callers can always test `deletedAt !== null`.
   */
  deletedAt: string | null;
}

/**
 * Response shape for `GET /api/v1/contracts/:id/milestones`.
 *
 * Wraps an array of {@link MilestoneResponseDto} with a count so callers
 * do not need to inspect the `milestones` array length themselves.
 */
export interface ListMilestonesResponseDto {
  /** Ordered list of milestones for the contract. */
  milestones: MilestoneResponseDto[];
  /** Total number of milestones returned (equals `milestones.length`). */
  total: number;
}

/**
 * Response shape for single-resource operations:
 * `POST /api/v1/contracts/:id/milestones`,
 * `DELETE /api/v1/contracts/:id/milestones/:milestoneId`,
 * `POST /api/v1/contracts/:id/milestones/:milestoneId/restore`.
 *
 * The `message` field is present on soft-delete and restore operations;
 * absent on plain create.
 */
export interface SingleMilestoneResponseDto {
  /** The created / updated / restored milestone. */
  milestone: MilestoneResponseDto;
  /** Optional human-readable description of the operation performed. */
  message?: string;
}

// ─── Request mapping functions ─────────────────────────────────────────────────

/**
 * Maps the raw HTTP request body to the service-layer input type.
 *
 * Only the fields declared on {@link CreateMilestoneInput} are forwarded —
 * unknown keys in the HTTP body cannot reach the domain layer.
 *
 * @param dto - Request body from `POST /api/v1/contracts/:id/milestones`.
 * @returns A {@link CreateMilestoneInput} ready for `MilestonesService.create()`.
 */
export function toCreateMilestoneInput(
  dto: CreateMilestoneRequestDto,
): CreateMilestoneInput {
  return {
    title: dto.title,
    amount: dto.amount,
    ...(dto.description !== undefined && { description: dto.description }),
    ...(dto.deadline !== undefined && { deadline: dto.deadline }),
    ...(dto.completed !== undefined && { completed: dto.completed }),
  };
}

/**
 * Coerces the raw query-string parameters to the typed options object
 * expected by `MilestonesService.listByContract()`.
 *
 * @param dto - Raw query params from `GET /api/v1/contracts/:id/milestones`.
 * @returns Service options with correctly-typed `includeDeleted`.
 */
export function toListMilestonesOptions(
  dto: ListMilestonesQueryDto,
): { includeDeleted: boolean } {
  return {
    includeDeleted: dto.includeDeleted === 'true',
  };
}

// ─── Response mapping functions ────────────────────────────────────────────────

/**
 * Maps an internal {@link MilestoneRecord} domain object to the stable public
 * {@link MilestoneResponseDto} shape.
 *
 * Fields are listed explicitly so any future additions to `MilestoneRecord`
 * do not accidentally appear in the API response until this mapping is
 * deliberately updated.
 *
 * `Date` → ISO-8601 string conversions are centralised here so the controller
 * never needs to call `.toISOString()` directly.
 *
 * @param record - Domain record from `MilestonesService`.
 * @returns A plain-object DTO safe for JSON serialisation.
 */
export function toMilestoneResponseDto(record: MilestoneRecord): MilestoneResponseDto {
  return {
    id: record.id,
    contractId: record.contractId,
    title: record.title,
    description: record.description,
    amount: record.amount,
    completed: record.completed,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: record.deletedAt ? record.deletedAt.toISOString() : null,
    ...(record.deadline !== undefined && { deadline: record.deadline }),
  };
}

/**
 * Builds a {@link ListMilestonesResponseDto} from an array of domain records.
 *
 * @param records - Array returned by `MilestonesService.listByContract()`.
 * @returns Response DTO with `milestones` array and matching `total` count.
 */
export function toListMilestonesResponseDto(
  records: MilestoneRecord[],
): ListMilestonesResponseDto {
  return {
    milestones: records.map(toMilestoneResponseDto),
    total: records.length,
  };
}

/**
 * Builds a {@link SingleMilestoneResponseDto} from a domain record.
 *
 * @param record - Domain record from a create / soft-delete / restore operation.
 * @param message - Optional operation summary (e.g. 'Milestone X soft-deleted').
 * @returns Response DTO with the serialised milestone and optional message.
 */
export function toSingleMilestoneResponseDto(
  record: MilestoneRecord,
  message?: string,
): SingleMilestoneResponseDto {
  const dto: SingleMilestoneResponseDto = {
    milestone: toMilestoneResponseDto(record),
  };
  if (message !== undefined) {
    dto.message = message;
  }
  return dto;
}

/**
 * Converts a public {@link MilestoneResponseDto} back to a {@link MilestoneRecord}.
 *
 * Useful in tests and adapters that hydrate records from an API response.
 * The round-trip is lossless for all defined fields; ISO-8601 strings are
 * parsed back to `Date` objects.
 *
 * @param dto - Public DTO received from the API.
 * @returns A domain {@link MilestoneRecord} (not frozen).
 */
export function fromMilestoneResponseDto(dto: MilestoneResponseDto): MilestoneRecord {
  return {
    id: dto.id,
    contractId: dto.contractId,
    title: dto.title,
    description: dto.description,
    amount: dto.amount,
    completed: dto.completed,
    createdAt: new Date(dto.createdAt),
    updatedAt: new Date(dto.updatedAt),
    deletedAt: dto.deletedAt ? new Date(dto.deletedAt) : null,
    ...(dto.deadline !== undefined && { deadline: dto.deadline }),
  };
}
