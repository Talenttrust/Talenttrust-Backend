/**
 * ReputationRepository — SQLite-backed data access for reputation entries.
 *
 * Provides typed CRUD operations for the reputation_entries table with:
 * - Prepared statements throughout (SQL injection prevention)
 * - DB-level uniqueness enforcement (reviewer_id, target_id, context_id)
 * - Contract participation verification for authorization
 * - Manual reputation corrections with full provenance tracking
 *
 * Security notes:
 *  - All queries use parameter binding — no string interpolation
 *  - Foreign key constraints ensure referential integrity
 *  - UNIQUE constraint prevents duplicate ratings at DB level
 *  - UNIQUE constraint prevents duplicate corrections (target_id, context_id, reference)
 */

import type BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { ConflictError } from '../errors/appError';
import {
  encodeCursor,
  decodeCursor,
  parseLimit,
} from '../contracts/cursor.repository';
import type { CursorPage, CursorPaginationInput } from '../contracts/cursor.types';

/** Raw row shape returned from SQLite (snake_case columns). */
interface ReputationRow {
  id: string;
  reviewer_id: string;
  target_id: string;
  rating: number;
  comment: string | null;
  context_id: string;
  created_at: string;
}

/** Raw row shape for reputation corrections (snake_case columns). */
interface ReputationCorrectionRow {
  id: string;
  target_id: string;
  context_id: string;
  reason: string;
  reference: string;
  before_score: number;
  after_score: number;
  before_weighted: number;
  after_weighted: number;
  before_total: number;
  after_total: number;
  operator_id: string;
  operator_role: string;
  created_at: string;
}

/** Domain-level reputation entry (camelCase). */
export interface ReputationEntry {
  id: string;
  reviewerId: string;
  targetId: string;
  rating: number;
  comment?: string;
  contextId: string;
  createdAt: string;
}

/** Input for creating a new reputation entry. */
export interface CreateReputationEntry {
  reviewerId: string;
  targetId: string;
  rating: number;
  comment?: string;
  contextId: string;
}

/** Domain-level reputation correction entry (camelCase). */
export interface ReputationCorrectionEntry {
  id: string;
  targetId: string;
  contextId: string;
  reason: string;
  reference: string;
  beforeScore: number;
  afterScore: number;
  beforeWeighted: number;
  afterWeighted: number;
  beforeTotal: number;
  afterTotal: number;
  operatorId: string;
  operatorRole: string;
  createdAt: string;
}

/** Input for creating a new reputation correction. */
export interface CreateReputationCorrection {
  targetId: string;
  contextId: string;
  reason: string;
  reference: string;
  beforeScore: number;
  afterScore: number;
  beforeWeighted: number;
  afterWeighted: number;
  beforeTotal: number;
  afterTotal: number;
  operatorId: string;
  operatorRole: string;
}

/** Maps a raw DB row to the domain ReputationEntry interface. */
function toReputationEntry(row: ReputationRow): ReputationEntry {
  return {
    id: row.id,
    reviewerId: row.reviewer_id,
    targetId: row.target_id,
    rating: row.rating,
    comment: row.comment ?? undefined,
    contextId: row.context_id,
    createdAt: row.created_at,
  };
}

/** Maps a raw DB row to the domain ReputationCorrectionEntry interface. */
function toReputationCorrectionEntry(row: ReputationCorrectionRow): ReputationCorrectionEntry {
  return {
    id: row.id,
    targetId: row.target_id,
    contextId: row.context_id,
    reason: row.reason,
    reference: row.reference,
    beforeScore: row.before_score,
    afterScore: row.after_score,
    beforeWeighted: row.before_weighted,
    afterWeighted: row.after_weighted,
    beforeTotal: row.before_total,
    afterTotal: row.after_total,
    operatorId: row.operator_id,
    operatorRole: row.operator_role,
    createdAt: row.created_at,
  };
}

/**
 * Repository providing typed access to the reputation_entries table.
 *
 * Instantiate with an open Database instance.
 */
export class ReputationRepository {
  private db: BetterSqlite3.Database;

  constructor(db: BetterSqlite3.Database) {
    this.db = db;
  }

  /**
   * Creates a new reputation entry.
   *
   * @param entry - Required fields for the reputation entry.
   * @returns The newly created ReputationEntry.
   * @throws ConflictError if a duplicate entry exists (UNIQUE constraint violation).
   */
  create(entry: CreateReputationEntry): ReputationEntry {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    try {
      this.db
        .prepare<[string, string, string, number, string | null, string, string]>(
          `INSERT INTO reputation_entries 
           (id, reviewer_id, target_id, rating, comment, context_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, entry.reviewerId, entry.targetId, entry.rating, entry.comment ?? null, entry.contextId, createdAt);
    } catch (error: any) {
      // SQLite UNIQUE constraint violation error code
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('Rating already exists for this reviewer, target, and context');
      }
      throw error;
    }

    return {
      id,
      reviewerId: entry.reviewerId,
      targetId: entry.targetId,
      rating: entry.rating,
      comment: entry.comment,
      contextId: entry.contextId,
      createdAt,
    };
  }

  /**
   * Finds a reputation entry by the composite unique key.
   *
   * @param reviewerId - The reviewer's user ID.
   * @param targetId - The target user's ID (being rated).
   * @param contextId - The contract/context ID.
   * @returns The matching ReputationEntry or undefined if not found.
   */
  findByReviewerTargetContext(
    reviewerId: string,
    targetId: string,
    contextId: string
  ): ReputationEntry | undefined {
    const row = this.db
      .prepare<[string, string, string], ReputationRow>(
        `SELECT * FROM reputation_entries 
         WHERE reviewer_id = ? AND target_id = ? AND context_id = ?`
      )
      .get(reviewerId, targetId, contextId);
    
    return row ? toReputationEntry(row) : undefined;
  }

  /**
   * Retrieves all reputation entries for a specific target user.
   *
   * @param targetId - The target user's ID.
   * @returns Array of ReputationEntry objects ordered by creation date descending.
   */
  findByTargetId(targetId: string): ReputationEntry[] {
    const rows = this.db
      .prepare<[string], ReputationRow>(
        `SELECT * FROM reputation_entries 
         WHERE target_id = ? 
         ORDER BY created_at DESC`
      )
      .all(targetId);
    
    return rows.map(toReputationEntry);
  }

  /**
   * Returns a cursor-paginated page of reputation entries for a target user.
   *
   * Pages are ordered newest-first by (created_at DESC, id DESC). The opaque
   * cursor encodes the anchor row's `created_at` + `id` tuple.
   *
   * @param targetId - The target user's ID.
   * @param input    - Optional {@link CursorPaginationInput} (limit defaults to 20, capped at 100).
   * @returns A {@link CursorPage} with up to `limit` entries and a `nextCursor` (or null on the last page).
   */
  findByTargetIdPaginated(
    targetId: string,
    input: CursorPaginationInput = {},
  ): CursorPage<ReputationEntry> {
    const limit = parseLimit(input.limit);

    let rows: ReputationRow[];

    if (input.cursor) {
      const pos = decodeCursor(input.cursor);

      rows = this.db
        .prepare<[string, string, string, string, number], ReputationRow>(
          `SELECT * FROM reputation_entries
           WHERE target_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(targetId, pos.createdAt, pos.createdAt, pos.id, limit + 1);
    } else {
      rows = this.db
        .prepare<[string, number], ReputationRow>(
          `SELECT * FROM reputation_entries
           WHERE target_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(targetId, limit + 1);
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const data = pageRows.map(toReputationEntry);

    // Use mapped domain objects (camelCase) for cursor encoding — raw rows use snake_case
    const lastEntry = data[data.length - 1];
    const nextCursor =
      hasNextPage && lastEntry
        ? encodeCursor({ createdAt: lastEntry.createdAt, id: lastEntry.id })
        : null;

    return { data, nextCursor, hasNextPage, limit };
  }

  /**
   * Verifies that a user is a participant in the specified contract.
   *
   * @param contractId - The contract UUID.
   * @param userId - The user UUID to check.
   * @returns true if the user is either the client or freelancer on the contract.
   */
  verifyContractParticipation(contractId: string, userId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM contracts 
         WHERE id = ? AND (client_id = ? OR freelancer_id = ?)`
      )
      .get(contractId, userId, userId) as { count: number } | undefined;
    
    return (row?.count ?? 0) > 0;
  }

  /**
   * Retrieves a single reputation entry by its UUID.
   *
   * @param id - The reputation entry UUID.
   * @returns The matching ReputationEntry or undefined if not found.
   */
  findById(id: string): ReputationEntry | undefined {
    const row = this.db
      .prepare<[string], ReputationRow>(
        `SELECT * FROM reputation_entries WHERE id = ?`
      )
      .get(id);
    
    return row ? toReputationEntry(row) : undefined;
  }

  /**
   * Returns the total number of reputation entries in the database.
   */
  count(): number {
    const row = this.db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) as count FROM reputation_entries`
      )
      .get();
    
    return row?.count || 0;
  }

  /**
   * Returns one page of distinct target_id values from reputation_entries,
   * ordered deterministically so callers can paginate the full set without
   * loading it all into memory.
   *
   * @param limit  - Maximum number of IDs to return per page.
   * @param offset - Number of IDs to skip (0-based).
   * @returns An array of distinct target IDs (may be shorter than `limit` on the last page).
   */
  getDistinctTargetIdPage(limit: number, offset: number): string[] {
    const rows = this.db
      .prepare<[number, number], { target_id: string }>(
        `SELECT DISTINCT target_id
         FROM reputation_entries
         ORDER BY target_id
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);

    return rows.map(r => r.target_id);
  }

  /**
   * Creates a new reputation correction entry with full provenance tracking.
   *
   * @param correction - Required fields for the reputation correction.
   * @returns The newly created ReputationCorrectionEntry.
   * @throws ConflictError if a duplicate correction exists for the same target, context, and reference.
   */
  createCorrection(correction: CreateReputationCorrection): ReputationCorrectionEntry {
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    try {
      this.db
        .prepare<[string, string, string, string, string, number, number, number, number, number, number, string, string, string]>(
          `INSERT INTO reputation_corrections 
           (id, target_id, context_id, reason, reference, before_score, after_score, before_weighted, after_weighted, before_total, after_total, operator_id, operator_role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          correction.targetId,
          correction.contextId,
          correction.reason,
          correction.reference,
          correction.beforeScore,
          correction.afterScore,
          correction.beforeWeighted,
          correction.afterWeighted,
          correction.beforeTotal,
          correction.afterTotal,
          correction.operatorId,
          correction.operatorRole,
          createdAt
        );
    } catch (error: any) {
      // SQLite UNIQUE constraint violation error code
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('Correction already exists for this target, context, and reference');
      }
      throw error;
    }

    return {
      id,
      targetId: correction.targetId,
      contextId: correction.contextId,
      reason: correction.reason,
      reference: correction.reference,
      beforeScore: correction.beforeScore,
      afterScore: correction.afterScore,
      beforeWeighted: correction.beforeWeighted,
      afterWeighted: correction.afterWeighted,
      beforeTotal: correction.beforeTotal,
      afterTotal: correction.afterTotal,
      operatorId: correction.operatorId,
      operatorRole: correction.operatorRole,
      createdAt,
    };
  }

  /**
   * Finds a reputation correction by the composite unique key.
   *
   * @param targetId - The target user's ID.
   * @param contextId - The contract/context ID.
   * @param reference - The reference identifier (e.g., ticket number, dispute ID).
   * @returns The matching ReputationCorrectionEntry or undefined if not found.
   */
  findCorrectionByTargetContextReference(
    targetId: string,
    contextId: string,
    reference: string
  ): ReputationCorrectionEntry | undefined {
    const row = this.db
      .prepare<[string, string, string], ReputationCorrectionRow>(
        `SELECT * FROM reputation_corrections 
         WHERE target_id = ? AND context_id = ? AND reference = ?`
      )
      .get(targetId, contextId, reference);
    
    return row ? toReputationCorrectionEntry(row) : undefined;
  }

  /**
   * Retrieves all reputation corrections for a specific target user.
   *
   * @param targetId - The target user's ID.
   * @returns Array of ReputationCorrectionEntry objects ordered by creation date descending.
   */
  findCorrectionsByTargetId(targetId: string): ReputationCorrectionEntry[] {
    const rows = this.db
      .prepare<[string], ReputationCorrectionRow>(
        `SELECT * FROM reputation_corrections 
         WHERE target_id = ? 
         ORDER BY created_at DESC`
      )
      .all(targetId);
    
    return rows.map(toReputationCorrectionEntry);
  }

  /**
   * Retrieves a single reputation correction by its UUID.
   *
   * @param id - The reputation correction UUID.
   * @returns The matching ReputationCorrectionEntry or undefined if not found.
   */
  findCorrectionById(id: string): ReputationCorrectionEntry | undefined {
    const row = this.db
      .prepare<[string], ReputationCorrectionRow>(
        `SELECT * FROM reputation_corrections WHERE id = ?`
      )
      .get(id);
    
    return row ? toReputationCorrectionEntry(row) : undefined;
  }
}
