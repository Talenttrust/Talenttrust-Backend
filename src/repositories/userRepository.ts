/**
 * UserRepository — CRUD operations for the `users` table.
 *
 * Uses prepared statements throughout to prevent SQL injection.
 * Username and email uniqueness is enforced at the DB level (UNIQUE constraint
 * on the raw column, plus a unique index on the normalised email — see
 * migration `add_unique_index_on_normalized_email`) in addition to
 * application-level validation.
 *
 * Security notes:
 *  - Passwords / credentials are NOT stored here; authentication is handled
 *    externally (Stellar key-based or third-party auth).
 *  - Emails are normalised (trimmed + lowercased) via {@link normalizeEmail}
 *    on both write and lookup paths to prevent case-variant duplicate
 *    accounts and the account-confusion/impersonation risk that follows.
 */

import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { User, UserRole } from "../db/types";

/**
 * Normalises an email address for storage and lookup: trims surrounding
 * whitespace and lowercases it, so `" User@X.com "` and `"user@x.com"`
 * resolve to the same account.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Raw row shape returned from SQLite (snake_case columns). */
interface UserRow {
  id: string;
  username: string;
  email: string;
  role: string;
  created_at: string;
}

/** Maps a raw DB row to the domain User interface. */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role as UserRole,
    createdAt: row.created_at,
  };
}

/**
 * Repository providing typed CRUD access to the `users` table.
 *
 * Instantiate with an open `Database` instance.
 */
export class UserRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Returns all users ordered by creation date descending.
   *
   * @returns Array of User objects (empty when no users exist).
   */
  findAll(): User[] {
    const rows = this.db
      .prepare<[], UserRow>("SELECT * FROM users ORDER BY created_at DESC")
      .all();
    return rows.map(toUser);
  }

  /**
   * Finds a user by their UUID primary key.
   *
   * @param id - The user UUID.
   * @returns The matching User or `undefined` if not found.
   */
  findById(id: string): User | undefined {
    const row = this.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?")
      .get(id);
    return row ? toUser(row) : undefined;
  }

  /**
   * Finds a user by their unique email address.
   *
   * @param email - Email address to search for (normalised before lookup,
   *                so the match is case- and whitespace-insensitive).
   * @returns The matching User or `undefined` if not found.
   */
  findByEmail(email: string): User | undefined {
    const row = this.db
      .prepare<[string], UserRow>("SELECT * FROM users WHERE email = ?")
      .get(normalizeEmail(email));
    return row ? toUser(row) : undefined;
  }

  /**
   * Creates a new user record.
   *
   * @param data - Required user fields (id and createdAt are generated).
   *               The email is normalised (trimmed + lowercased) before
   *               being persisted.
   * @returns  The newly created User (with the normalised email).
   * @throws   If username or email already exists (SQLite UNIQUE constraint).
   */
  create(data: Omit<User, "id" | "createdAt">): User {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const email = normalizeEmail(data.email);

    this.db
      .prepare<[string, string, string, string, string]>(
        `INSERT INTO users (id, username, email, role, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, data.username, email, data.role, createdAt);

    return { id, ...data, email, createdAt };
  }

  /**
   * Deletes a user by ID.
   *
   * Note: Deleting a user with associated contracts will fail due to the
   * REFERENCES foreign key constraint unless those contracts are removed first.
   *
   * @param id - UUID of the user to remove.
   * @returns `true` if a row was deleted, `false` if the ID did not exist.
   */
  delete(id: string): boolean {
    const result = this.db
      .prepare<[string]>("DELETE FROM users WHERE id = ?")
      .run(id);
    return result.changes > 0;
  }
}
