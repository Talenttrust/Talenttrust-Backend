/**
 * ReputationRepository — SQLite-backed data access for reputation entries.
 *
 * Provides typed CRUD operations for the reputation_entries table with:
 * - Prepared statements throughout (SQL injection prevention)
 * - DB-level uniqueness enforcement (reviewer_id, target_id, context_id)
 * - Contract participation verification for authorization
 *
 * Security notes:
 *  - All queries use parameter binding — no string interpolation
 *  - Foreign key constraints ensure referential integrity
 *  - UNIQUE constraint prevents duplicate ratings at DB level
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { ConflictError } from '../errors/appError';

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

/**
 * Repository providing typed access to the reputation_entries table.
 *
 * Instantiate with an open Database instance.
 */
export class ReputationRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
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
}
